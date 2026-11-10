import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  AsrClient,
  AsrError,
  asrApiKey,
  asrBaseUrl,
  customAsrBaseUrl,
  hasAsrCredentials,
  pcmToWav,
} from "../src/asr-client.js";

type CapturedRequest = { url: string; init: RequestInit };

function jsonOk(text: string): Response {
  return new Response(JSON.stringify({ text }), { status: 200 });
}

/** Installs a key and base URL for one test, restoring the environment after. */
function withEnv(t: TestContext, env: Record<string, string | undefined>) {
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("the key prefers the dedicated variable over the OpenAI one", (t) => {
  withEnv(t, { PI_VOICE_ASR_API_KEY: " dedicated ", OPENAI_API_KEY: "compatible" });
  assert.equal(asrApiKey(), "dedicated");
  withEnv(t, { PI_VOICE_ASR_API_KEY: undefined, OPENAI_API_KEY: "compatible" });
  assert.equal(asrApiKey(), "compatible");
  withEnv(t, { PI_VOICE_ASR_API_KEY: undefined, OPENAI_API_KEY: undefined });
  assert.equal(asrApiKey(), undefined);
});

test("the base URL defaults to OpenAI and trims trailing slashes", (t) => {
  withEnv(t, { PI_VOICE_ASR_BASE_URL: undefined });
  assert.equal(asrBaseUrl(), "https://api.openai.com/v1");
  assert.equal(customAsrBaseUrl(), undefined);
  withEnv(t, { PI_VOICE_ASR_BASE_URL: "http://localhost:9000/v1///" });
  assert.equal(asrBaseUrl(), "http://localhost:9000/v1");
  assert.equal(customAsrBaseUrl(), "http://localhost:9000/v1");
});

test("credentials mean a key or a custom endpoint", (t) => {
  withEnv(t, { PI_VOICE_ASR_API_KEY: undefined, OPENAI_API_KEY: undefined, PI_VOICE_ASR_BASE_URL: undefined });
  assert.equal(hasAsrCredentials(), false);
  withEnv(t, { PI_VOICE_ASR_API_KEY: undefined, PI_VOICE_ASR_BASE_URL: "http://localhost:9000/v1" });
  assert.equal(hasAsrCredentials(), true);
  withEnv(t, { PI_VOICE_ASR_API_KEY: "sk-test", PI_VOICE_ASR_BASE_URL: undefined });
  assert.equal(hasAsrCredentials(), true);
});

test("PCM becomes a 16 kHz mono 16-bit WAV", () => {
  const wav = pcmToWav(Float32Array.of(0, 0.5, -0.5, 1, -1, 2));
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...wav.subarray(offset, offset + length));
  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), 36 + 12);
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getInt16(44, true), 0);
  // 0.5 scales to a quarter of the positive range; 2 clips to the maximum.
  assert.equal(view.getInt16(46, true), Math.round(0.5 * 0x7fff));
  assert.equal(view.getInt16(48, true), Math.round(-0.5 * 0x8000));
  assert.equal(view.getInt16(50, true), 0x7fff);
  assert.equal(view.getInt16(52, true), -0x8000);
});

test("a transcription request carries auth, model, language, and audio", async (t) => {
  withEnv(t, { PI_VOICE_ASR_API_KEY: "sk-test", PI_VOICE_ASR_BASE_URL: "http://localhost:9000/v1" });
  const requests: CapturedRequest[] = [];
  const client = new AsrClient({
    fetch: async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return jsonOk("  Hello there  ");
    },
  });

  const text = await client.transcribe(Float32Array.of(0.1), {
    model: "whisper-1",
    language: "en",
  });
  assert.equal(text, "Hello there");

  const request = requests[0]!;
  assert.equal(request.url, "http://localhost:9000/v1/audio/transcriptions");
  assert.equal(request.init.method, "POST");
  assert.equal((request.init.headers as Record<string, string>).Authorization, "Bearer sk-test");
  const form = request.init.body as FormData;
  assert.equal(form.get("model"), "whisper-1");
  assert.equal(form.get("language"), "en");
  assert.equal(form.get("response_format"), "json");
  const file = form.get("file") as File;
  assert.equal(file.type, "audio/wav");
  assert.equal(file.name, "dictation.wav");
  assert.equal(file.size, 44 + 2);
});

test("an absent language means auto-detection, not an empty parameter", async (t) => {
  withEnv(t, { PI_VOICE_ASR_API_KEY: "sk-test" });
  const requests: CapturedRequest[] = [];
  const client = new AsrClient({
    fetch: async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return jsonOk("auto");
    },
  });
  await client.transcribe(Float32Array.of(0.1), { model: "whisper-1" });
  const form = requests[0]!.init.body as FormData;
  assert.equal(form.has("language"), false);
});

test("a plain-text body is accepted as the transcript", async (t) => {
  withEnv(t, { PI_VOICE_ASR_API_KEY: "sk-test" });
  const client = new AsrClient({ fetch: async () => new Response("plain words", { status: 200 }) });
  assert.equal(await client.transcribe(Float32Array.of(0.1), { model: "whisper-1" }), "plain words");
});

