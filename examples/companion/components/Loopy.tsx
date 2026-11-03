// Loopy, drawn: one teal vinyl-coated wire bent like two triangle clips crossed into a little
// figure: from one cut end it runs up into the left wing, down through the waist to the base, along
// the base, back up through the waist into the right wing, and ends at the other cut end, so the
// base and the two wings are one continuous piece. A polished steel bead sits between the wings as
// the head, with the face on it: two big eyes under expressive brows and a small mouth.
// Hand-written SVG, no assets; the wire is ONE path with rounded bends. Every move is CSS keyed off
// `data-state` (public/styles.css).
//
// Pure: no hooks, no timers — app/companion.tsx owns the state machine and the squash on poke.
import type { LoopyState } from "../lib/loopy-machine.ts";

/**
 * The wire's bend points, in order along the wire: a cut end near the waist, the left wing's inner
 * corner and tip, the base's right and left corners, the right wing's tip and inner corner, and the
 * other cut end. The two long diagonals cross at the waist, about (80, 137).
 */
const BENDS: ReadonlyArray<readonly [number, number]> = [
  [81, 128],
  [52, 94],
  [8, 88],
  [150, 182],
  [10, 182],
  [152, 88],
  [108, 94],
  [79, 128],
];

/** A path through `points` with each interior corner rounded by radius `r` (a bent wire). */
function bentWire(points: ReadonlyArray<readonly [number, number]>, r: number): string {
  const [first] = points;
  let d = `M${first[0]} ${first[1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    const toPrev = Math.hypot(px - cx, py - cy);
    const toNext = Math.hypot(nx - cx, ny - cy);
    const k1 = Math.min(r, toPrev / 2) / toPrev;
    const k2 = Math.min(r, toNext / 2) / toNext;
    const ax = cx + (px - cx) * k1;
    const ay = cy + (py - cy) * k1;
    const bx = cx + (nx - cx) * k2;
    const by = cy + (ny - cy) * k2;
    d += ` L${ax.toFixed(1)} ${ay.toFixed(1)} Q${cx} ${cy} ${bx.toFixed(1)} ${by.toFixed(1)}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last[0]} ${last[1]}`;
}

/** The whole wire, bent once at module load. */
const WIRE = bentWire(BENDS, 7);

/** The props of {@linkcode Loopy}. */
export interface LoopyProps {
  /** The move on screen. */
  readonly state: LoopyState;
  /** Accessible name (default "Loopy"). */
  readonly label?: string;
}

/** One stroke of vinyl-coated wire: a dark edge, the colour, and a highlight. */
function Wire({ d }: { d: string }) {
  return (
    <g>
      <path d={d} class="loopy-wire-edge" />
      <path d={d} class="loopy-wire" />
      <path d={d} class="loopy-wire-shine" />
    </g>
  );
}

/** Loopy, the paper clip. */
export function Loopy({ state, label = "Loopy" }: LoopyProps) {
  return (
    <svg
      class="loopy"
      data-state={state}
      viewBox="0 0 160 200"
      width="160"
      height="200"
      role="img"
      aria-label={label}
    >
      <defs>
        <radialGradient id="loopy-bead" cx="0.36" cy="0.32" r="0.75">
          <stop offset="0" stop-color="#ffffff" />
          <stop offset="0.35" stop-color="#d9dee3" />
          <stop offset="0.8" stop-color="#8b959e" />
          <stop offset="1" stop-color="#5d666e" />
        </radialGradient>
      </defs>
      <ellipse class="loopy-shadow" cx="80" cy="192" rx="68" ry="5" />
      <g class="loopy-body">
        <Wire d={WIRE} />
        <g class="loopy-head">
          <circle class="loopy-bead" cx="80" cy="76" r="29" fill="url(#loopy-bead)" />
          <g class="loopy-brows">
            <path d="M59 60 Q67 51 76 58" />
            <path d="M84 58 Q93 51 101 60" />
          </g>
          <g class="loopy-eyes">
            <ellipse class="loopy-eye-white" cx="70" cy="72" rx="7.2" ry="8.8" />
            <ellipse class="loopy-eye-white" cx="90" cy="72" rx="7.2" ry="8.8" />
            <circle cx="71.8" cy="73.8" r="3.6" />
            <circle cx="88.2" cy="73.8" r="3.6" />
          </g>
          <path class="loopy-mouth" d="M71 88 Q80 95 89 88" />
        </g>
        <g class="loopy-thought" aria-hidden="true">
          <circle cx="112" cy="40" r="2.6" />
          <circle cx="121" cy="32" r="2.6" />
          <circle cx="130" cy="24" r="2.6" />
        </g>
        <g class="loopy-sparkles" aria-hidden="true">
          <path d="M16 46 l3 -8 l3 8 l-3 8 z" />
          <path d="M140 60 l2.5 -6 l2.5 6 l-2.5 6 z" />
          <path d="M20 120 l2 -5 l2 5 l-2 5 z" />
        </g>
      </g>
    </svg>
  );
}
