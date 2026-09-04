// Procedural retro sound — all synthesized with the Web Audio API. No audio files,
// no sampled/copyrighted music: just oscillators + noise shaped into bleeps, plus a
// short original chiptune loop. Created lazily on the first user gesture (Play), to
// satisfy browser autoplay rules.

import type { SoundFx } from "./physics.ts";

type Ctx = AudioContext;

export class Sound implements SoundFx {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private muted = false;
  private musicOn = false;
  private step = 0;
  private nextNoteAt = 0;
  private timer = 0;

  /** Call from a user gesture (the Play button). */
  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const AC = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (AC) this.open(new AC());
  }

  /** Wire the master gain to a fresh context (muted state carries over). */
  private open(ctx: Ctx): void {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(ctx.destination);
  }

  setMuted(v: boolean): void {
    this.muted = v;
    if (this.master) this.master.gain.value = v ? 0 : 0.5;
  }

  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    vol = 0.5,
    slideTo?: number,
    delay = 0,
  ): void {
    const ctx = this.ctx, master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol = 0.4, hp = 400): void {
    const ctx = this.ctx, master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(filter).connect(g).connect(master);
    src.start(t);
  }

  jump(): void {
    this.tone(300, 0.18, "square", 0.4, 620);
  }
  land(): void {
    this.noise(0.09, 0.3, 200);
  }
  climb(): void {
    this.tone(200 + Math.random() * 40, 0.05, "triangle", 0.18);
  }
  roll(): void {
    this.noise(0.05, 0.08, 120);
  }
  point(): void {
    this.tone(660, 0.08, "square", 0.4);
    this.tone(880, 0.1, "square", 0.4, undefined, 0.08);
  }
  hit(): void {
    this.tone(400, 0.5, "sawtooth", 0.5, 60);
    this.noise(0.3, 0.3, 100);
  }
  win(): void {
    const notes = [523, 659, 784, 1047, 1319];
    notes.forEach((f, i) => this.tone(f, 0.18, "square", 0.45, undefined, i * 0.12));
  }
  lose(): void {
    [440, 349, 262, 196].forEach((f, i) =>
      this.tone(f, 0.28, "sawtooth", 0.4, undefined, i * 0.16)
    );
  }

  // A short, original 8-step bass/arp loop — plain public-domain-ish chiptune, not
  // anyone's tune. Scheduled a note at a time off a timer.
  startMusic(): void {
    if (!this.ctx || this.musicOn) return;
    this.musicOn = true;
    this.step = 0;
    this.nextNoteAt = this.ctx.currentTime;
    const bass = [131, 131, 165, 131, 175, 131, 196, 165];
    const lead = [523, 0, 659, 0, 587, 0, 784, 659];
    this.timer = setInterval(() => {
      if (this.ctx && this.musicOn) this.scheduleNotes(this.ctx, bass, lead);
    }, 60) as unknown as number;
  }

  /** Queue every note due in the next 200 ms (the sequencer runs ahead of the clock). */
  private scheduleNotes(ctx: Ctx, bass: number[], lead: number[]): void {
    while (this.nextNoteAt < ctx.currentTime + 0.2) {
      const i = this.step % 8;
      const dt = Math.max(0, this.nextNoteAt - ctx.currentTime);
      this.tone(bass[i], 0.22, "triangle", 0.22, undefined, dt);
      if (lead[i]) this.tone(lead[i], 0.12, "square", 0.12, undefined, dt);
      this.nextNoteAt += 0.16;
      this.step++;
    }
  }

  stopMusic(): void {
    this.musicOn = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
  }
}