test("llama.cpp Qwen3-ASR template artifacts are stripped", async (t) => {
  withEnv(t, { PI_VOICE_ASR_API_KEY: "sk-test" });
  const respond = (text: string) =>
    new AsrClient({ fetch: async () => jsonOk(text) });
  assert.equal(
    await respond("language English<asr_text>Uh huh. Oh yeah.").transcribe(
      Float32Array.of(0.1), { model: "Qwen3-ASR-1.7B" },
    ),
    "Uh huh. Oh yeah.",
  );
  // Silence echoes the server's default instruction: reads as no speech.
  assert.equal(
    await respond("language Chinese<asr_text>Transcribe audio to text.").transcribe(
      Float32Array.of(0.1), { model: "Qwen3-ASR-1.7B" },
    ),
    "",
  );
  // The strip must not touch transcripts that merely contain the marker words.
  assert.equal(
    await respond("Please transcribe audio to text for me").transcribe(
      Float32Array.of(0.1), { model: "Qwen3-ASR-1.7B" },
    ),
    "Please transcribe audio to text for me",
  );
});

test("Chinese transcripts convert script after the strip", async (t) => {
  withEnv(t, { PI_VOICE_ASR_API_KEY: "sk-test" });
  const client = new AsrClient({ fetch: async () => jsonOk("language Chinese<asr_text>學校圖書館") });
  assert.equal(
    await client.transcribe(Float32Array.of(0.1), {
      model: "Qwen3-ASR-1.7B",
      chineseEnabled: true,
      chineseOutput: "simplified",
    }),
    "学校图书馆",
  );
});

for (const [status, body, pattern] of [
  [401, JSON.stringify({ error: { message: "Incorrect API key provided" } }), /HTTP 401.*Incorrect API key provided.*PI_VOICE_ASR_API_KEY/],
  [429, "rate limited", /HTTP 429.*rate-limiting/],
] as const) {
  test(`HTTP ${status} maps to an AsrError with guidance`, async (t) => {
    withEnv(t, { PI_VOICE_ASR_API_KEY: "sk-test" });
    const client = new AsrClient({
      fetch: async () => new Response(body, { status, statusText: "Too Many Requests" }),
    });
    const error = await client.transcribe(Float32Array.of(0.1), { model: "whisper-1" })
      .catch((caught: unknown) => caught);
    assert.ok(error instanceof AsrError);
    assert.equal(error.status, status);
    assert.match(error.message, pattern);
  });
}

test("a JSON response without a text field is an error", async (t) => {
  withEnv(t, { PI_VOICE_ASR_API_KEY: "sk-test" });
  const client = new AsrClient({
    fetch: async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
  });
  await assert.rejects(
    client.transcribe(Float32Array.of(0.1), { model: "whisper-1" }),
    /no text field/,
  );
});

test("a missing key or empty clip fails before any request", async (t) => {
  withEnv(t, {
    PI_VOICE_ASR_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    PI_VOICE_ASR_BASE_URL: undefined,
  });
  const client = new AsrClient({ fetch: async () => assert.fail("no request expected") });
  await assert.rejects(
    client.transcribe(Float32Array.of(0.1), { model: "whisper-1" }),
    /PI_VOICE_ASR_API_KEY/,
  );
  withEnv(t, { PI_VOICE_ASR_API_KEY: "sk-test" });
  await assert.rejects(
    client.transcribe(new Float32Array(0), { model: "whisper-1" }),
    /No audio samples/,
  );
  await assert.rejects(
    client.transcribe(Float32Array.of(0.1), { model: "  " }),
    /No transcription model/,
  );
});

test("a custom endpoint runs without a key and sends no auth header", async (t) => {
  withEnv(t, {
    PI_VOICE_ASR_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    PI_VOICE_ASR_BASE_URL: "http://localhost:9000/v1",
  });
  const requests: CapturedRequest[] = [];
  const client = new AsrClient({
    fetch: async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return jsonOk("local result");
    },
  });
  const text = await client.transcribe(Float32Array.of(0.1), { model: "qwen3-asr" });
  assert.equal(text, "local result");
  assert.equal(requests[0]!.url, "http://localhost:9000/v1/audio/transcriptions");
  assert.equal((requests[0]!.init.headers as Record<string, string> | undefined)?.Authorization, undefined);
  const form = requests[0]!.init.body as FormData;
  assert.equal(form.get("model"), "qwen3-asr");
});

test("a custom endpoint still sends the auth header when a key is set", async (t) => {
  withEnv(t, { PI_VOICE_ASR_API_KEY: "sk-local", PI_VOICE_ASR_BASE_URL: "http://localhost:9000/v1" });
  const requests: CapturedRequest[] = [];
  const client = new AsrClient({
    fetch: async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return jsonOk("ok");
    },
  });
  await client.transcribe(Float32Array.of(0.1), { model: "whisper-1" });
  assert.equal((requests[0]!.init.headers as Record<string, string>).Authorization, "Bearer sk-local");
});

test("network failures name the endpoint", async (t) => {
  withEnv(t, { PI_VOICE_ASR_API_KEY: "sk-test", PI_VOICE_ASR_BASE_URL: "http://localhost:9/v1" });
  const client = new AsrClient({
    fetch: async () => { throw new TypeError("fetch failed"); },
  });
  await assert.rejects(
    client.transcribe(Float32Array.of(0.1), { model: "whisper-1" }),
    /Could not reach http:\/\/localhost:9\/v1\/audio\/transcriptions: fetch failed/,
  );
});

test("a caller's abort propagates", async (t) => {
  withEnv(t, { PI_VOICE_ASR_API_KEY: "sk-test" });
  const abort = new AbortController();
  const client = new AsrClient({
    fetch: async (_input, init) => {
      abort.abort(new Error("user cancelled"));
      init?.signal?.throwIfAborted();
      throw new Error("unreachable");
    },
  });
  await assert.rejects(
    client.transcribe(Float32Array.of(0.1), { model: "whisper-1", signal: abort.signal }),
    /user cancelled/,
  );
});
