"use client";

// Pearl's voice in the browser: Kokoro in a Web Worker, played in order through Web Audio. Until Kokoro has
// loaded (first call downloads ~90 MB, cached afterwards) the browser's built-in voice speaks instead, so the first
// reply never waits on the download.

type Chunk =
  | { kind: "kokoro"; text: string; audio: Promise<{ samples: Float32Array; rate: number } | null> }
  | { kind: "native"; text: string };

export interface TTSCallbacks {
  onSpeakStart?: () => void; // first audio of a burst starts playing
  onIdle?: () => void; // queue drained
  onStatus?: (status: "loading" | "kokoro" | "native", detail?: string) => void;
}

const VOICE = "af_heart";

export class BrowserTTS {
  private worker: Worker | null = null;
  private ready = false;
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private gain: GainNode;
  private levelBuf: Uint8Array<ArrayBuffer>;
  private queue: Chunk[] = [];
  private playing = false;
  private current: AudioBufferSourceNode | null = null;
  private pending = new Map<number, (v: { samples: Float32Array; rate: number } | null) => void>();
  private nextId = 1;
  private generation = 0; // bumped on stop(): stale playback loops bail out
  private nativeSpeaking = false;
  speaking = false;
  /** performance.now() when the current burst of speech became audible. */
  startedAt = 0;

  constructor(private cb: TTSCallbacks = {}) {
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.gain = this.ctx.createGain();
    this.analyser.connect(this.gain);
    this.gain.connect(this.ctx.destination);
    this.levelBuf = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
  }

  /** Start downloading Kokoro (after the microphone is up, so the two downloads don't compete). */
  startKokoro() {
    if (!this.worker) this.loadKokoro();
  }

  /** Must run in a user gesture at least once (browser autoplay rules). */
  async resume() {
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  private loadKokoro() {
    try {
      this.cb.onStatus?.("loading");
      this.worker = new Worker("/kokoro-worker.js", { type: "module" });
      this.worker.onmessage = (e: MessageEvent) => {
        const m = e.data as { type: string; id?: number; samples?: Float32Array; rate?: number; device?: string; message?: string };
        if (m.type === "ready") {
          this.ready = true;
          this.cb.onStatus?.("kokoro", m.device);
        } else if (m.type === "audio" && m.id != null) {
          this.pending.get(m.id)?.({ samples: m.samples!, rate: m.rate! });
          this.pending.delete(m.id);
        } else if (m.type === "error") {
          if (m.id != null) {
            this.pending.get(m.id)?.(null);
            this.pending.delete(m.id);
          } else this.cb.onStatus?.("native", m.message);
        }
      };
      this.worker.onerror = () => this.cb.onStatus?.("native", "worker failed");
      this.worker.postMessage({ type: "load" });
    } catch {
      this.cb.onStatus?.("native", "workers unavailable");
    }
  }

  /** Lower Pearl's volume while the caller might be talking (1 = normal). */
  duck(volume: number) {
    this.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.05);
  }

  /** 0..1 loudness of what Pearl is saying right now (for the orb). */
  level(): number {
    if (this.nativeSpeaking) return 0.25 + 0.15 * Math.sin(performance.now() / 90);
    if (!this.current) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuf);
    let sum = 0;
    for (const v of this.levelBuf) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 4);
  }

  speak(text: string) {
    const t = text.trim();
    if (!t) return;
    if (this.ready && this.worker) {
      const id = this.nextId++;
      const audio = new Promise<{ samples: Float32Array; rate: number } | null>((resolve) => this.pending.set(id, resolve));
      this.worker.postMessage({ type: "speak", id, text: t, voice: VOICE });
      this.queue.push({ kind: "kokoro", text: t, audio });
    } else {
      this.queue.push({ kind: "native", text: t });
    }
    if (!this.playing) void this.playLoop();
  }

  /** Barge-in / hang-up: silence now and drop everything queued. */
  stop() {
    this.generation++;
    this.duck(1);
    this.queue = [];
    try {
      this.current?.stop();
    } catch {
      /* already stopped */
    }
    this.current = null;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.nativeSpeaking = false;
    this.playing = false;
    if (this.speaking) {
      this.speaking = false;
      this.cb.onIdle?.();
    }
  }

  close() {
    this.stop();
    this.worker?.terminate();
    void this.ctx.close();
  }

  private async playLoop() {
    this.playing = true;
    const gen = this.generation;
    while (this.queue.length && gen === this.generation) {
      const chunk = this.queue.shift()!;
      if (chunk.kind === "kokoro") {
        const audio = await chunk.audio;
        if (gen !== this.generation) return;
        if (audio) await this.playSamples(audio.samples, audio.rate, gen);
        else await this.playNative(chunk.text, gen); // synthesis failed: say it anyway
      } else {
        await this.playNative(chunk.text, gen);
      }
    }
    if (gen !== this.generation) return;
    this.playing = false;
    if (this.speaking) {
      this.speaking = false;
      this.cb.onIdle?.();
    }
  }

  private markStart() {
    if (!this.speaking) {
      this.speaking = true;
      this.startedAt = performance.now();
      this.cb.onSpeakStart?.();
    }
  }

  private playSamples(samples: Float32Array, rate: number, gen: number): Promise<void> {
    return new Promise((resolve) => {
      if (gen !== this.generation) return resolve();
      const buffer = this.ctx.createBuffer(1, samples.length, rate);
      buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.analyser);
      src.onended = () => {
        if (this.current === src) this.current = null;
        resolve();
      };
      this.current = src;
      this.markStart();
      src.start();
    });
  }

  private playNative(text: string, gen: number): Promise<void> {
    return new Promise((resolve) => {
      if (gen !== this.generation || typeof speechSynthesis === "undefined") return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      const voice = speechSynthesis.getVoices().find((v) => /en[-_](US|GB|IN)/i.test(v.lang) && /female|samantha|google us/i.test(v.name));
      if (voice) u.voice = voice;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        this.nativeSpeaking = false;
        resolve();
      };
      // Some browsers never fire onend (e.g. no voices installed): don't let the queue hang.
      const guard = setTimeout(finish, 1500 + text.split(/\s+/).length * 450);
      u.onend = u.onerror = finish;
      this.nativeSpeaking = true;
      this.markStart();
      speechSynthesis.speak(u);
    });
  }
}
