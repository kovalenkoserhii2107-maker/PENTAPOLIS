/**
 * Spatial 3D Audio & Generative Music (Sprint 8, GDD §8.1: "calm urban jazz/ambient on the wide
 * shot, positional 3D sounds as the camera nears the streets").
 *
 * Everything is synthesised with the Web Audio API — no sound files:
 * - music: a slow lo-fi jazz loop (ii–V–I–VI with 9ths/13ths, walking bass, brushed hats);
 * - emitters: traffic hum, furnace rumble, crane clanks, two-tone sirens and gulls, each an HRTF
 *   panner placed at its map position; the listener sits at the camera target.
 * Zooming out favours the music, zooming in brings the city up. It plays through the UI sound
 * engine's context and master gain, so one mute/volume control governs all sound.
 */

export type SoundKind = "traffic" | "furnace" | "crane" | "siren" | "gulls";

export interface SoundSource {
  readonly id: string;
  readonly kind: SoundKind;
  readonly x: number;
  readonly z: number;
  /** 0..1 loudness at the source. */
  readonly intensity: number;
}

export interface AudioListenerState {
  readonly x: number;
  readonly z: number;
  /** Camera zoom (0.55 overview .. 14 street level). */
  readonly zoom: number;
}

interface Emitter {
  readonly kind: SoundKind;
  readonly panner: PannerNode;
  readonly gain: GainNode;
  readonly stop: () => void;
}

const MAX_EMITTERS = 10;
const BASE_GAIN: Readonly<Record<SoundKind, number>> = { traffic: 0.35, furnace: 0.45, crane: 0.5, siren: 0.22, gulls: 0.3 };

