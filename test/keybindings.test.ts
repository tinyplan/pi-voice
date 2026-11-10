import assert from "node:assert/strict";
import { test } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { VoiceKeys } from "../src/keybindings.js";
import { keybindings } from "./ui-helpers.js";

const ctrl = (letter: string) => String.fromCharCode(letter.charCodeAt(0) - 96);
const matchesVoiceKeybinding = (data: string, id: Parameters<VoiceKeys["matches"]>[1]) =>
  new VoiceKeys(keybindings()).matches(data, id);

test("letter shortcuts accept either case and Kitty reports, never control keys", () => {
  const ESC = String.fromCharCode(0x1b);
  for (const data of ["c", "C", `${ESC}[99u`, `${ESC}[99;2u`]) {
    assert.equal(matchesVoiceKeybinding(data, "voice.tryIt.model"), true, JSON.stringify(data));
  }
  for (const data of [ctrl("c"), "cc", `${ESC}[99;5u`]) {
    assert.equal(matchesVoiceKeybinding(data, "voice.tryIt.model"), false);
  }
});

test("VoiceKeys routes pi ids to the injected manager and local ids to the table", () => {
  const keys = new VoiceKeys(keybindings());
  assert.equal(keys.matches("\x1b[B", "tui.select.down"), true);
  assert.equal(keys.matches(" ", "voice.languages.toggle"), true);
  assert.equal(keys.matches("\t", "voice.languages.continue"), true);
  assert.equal(keys.matches("s", "voice.tryIt.shortcut"), true);
  assert.equal(keys.matches("m", "voice.tryIt.microphone"), true);
  assert.equal(keys.matches("\x1b", "voice.dictation.cancel"), true);
  assert.equal(keys.matches(" ", "voice.dictation.stop"), true);
});

test("key hints list the bound keys for one or more ids", () => {
  const keys = new VoiceKeys(keybindings());
  assert.equal(keys.keyText("voice.tryIt.model"), "c");
  assert.match(keys.keyText(["tui.select.up", "tui.select.down"]), /up.*down|down.*up/);
});

test("user bindings still override the local table", () => {
  const host = new KeybindingsManager(TUI_KEYBINDINGS, {
    "voice.tryIt.model": "x",
  });
  const keys = new VoiceKeys(host);
  assert.equal(keys.matches("x", "voice.tryIt.model"), true);
  assert.equal(keys.matches("c", "voice.tryIt.model"), false);
});
