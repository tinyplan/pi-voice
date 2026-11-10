import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { convertChineseOutput, shouldConvertChinese } from "./chinese.js";
import type { ChineseOutput } from "./settings.js";

export const ASR_API_KEY_VARIABLE = "PI_VOICE_ASR_API_KEY";
/** Fallback for users who already have the OpenAI key in their environment. */
export const OPENAI_API_KEY_VARIABLE = "OPENAI_API_KEY";
export const ASR_BASE_URL_VARIABLE = "PI_VOICE_ASR_BASE_URL";
export const DEFAULT_ASR_BASE_URL = "https://api.openai.com/v1";

/** Long clips decode slowly server-side too; only long-file chunking should approach this. */
const REQUEST_TIMEOUT_MS = 300_000;

export function asrApiKey(): string | undefined {
  return (
    process.env.PI_VOICE_ASR_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    undefined
  );
}

/** A custom endpoint, without trailing slashes; local servers often need none. */
export function customAsrBaseUrl(): string | undefined {
  return process.env.PI_VOICE_ASR_BASE_URL?.trim().replace(/\/+$/, "") || undefined;
}

export function asrBaseUrl(): string {
  return customAsrBaseUrl() ?? DEFAULT_ASR_BASE_URL;
}

/** Whether transcription can run: an API key, or a custom (often local) endpoint. */
export function hasAsrCredentials(): boolean {
  return asrApiKey() !== undefined || customAsrBaseUrl() !== undefined;
}

export function missingApiKeyMessage(): string {
  return `No transcription API key. Set ${ASR_API_KEY_VARIABLE} (or ${OPENAI_API_KEY_VARIABLE}) in your environment and restart Pi, or point ${ASR_BASE_URL_VARIABLE} at a server that does not need one.`;
}

export function apiKeyStatusMessage(): string {
  const key = asrApiKey();
  const custom = customAsrBaseUrl();
  if (key) return `API key: set (${key.length} characters). Endpoint: ${asrBaseUrl()}.`;
  if (custom) return `No API key. Using the custom endpoint ${custom} without authentication.`;
  return missingApiKeyMessage();
}

export class AsrError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AsrError";
  }
}

/** Mono 16-bit PCM WAV bytes for one channel of capture-rate samples. */
export function pcmToWav(pcm: Float32Array): Uint8Array {
  const dataBytes = pcm.length * 2;
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, CAPTURE_SAMPLE_RATE, true);
  view.setUint32(28, CAPTURE_SAMPLE_RATE * 2, true); // bytes per second
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index]!));
    view.setInt16(44 + index * 2, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
  }
  return wav;
}

export type AsrTranscribeOptions = {
  /** The model name sent to the API, e.g. "whisper-1". */
  model: string;
  /** ISO language code; undefined lets the service detect the language. */
  language?: string;
  chineseOutput?: ChineseOutput;
  /** Chinese is a preferred or chosen language: convert any Chinese text. */
  chineseEnabled?: boolean;
  signal?: AbortSignal;
};

/**
 * Shared final step for transcripts: trim, strip server template artifacts,
 * then apply the Chinese script preference (see shouldConvertChinese).
 */
// llama.cpp serving Qwen3-ASR emits the detected language and an <asr_text>
// marker before the transcript, and on silence echoes its default
// instruction instead of speech.
const QWEN_ASR_PREFIX = /^language\s+\S+?\s*<asr_text>\s*/i;
const QWEN_ASR_INSTRUCTION_ECHO = /^transcribe audio to text\.?$/i;

async function finishTranscript(
  text: string,
  options: AsrTranscribeOptions,
): Promise<string> {
  const stripped = text.trim().replace(QWEN_ASR_PREFIX, "").trim();
  if (QWEN_ASR_INSTRUCTION_ECHO.test(stripped)) return "";
  return shouldConvertChinese(stripped, {
    chineseEnabled: options.chineseEnabled ?? false,
    language: options.language ?? "",
  })
    ? convertChineseOutput(stripped, options.chineseOutput ?? "simplified")
    : stripped;
}

async function httpError(response: Response): Promise<AsrError> {
  const body = await response.text().catch(() => "");
  let detail = body.slice(0, 500);
  try {
    const parsed: unknown = JSON.parse(body);
    const message = (parsed as { error?: { message?: unknown } })?.error?.message;
    if (typeof message === "string") detail = message;
  } catch {
    // Some compatible servers answer with a plain-text body.
  }
  let hint = "";
  if (response.status === 401 || response.status === 403) {
    hint = ` Check ${ASR_API_KEY_VARIABLE}.`;
  } else if (response.status === 429) {
    hint = " The service is rate-limiting requests; try again shortly.";
  } else if (response.status === 413) {
    hint = " The request was too large for the service.";
  }
  const summary = detail ? `: ${detail}` : "";
  return new AsrError(
    `Transcription request failed (HTTP ${response.status} ${response.statusText})${summary}.${hint}`,
    response.status,
  );
}

/** Reads a transcription response: `{ "text": "…" }`, or a plain-text body. */
async function readTranscript(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed: unknown = JSON.parse(body);
    const text = (parsed as { text?: unknown })?.text;
    if (typeof text === "string") return text;
    if (parsed !== null && typeof parsed === "object") {
      throw new AsrError("The transcription response had no text field.");
    }
  } catch (error) {
    if (error instanceof AsrError) throw error;
    // A body that is not JSON is treated as the transcript itself, as some
    // OpenAI-compatible servers ignore response_format.
  }
  return body;
}

export type AsrClientOptions = {
  /** Overridable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/**
 * A client for the OpenAI audio transcription protocol
 * (`POST {base}/audio/transcriptions`), against OpenAI or any compatible
 * server configured with PI_VOICE_ASR_BASE_URL.
 */
export class AsrClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AsrClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async transcribe(pcm: Float32Array, options: AsrTranscribeOptions): Promise<string> {
    const model = options.model.trim();
    if (!model) {
      throw new AsrError("No transcription model is configured. Open /voice-settings and choose a model.");
    }
    if (pcm.length === 0) throw new AsrError("No audio samples were provided");
    // A custom endpoint (typically a local server) may run without auth.
    const key = asrApiKey();
    if (!key && !customAsrBaseUrl()) throw new AsrError(missingApiKeyMessage());

    const form = new FormData();
    form.append("file", new Blob([pcmToWav(pcm)], { type: "audio/wav" }), "dictation.wav");
    form.append("model", model);
    form.append("response_format", "json");
    if (options.language) form.append("language", options.language);

    const url = `${asrBaseUrl()}/audio/transcriptions`;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: key ? { Authorization: `Bearer ${key}` } : undefined,
        body: form,
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : error;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new AsrError(`Transcription request timed out after ${Math.round(this.timeoutMs / 1000)}s`);
      }
      if (error instanceof Error && error.name === "AbortError" && !options.signal?.aborted) {
        throw new AsrError(`Transcription request timed out after ${Math.round(this.timeoutMs / 1000)}s`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new AsrError(`Could not reach ${url}: ${message}`);
    }

    if (!response.ok) throw await httpError(response);
    return finishTranscript(await readTranscript(response), options);
  }
}
