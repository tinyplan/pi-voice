import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { describeError, log, logStep, sinceKeyPress } from "./log.js";
import type { MicrophoneSetting, TranscribeSettings } from "./settings.js";
import type { TranscriptionService } from "./transcription-service.js";

/** What a recording captured. `interruption` is why it ended early, if it did. */
export type CapturedAudio = { pcm: Float32Array; interruption?: Error; droppedFrames?: number };
/** A running recording. `stop` ends it and releases the device. */
export type Capture = { stop(): Promise<CapturedAudio> };
/** Where a recording delivers audio, in order, until its `stop` resolves. */
export type CaptureSinks = {
  onAudio(chunk: Float32Array): void;
  onFailure(error: Error): void;
};
/** Opens a microphone and starts recording; resolves once audio is flowing. */
export type OpenCapture = (microphone: MicrophoneSetting, sinks: CaptureSinks) => Promise<Capture>;
export type DictationResult = {
  text: string;
  speechSeconds: number;
  transcribeSeconds: number;
  /** The microphone failed mid-recording; `text` covers the audio before it. */
  interruption?: Error;
  /** Audio lost inside the recording because it wasn't read in time. */
  droppedFrames?: number;
};
export type DictationState =
  | { phase: "idle" | "ready" | "starting" | "listening" | "transcribing" | "cancelling" | "disposed" }
  | { phase: "result"; result: DictationResult }
  | { phase: "error"; stage: "capture" | "transcription"; cause: unknown };
export type DictationControllerOptions = {
  openCapture: OpenCapture;
  now?: () => number;
  onChange?: (state: DictationState) => void;
  onAudio?: (chunk: Float32Array) => void;
};
type Take = {
  settings: TranscribeSettings;
  abort: AbortController;
  capture?: Capture;
  interruption?: Error;
  stopping?: Promise<CapturedAudio>;
  submission?: Promise<DictationResult | undefined>;
};

/** Owns one capture/transcription lifecycle, never the injected service itself. */
export class DictationController {
  private current: DictationState = { phase: "idle" };
  private take: Take | undefined;
  private disposed = false;
  private cleanup: Promise<void> = Promise.resolve();
  private starting: Promise<void> | undefined;
  /** Bumped by cancel, so a start still opening the microphone knows it lost. */
  private generation = 0;
  private opening = false;
  private startedAt = 0;
  private readonly now: () => number;

  constructor(
    private readonly service: Pick<TranscriptionService, "transcribe">,
    private readonly options: DictationControllerOptions,
  ) {
    this.now = options.now ?? (() => performance.now());
  }

  get state(): DictationState { return this.current; }
  get elapsedMs(): number { return Math.max(0, this.now() - this.startedAt); }
  /** Set when the microphone failed during the current recording. */
  get interruption(): Error | undefined { return this.take?.interruption; }

  private notify(): void {
    if (this.disposed) return;
    // Presentation must not strand the recording or drop recorded audio.
    try { this.options.onChange?.(this.current); } catch { /* UI owns rendering errors. */ }
  }
  private setState(state: DictationState): void {
    if (this.disposed) return;
    this.current = state;
    if (state.phase === "error") {
      log.error(`${state.stage} failed: ${describeError(state.cause)}`);
      logStep("idle");
    }
    this.notify();
  }

