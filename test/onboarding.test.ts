import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Deferred } from "./helpers.js";
import { LanguagePicker } from "../src/language-picker.js";
import { runModelSelection, runOnboarding } from "../src/onboarding.js";
import { createSettings, readSettings, writeSettings } from "../src/settings.js";
import { TryItPane } from "../src/try-it.js";
import { SingleSelectPicker } from "../src/ui-components.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");

type Step = (pane: Component, done: (value: unknown) => void) => void | Promise<void>;

function scriptedContext(steps: Step[], notifications: string[] = []) {
  let index = 0;
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        const result = new Deferred<unknown>();
        const pane = await factory(
          testTui(24), testTheme(), keybindings() as Parameters<typeof factory>[2],
          (value) => result.resolve(value),
        );
        try {
          const step = steps[index++];
          assert.ok(step, `Unexpected pane: ${pane.constructor.name}`);
          await step(pane, (value) => result.resolve(value));
          return await result.promise;
        } finally {
          pane.dispose?.();
        }
      },
      notify: (message: string) => { notifications.push(message); },
    },
  } as unknown as ExtensionContext;
  return { ctx, assertFinished: () => assert.equal(index, steps.length) };
}

function isolatedSettings(t: TestContext) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(join(tmpdir(), "pi-voice-onboarding-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function confirmLanguages(languages: string[]): Step {
  return (_pane, done) => done({ languages, confirmed: true });
}

/** Select the first preset model (whisper-1) from the model picker. */
function selectFirstPreset(): Step {
  return (pane) => {
    assert.ok(pane instanceof SingleSelectPicker);
    pane.handleInput("\r");
  };
}

test("first-run setup saves settings and finishes at Try it", async (t) => {
  isolatedSettings(t);
  const script = scriptedContext([
    (pane) => {
      assert.ok(pane instanceof LanguagePicker);
      pane.handleInput("\t"); // Continue with the default languages.
    },
    selectFirstPreset(),
    (pane, done) => {
      assert.ok(pane instanceof TryItPane);
      done({ action: "done" });
    },
  ]);
  const configured = await runOnboarding(script.ctx, "ctrl+alt+z");
  script.assertFinished();
  assert.ok(configured);
  assert.equal(configured.model, "whisper-1");
  assert.equal(configured.shortcut, "ctrl+alt+z");
  assert.equal(configured.transcriptionLanguage, "auto");
  assert.ok(configured.preferredLanguages.length >= 1);
  assert.deepEqual((await readSettings()).settings, configured);
});

test("Escape from languages exits without configuring anything", async (t) => {
  isolatedSettings(t);
  const script = scriptedContext([
    (_pane, done) => done(undefined),
  ]);
  assert.equal(await runOnboarding(script.ctx, "ctrl+alt+z"), undefined);
  script.assertFinished();
  assert.equal((await readSettings()).settings, undefined);
});

test("Escape from the model step returns to languages, not Try it", async (t) => {
  isolatedSettings(t);
  const script = scriptedContext([
    confirmLanguages(["en"]),
    (pane, done) => {
      assert.ok(pane instanceof SingleSelectPicker);
      done(undefined); // Esc from the model picker.
    },
    (_pane, done) => done(undefined), // Back at languages; exit.
  ]);
  assert.equal(await runOnboarding(script.ctx, "ctrl+alt+z"), undefined);
  script.assertFinished();
  assert.equal((await readSettings()).settings, undefined);
});

test("a missing API key warns once but does not block setup", async (t) => {
  isolatedSettings(t);
  const previousKey = process.env.PI_VOICE_ASR_API_KEY;
  const previousOpenAi = process.env.OPENAI_API_KEY;
  delete process.env.PI_VOICE_ASR_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (previousKey !== undefined) process.env.PI_VOICE_ASR_API_KEY = previousKey;
    if (previousOpenAi !== undefined) process.env.OPENAI_API_KEY = previousOpenAi;
  });
  const notifications: string[] = [];
  const script = scriptedContext([
    confirmLanguages(["en"]),
    selectFirstPreset(),
    (_pane, done) => done({ action: "skip" }),
  ], notifications);
  const configured = await runOnboarding(script.ctx, "ctrl+alt+z");
  script.assertFinished();
  assert.ok(configured);
  assert.equal(notifications.filter((message) => message.includes("PI_VOICE_ASR_API_KEY")).length, 1);
});

test("runModelSelection persists a changed model on the current settings", async (t) => {
  isolatedSettings(t);
  const current = createSettings({ shortcut: "ctrl+alt+z", model: "whisper-1" });
  await writeSettings(current);
  const script = scriptedContext([
    (pane) => {
      assert.ok(pane instanceof SingleSelectPicker);
      pane.handleInput("\x1b[B"); // gpt-4o-transcribe
      pane.handleInput("\r");
    },
  ]);
  const updated = await runModelSelection(script.ctx, current);
  script.assertFinished();
  assert.ok(updated);
  assert.equal(updated.model, "gpt-4o-transcribe");
  assert.equal(updated.shortcut, current.shortcut);
  assert.deepEqual((await readSettings()).settings, updated);
});

test("runModelSelection leaves settings untouched when nothing changes", async (t) => {
  isolatedSettings(t);
  const current = createSettings({ shortcut: "ctrl+alt+z", model: "whisper-1" });
  await writeSettings(current);
  const script = scriptedContext([
    (pane, done) => {
      assert.ok(pane instanceof SingleSelectPicker);
      done(undefined);
    },
  ]);
  assert.equal(await runModelSelection(script.ctx, current), undefined);
  script.assertFinished();
  assert.deepEqual((await readSettings()).settings, current);
});

test("a version 1 settings file migrates to the remote backend", async (t) => {
  const directory = isolatedSettings(t);
  writeFileSync(
    join(directory, "pi-voice.json"),
    JSON.stringify({
      version: 1,
      backend: { type: "transcribe-cpp" },
      shortcut: "ctrl+alt+z",
      preferredLanguages: ["zh", "en"],
      transcriptionLanguage: "zh",
      chineseOutput: "traditional-taiwan",
      microphone: { type: "device", name: "Test microphone", occurrence: 1 },
      voiceActivityDetection: true,
      longformChunking: false,
      model: { source: "catalog", id: "some-model", path: "/tmp/model.gguf" },
    }),
    "utf8",
  );
  const { settings } = await readSettings();
  assert.ok(settings);
  assert.equal(settings.version, 2);
  assert.equal(settings.backend.type, "openai-asr");
  assert.equal(settings.model, "whisper-1");
  assert.equal(settings.shortcut, "ctrl+alt+z");
  assert.deepEqual(settings.preferredLanguages, ["zh", "en"]);
  assert.equal(settings.chineseOutput, "traditional-taiwan");
  assert.deepEqual(settings.microphone, { type: "device", name: "Test microphone", occurrence: 1 });
  assert.equal(settings.transcriptionLanguage, "zh");
});

test("an unrecognizable settings file warns instead of migrating", async (t) => {
  const directory = isolatedSettings(t);
  writeFileSync(join(directory, "pi-voice.json"), "{not json", "utf8");
  const result = await readSettings();
  assert.equal(result.settings, undefined);
  assert.match(result.warning ?? "", /Could not read/);
});
