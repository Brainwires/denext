// The renderers' shared shape, and the canvas sizing they both use.

/** Draws decoded frames on a canvas. */
export interface FrameRenderer {
  readonly kind: "webgpu" | "webgl2";
  /** Draws `frame` aspect-fitted, then closes it. */
  draw(frame: VideoFrame): void;
  destroy(): void;
}

/** Matches the canvas's backing store to its CSS size × the device pixel ratio. */
export function syncCanvasSize(canvas: HTMLCanvasElement): void {
  const ratio = globalThis.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}
