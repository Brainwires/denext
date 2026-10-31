// Loopy, drawn: a Gem-style double-oval paper clip in teal vinyl-coated wire, standing on its
// outer bend, with a face (two dot eyes, a small mouth) inside its top loop. Hand-written SVG, no
// assets. Every move is CSS keyed off `data-state` (public/styles.css); the arm is the clip's
// outer leg, which "unbends" (rotates about its bend) to point at the speech bubble.
//
// Pure: no hooks, no timers — app/companion.tsx owns the state machine and the squash on poke.
import type { LoopyState } from "../lib/loopy-machine.ts";

/** The wire, except the outer leg: inner tail, inner bend, top loop, outer bend. */
const WIRE = "M48 62 V146 A12 12 0 0 0 72 146 V44 A18 18 0 0 0 36 44 V160 A24 24 0 0 0 84 160";
/** The outer leg (the arm that unbends to point), from the outer bend up. */
const ARM = "M84 160 V74";

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

/** Loopy the paper clip. */
export function Loopy({ state, label = "Loopy" }: LoopyProps) {
  return (
    <svg
      class="loopy"
      data-state={state}
      viewBox="0 0 120 200"
      width="120"
      height="200"
      role="img"
      aria-label={label}
    >
      <ellipse class="loopy-shadow" cx="60" cy="192" rx="30" ry="5" />
      <g class="loopy-body">
        <Wire d={WIRE} />
        <g class="loopy-arm">
          <Wire d={ARM} />
        </g>
        <g class="loopy-face">
          <g class="loopy-eyes">
            <circle cx="47" cy="44" r="3.4" />
            <circle cx="61" cy="44" r="3.4" />
          </g>
          <path class="loopy-mouth" d="M49 53 Q54 57.5 59 53" />
        </g>
        <g class="loopy-thought" aria-hidden="true">
          <circle cx="82" cy="22" r="2.6" />
          <circle cx="90" cy="16" r="2.6" />
          <circle cx="98" cy="10" r="2.6" />
        </g>
        <g class="loopy-sparkles" aria-hidden="true">
          <path d="M14 40 l3 -8 l3 8 l-3 8 z" />
          <path d="M100 52 l2.5 -6 l2.5 6 l-2.5 6 z" />
          <path d="M20 96 l2 -5 l2 5 l-2 5 z" />
        </g>
      </g>
    </svg>
  );
}
