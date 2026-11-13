// Loopy, drawn: one teal vinyl-coated wire bent like two triangle clips crossed into a little
// figure: from one cut end it runs up into the left wing, down through the waist to the base, along
// the base, back up through the waist into the right wing, and ends at the other cut end, so the
// base and the two wings are one continuous piece. A polished steel bead sits between the wings as
// the head, with the face on it: two big eyes under expressive brows and a small mouth.
// Hand-written SVG, no assets; the wire is ONE path with rounded bends. Every move is CSS keyed off
// `data-state` (public/styles.css).
//
// Pure: no hooks, no timers — app/companion.tsx owns the state machine and the squash on poke.
import type { LoopyMood, LoopyState } from "../lib/loopy-machine.ts";
import { LEVEL_STEPS, mouthShape } from "../lib/lip-sync.ts";

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

/** One face: the brows, the eyes' shape and pupils, the mouth, and any extras. */
interface Face {
  /** The left and right brow paths. */
  readonly brows: readonly [string, string];
  /** The eye whites' vertical radius (smaller: sleepier); 0 draws no whites. */
  readonly eyeRy: number;
  /** The pupils: dots offset from the eye centre, hearts, or none. */
  readonly pupils:
    | {
      readonly kind: "dots";
      readonly dx: [number, number];
      readonly dy: number;
      readonly r?: number;
    }
    | { readonly kind: "hearts" }
    | { readonly kind: "stars" }
    | { readonly kind: "ovals" }
    | { readonly kind: "none" };
  /** The mouth path, and whether it is filled (an open mouth). */
  readonly mouth: string;
  readonly mouthOpen?: boolean;
}

const SMILE = "M71 88 Q80 95 89 88";
const FROWN = "M71 92 Q80 85 89 92";

/** The face each mood wears. */
const FACES: Readonly<Record<LoopyMood, Face>> = {
  neutral: {
    brows: ["M59 60 Q67 51 76 58", "M84 58 Q93 51 101 60"],
    eyeRy: 8.8,
    pupils: { kind: "dots", dx: [1.8, -1.8], dy: 1.8 },
    mouth: SMILE,
  },
  thinking: {
    brows: ["M59 57 Q67 49 76 55", "M84 58 Q93 54 101 60"],
    eyeRy: 8.8,
    pupils: { kind: "dots", dx: [2.6, 2.6], dy: -2.6 },
    mouth: "M73 90 Q80 91 87 89",
  },
  attention: {
    brows: ["M59 55 Q67 46 76 53", "M84 53 Q93 46 101 55"],
    eyeRy: 9.6,
    pupils: { kind: "dots", dx: [2.4, 2.4], dy: -0.5 },
    mouth: "M76 89 a4 4.5 0 1 0 8 0 a4 4.5 0 1 0 -8 0",
    mouthOpen: true,
  },
  success: {
    brows: ["M59 57 Q67 48 76 55", "M84 55 Q93 48 101 57"],
    eyeRy: 8.8,
    pupils: { kind: "dots", dx: [1.2, -1.2], dy: 0.8 },
    mouth: "M68 85 Q80 101 92 85 Z",
    mouthOpen: true,
  },
  confused: {
    brows: ["M59 54 Q67 45 76 52", "M84 61 Q93 60 101 63"],
    eyeRy: 8.8,
    pupils: { kind: "dots", dx: [-2.4, 2.4], dy: 1 },
    mouth: "M70 90 Q75 86 80 90 Q85 94 90 89",
  },
  mad: {
    brows: ["M60 56 L77 63", "M83 63 L100 56"],
    eyeRy: 7.4,
    pupils: { kind: "dots", dx: [2, -2], dy: 2.4 },
    mouth: FROWN,
  },
  sad: {
    brows: ["M60 63 L76 56", "M84 56 L100 63"],
    eyeRy: 8.8,
    pupils: { kind: "dots", dx: [0.8, -0.8], dy: 3 },
    mouth: FROWN,
  },
  excited: {
    brows: ["M59 53 Q67 44 76 51", "M84 51 Q93 44 101 53"],
    eyeRy: 9.8,
    pupils: { kind: "dots", dx: [0, 0], dy: 0 },
    mouth: "M67 84 Q80 104 93 84 Z",
    mouthOpen: true,
  },
  sleepy: {
    brows: ["M60 62 Q67 59 76 62", "M84 62 Q93 59 100 62"],
    eyeRy: 2.2,
    pupils: { kind: "none" },
    mouth: "M77 90 a3 2.4 0 1 0 6 0 a3 2.4 0 1 0 -6 0",
    mouthOpen: true,
  },
  love: {
    brows: ["M59 58 Q67 50 76 56", "M84 56 Q93 50 101 58"],
    eyeRy: 8.8,
    pupils: { kind: "hearts" },
    mouth: SMILE,
  },
  surprised: {
    brows: ["M59 52 Q67 43 76 50", "M84 50 Q93 43 101 52"],
    eyeRy: 10,
    pupils: { kind: "dots", dx: [0, 0], dy: 0, r: 3 },
    mouth: "M76.5 90 a3.5 4 0 1 0 7 0 a3.5 4 0 1 0 -7 0",
    mouthOpen: true,
  },
  shocked: {
    brows: ["M60 49 Q67 41 76 47", "M84 47 Q93 41 100 49"],
    eyeRy: 11,
    pupils: { kind: "dots", dx: [0, 0], dy: 0, r: 2 },
    mouth: "M75 91 a5 7 0 1 0 10 0 a5 7 0 1 0 -10 0",
    mouthOpen: true,
  },
  wow: {
    brows: ["M59 54 Q67 46 76 52", "M84 52 Q93 46 101 54"],
    eyeRy: 0,
    pupils: { kind: "ovals" },
    mouth: "M74 92 a6 7.5 0 1 0 12 0 a6 7.5 0 1 0 -12 0",
    mouthOpen: true,
  },
};

