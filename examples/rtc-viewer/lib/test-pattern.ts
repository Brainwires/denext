// The browser sender's test pattern: a canvas drawn 30 times a second and captured as a video
// track (`captureStream`). Colour bars, a sweeping square, the time and a frame counter, so the
// viewer shows motion, colour, aspect and latency at a glance.

const BARS = [
  "#bfbfbf",
  "#bfbf00",
  "#00bfbf",
  "#00bf00",
  "#bf00bf",
  "#bf0000",
  "#0000bf",
];

/** A running pattern. */
export interface PatternSource {
  track: MediaStreamTrack;
  stop(): void;
}

/** Draws one frame of the pattern on `ctx` (`width`×`height`), frame number `n`. */
function drawPattern(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  n: number,
): void {
  const bar = width / BARS.length;
  BARS.forEach((colour, i) => {
    ctx.fillStyle = colour;
    ctx.fillRect(Math.floor(i * bar), 0, Math.ceil(bar), height);
  });
  const side = height / 4;
  const travel = width - side;
  const phase = (n * 8) % (2 * travel);
  ctx.fillStyle = "#fff";
  ctx.fillRect(
    phase < travel ? phase : 2 * travel - phase,
    (height - side) / 2,
    side,
    side,
  );
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect(0, height - 72, width, 72);
  ctx.fillStyle = "#fff";
  ctx.font = "600 40px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  const now = new Date();
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  ctx.fillText(
    `${now.toLocaleTimeString()}.${ms}   frame ${n}`,
    24,
    height - 36,
  );
}

/** Starts a `width`×`height` pattern at `fps`. */
export function startPattern(
  width = 1280,
  height = 720,
  fps = 30,
): PatternSource {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  let n = 0;
  drawPattern(ctx, width, height, n);
  // A timer, not requestAnimationFrame: rAF stops in a hidden tab (a timer is only throttled).
  const timer = setInterval(
    () => drawPattern(ctx, width, height, ++n),
    1000 / fps,
  );
  const [track] = canvas.captureStream(fps).getVideoTracks();
  return {
    track,
    stop() {
      clearInterval(timer);
      track.stop();
    },
  };
}
