import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { AsrClient } from "./asr-client.js";
import { isChineseLanguage } from "./chinese.js";
import { log } from "./log.js";
import type { TranscribeSettings } from "./settings.js";

export type Transcript = { text: string };

export const ASR_MAX_SECONDS_VARIABLE = "PI_VOICE_ASR_MAX_SECONDS";
// WAV at capture rate, mono, 16-bit is 32 kB/s: 600 s stays under the usual
// 25 MB request cap with room for multipart overhead. Local LLM-based models
// with smaller audio context windows can lower it.
export const DEFAULT_MAX_REQUEST_SECONDS = 600;
const MIN_REQUEST_SECONDS = 10;
const MAX_REQUEST_SECONDS_LIMIT = 3600;
// Look for the quietest cut point in the last five seconds before the cap.
const CUT_SEARCH_SECONDS = 5;
const CUT_SEARCH_SAMPLES = CUT_SEARCH_SECONDS * CAPTURE_SAMPLE_RATE;
const CUT_WINDOW_SAMPLES = Math.round((CAPTURE_SAMPLE_RATE * 200) / 1000);

/** The per-request audio cap from PI_VOICE_ASR_MAX_SECONDS, clamped to [10, 3600]. */
export function maxRequestSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ASR_MAX_SECONDS_VARIABLE]?.trim();
  if (!raw) return DEFAULT_MAX_REQUEST_SECONDS;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_MAX_REQUEST_SECONDS;
  return Math.min(
    MAX_REQUEST_SECONDS_LIMIT,
    Math.max(MIN_REQUEST_SECONDS, Math.round(value)),
  );
}

/**
 * One transcription pass over a clip: the model and language settings applied,
 * long audio split into requests the service accepts, and the per-request
 * transcripts joined back together.
 */
export class TranscriptionService {
  private readonly shutdownController = new AbortController();
  private shuttingDown = false;

  constructor(
    private readonly client: Pick<AsrClient, "transcribe"> = new AsrClient(),
  ) {}

  transcribe(
    settings: TranscribeSettings,
    pcm: Float32Array,
    signal?: AbortSignal,
  ): Promise<Transcript> {
    if (this.shuttingDown) {
      return Promise.reject(new Error("Pi Voice is shutting down"));
    }
    return this.run(settings, pcm, signal);
  }

  private async run(
    settings: TranscribeSettings,
    pcm: Float32Array,
    signal?: AbortSignal,
  ): Promise<Transcript> {
    const composed = signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;
    composed.throwIfAborted();

    const cuts = chunkCuts(pcm, maxRequestSeconds() * CAPTURE_SAMPLE_RATE);
    if (cuts.length === 1) {
      const text = await this.client.transcribe(pcm, this.options(settings, composed));
      composed.throwIfAborted();
      return { text };
    }

    const texts: string[] = [];
    for (let index = 0; index < cuts.length; index += 1) {
      const chunk = pcm.subarray(cuts[index - 1] ?? 0, cuts[index]!);
      texts.push(await this.client.transcribe(chunk, this.options(settings, composed)));
      composed.throwIfAborted();
    }
    log.info(
      `transcribed ${(pcm.length / CAPTURE_SAMPLE_RATE).toFixed(1)} s of audio in ${cuts.length} requests`,
    );
    return { text: joinTranscripts(texts) };
  }

  private options(settings: TranscribeSettings, signal: AbortSignal) {
    return {
      model: settings.model,
      language: settings.transcriptionLanguage === "auto"
        ? undefined
        : settings.transcriptionLanguage,
      chineseOutput: settings.chineseOutput,
      chineseEnabled: isChineseLanguage(settings.transcriptionLanguage) ||
        settings.preferredLanguages.some(isChineseLanguage),
      signal,
    };
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.shutdownController.abort(new Error("Pi Voice is shutting down"));
  }
}

/**
 * Chunk ends, in samples, the last being the clip's length: audio up to the
 * request cap stays whole, longer audio is cut at its quietest points.
 */
export function chunkCuts(
  pcm: Float32Array,
  maxSamples: number = DEFAULT_MAX_REQUEST_SECONDS * CAPTURE_SAMPLE_RATE,
  searchSamples: number = CUT_SEARCH_SAMPLES,
): number[] {
  const cuts: number[] = [];
  let start = 0;
  while (pcm.length - start > maxSamples) {
    const limit = start + maxSamples;
    const cut = Math.max(start + 1, quietCutNear(pcm, limit, searchSamples));
    cuts.push(cut);
    start = cut;
  }
  cuts.push(pcm.length);
  return cuts;
}

/** The end of the quietest 200 ms window at or before `limit`, within `radius`. */
export function quietCutNear(
  pcm: Float32Array,
  limit: number,
  radius: number,
): number {
  const first = Math.max(0, limit - radius - CUT_WINDOW_SAMPLES);
  const last = Math.min(limit, pcm.length) - CUT_WINDOW_SAMPLES;
  let best = limit;
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let start = first; start <= last; start += CUT_WINDOW_SAMPLES) {
    let energy = 0;
    for (let index = start; index < start + CUT_WINDOW_SAMPLES; index += 1) {
      const sample = pcm[index]!;
      energy += sample * sample;
    }
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = start + CUT_WINDOW_SAMPLES;
    }
  }
  return best;
}

// Scripts written without spaces between words, and CJK punctuation.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\u3000-\u303f\uff00-\uffef]/u;

/** Chunk texts in order: a space between two chunks unless either side is unspaced script. */
export function joinTranscripts(texts: readonly string[]): string {
  let joined = "";
  // Whole code points: astral Han (CJK Extension B+) is a surrogate pair.
  let last: string | undefined;
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;
    if (last !== undefined && !UNSPACED.test(last) && !UNSPACED.test(String.fromCodePoint(text.codePointAt(0)!))) {
      joined += " ";
    }
    joined += text;
    last = Array.from(text).at(-1);
  }
  return joined;
}
