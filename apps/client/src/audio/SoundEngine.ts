import type { TrafficStateDto, WorldSnapshotDto } from "@pentapolis/shared-sim";

const STORAGE_MUTED_KEY = "pentapolis_audio_muted";
const STORAGE_VOLUME_KEY = "pentapolis_audio_volume";

export interface SpatialCameraProbe {
  readonly centerX: number;
  readonly centerY: number;
  readonly zoomLevel: number;
  readonly waterRatio: number;
}

/**
 * Pure Procedural Web Audio Synthesizer & Spatial 3D Ambience Engine (Sprint 8).
 *
 * Uses zero external `.mp3` / `.wav` files:
 * - Procedural SFX: UI clicks, asphalt laying, heavy building foundation thud,
 *   cash-register chime (taxes/grants/dividends), and emergency dispatch siren.
 * - Spatial 3D Audio at `zoomLevel >= 4.5`: dynamically mixes avenue traffic + horns,
 *   construction crane & welding crackles, industrial turbine hum, and coastal waves + seagulls
 *   around the camera's current tile target.
 */
export class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private ambientInitialized = false;
  private roadGain: GainNode | null = null;
  private factoryGain: GainNode | null = null;
  private waterGain: GainNode | null = null;
  private lastMicroEventMs = 0;

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

  private ensureAmbientBed(ctx: AudioContext): void {
    if (this.ambientInitialized || !this.masterGain || !this.noiseBuffer) return;
    this.ambientInitialized = true;

    // 1. Road traffic continuous rumble (bandpass noise around 220 Hz)
    const roadNoise = ctx.createBufferSource();
    roadNoise.buffer = this.noiseBuffer;
    roadNoise.loop = true;
    const roadFilter = ctx.createBiquadFilter();
    roadFilter.type = "bandpass";
    roadFilter.frequency.value = 230;
    roadFilter.Q.value = 0.9;
    this.roadGain = ctx.createGain();
    this.roadGain.gain.value = 0;
    roadNoise.connect(roadFilter);
    roadFilter.connect(this.roadGain);
    this.roadGain.connect(this.masterGain);
    roadNoise.start();

    // 2. Industrial factory & turbine hum (58 Hz + 116 Hz warm drone)
    const facOsc1 = ctx.createOscillator();
    const facOsc2 = ctx.createOscillator();
    facOsc1.type = "sine";
    facOsc1.frequency.value = 58;
    facOsc2.type = "triangle";
    facOsc2.frequency.value = 116;
    const facFilter = ctx.createBiquadFilter();
    facFilter.type = "lowpass";
    facFilter.frequency.value = 240;
    this.factoryGain = ctx.createGain();
    this.factoryGain.gain.value = 0;
    facOsc1.connect(facFilter);
    facOsc2.connect(facFilter);
    facFilter.connect(this.factoryGain);
    this.factoryGain.connect(this.masterGain);
    facOsc1.start();
    facOsc2.start();

    // 3. River & coastal sea surf (lowpass noise modulated by 0.16 Hz wave LFO)
    const waterNoise = ctx.createBufferSource();
    waterNoise.buffer = this.noiseBuffer;
    waterNoise.loop = true;
    const waterFilter = ctx.createBiquadFilter();
    waterFilter.type = "lowpass";
    waterFilter.frequency.value = 620;
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.16;
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain);
    lfoGain.connect(waterFilter.frequency);
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0;
    waterNoise.connect(waterFilter);
    waterFilter.connect(this.waterGain);
    this.waterGain.connect(this.masterGain);
    waterNoise.start();
    lfo.start();
  }

  /** Soft dual-tone urban car horn micro-event. */
  private triggerSoftCarHorn(ctx: AudioContext): void {
    if (!this.masterGain) return;
    const now = ctx.currentTime;
    for (const f of [415, 523]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.035, now);
      g.gain.exponentialRampToValueAtTime(0.0008, now + 0.14);
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.15);
    }
  }

  /** Construction crane clank & brief welding spark burst. */
  private triggerConstructionClank(ctx: AudioContext): void {
    if (!this.masterGain || !this.noiseBuffer) return;
    const now = ctx.currentTime;

    // Crane steel ping
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1240, now);
    osc.frequency.exponentialRampToValueAtTime(680, now + 0.08);
    g.gain.setValueAtTime(0.05, now);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 0.09);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.1);

    // Welding crackle
    const weld = ctx.createBufferSource();
    weld.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2800;
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.04, now + 0.05);
    wg.gain.exponentialRampToValueAtTime(0.0008, now + 0.16);
    weld.connect(hp);
    hp.connect(wg);
    wg.connect(this.masterGain);
    weld.start(now + 0.05);
    weld.stop(now + 0.17);
  }

  /** Distant coastal seagull pitch-glide. */
  private triggerSeagull(ctx: AudioContext): void {
    if (!this.masterGain) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1650, now);
    osc.frequency.linearRampToValueAtTime(2150, now + 0.07);
    osc.frequency.exponentialRampToValueAtTime(1180, now + 0.26);
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.03, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 0.28);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.29);
  }

  /**
   * Updates Spatial 3D Ambience every ~250ms based on camera zoom (`>= 4.5`) and tile center.
   */
  public updateSpatialAmbience(
    probe: SpatialCameraProbe,
    snapshot: WorldSnapshotDto | null,
    traffic: TrafficStateDto | null
  ): void {
    if (!this.ctx || this.ctx.state !== "running") return;
    this.ensureAmbientBed(this.ctx);
    if (!this.roadGain || !this.factoryGain || !this.waterGain) return;

    const now = this.ctx.currentTime;
    if (this.muted || !snapshot || probe.zoomLevel < 4.5) {
      this.roadGain.gain.setTargetAtTime(0, now, 0.18);
      this.factoryGain.gain.setTargetAtTime(0, now, 0.18);
      this.waterGain.gain.setTargetAtTime(0, now, 0.18);
      return;
    }

    const zoomFactor = Math.min(1, (probe.zoomLevel - 4.3) / 3.2);
    const radius = 28;
    const { centerX, centerY } = probe;

    // 1. Nearby vehicles / avenues
    let nearbyVehicles = 0;
    if (traffic) {
      for (const v of traffic.vehicles) {
        const vx = v.path[0] ?? -999;
        const vy = v.path[1] ?? -999;
        if (Math.abs(vx - centerX) <= radius && Math.abs(vy - centerY) <= radius) {
          nearbyVehicles += 1;
        }
      }
    }
    const roadWeight = Math.min(1, nearbyVehicles / 8) * zoomFactor;

    // 2. Nearby active construction sites & operational factories
    let constructionSites = 0;
    let factoryCount = 0;
    for (const b of snapshot.buildings) {
      const bx = b.tileX + b.width * 0.5;
      const by = b.tileY + b.depth * 0.5;
      if (Math.abs(bx - centerX) > radius || Math.abs(by - centerY) > radius) continue;
      if (b.constructionProgress < 1 && !b.stalledAwaitingPrivate) {
        constructionSites += 1;
      } else if (
        b.constructionProgress >= 1 &&
        (b.catalogId.startsWith("EXT-") ||
          b.catalogId.startsWith("PRO-") ||
          b.catalogId.startsWith("CMP-") ||
          b.catalogId.startsWith("ASM-") ||
          b.catalogId.startsWith("ENG-"))
      ) {
        factoryCount += 1;
      }
    }
    for (const z of snapshot.zones) {
      const zx = z.x + z.width * 0.5;
      const zy = z.y + z.depth * 0.5;
      if (Math.abs(zx - centerX) > radius || Math.abs(zy - centerY) > radius) continue;
      if (z.occupancyRatio > 0.02 && z.occupancyRatio < 0.96) {
        constructionSites += 1;
      }
    }

    const factoryWeight = Math.min(1, factoryCount / 2) * zoomFactor;
    const constructionWeight = Math.min(1, constructionSites / 2) * zoomFactor;
    const waterWeight = probe.waterRatio * zoomFactor;

    this.roadGain.gain.setTargetAtTime(roadWeight * 0.11, now, 0.2);
    this.factoryGain.gain.setTargetAtTime(factoryWeight * 0.09, now, 0.2);
    this.waterGain.gain.setTargetAtTime(waterWeight * 0.1, now, 0.2);

    // Occasional spatial micro-SFX (horn, crane/welding, seagull) at most once every 2.4s
    const nowMs = performance.now();
    if (nowMs - this.lastMicroEventMs > 2400) {
      if (constructionWeight > 0.3 && Math.random() < 0.32) {
        this.lastMicroEventMs = nowMs;
        this.triggerConstructionClank(this.ctx);
      } else if (roadWeight > 0.35 && Math.random() < 0.25) {
        this.lastMicroEventMs = nowMs;
        this.triggerSoftCarHorn(this.ctx);
      } else if (waterWeight > 0.3 && Math.random() < 0.28) {
        this.lastMicroEventMs = nowMs;
        this.triggerSeagull(this.ctx);
      }
    }
  }
}
