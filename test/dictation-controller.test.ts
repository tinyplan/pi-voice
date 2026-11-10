import { test } from "node:test";
import assert from "node:assert/strict";
import { DictationController, type DictationState } from "../src/dictation-controller.js";
import { Deferred } from "./helpers.js";
import { createSettings } from "../src/settings.js";
import { FakeMicrophone, FakeTranscriptionService } from "./dictation-helper.js";
import { nextTurn } from "./helpers.js";

const settings = createSettings({ shortcut: "ctrl+alt+z", model: "whisper-1" });

function harness() {
  const service = new FakeTranscriptionService();
  const mic = new FakeMicrophone();
  const states: DictationState[] = [];
  let now = 0;
  const controller = new DictationController(service, {
    openCapture: mic.open,
    now: () => now,
    onChange: (state) => states.push(state),
  });
  return { controller, service, mic, captures: mic.captures, states, time: (value: number) => { now = value; } };
}

test("recording, submission and timing have one lifecycle", async () => {
  const h = harness();
  await h.controller.start(settings);
  assert.equal(h.captures.length, 1);
  assert.equal(h.controller.state.phase, "listening");
  h.time(60000); // Wall-clock recording time must not be reported as PCM duration.
  const submission = h.controller.stop();
  assert.equal(h.controller.stop(), submission);
  await nextTurn();
  const call = h.service.calls[0]!;
  assert.equal(call.pcm, h.captures[0]!.pcm);
  assert.equal(call.settings, settings);
  h.time(61500);
  call.result.resolve({ text: "hello" });
  assert.deepEqual(await submission, { text: "hello", speechSeconds: 1, transcribeSeconds: 1.5 });
  assert.equal(h.captures[0]!.stops, 1);
  assert.equal(h.controller.state.phase, "result");
  await h.controller.dispose();
});

test("duplicate starts cannot open two microphones", async () => {
  const h = harness();
  await Promise.all([h.controller.start(settings), h.controller.start(settings)]);
  assert.equal(h.captures.length, 1);
  await h.controller.dispose();
});

test("capture audio flows to the meter while the recorder keeps the samples", async () => {
  const h = harness();
  const seen: Float32Array[] = [];
  const controller = new DictationController(h.service, {
    openCapture: h.mic.open,
    onAudio: (chunk) => seen.push(chunk),
  });
  await controller.start(settings);
  h.captures[0]!.feed(new Float32Array(512));
  assert.deepEqual(seen.map((chunk) => chunk.length), [512]);
  await controller.dispose();
});

test("capture cancellation waits for native teardown", async () => {
  const h = harness();
  await h.controller.start(settings);
  const capture = h.captures[0]!;
  capture.stopGate = new Deferred();
  const cancelling = h.controller.cancel();
  assert.equal(h.controller.state.phase, "cancelling");
  await h.controller.start(settings);
  assert.equal(h.captures.length, 1);
  capture.stopGate.resolve({ pcm: capture.pcm });
  await cancelling;
  assert.equal(h.controller.state.phase, "idle");
  await h.controller.start(settings);
  assert.equal(h.captures.length, 2);
  assert.equal(h.service.calls.length, 0);
  await h.controller.dispose();
});

test("cancelling while stop is pending never submits the discarded recording", async () => {
  const h = harness();
  await h.controller.start(settings);
  h.captures[0]!.stopGate = new Deferred();
  const submission = h.controller.stop();
  const cancelling = h.controller.cancel();
  h.captures[0]!.stopGate.resolve({ pcm: new Float32Array(16000) });
  assert.equal(await submission, undefined);
  await cancelling;
  assert.equal(h.service.calls.length, 0);
  assert.equal(h.captures[0]!.stops, 1);
  await h.controller.dispose();
});

test("a cancelled transcription cannot publish a late successful result", async () => {
  const h = harness();
  await h.controller.start(settings);
  const submission = h.controller.stop();
  await nextTurn();
  const call = h.service.calls[0]!;
  const cancelling = h.controller.cancel();
  assert.equal(call.signal?.aborted, true);
  call.result.resolve({ text: "late text" });
  assert.equal(await submission, undefined);
  await cancelling;
  assert.equal(h.states.some((state) => state.phase === "result"), false);
  await h.controller.dispose();
});

test("a transcription failure is reported at the transcription stage and is retryable", async () => {
  const h = harness();
  await h.controller.start(settings);
  const submission = h.controller.stop();
  await nextTurn();
  h.service.calls[0]!.result.reject(new Error("HTTP 500"));
  assert.equal(await submission, undefined);
  assert.deepEqual(
    h.controller.state,
    { phase: "error", stage: "transcription", cause: new Error("HTTP 500") },
  );
  await h.controller.start(settings);
  assert.equal(h.controller.state.phase, "listening");
  await h.controller.dispose();
});