  /**
   * Starts recording. The microphone is opened first so its latency is never
   * hidden behind other work; audio accumulates in the recorder itself until
   * the take is submitted at stop.
   */
  start(settings: TranscribeSettings): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.current.phase === "starting") return this.starting ?? Promise.resolve();
    if (["listening", "transcribing", "cancelling"].includes(this.current.phase)) return Promise.resolve();
    this.take = undefined;
    const generation = this.generation;
    this.opening = true;
    this.setState({ phase: "starting" });
    // Callbacks stay live from open through the whole recording: early audio
    // and failures belong to the recorder, which keeps the samples itself.
    const live = () => !this.disposed && this.generation === generation;
    const work = this.cleanup.then(async () => {
      if (!live()) return;
      const openedAt = this.now();
      logStep("opening microphone");
      let earlyFailure: Error | undefined;
      let capture: Capture;
      try {
        capture = await this.options.openCapture(settings.microphone, {
          onAudio: (chunk) => {
            if (!live()) return;
            try { this.options.onAudio?.(chunk); } catch { /* Audio is already recorded. */ }
          },
          onFailure: (error) => {
            if (!live()) return;
            if (this.take) this.take.interruption = error;
            else earlyFailure = error;
            this.notify();
          },
        });
      } catch (cause) {
        if (!live()) return; // Cancelled meanwhile; cancel() stopped the device.
        this.setState({ phase: "error", stage: "capture", cause });
        return;
      }
      if (!live() || this.take !== undefined) {
        // Cancelled or disposed while opening (cancel() waits on this stop);
        // a second start cannot reach here while this one is opening.
        log.debug(`microphone opened in ${Math.round(this.now() - openedAt)} ms, then released`);
        await capture.stop().then(() => undefined, () => undefined);
        return;
      }
      const take: Take = { settings, abort: new AbortController() };
      take.interruption = earlyFailure;
      take.capture = capture;
      this.take = take;
      this.startedAt = this.now();
      const sincePress = sinceKeyPress();
      const press = sincePress === undefined ? "" : `, ${Math.round(sincePress)} ms after the key press`;
      log.info(`listening: microphone opened in ${Math.round(this.now() - openedAt)} ms${press}`);
      logStep("listening");
      this.setState({ phase: "listening" });
    }).finally(() => {
      if (this.generation === generation) this.opening = false;
    });
    this.starting = work;
    return work;
  }

  private stopCapture(take: Take): Promise<CapturedAudio> {
    if (take.stopping) return take.stopping;
    const capture = take.capture;
    take.capture = undefined;
    if (!capture) return Promise.resolve({ pcm: new Float32Array() });
    // Normalize synchronous failures too; native implementations normally reject.
    try { take.stopping = capture.stop(); }
    catch (error) { take.stopping = Promise.reject(error); }
    return take.stopping;
  }

  stop(): Promise<DictationResult | undefined> {
    const take = this.take;
    if (!take || this.disposed) return Promise.resolve(undefined);
    if (take.submission) return take.submission;
    if (this.current.phase !== "listening") return Promise.resolve(undefined);
    const stoppedAt = this.now();
    logStep("stopping microphone");
    this.setState({ phase: "transcribing" });
    let stage: "capture" | "transcription" = "capture";
    take.submission = this.stopCapture(take).then(async (captured) => {
      // Cancellation while the native microphone is stopping must never submit.
      if (this.take !== take || take.abort.signal.aborted) return undefined;
      const recorded = captured.pcm;
      const interruption = captured.interruption ?? take.interruption;
      if (interruption && recorded.length === 0) throw interruption;
      let text: string;
      if (recorded.length === 0) {
        text = ""; // Nothing was captured; skip the request entirely.
      } else {
        stage = "transcription";
        logStep("transcribing", `${(recorded.length / CAPTURE_SAMPLE_RATE).toFixed(1)} s of audio`);
        ({ text } = await this.service.transcribe(take.settings, recorded, take.abort.signal));
      }
      if (this.disposed || this.take !== take || take.abort.signal.aborted) return undefined;
      const result = {
        text,
        speechSeconds: recorded.length / CAPTURE_SAMPLE_RATE,
        transcribeSeconds: Math.max(0, (this.now() - stoppedAt) / 1000),
        ...(interruption ? { interruption } : {}),
        ...(captured.droppedFrames ? { droppedFrames: captured.droppedFrames } : {}),
      };
      this.take = undefined;
      log.info(text
        ? `transcribed ${(recorded.length / CAPTURE_SAMPLE_RATE).toFixed(1)} s of audio in ${result.transcribeSeconds.toFixed(1)} s`
        : "no speech detected");
      logStep("idle");
      this.setState({ phase: "result", result });
      return result;
    }).catch((cause: unknown) => {
      if (this.disposed || this.take !== take || take.abort.signal.aborted) return undefined;
      this.take = undefined;
      this.setState({ phase: "error", stage, cause });
      return undefined;
    });
    return take.submission;
  }

  /** Cancel is serialized with capture teardown, so retries never overlap devices. */
  cancel(): Promise<void> {
    const take = this.take;
    this.take = undefined; // Invalidate callbacks before touching native resources.
    this.generation++;
    const opening = this.opening;
    this.opening = false;
    if (!take && !opening) return this.cleanup;
    if (take) take.abort.abort();
    if (opening) log.info("start cancelled");
    else if (take?.submission) log.info("transcription cancelled");
    else if (take?.capture) log.info("recording discarded");
    logStep("idle");
    if (!this.disposed) this.setState({ phase: "cancelling" });
    const cleanup = Promise.all([
      this.cleanup,
      take && this.stopCapture(take).catch(() => undefined),
      take?.submission,
      this.starting,
    ]).then(() => {
      if (this.cleanup === cleanup) this.setState({ phase: "idle" });
    });
    this.cleanup = cleanup;
    return cleanup;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.current = { phase: "disposed" };
    return this.cancel();
  }
}
