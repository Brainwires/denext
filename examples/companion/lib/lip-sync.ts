// Loopy's lip-sync and listening pulse: an audio level (from a Web Audio analyser on the model's
// voice or the microphone) becomes a small number of steps, and a mouth step becomes a mouth shape
// on Loopy's face. Pure, so it is unit-tested; lib/use-voice.ts samples the analysers.

/** How many open steps the mouth (and the listening pulse) has above closed (0). */
export const LEVEL_STEPS = 4;

/** Below this level (0–1 RMS) the voice counts as silent: breath and line noise close the mouth. */
export const SILENCE = 0.02;

/** A level this loud (RMS) opens the mouth all the way; speech rarely goes above ~0.3. */
export const FULL = 0.25;

/**
 * The RMS level of one frame of time-domain samples (`AnalyserNode.getByteTimeDomainData`: 128 is
 * silence), from 0 to 1.
 */
export function rmsLevel(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}

/**
 * One smoothing step: a quick attack (the mouth opens on a syllable at once) and a slower release
 * (it doesn't flutter shut between them).
 */
export function smoothLevel(previous: number, next: number, attack = 0.6, release = 0.25): number {
  const k = next > previous ? attack : release;
  return previous + (next - previous) * k;
}

/** The step (0 = closed … {@linkcode LEVEL_STEPS}) for a smoothed level. */
export function levelStep(level: number): number {
  if (!(level > SILENCE)) return 0;
  const t = Math.min(1, (level - SILENCE) / (FULL - SILENCE));
  return Math.max(1, Math.round(t * LEVEL_STEPS));
}

/** The mouth for a step: a closed line, or an open oval that grows taller with the level. */
export function mouthShape(step: number): { readonly d: string; readonly open: boolean } {
  const s = Math.max(0, Math.min(LEVEL_STEPS, Math.round(step)));
  if (s === 0) return { d: "M73 90 Q80 92 87 90", open: false };
  const rx = 4 + s * 0.9;
  const ry = 1.6 + s * 1.6;
  const cy = 89 + s * 0.6;
  return {
    d: `M${(80 - rx).toFixed(1)} ${cy.toFixed(1)} a${rx.toFixed(1)} ${ry.toFixed(1)} 0 1 0 ${
      (2 * rx).toFixed(1)
    } 0 a${rx.toFixed(1)} ${ry.toFixed(1)} 0 1 0 ${(-2 * rx).toFixed(1)} 0`,
    open: true,
  };
}