for (const failure of ["start", "stop"] as const) {
  test(`microphone ${failure} failure allows retry`, async () => {
    const h = harness();
    if (failure === "start") h.mic.openError = new Error("permission denied");
    await h.controller.start(settings);
    if (failure === "stop") {
      h.captures[0]!.stopError = new Error("device disconnected");
      await h.controller.stop();
    }
    assert.equal(h.controller.state.phase, "error");
    assert.deepEqual(h.controller.state, {
      phase: "error",
      stage: "capture",
      cause: failure === "start" ? new Error("permission denied") : new Error("device disconnected"),
    });
    h.mic.openError = undefined;
    await h.controller.start(settings);
    assert.equal(h.controller.state.phase, "listening");
    await h.controller.dispose();
  });
}

test("disposal is idempotent and silences pending capture callbacks", async () => {
  const h = harness();
  await h.controller.start(settings);
  await Promise.all([h.controller.dispose(), h.controller.dispose()]);
  const before = h.states.length;
  h.captures[0]!.feed(new Float32Array(8000));
  await h.controller.start(settings);
  await nextTurn();
  assert.equal(h.controller.state.phase, "disposed");
  assert.equal(h.states.length, before);
  assert.equal(h.captures[0]!.stops, 1);
});

test("disposal before microphone startup never opens a device", async () => {
  const h = harness();
  const starting = h.controller.start(settings);
  await h.controller.dispose();
  await starting;
  assert.equal(h.mic.opens, 0);
});

test("display failures do not interrupt submission or cleanup", async () => {
  const service = new FakeTranscriptionService();
  const mic = new FakeMicrophone();
  const controller = new DictationController(service, {
    openCapture: mic.open,
    onChange: () => { throw new Error("render failed"); },
    onAudio: () => { throw new Error("meter failed"); },
  });
  await controller.start(settings);
  mic.captures[0]!.feed(new Float32Array(8000));
  const submission = controller.stop();
  await nextTurn();
  service.calls[0]!.result.resolve({ text: "still works" });
  assert.equal((await submission)?.text, "still works");
  await controller.dispose();
});

for (const teardown of ["cancel", "dispose"] as const) {
  test(`${teardown} while the microphone opens releases it and never submits`, async () => {
    const h = harness();
    h.mic.openGate = new Deferred();
    const starting = h.controller.start(settings);
    await nextTurn();
    assert.equal(h.mic.opens, 1);
    const tearingDown = teardown === "cancel" ? h.controller.cancel() : h.controller.dispose();
    let settled = false;
    void tearingDown.then(() => { settled = true; });
    await nextTurn();
    assert.equal(settled, false, "teardown must wait for the opening device");
    h.mic.openGate.resolve();
    await Promise.all([starting, tearingDown]);
    assert.equal(h.captures[0]!.stops, 1);
    assert.equal(h.controller.state.phase, teardown === "cancel" ? "idle" : "disposed");
    await h.controller.dispose();
  });
}

test("a microphone failure keeps the audio before it and reports the interruption", async () => {
  const h = harness();
  await h.controller.start(settings);
  const capture = h.captures[0]!;
  const lost = new Error("device lost");
  const paints = h.states.length;
  capture.fail(lost);
  assert.equal(h.controller.interruption, lost);
  assert.equal(h.states.length, paints + 1);
  assert.equal(h.controller.state.phase, "listening");
  capture.stopGate = new Deferred();
  const submission = h.controller.stop();
  capture.stopGate.resolve({ pcm: new Float32Array(8000), interruption: lost });
  await nextTurn();
  h.service.calls[0]!.result.resolve({ text: "partial" });
  assert.deepEqual(await submission, { text: "partial", speechSeconds: 0.5, transcribeSeconds: 0, interruption: lost });
  await h.controller.dispose();
});

test("a microphone that fails before capturing anything is a capture error", async () => {
  const h = harness();
  await h.controller.start(settings);
  const capture = h.captures[0]!;
  const lost = new Error("device lost");
  capture.stopGate = new Deferred();
  const submission = h.controller.stop();
  capture.stopGate.resolve({ pcm: new Float32Array(), interruption: lost });
  assert.equal(await submission, undefined);
  assert.deepEqual(h.controller.state, { phase: "error", stage: "capture", cause: lost });
  assert.equal(h.service.calls.length, 0);
  await h.controller.dispose();
});

test("an empty recording reports no speech without a request", async () => {
  const h = harness();
  await h.controller.start(settings);
  h.captures[0]!.pcm = new Float32Array(0);
  const result = await h.controller.stop();
  assert.deepEqual(result, { text: "", speechSeconds: 0, transcribeSeconds: 0 });
  assert.equal(h.service.calls.length, 0);
  await h.controller.dispose();
});

test("a start while a previous recording is stopping is refused", async () => {
  const h = harness();
  await h.controller.start(settings);
  h.captures[0]!.stopGate = new Deferred();
  const submission = h.controller.stop();
  await h.controller.start(settings);
  assert.equal(h.captures.length, 1, "no second microphone while transcribing");
  h.captures[0]!.stopGate.resolve({ pcm: h.captures[0]!.pcm });
  await nextTurn();
  h.service.calls[0]!.result.resolve({ text: "done" });
  assert.equal((await submission)?.text, "done");
  await h.controller.dispose();
});
