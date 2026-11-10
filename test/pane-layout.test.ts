import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { VoiceKeys } from "../src/keybindings.js";
import {
  createTranscriptionLanguagePicker,
  LanguagePicker,
} from "../src/language-picker.js";
import { createSettings } from "../src/settings.js";
import { TryItPane } from "../src/try-it.js";
import { SingleSelectPicker, TextInputPrompt } from "../src/ui-components.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");
const DOWN = "\x1b[B";
const settings = createSettings({ shortcut: "ctrl+alt+z", model: "whisper-1" });

type TestPane = Component & {
  handleInput?: (data: string) => void;
  dispose?: () => unknown;
};

test("editor-mounted panes respect the shared 80x24 row and width budget", async () => {
  const makeTui = () => testTui(24);
  const pendingTranscribe = () => new Promise<{ text: string }>(() => {});
  const pendingService = { transcribe: pendingTranscribe };
  const choices = Array.from({ length: 30 }, (_, index) => ({
    value: `choice-${index}`,
    label: `Choice ${index}`,
    description: `Description for choice ${index}`,
  }));

  const factories: [string, () => TestPane][] = [
    ["languages", () => new LanguagePicker(
      makeTui(), testTheme(), keybindings(), ["en"], "back", () => {},
    )],
    ["transcription language", () => createTranscriptionLanguagePicker(
      makeTui(),
      testTheme(),
      keybindings(),
      "auto",
      ["en", "zh"],
      () => {},
    )],
    ["single select", () => new SingleSelectPicker(
      makeTui(), testTheme(), keybindings(), choices, choices[0]!.value,
      { title: "Choose one", searchable: true }, () => {},
    )],
    ["text input", () => new TextInputPrompt(
      makeTui(), testTheme(), keybindings(),
      { title: "Custom model name", subtitle: "The model string your endpoint expects." },
      () => {},
    )],
    ["Try It", () => new TryItPane(
      makeTui(), testTheme(), keybindings(), settings, pendingService, () => {},
    )],
  ];

  for (const [name, factory] of factories) {
    const pane = factory();
    for (let step = 0; step < 40; step += 1) {
      const lines = pane.render(80);
      assert.ok(lines.length <= 22, `${name}: ${lines.length} rows at step ${step}`);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= 80),
        `${name}: line exceeds 80 columns`,
      );
      pane.handleInput?.(DOWN);
    }
    await pane.dispose?.();
  }
});

test("a plain keys instance still routes voice bindings", () => {
  const keys = new VoiceKeys(keybindings());
  assert.equal(keys.matches(" ", "voice.languages.toggle"), true);
  assert.equal(keys.matches("\t", "voice.languages.continue"), true);
});
