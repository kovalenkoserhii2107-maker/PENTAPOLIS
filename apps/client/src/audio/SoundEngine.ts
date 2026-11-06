
const STORAGE_MUTED_KEY = "pentapolis_audio_muted";
const STORAGE_VOLUME_KEY = "pentapolis_audio_volume";

/**
 * Pure Procedural Web Audio Synthesizer & Spatial 3D Ambience Engine (Sprint 8).
 *
 * Uses zero external `.mp3` / `.wav` files:
 * - Procedural SFX: UI clicks, asphalt laying, heavy building foundation thud,
 *   cash-register chime (taxes/grants/dividends), and emergency dispatch siren.
 * - Music and positional 3D emitters live in `AudioEngine`, mounted on this engine's output
 *   (`getOutput()`), so one mute/volume control governs all sound.
 */
export class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;


  private muted: boolean;
  private volume: number;

  constructor() {
    let savedMuted = false;
    let savedVol = 0.55;
    try {
      savedMuted = window.localStorage.getItem(STORAGE_MUTED_KEY) === "1";
      const rawVol = Number(window.localStorage.getItem(STORAGE_VOLUME_KEY));
      if (Number.isFinite(rawVol) && rawVol >= 0 && rawVol <= 1) {
        savedVol = rawVol;
      }
    } catch {
      // Ignore storage access errors in private/sandboxed frames
    }
    this.muted = savedMuted;
    this.volume = savedVol;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public getVolume(): number {
    return this.volume;
  }

  public setMuted(next: boolean): void {
    this.muted = next;
    try {
      window.localStorage.setItem(STORAGE_MUTED_KEY, next ? "1" : "0");
    } catch {
      // Ignore
    }
    this.syncMasterGain();
  }

  public setVolume(next: number): void {
    this.volume = Math.max(0, Math.min(1, next));
    try {
      window.localStorage.setItem(STORAGE_VOLUME_KEY, this.volume.toFixed(2));
    } catch {
      // Ignore
    }
    if (this.volume > 0 && this.muted) {
      this.muted = false;
    }
    this.syncMasterGain();
  }

  private ensureContext(): AudioContext | null {
    if (this.muted || typeof window === "undefined") return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : this.volume;
      this.masterGain.connect(this.ctx.destination);
      this.noiseBuffer = this.createNoiseBuffer(this.ctx, 2.0);
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private syncMasterGain(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const target = this.muted ? 0 : this.volume;
    this.masterGain.gain.setTargetAtTime(target, now, 0.04);
  }

  private createNoiseBuffer(ctx: AudioContext, durationSec: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * durationSec);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    // Pink-ish noise for warm natural surf, asphalt, and wind textures
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      data[i] = Math.max(-1, Math.min(1, (b0 + b1 + b2 + white * 0.1848) * 0.22));
    }
    return buffer;
  }

  /** Crisp tactile UI click. */
  public playUiClick(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(410, now + 0.028);

    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.032);
  }

  /** Asphalt / infrastructure segment lay sweep + gravel tamp. */
  public playRoadBuild(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain || !this.noiseBuffer) return;
    const now = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(950, now);
    filter.frequency.exponentialRampToValueAtTime(340, now + 0.12);
    filter.Q.value = 1.6;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.26, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    src.start(now);
    src.stop(now + 0.14);
  }

  /** Heavy foundation thud when placing a building or painting a district. */
  public playBuildingPlace(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(105, now);
    osc.frequency.exponentialRampToValueAtTime(36, now + 0.17);

    gain.gain.setValueAtTime(0.38, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.19);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  /** Bright metallic cash-register chime for quest grants, dividends, and treasury inflows. */
  public playCashRegister(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    const now = ctx.currentTime;

    const notes = [987.77, 1318.51]; // B5 -> E6
    notes.forEach((freq, idx) => {
      const t0 = now + idx * 0.065;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, t0);

      gain.gain.setValueAtTime(0.22, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);

      osc.connect(gain);
      gain.connect(this.masterGain!);
      osc.start(t0);
      osc.stop(t0 + 0.24);
    });
  }

  /** Urgent two-tone European emergency dispatch siren. */
  public playEmergencySiren(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sawtooth";

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1800;

    osc.frequency.setValueAtTime(660, now);
    osc.frequency.setValueAtTime(880, now + 0.16);
    osc.frequency.setValueAtTime(660, now + 0.32);

    gain.gain.setValueAtTime(0.14, now);
    gain.gain.setValueAtTime(0.14, now + 0.42);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.52);
  }

  /**
   * Shared output for the spatial engine (music + HRTF emitters): same context and master gain,
   * so mute and volume govern everything. `null` while muted or before the context exists.
   */
  public getOutput(): { ctx: AudioContext; destination: AudioNode } | null {
    const ctx = this.ensureContext();
    return ctx && this.masterGain ? { ctx, destination: this.masterGain } : null;
  }
}
