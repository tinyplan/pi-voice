import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPTURE_SAMPLE_RATE } from "../src/audio-constants.js";
import type { AsrTranscribeOptions } from "../src/asr-client.js";
import { createSettings } from "../src/settings.js";
import {
  chunkCuts,
  joinTranscripts,
  maxRequestSeconds,
  quietCutNear,
  TranscriptionService,
} from "../src/transcription-service.js";
import { Deferred } from "./helpers.js";
import { nextTurn } from "./helpers.js";

const settings = createSettings({ shortcut: "ctrl+alt+z", model: "whisper-1" });

function fakeClient() {
  const calls: { pcm: Float32Array; options: AsrTranscribeOptions; result: Deferred<string> }[] = [];
  const client = {
    // Like fetch, an aborted signal rejects the in-flight request.
    async transcribe(pcm: Float32Array, options: AsrTranscribeOptions): Promise<string> {
      const result = new Deferred<string>();
      const onAbort = (): void =>
        result.reject(options.signal?.reason ?? new Error("aborted"));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      calls.push({ pcm, options, result });
      return result.promise.finally(() =>
        options.signal?.removeEventListener("abort", onAbort));
    },
  };
  return { calls, client };
}

test("short audio is one request carrying the model and language settings", async () => {
  const { calls, client } = fakeClient();
  const service = new TranscriptionService(client);
  const chinese = createSettings({
    shortcut: "ctrl+alt+z",
    model: "whisper-1",
    preferredLanguages: ["zh"],
    transcriptionLanguage: "zh",
    chineseOutput: "simplified",
  });
  const promise = service.transcribe(chinese, Float32Array.of(0.1));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options.model, "whisper-1");
  assert.equal(calls[0]!.options.language, "zh");
  assert.equal(calls[0]!.options.chineseEnabled, true);
  assert.equal(calls[0]!.options.chineseOutput, "simplified");
  calls[0]!.result.resolve("你好");
  assert.deepEqual(await promise, { text: "你好" });
  await service.shutdown();
});

test("auto language is sent as an absent language", async () => {
  const { calls, client } = fakeClient();
  const service = new TranscriptionService(client);
  const promise = service.transcribe(settings, Float32Array.of(0.1));
  assert.equal(calls[0]!.options.language, undefined);
  calls[0]!.result.resolve("hi");
  assert.deepEqual(await promise, { text: "hi" });
  await service.shutdown();
});

test("long audio is cut at quiet points and joined", async () => {
  const { calls, client } = fakeClient();
  const service = new TranscriptionService(client);
  // 25 minutes: quiet everywhere except a loud tail forcing a hard cut later.
  const samples = 25 * 60 * CAPTURE_SAMPLE_RATE;
  const pcm = new Float32Array(samples);
  pcm.fill(0.5, samples - CAPTURE_SAMPLE_RATE * 30);
  const cuts = chunkCuts(pcm);
  assert.ok(cuts.length > 1, "the clip spans several requests");
  const promise = service.transcribe(settings, pcm);
  const texts: string[] = [];
  for (let index = 0; index < cuts.length; index += 1) {
    await nextTurn();
    assert.ok(calls.length === index + 1, `request ${index + 1} of ${cuts.length} was sent`);
    const expected = index === 0 ? 0 : cuts[index - 1]!;
    assert.equal(calls[index]!.pcm.length, cuts[index]! - expected);
    texts.push(`part ${index + 1}`);
    calls[index]!.result.resolve(texts[index]!);
  }
  assert.deepEqual(await promise, { text: texts.join(" ") });
  await service.shutdown();
});

test("chunk cuts never exceed the request cap and prefer silence", () => {
  const max = 10 * CAPTURE_SAMPLE_RATE;
  const pcm = new Float32Array(25 * CAPTURE_SAMPLE_RATE);
  // Loud speech, one quiet second around the eight-minute mark.
  pcm.fill(0.8);
  pcm.fill(0, 8 * CAPTURE_SAMPLE_RATE, 9 * CAPTURE_SAMPLE_RATE);
  const cuts = chunkCuts(pcm, max, CAPTURE_SAMPLE_RATE);
  assert.deepEqual(cuts.at(-1)!, pcm.length);
  for (let index = 0; index < cuts.length; index += 1) {
    const start = index === 0 ? 0 : cuts[index - 1]!;
    const length = cuts[index]! - start;
    assert.ok(length <= max, `chunk ${index} is ${length / CAPTURE_SAMPLE_RATE}s`);
  }
  // The first cut lands inside the quiet second rather than the hard cap.
  const quietStart = 8 * CAPTURE_SAMPLE_RATE;
  assert.ok(
    cuts[0]! > quietStart && cuts[0]! <= 9 * CAPTURE_SAMPLE_RATE,
    `first cut at ${(cuts[0]! / CAPTURE_SAMPLE_RATE).toFixed(1)}s`,
  );
});

