import { VOICE_CHUNK_BYTES, VOICE_MAX_AUDIO_BYTES, type VoiceOperation, type VoiceTarget } from "@openremotecode/protocol";
import { VoiceError, type VoiceEngine, type VoiceStream } from "./hex-engine.js";

interface Session {
  target: VoiceTarget; controller: AbortController; stream?: VoiceStream;
  sequence: number; bytes: number; pending: boolean; touched: number; checked: number; started: number;
  closing?: Promise<void>;
}

/** One bounded audio stream, owned by one authenticated peer and connection epoch. */
export class VoiceSessions {
  #session: Session | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #probe: { controller: AbortController; result: Promise<boolean> } | undefined;
  constructor(readonly engine: VoiceEngine,
    readonly authorize: (target: VoiceTarget, signal: AbortSignal) => Promise<void>, readonly now = Date.now) {}

  async execute(operation: VoiceOperation, body: Record<string, unknown>): Promise<unknown> {
    if (operation === "voice.status") {
      if (!this.#probe) {
        const controller = new AbortController();
        const probe = { controller, result: Promise.resolve().then(() => this.engine.available(controller.signal)) };
        this.#probe = probe;
        void probe.result.finally(() => { if (this.#probe === probe) this.#probe = undefined; }).catch(() => {});
      }
      return { version: 1, available: await this.#probe.result };
    }
    const id = String(body.voiceId);
    if (operation === "voice.cancel") {
      const item = this.#session;
      if (item?.target.voiceId === id) await this.#remove(item);
      return { version: 1, voiceId: id, cancelled: true };
    }
    if (operation === "voice.start") {
      if (this.#session) throw new VoiceError("voice_busy");
      const item: Session = { target: body as VoiceTarget, controller: new AbortController(), sequence: 0,
        bytes: 0, pending: true, touched: this.now(), checked: this.now(), started: this.now() };
      this.#session = item; // Reserve before discovery or authorization can yield.
      this.#timer = setInterval(() => { void this.#check(item); }, 2000);
      this.#timer.unref();
      try {
        await this.authorize(item.target, item.controller.signal);
        item.controller.signal.throwIfAborted();
        item.stream = await this.engine.start(item.controller.signal);
        item.controller.signal.throwIfAborted();
        item.pending = false;
        return { version: 1, voiceId: id, sampleRate: 16000, sampleFormat: "s16le",
          maxChunkBytes: VOICE_CHUNK_BYTES, maxDurationMs: 60000 };
      } catch (error) { item.pending = false; await this.#remove(item); throw error; }
    }
    const item = this.#session;
    if (item?.target.voiceId !== id || item.controller.signal.aborted || !item.stream) {
      throw new VoiceError("voice_expired");
    }
    if (item.pending) throw new VoiceError("voice_busy");
    item.pending = true;
    item.touched = this.now();
    try {
      if (operation === "voice.audio") {
        const audio = Buffer.from(String(body.audio), "base64url");
        if (body.sequence !== item.sequence || item.bytes + audio.length > VOICE_MAX_AUDIO_BYTES) {
          throw new VoiceError("voice_expired");
        }
        item.bytes += audio.length;
        item.sequence++;
        await item.stream.append(audio, item.controller.signal);
        item.controller.signal.throwIfAborted();
        return { version: 1, voiceId: id, sequence: body.sequence };
      }
      await this.authorize(item.target, item.controller.signal);
      const text = await item.stream.finish(item.controller.signal);
      await this.authorize(item.target, item.controller.signal);
      item.controller.signal.throwIfAborted();
      await this.#remove(item);
      return { version: 1, voiceId: id, text };
    } catch (error) { await this.#remove(item); throw error; }
    finally { item.pending = false; }
  }

  async #check(item: Session): Promise<void> {
    if (this.#session !== item || item.controller.signal.aborted) return;
    if (this.now() - item.started > 90000 || (!item.pending && this.now() - item.touched > 7000)) {
      await this.#remove(item); return;
    }
    // Idle streams also lose access when a local folder approval is revoked.
    if (this.now() - item.checked < 2000) return;
    item.checked = this.now() + 10000;
    try {
      await this.authorize(item.target, AbortSignal.any([item.controller.signal, AbortSignal.timeout(5000)]));
      item.checked = this.now();
    } catch { await this.#remove(item); }
  }
  async #remove(item: Session): Promise<void> {
    item.controller.abort();
    if (item.pending && !item.stream) return; // Startup still owns its reservation.
    if (item.closing) return item.closing;
    // Keep the reservation until cleanup finishes; an old cancellation cannot erase a new stream.
    return item.closing = (async () => {
      try { await item.stream?.cancel(); }
      finally {
        if (this.#session === item) {
          this.#session = undefined;
          clearInterval(this.#timer);
          this.#timer = undefined;
        }
      }
    })();
  }
  dispose(): void {
    this.#probe?.controller.abort();
    this.#probe = undefined;
    if (this.#session) void this.#remove(this.#session);
  }
}
