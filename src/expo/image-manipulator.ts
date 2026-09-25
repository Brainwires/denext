/**
 * `expo-image-manipulator` for denext: `manipulateAsync` on a `<canvas>` (resize, rotate by
 * right angles or any angle, flip, crop, extent), saved as JPEG, PNG or WebP. The result's
 * `uri` is a `blob:` URL (and `base64` when asked).
 *
 * The contextual API (`useImageManipulator`, `ImageManipulator.manipulate`) is not provided
 * (see the manifest).
 *
 * @example
 * ```ts
 * import { manipulateAsync, SaveFormat } from "denext/expo/image-manipulator";
 *
 * const small = await manipulateAsync(uri, [{ resize: { width: 800 } }], {
 *   compress: 0.8,
 *   format: SaveFormat.JPEG,
 * });
 * ```
 *
 * @module
 */

import { bytesToBase64 } from "../mobile/base64.ts";
import { displayUrl } from "./internal/fs.ts";

/** A flip direction. */
export enum FlipType {
  /** Top to bottom. */
  Vertical = "vertical",
  /** Left to right. */
  Horizontal = "horizontal",
}

/** The output format. */
export enum SaveFormat {
  /** JPEG. */
  JPEG = "jpeg",
  /** PNG. */
  PNG = "png",
  /** WebP. */
  WEBP = "webp",
}

/** Resize (one side alone keeps the aspect ratio). */
export interface ActionResize {
  /** The new size. */
  resize: { width?: number; height?: number };
}

/** Rotate clockwise by degrees. */
export interface ActionRotate {
  /** Degrees. */
  rotate: number;
}

/** Flip. */
export interface ActionFlip {
  /** The direction. */
  flip: FlipType;
}

/** Crop to a rectangle. */
export interface ActionCrop {
  /** The rectangle. */
  crop: { originX: number; originY: number; width: number; height: number };
}

/** Extend (or cut) the canvas, filling new space with a colour. */
export interface ActionExtent {
  /** The new canvas. */
  extent: {
    backgroundColor?: string | null;
    originX?: number;
    originY?: number;
    width: number;
    height: number;
  };
}

/** One manipulation. */
export type Action = ActionResize | ActionRotate | ActionFlip | ActionCrop | ActionExtent;

/** How to save the result. */
export interface SaveOptions {
  /** Quality, 0–1 (default 1). */
  compress?: number;
  /** The format (default JPEG). */
  format?: SaveFormat;
  /** Also return the image as base64. */
  base64?: boolean;
}

/** The manipulated image. */
export interface ImageResult {
  /** A `blob:` URL of the image. */
  uri: string;
  /** Its width. */
  width: number;
  /** Its height. */
  height: number;
  /** The image as base64 (with `base64: true`). */
  base64?: string;
}

/** A canvas holding the current image. */
type Surface = HTMLCanvasElement;

/** A new canvas of `width` × `height`. */
function canvas(width: number, height: number): Surface {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

/** Draw `draw` onto a fresh canvas of the given size. */
function redraw(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): Surface {
  const out = canvas(width, height);
  draw(out.getContext("2d")!);
  return out;
}

/** The size a resize to `size` gives `src` (one side alone keeps the aspect ratio). */
function resizedSize(src: Surface, size: ActionResize["resize"]): [number, number] {
  const ratio = src.width / src.height;
  if (size.width !== undefined) return [size.width, size.height ?? size.width / ratio];
  if (size.height !== undefined) return [size.height * ratio, size.height];
  return [src.width, src.height];
}

/** Resize. */
function resize(src: Surface, action: ActionResize): Surface {
  const [w, h] = resizedSize(src, action.resize);
  return redraw(w, h, (ctx) => ctx.drawImage(src, 0, 0, w, h));
}

/** Rotate clockwise by any angle, growing the canvas to fit. */
function rotate(src: Surface, action: ActionRotate): Surface {
  const rad = (action.rotate * Math.PI) / 180;
  const [cos, sin] = [Math.abs(Math.cos(rad)), Math.abs(Math.sin(rad))];
  const w = src.width * cos + src.height * sin;
  const h = src.width * sin + src.height * cos;
  return redraw(w, h, (ctx) => {
    ctx.translate(w / 2, h / 2);
    ctx.rotate(rad);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
  });
}

/** Flip. */
function flip(src: Surface, action: ActionFlip): Surface {
  const [sx, sy] = action.flip === FlipType.Horizontal ? [-1, 1] : [1, -1];
  return redraw(src.width, src.height, (ctx) => {
    ctx.translate(sx < 0 ? src.width : 0, sy < 0 ? src.height : 0);
    ctx.scale(sx, sy);
    ctx.drawImage(src, 0, 0);
  });
}

/** Crop. */
function crop(src: Surface, action: ActionCrop): Surface {
  const { originX, originY, width, height } = action.crop;
  return redraw(width, height, (ctx) => ctx.drawImage(src, -originX, -originY));
}

/** Extend (or cut) the canvas. */
function extent(src: Surface, action: ActionExtent): Surface {
  const { backgroundColor, originX = 0, originY = 0, width, height } = action.extent;
  return redraw(width, height, (ctx) => {
    if (backgroundColor) {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(src, -originX, -originY);
  });
}

/** Each action's key → the function that applies it. */
const ACTIONS: Readonly<Record<string, (src: Surface, action: never) => Surface>> = {
  resize,
  rotate,
  flip,
  crop,
  extent,
};

/** Apply one action. */
function apply(src: Surface, action: Action): Surface {
  const run = ACTIONS[Object.keys(action)[0]];
  if (!run) throw new TypeError(`manipulateAsync: unknown action ${JSON.stringify(action)}`);
  return run(src, action as never);
}

/** Load the image at `uri` onto a canvas. */
async function load(uri: string): Promise<Surface> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = await displayUrl(uri);
  await img.decode();
  return redraw(img.naturalWidth, img.naturalHeight, (ctx) => ctx.drawImage(img, 0, 0));
}

/**
 * Apply `actions` to the image at `uri`, in order, and save the result.
 *
 * @param uri The image (a URL, or a `file:///…` app file).
 * @param actions The manipulations.
 * @param saveOptions The format, quality and `base64` flag.
 * @returns The new image.
 */
export async function manipulateAsync(
  uri: string,
  actions: Action[] = [],
  saveOptions: SaveOptions = {},
): Promise<ImageResult> {
  let surface = await load(uri);
  for (const action of actions) surface = apply(surface, action);
  const type = `image/${saveOptions.format ?? SaveFormat.JPEG}`;
  const blob = await new Promise<Blob>((resolve, reject) =>
    surface.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("manipulateAsync: encoding failed"))),
      type,
      saveOptions.compress ?? 1,
    )
  );
  const result: ImageResult = {
    uri: URL.createObjectURL(blob),
    width: surface.width,
    height: surface.height,
  };
  if (saveOptions.base64) {
    result.base64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  }
  return result;
}
