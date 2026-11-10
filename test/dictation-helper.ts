import { Deferred } from "./helpers.js";
import type { Capture, CapturedAudio, CaptureSinks, OpenCapture } from "../src/dictation-controller.js";
import type { TranscribeSettings } from "../src/settings.js";
import type { Transcript } from "../src/transcription-service.js";

/** One recording on a FakeMicrophone. */
export class FakeCapture implements Capture {
  stops = 0;
  stopError: Error | undefined;
  stopGate: Deferred<CapturedAudio> | undefined;
  pcm = new Float32Array(16000);
  constructor(private readonly sinks: CaptureSinks) {}
  feed(chunk: Float32Array): void { this.sinks.onAudio(chunk); }
  fail(error: Error): void { this.sinks.onFailure(error); }
  stop(): Promise<CapturedAudio> {
    this.stops++;
    if (this.stopError) return Promise.reject(this.stopError);
    return this.stopGate?.promise ?? Promise.resolve({ pcm: this.pcm });
  }
}

export class FakeMicrophone {
  readonly captures: FakeCapture[] = [];
  opens = 0;
  openError: Error | undefined;
  openGate: Deferred<void> | undefined;
  readonly open: OpenCapture = async (_microphone, sinks) => {
    this.opens++;
    await this.openGate?.promise;
    if (this.openError) throw this.openError;
    const capture = new FakeCapture(sinks);
    this.captures.push(capture);
    return capture;
  };
}

/** A transcription service stand-in that records submits and settles them by hand. */
export class FakeTranscriptionService {
  readonly calls: {
    settings: TranscribeSettings;
    pcm: Float32Array;
    signal: AbortSignal | undefined;
    result: Deferred<Transcript>;
  }[] = [];

  transcribe(settings: TranscribeSettings, pcm: Float32Array, signal?: AbortSignal): Promise<Transcript> {
    const result = new Deferred<Transcript>();
    this.calls.push({ settings, pcm, signal, result });
    return result.promise;
  }

  get pending() {
    return this.calls.at(-1);
  }
}
