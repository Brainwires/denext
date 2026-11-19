// The CLI sender's test picture: colour bars with a square that sweeps across them, so motion,
// colour (YUV → RGB in the viewer) and the aspect fit are all visible. Pure.

import type { YuvFrame } from "./h264.ts";

/** BT.601 limited-range YUV for an sRGB colour (what an H.264 stream without VUI means). */
export function rgbToYuv(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const y = 16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255;
  const u = 128 + (-37.797 * r - 74.203 * g + 112 * b) / 255;
  const v = 128 + (112 * r - 93.786 * g - 18.214 * b) / 255;
  return [Math.round(y), Math.round(u), Math.round(v)];
}

const BARS: [number, number, number][] = [
  [191, 191, 191], // grey
  [191, 191, 0], // yellow
  [0, 191, 191], // cyan
  [0, 191, 0], // green
  [191, 0, 191], // magenta
  [191, 0, 0], // red
  [0, 0, 191], // blue
].map(([r, g, b]) => rgbToYuv(r, g, b));

const WHITE = rgbToYuv(255, 255, 255);

/** Paints a 4:2:0 frame of `width`×`height` (even) for frame number `index`. */
export function testPattern(
  width: number,
  height: number,
  index: number,
): YuvFrame {
  const y = new Uint8Array(width * height);
  const u = new Uint8Array((width / 2) * (height / 2));
  const v = new Uint8Array((width / 2) * (height / 2));
  const side = Math.max(2, Math.round(height / 4) & ~1);
  const travel = width - side;
  const phase = (index * 4) % (2 * travel || 1);
  const sx = phase < travel ? phase : 2 * travel - phase;
  const sy = Math.round((height - side) / 2) & ~1;
  const colourAt = (px: number, py: number) => {
    const inSquare = px >= sx && px < sx + side && py >= sy && py < sy + side;
    return inSquare
      ? WHITE
      : BARS[Math.min(BARS.length - 1, Math.floor((px * BARS.length) / width))];
  };
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) y[py * width + px] = colourAt(px, py)[0];
  }
  for (let py = 0; py < height / 2; py++) {
    for (let px = 0; px < width / 2; px++) {
      const [, cu, cv] = colourAt(px * 2, py * 2);
      u[py * (width / 2) + px] = cu;
      v[py * (width / 2) + px] = cv;
    }
  }
  return { width, height, y, u, v };
}
