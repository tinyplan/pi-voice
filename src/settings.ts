import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { defaultShortcut } from "./default-shortcut.js";
import { languageIdentity } from "./languages.js";
import { normalizeShortcut } from "./shortcut-core.js";
import { legacySettingsPath, settingsPath } from "./settings-path.js";

const SETTINGS_VERSION = 2;

export type MicrophoneSetting =
  | { type: "system-default" }
  | { type: "device"; name: string; occurrence: number };

export const DEFAULT_MICROPHONE: MicrophoneSetting = { type: "system-default" };

export type ChineseOutput = "simplified" | "traditional-taiwan" | "traditional-hong-kong";

function defaultChineseOutput(): ChineseOutput {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const subtags = locale.toLowerCase().split("-");
  if (subtags.includes("hk") || subtags.includes("mo")) return "traditional-hong-kong";
  if (subtags.includes("tw") || subtags.includes("hant")) return "traditional-taiwan";
  return "simplified";
}

/** "auto" asks the service to detect the language; otherwise an ISO language code. */
export type TranscriptionLanguage = string;

/** The model name sent to the transcription API. */
export const DEFAULT_MODEL = "whisper-1";

export type TranscribeSettings = {
  version: 2;
  backend: { type: "openai-asr" };
  shortcut: string;
  preferredLanguages: string[];
  transcriptionLanguage: TranscriptionLanguage;
  chineseOutput: ChineseOutput;
  microphone: MicrophoneSetting;
  model: string;
};

type SettingsReadResult = {
  settings?: TranscribeSettings;
  warning?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLanguages(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((language) => typeof language === "string")) {
    return undefined;
  }
  const languages = [...new Set(value.map(languageIdentity).filter(Boolean))];
  return languages.length > 0 ? languages : undefined;
}

function validateChineseOutput(value: unknown): ChineseOutput {
  return value === "simplified" ||
    value === "traditional-taiwan" ||
    value === "traditional-hong-kong"
    ? value
    : defaultChineseOutput();
}

function validateMicrophone(value: unknown): MicrophoneSetting | undefined {
  if (!isObject(value)) return undefined;
  if (value.type === "system-default") return { type: "system-default" };
  if (
    value.type !== "device" ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    !Number.isInteger(value.occurrence) ||
    (value.occurrence as number) < 0
  ) {
    return undefined;
  }
  return { type: "device", name: value.name, occurrence: value.occurrence as number };
}

function validateSettings(value: unknown): TranscribeSettings | undefined {
  if (!isObject(value) || value.version !== SETTINGS_VERSION) return undefined;
  if (!isObject(value.backend) || value.backend.type !== "openai-asr") return undefined;
  const shortcut =
    typeof value.shortcut === "string" ? normalizeShortcut(value.shortcut) : undefined;
  if (!shortcut) return undefined;
  if (typeof value.model !== "string" || !value.model.trim()) return undefined;
  const preferredLanguages = normalizeLanguages(value.preferredLanguages);
  const microphone = validateMicrophone(value.microphone);
  if (!preferredLanguages || !microphone) return undefined;
  if (typeof value.transcriptionLanguage !== "string" || !value.transcriptionLanguage.trim()) {
    return undefined;
  }

  return {
    version: SETTINGS_VERSION,
    backend: { type: "openai-asr" },
    shortcut,
    preferredLanguages,
    transcriptionLanguage: value.transcriptionLanguage.trim().toLowerCase(),
    chineseOutput: validateChineseOutput(value.chineseOutput),
    microphone,
    model: value.model.trim(),
  };
}

/** Portable fields of a local-model settings file, for the remote rewrite. */
function migrateLocalSettings(value: unknown): Partial<TranscribeSettings> | undefined {
  if (!isObject(value) || value.version !== 1) return undefined;
  const preferredLanguages = normalizeLanguages(value.preferredLanguages);
  const microphone = validateMicrophone(value.microphone);
  const chineseOutput =
    typeof value.chineseOutput === "string" ? validateChineseOutput(value.chineseOutput) : undefined;
  const transcriptionLanguage = typeof value.transcriptionLanguage === "string" && value.transcriptionLanguage.trim()
    ? value.transcriptionLanguage.trim().toLowerCase()
    : undefined;
  return {
    ...(preferredLanguages ? { preferredLanguages } : {}),
    ...(microphone ? { microphone } : {}),
    ...(chineseOutput ? { chineseOutput } : {}),
    ...(transcriptionLanguage ? { transcriptionLanguage } : {}),
  };
}

async function readSettingsFile(path: string): Promise<SettingsReadResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return {
      warning: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const settings = validateSettings(parsed);
  if (settings) return { settings };

  // Pi Voice 0.2 and earlier ran local models. Carry over what still applies
  // and finish setup with the remote backend's defaults.
  const migrated = migrateLocalSettings(parsed);
  if (migrated) {
    const shortcut = isObject(parsed) && typeof parsed.shortcut === "string"
      ? normalizeShortcut(parsed.shortcut)
      : undefined;
    return { settings: createSettings({ shortcut: shortcut ?? defaultShortcut(), ...migrated }) };
  }
  return { warning: `Invalid settings in ${path}; configuration is required.` };
}

export async function readSettings(): Promise<SettingsReadResult> {
  const currentPath = settingsPath();
  const current = await readSettingsFile(currentPath);
  if (current.settings || current.warning) return current;

  const legacyPath = legacySettingsPath();
  const legacy = await readSettingsFile(legacyPath);
  if (!legacy.settings) return legacy;

  try {
    await writeSettings(legacy.settings);
    await unlink(legacyPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return { settings: legacy.settings };
  } catch (error) {
    return {
      settings: legacy.settings,
      warning: `Loaded legacy settings from ${legacyPath}, but could not migrate them to ${currentPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function writeSettings(settings: TranscribeSettings): Promise<void> {
  const path = settingsPath();
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(settings, null, 2)}\n`;

  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

type CreateSettingsOptions = {
  shortcut: string;
  preferredLanguages?: readonly string[];
  model?: string;
  transcriptionLanguage?: TranscriptionLanguage;
  chineseOutput?: ChineseOutput;
  microphone?: MicrophoneSetting;
};

export function createSettings(options: CreateSettingsOptions): TranscribeSettings {
  const preferredLanguages = [
    ...new Set((options.preferredLanguages ?? ["en"]).map(languageIdentity)),
  ].filter(Boolean);
  return {
    version: SETTINGS_VERSION,
    backend: { type: "openai-asr" },
    shortcut: options.shortcut,
    preferredLanguages,
    transcriptionLanguage: options.transcriptionLanguage === undefined
      ? "auto"
      : options.transcriptionLanguage.trim().toLowerCase(),
    chineseOutput: options.chineseOutput ?? defaultChineseOutput(),
    microphone: { ...(options.microphone ?? DEFAULT_MICROPHONE) },
    model: options.model ?? DEFAULT_MODEL,
  };
}

export function settingsWithPreferredLanguages(
  current: TranscribeSettings,
  preferredLanguages: readonly string[],
): TranscribeSettings {
  return {
    ...current,
    preferredLanguages: [...new Set(preferredLanguages.map(languageIdentity))].filter(Boolean),
  };
}