test("quietCutNear returns the end of the quietest window", () => {
  const pcm = new Float32Array(20 * CAPTURE_SAMPLE_RATE);
  pcm.fill(0.9);
  const quietStart = 10 * CAPTURE_SAMPLE_RATE;
  pcm.fill(0, quietStart, quietStart + CAPTURE_SAMPLE_RATE / 2);
  const cut = quietCutNear(pcm, 11 * CAPTURE_SAMPLE_RATE, CAPTURE_SAMPLE_RATE);
  assert.ok(cut >= quietStart && cut <= quietStart + CAPTURE_SAMPLE_RATE / 2);
});

test("the per-request cap reads PI_VOICE_ASR_MAX_SECONDS with clamps", () => {
  const env = (value?: string) => (value === undefined ? {} : { PI_VOICE_ASR_MAX_SECONDS: value });
  assert.equal(maxRequestSeconds(env()), 600);
  assert.equal(maxRequestSeconds(env("120")), 120);
  assert.equal(maxRequestSeconds(env(" 90 ")), 90);
  assert.equal(maxRequestSeconds(env("abc")), 600);
  assert.equal(maxRequestSeconds(env("5")), 10, "clamped up to the minimum");
  assert.equal(maxRequestSeconds(env("99999")), 3600, "clamped down to the limit");
});

test("the request cap follows PI_VOICE_ASR_MAX_SECONDS for long audio", async (t) => {
  const previous = process.env.PI_VOICE_ASR_MAX_SECONDS;
  process.env.PI_VOICE_ASR_MAX_SECONDS = "120";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_VOICE_ASR_MAX_SECONDS;
    else process.env.PI_VOICE_ASR_MAX_SECONDS = previous;
  });
  const { calls, client } = fakeClient();
  const service = new TranscriptionService(client);
  // Five minutes at a two-minute cap: at least three requests, none over the cap.
  const pcm = new Float32Array(5 * 60 * CAPTURE_SAMPLE_RATE);
  const cuts = chunkCuts(pcm, 120 * CAPTURE_SAMPLE_RATE);
  assert.ok(cuts.length >= 3);
  const promise = service.transcribe(settings, pcm);
  for (let index = 0; index < cuts.length; index += 1) {
    await nextTurn();
    assert.ok(calls.length === index + 1);
    assert.ok(calls[index]!.pcm.length <= 120 * CAPTURE_SAMPLE_RATE);
    calls[index]!.result.resolve(`part ${index + 1}`);
  }
  assert.deepEqual(await promise, {
    text: Array.from({ length: cuts.length }, (_, index) => `part ${index + 1}`).join(" "),
  });
  await service.shutdown();
});

test("joined transcripts space unspaced scripts and drop empties", () => {
  assert.equal(joinTranscripts(["Hello", "world"]), "Hello world");
  assert.equal(joinTranscripts(["你好", "世界"]), "你好世界");
  assert.equal(joinTranscripts(["Hello", "世界"]), "Hello世界");
  assert.equal(joinTranscripts(["你好", "world"]), "你好world");
  assert.equal(joinTranscripts(["", "Hello", ""]), "Hello");
  assert.equal(joinTranscripts(["  spaced  ", "out  "]), "spaced out");
});

test("shutdown rejects new work and aborts an in-flight request", async () => {
  const { calls, client } = fakeClient();
  const service = new TranscriptionService(client);
  const pcm = Float32Array.of(0.2);
  const promise = service.transcribe(settings, pcm);
  assert.equal(promise instanceof Promise, true);
  await service.shutdown();
  assert.equal(calls[0]!.options.signal?.aborted, true);
  calls[0]!.result.resolve("too late");
  await assert.rejects(promise, /Pi Voice is shutting down/);
  await assert.rejects(service.transcribe(settings, pcm), /Pi Voice is shutting down/);
});

test("a caller's abort signal reaches the request", async () => {
  const { calls, client } = fakeClient();
  const service = new TranscriptionService(client);
  const abort = new AbortController();
  const promise = service.transcribe(settings, Float32Array.of(0.1), abort.signal);
  abort.abort(new Error("user cancelled"));
  await assert.rejects(promise, /user cancelled/);
  assert.equal(calls[0]!.options.signal?.aborted, true);
  await service.shutdown();
});