/** A five-pointed star centred on (x, y) with outer radius `r`. */
const star = (x: number, y: number, r: number) => {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(x + rad * Math.cos(a)).toFixed(1)} ${(y + rad * Math.sin(a)).toFixed(1)}`);
  }
  return `M${pts.join(" L")} Z`;
};

/** A small heart centred on (x, y). */
const heart = (x: number, y: number, s: number) =>
  `M${x} ${y + s * 0.9} C${x - s * 1.6} ${y - s * 0.2} ${x - s * 0.7} ${y - s * 1.3} ${x} ${
    y - s * 0.4
  } C${x + s * 0.7} ${y - s * 1.3} ${x + s * 1.6} ${y - s * 0.2} ${x} ${y + s * 0.9} Z`;

/** The pupils of `face` for eyes centred at x 70 and 90, y 72. */
function Pupils({ face }: { face: Face }) {
  const p = face.pupils;
  if (p.kind === "none") return null;
  if (p.kind === "ovals") {
    return (
      <>
        <ellipse cx="70" cy="72" rx="4.2" ry="6.6" />
        <ellipse cx="90" cy="72" rx="4.2" ry="6.6" />
      </>
    );
  }
  if (p.kind === "stars") {
    return (
      <g class="loopy-star-eyes">
        <path d={star(70, 72, 5.4)} />
        <path d={star(90, 72, 5.4)} />
      </g>
    );
  }
  if (p.kind === "hearts") {
    return (
      <g class="loopy-heart-eyes">
        <path d={heart(70, 72, 4.6)} />
        <path d={heart(90, 72, 4.6)} />
      </g>
    );
  }
  return (
    <>
      <circle cx={70 + p.dx[0]} cy={72 + p.dy} r={p.r ?? 3.6} />
      <circle cx={90 + p.dx[1]} cy={72 + p.dy} r={p.r ?? 3.6} />
    </>
  );
}

/** The extras a mood adds around the head: a question mark, steam, a tear, z's, hearts, blush. */
function Extras({ mood }: { mood: LoopyMood }) {
  switch (mood) {
    case "confused":
      return <text class="loopy-extra loopy-question" x="112" y="52">?</text>;
    case "mad":
      return (
        <g class="loopy-extra loopy-steam">
          <path d="M44 50 q-4 -6 0 -12 q4 -6 0 -12" />
          <path d="M116 50 q4 -6 0 -12 q-4 -6 0 -12" />
        </g>
      );
    case "sad":
      return <path class="loopy-extra loopy-tear" d="M63 82 q-3 6 0 8 q3 -2 0 -8 Z" />;
    case "sleepy":
      return (
        <g class="loopy-extra loopy-zs">
          <text x="110" y="52">z</text>
          <text x="120" y="40">z</text>
          <text x="131" y="28">Z</text>
        </g>
      );
    case "love":
      return (
        <g class="loopy-extra">
          <g class="loopy-blush">
            <ellipse cx="62" cy="86" rx="5" ry="3" />
            <ellipse cx="98" cy="86" rx="5" ry="3" />
          </g>
          <g class="loopy-floating-hearts">
            <path d={heart(120, 44, 5)} />
            <path d={heart(36, 36, 4)} />
          </g>
        </g>
      );
    case "surprised":
      return <text class="loopy-extra loopy-exclaim" x="112" y="50">!</text>;
    case "shocked":
      return (
        <g class="loopy-extra loopy-zaps">
          <path d="M40 54 l-8 -4 M38 66 l-9 0 M40 78 l-8 4" />
          <path d="M120 54 l8 -4 M122 66 l9 0 M120 78 l8 4" />
        </g>
      );
    case "wow":
      return <ellipse class="loopy-extra loopy-tongue" cx="80" cy="96.5" rx="4.2" ry="2.4" />;
    default:
      return null;
  }
}

/** The props of {@linkcode Loopy}. */
export interface LoopyProps {
  /** The move on screen. */
  readonly state: LoopyState;
  /** Accessible name (default "Loopy"). */
  readonly label?: string;
  /** The mood of the message on screen, which tints the wire (none: bare steel). */
  readonly mood?: LoopyMood;
  /** What Loopy is doing in a voice turn (`data-voice`): listening, thinking or speaking. */
  readonly voice?: "listening" | "thinking" | "speaking";
  /**
   * The audio level step, 0 to `LEVEL_STEPS`: while speaking how open the mouth is (lip-sync),
   * while listening the microphone's (the pulse).
   */
  readonly level?: number;
}

/** The mouth to draw: the lip-sync shape while speaking, else the mood's. */
function mouthFor(face: Face, voice: LoopyProps["voice"], step: number) {
  if (voice === "speaking") return mouthShape(step);
  return { d: face.mouth, open: face.mouthOpen === true };
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
export function Loopy(
  { state, label = "Loopy", mood, voice, level = 0 }: LoopyProps,
) {
  const current = mood ?? "neutral";
  const face = FACES[current];
  const mouth = mouthFor(face, voice, level);
  const listen = voice === "listening" ? Math.min(1, level / LEVEL_STEPS) : 0;
  return (
    <svg
      class="loopy"
      data-state={state}
      data-mood={current}
      data-voice={voice}
      style={{ "--loopy-listen": listen }}
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
            <path d={face.brows[0]} />
            <path d={face.brows[1]} />
          </g>
          <g class="loopy-eyes">
            {face.eyeRy > 0 && (
              <>
                <ellipse class="loopy-eye-white" cx="70" cy="72" rx="7.2" ry={face.eyeRy} />
                <ellipse class="loopy-eye-white" cx="90" cy="72" rx="7.2" ry={face.eyeRy} />
              </>
            )}
            <Pupils face={face} />
          </g>
          <path class={mouth.open ? "loopy-mouth is-open" : "loopy-mouth"} d={mouth.d} />
          <Extras mood={current} />
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