/** Dm9 – G13 – Cmaj9 – A7♭9 (MIDI notes), the city's late-evening loop. */
const CHORDS: readonly (readonly number[])[] = [
  [50, 53, 57, 60, 64],
  [43, 53, 57, 59, 64],
  [48, 52, 55, 59, 62],
  [45, 49, 55, 58, 61],
];
const BASS_WALK: readonly (readonly number[])[] = [
  [38, 41, 45, 43],
  [31, 35, 38, 40],
  [36, 40, 43, 44],
  [33, 37, 40, 39],
];
const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private noise!: AudioBuffer;
  private readonly emitters = new Map<string, Emitter>();
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private nextBeatTime = 0;
  private beat = 0;
  private enabled = false;

  /** Mounts on a shared output (the UI sound engine's context and master gain). */
  public start(output: { ctx: AudioContext; destination: AudioNode }): void {
    if (!this.ctx) {
      this.ctx = output.ctx;
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0;
      const comp = ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(output.destination);
      this.musicBus = ctx.createGain();
      this.sfxBus = ctx.createGain();
      this.musicBus.connect(this.master);
      this.sfxBus.connect(this.master);
      this.noise = this.makeNoise(ctx, 2);
      ctx.listener.positionY.value = 30;
    }
    this.enabled = true;
    this.master.gain.setTargetAtTime(0.8, this.ctx.currentTime, 0.4);
    this.startMusic();
  }

  public stop(): void {
    if (!this.ctx) return;
    this.enabled = false;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
    for (const e of this.emitters.values()) e.stop();
    this.emitters.clear();
  }

  public get isRunning(): boolean {
    return this.enabled;
  }

  /** Repositions the listener, mixes music vs city by zoom and keeps the nearest emitters alive. */
  public update(listener: AudioListenerState, sources: readonly SoundSource[]): void {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    const L = ctx.listener;
    L.positionX.setTargetAtTime(listener.x, t, 0.1);
    L.positionZ.setTargetAtTime(listener.z, t, 0.1);
    // The 2:1 isometric camera looks from +x+z towards the target
    L.forwardX.value = -0.7071;
    L.forwardY.value = -0.5;
    L.forwardZ.value = -0.7071;
    L.upX.value = 0;
    L.upY.value = 1;
    L.upZ.value = 0;

    const street = Math.max(0, Math.min(1, (listener.zoom - 1) / 6));
    this.musicBus.gain.setTargetAtTime(0.55 - 0.3 * street, t, 0.5);
    this.sfxBus.gain.setTargetAtTime(0.15 + 0.85 * street, t, 0.5);

    const radius = 160 / Math.max(0.5, listener.zoom) + 20;
    const nearest = sources
      .map((s) => ({ s, d: Math.hypot(s.x - listener.x, s.z - listener.z) }))
      .filter((p) => p.d <= radius && p.s.intensity > 0.02)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_EMITTERS);
    const keep = new Set(nearest.map((p) => p.s.id));
    for (const [id, e] of this.emitters) {
      if (!keep.has(id)) {
        e.gain.gain.setTargetAtTime(0, t, 0.3);
        setTimeout(e.stop, 1500);
        this.emitters.delete(id);
      }
    }
    const refDistance = Math.max(4, 40 / Math.max(0.5, listener.zoom));
    for (const { s } of nearest) {
      let e = this.emitters.get(s.id);
      if (!e) {
        e = this.createEmitter(s.kind);
        this.emitters.set(s.id, e);
      }
      e.panner.refDistance = refDistance;
      e.panner.positionX.setTargetAtTime(s.x, t, 0.1);
      e.panner.positionZ.setTargetAtTime(s.z, t, 0.1);
      e.gain.gain.setTargetAtTime(BASE_GAIN[s.kind] * s.intensity, t, 0.4);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Emitters
  // ---------------------------------------------------------------------------------------------

  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.02 * white) / 1.02;
      data[i] = white * 0.4 + brown * 3;
    }
    return buf;
  }

  private createEmitter(kind: SoundKind): Emitter {
    const ctx = this.ctx!;
    const panner = new PannerNode(ctx, {
      panningModel: "HRTF",
      distanceModel: "inverse",
      rolloffFactor: 1.4,
      maxDistance: 2000,
      positionY: 0,
    });
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(panner).connect(this.sfxBus);
    const stops: Array<() => void> = [];
    let alive = true;

    const loopNoise = (type: BiquadFilterType, freq: number, q = 0.7) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.playbackRate.value = 0.8 + Math.random() * 0.4;
      const filter = new BiquadFilterNode(ctx, { type, frequency: freq, Q: q });
      src.connect(filter).connect(gain);
      src.start(ctx.currentTime, Math.random() * 1.5);
      stops.push(() => src.stop());
      return filter;
    };
    const every = (minMs: number, maxMs: number, fn: () => void) => {
      const tick = () => {
        if (!alive) return;
        fn();
        setTimeout(tick, minMs + Math.random() * (maxMs - minMs));
      };
      setTimeout(tick, Math.random() * maxMs);
    };
    const blip = (type: OscillatorType, from: number, to: number, dur: number, peak: number, filterHz = 4000) => {
      const t = ctx.currentTime;
      const osc = new OscillatorNode(ctx, { type, frequency: from });
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(peak, t + 0.01);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: filterHz })).connect(env).connect(gain);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    };

    if (kind === "traffic") {
      loopNoise("lowpass", 420);
      loopNoise("bandpass", 1100, 2);
      every(2500, 7000, () => blip("square", 420, 410, 0.18, 0.08, 1800)); // a horn far away
    } else if (kind === "furnace") {
      const f = loopNoise("lowpass", 140);
      const lfo = new OscillatorNode(ctx, { frequency: 0.3 });
      const depth = ctx.createGain();
      depth.gain.value = 60;
      lfo.connect(depth).connect(f.frequency);
      lfo.start();
      stops.push(() => lfo.stop());
    } else if (kind === "crane") {
      every(1800, 4200, () => {
        blip("triangle", 820, 760, 0.35, 0.5, 3000);
        blip("triangle", 1235, 1190, 0.25, 0.3, 3000);
      });
      loopNoise("highpass", 3000); // site hiss: grinders and compressors
    } else if (kind === "siren") {
      const osc = new OscillatorNode(ctx, { type: "sawtooth", frequency: 650 });
      osc.connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 1600 })).connect(gain);
      osc.start();
      const t0 = ctx.currentTime;
      for (let i = 0; i < 600; i++) osc.frequency.setValueAtTime(i % 2 === 0 ? 650 : 900, t0 + i * 0.5);
      stops.push(() => osc.stop());
    } else if (kind === "gulls") {
      loopNoise("bandpass", 500, 0.4); // surf
      every(2500, 8000, () => {
        blip("sine", 1900, 1100, 0.22, 0.4);
        setTimeout(() => alive && blip("sine", 2100, 1200, 0.18, 0.3), 260);
      });
    }

    return {
      kind,
      panner,
      gain,
      stop: () => {
        alive = false;
        for (const s of stops) {
          try {
            s();
          } catch {
            // already stopped
          }
        }
        gain.disconnect();
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Generative music
  // ---------------------------------------------------------------------------------------------

  private startMusic(): void {
    if (this.schedulerTimer || !this.ctx) return;
    this.nextBeatTime = this.ctx.currentTime + 0.1;
    this.schedulerTimer = setInterval(() => this.scheduleAhead(), 100);
  }

  private scheduleAhead(): void {
    const ctx = this.ctx!;
    const secondsPerBeat = 60 / 72;
    while (this.nextBeatTime < ctx.currentTime + 0.4) {
      const bar = Math.floor(this.beat / 4) % CHORDS.length;
      const beatInBar = this.beat % 4;
      const t = this.nextBeatTime;
      if (beatInBar === 0) this.pad(CHORDS[bar]!, t, secondsPerBeat * 4);
      this.bass(BASS_WALK[bar]![beatInBar]!, t, secondsPerBeat * 0.9);
      this.hat(t + secondsPerBeat * 0.66, 0.05); // swung brush
      if (beatInBar === 1 || beatInBar === 3) this.hat(t, 0.08);
      if (Math.random() < 0.18) {
        const chord = CHORDS[bar]!;
        this.keys(chord[2 + Math.floor(Math.random() * 3)]! + 12, t + secondsPerBeat * 0.5, secondsPerBeat * 1.5);
      }
      this.nextBeatTime += secondsPerBeat;
      this.beat += 1;
    }
  }

  private pad(notes: readonly number[], t: number, dur: number): void {
    const ctx = this.ctx!;
    const filter = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 1200 });
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.06, t + 0.6);
    env.gain.setTargetAtTime(0, t + dur - 0.4, 0.3);
    filter.connect(env).connect(this.musicBus);
    for (const n of notes) {
      for (const detune of [-6, 6]) {
        const osc = new OscillatorNode(ctx, { type: "triangle", frequency: midiHz(n), detune });
        osc.connect(filter);
        osc.start(t);
        osc.stop(t + dur + 0.6);
      }
    }
  }

  private bass(note: number, t: number, dur: number): void {
    const ctx = this.ctx!;
    const osc = new OscillatorNode(ctx, { type: "sine", frequency: midiHz(note) });
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.22, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(env).connect(this.musicBus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private keys(note: number, t: number, dur: number): void {
    const ctx = this.ctx!;
    const osc = new OscillatorNode(ctx, { type: "sine", frequency: midiHz(note) });
    const bell = new OscillatorNode(ctx, { type: "sine", frequency: midiHz(note) * 3 });
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.07, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    const bellGain = ctx.createGain();
    bellGain.gain.value = 0.15;
    osc.connect(env);
    bell.connect(bellGain).connect(env);
    env.connect(this.musicBus);
    osc.start(t);
    bell.start(t);
    osc.stop(t + dur + 0.05);
    bell.stop(t + dur + 0.05);
  }

  private hat(t: number, peak: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const env = ctx.createGain();
    env.gain.setValueAtTime(peak, t);
    env.gain.exponentialRampToValueAtTime(0.0005, t + 0.12);
    src.connect(new BiquadFilterNode(ctx, { type: "highpass", frequency: 6000 })).connect(env).connect(this.musicBus);
    src.start(t, Math.random());
    src.stop(t + 0.15);
  }
}
