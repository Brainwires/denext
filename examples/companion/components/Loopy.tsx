// Loopy, drawn: two triangular paper clips in teal vinyl-coated wire, crossed into a little figure:
// the clips' bottom edges make a skirt, their tops cross at the waist and open into two wings, and
// a polished steel bead sits between the wings as the head. The face is on the bead: two big eyes
// under heavy, expressive brows, and a small mouth. Hand-written SVG, no assets. Every move is CSS
// keyed off `data-state` (public/styles.css); the arm is the right wing, which swings about the
// waist to point at the speech bubble.
//
// Pure: no hooks, no timers — app/companion.tsx owns the state machine and the squash on poke.
import type { LoopyState } from "../lib/loopy-machine.ts";

/** The skirt: both clips' bottom edges and the two diagonals up to the waist crossing (80, 138). */
const SKIRT = "M150 182 H10 L80 138 M150 182 L80 138";
/** The left wing: up from the waist to its tip, across, and the clip's inner tail back down. */
const LEFT_WING = "M80 138 L8 88 L52 94 L81 128";
/** The right wing (the arm that swings to point), the mirror of the left one. */
const ARM = "M80 138 L152 88 L108 94 L79 128";

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

/** Loopy, the paper-clip figure. */
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
        <Wire d={SKIRT} />
        <Wire d={LEFT_WING} />
        <g class="loopy-arm">
          <Wire d={ARM} />
        </g>
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
