import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasAsrCredentials } from "./asr-client.js";
import { microphonePermission } from "./audio.js";
import { chooseLanguages, defaultSpokenLanguages } from "./language-picker.js";
import { chooseAsrModel } from "./model-picker.js";
import { chooseMicrophone, microphonesEqual } from "./microphone-picker.js";
import { createShortcutPicker } from "./shortcuts.js";
import { tryVoice } from "./try-it.js";
import {
  createSettings,
  writeSettings,
  type TranscribeSettings,
} from "./settings.js";

function requireTui(ctx: ExtensionContext): boolean {
  if (ctx.mode === "tui") return true;
  ctx.ui.notify("Pi Voice configuration requires the interactive TUI", "error");
  return false;
}

/**
 * The Model step, reused from Try it and the settings menu: pick a model name
 * and persist it on the current settings.
 */
export async function runModelSelection(
  ctx: ExtensionContext,
  current: TranscribeSettings,
): Promise<TranscribeSettings | undefined> {
  if (!requireTui(ctx)) return undefined;
  const model = await chooseAsrModel(ctx, current.model);
  if (!model || model === current.model) return undefined;
  const updated = { ...current, model };
  try {
    await writeSettings(updated);
    return updated;
  } catch (error) {
    ctx.ui.notify(
      `Could not save settings: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return undefined;
  }
}

async function chooseOnboardingShortcut(
  ctx: ExtensionContext,
  current: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
    createShortcutPicker(tui, theme, keybindings, current, done),
  );
}

async function saveOnboardingSettings(
  ctx: ExtensionContext,
  settings: TranscribeSettings,
): Promise<boolean> {
  try {
    await writeSettings(settings);
    return true;
  } catch (error) {
    ctx.ui.notify(
      `Could not save settings: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return false;
  }
}

/** The Try it step, with its shortcut, microphone, and model adjustments looping back into it. */
async function finishOnboarding(
  ctx: ExtensionContext,
  initial: TranscribeSettings,
  changeModel: (current: TranscribeSettings) => Promise<TranscribeSettings | undefined>,
): Promise<TranscribeSettings> {
  let configured = initial;
  while (true) {
    const result = await tryVoice(ctx, configured);
    if (result?.action === "model") {
      configured = (await changeModel(configured)) ?? configured;
      continue;
    }
    if (result?.action === "shortcut") {
      const shortcut = await chooseOnboardingShortcut(ctx, configured.shortcut);
      if (!shortcut || shortcut === configured.shortcut) continue;
      const updated = { ...configured, shortcut };
      if (await saveOnboardingSettings(ctx, updated)) configured = updated;
      continue;
    }
    if (result?.action === "microphone") {
      const permission = microphonePermission();
      const microphone = await chooseMicrophone(ctx, configured.microphone, permission);
      if (!microphone || microphonesEqual(microphone, configured.microphone)) continue;
      const updated = { ...configured, microphone };
      if (await saveOnboardingSettings(ctx, updated)) configured = updated;
      continue;
    }
    return configured;
  }
}

/**
 * First-run setup: languages, model name, then a Try it recording. Settings
 * are saved once, before the Try it step, so an exit there still leaves a
 * working configuration behind.
 */
export async function runOnboarding(
  ctx: ExtensionContext,
  shortcut: string,
): Promise<TranscribeSettings | undefined> {
  if (!requireTui(ctx)) return undefined;
  if (!hasAsrCredentials()) {
    ctx.ui.notify(
      "Pi Voice transcribes through a remote API. Set PI_VOICE_ASR_API_KEY (or OPENAI_API_KEY) in your environment before recording, or point PI_VOICE_ASR_BASE_URL at a local server that needs no key.",
      "warning",
    );
  }

  let languages = defaultSpokenLanguages();
  while (true) {
    const chosen = await chooseLanguages(ctx, languages, {
      cancelLabel: "exit",
      onboardingStep: 1,
    });
    if (!chosen?.confirmed) return undefined;
    languages = chosen.languages;

    const model = await chooseAsrModel(ctx, undefined, {
      subtitle: "Pi Voice setup · step 2 of 3 — sent to the transcription endpoint with each recording.",
    });
    // Esc from the model step returns to languages; setup is not complete.
    if (!model) continue;

    const settings = createSettings({ shortcut, preferredLanguages: languages, model });
    if (!await saveOnboardingSettings(ctx, settings)) continue;
    return finishOnboarding(ctx, settings, (current) => runModelSelection(ctx, current));
  }
}
