/**
 * `@denext/avif` — a Deno-native AVIF **encoder**, the first-party replacement for
 * the npm `@jsquash/avif` peer codec denext's image optimizer used to lazily import.
 *
 * It wraps the **libavif** (AOM/AV1) WebAssembly encoder from
 * [jSquash](https://github.com/jamsinclair/jSquash) `@jsquash/avif@2.1.1` (itself
 * repackaged from Google's Squoosh, Apache-2.0). denext forks the **prebuilt
 * single-threaded encoder** (`lib/avif_enc.{js,wasm}`) and drives it through the
 * emscripten module's `instantiateWasm` hook, so the codec carries **zero npm
 * dependencies** and runs under Deno with no `--unstable-*` flag. See
 * `THIRD-PARTY-LICENSES.md` for the libavif / libaom / emscripten licenses it embeds.
 *
 * Only the encode path is vendored — the optimizer never decodes AVIF (Photon does
 * source decode). The wasm is compiled from `fetch(new URL(..., import.meta.url))`,
 * so a consumer needs read access to the package file locally (`--allow-read`) or
 * net access when loaded from JSR (`--allow-net`); it is a server-only codec and is
 * never shipped to the browser.
 *
 * @example Encode an RGBA frame to AVIF
 * ```ts
 * import { encode } from "@denext/avif";
 * const avif = await encode(
 *   { data: rgbaU8, width: 128, height: 128 },
 *   { quality: 60 },
 * );
 * ```
 *
 * @module
 */

// The vendored emscripten glue is untyped JS; its default export is the module factory.
import moduleFactory from "./lib/avif_enc.js";

/** Raw pixel input: RGBA (8-bit) bytes plus dimensions. Mirrors the DOM `ImageData` shape. */
export interface AvifImageData {
  /** Row-major RGBA bytes, length `width * height * 4`. */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/**
 * libavif encode options. Only `quality` is commonly set; every field has a default
 * matching Squoosh/`@jsquash/avif`, and all are forwarded to the wasm encoder (the
 * embind value-object requires the full set, so partial options are merged over the
 * defaults below).
 */
export interface AvifEncodeOptions {
  /** 0–100, higher = better quality / larger file. Default 50. */
  quality?: number;
  /** Alpha-plane quality, or -1 to reuse `quality`. Default -1. */
  qualityAlpha?: number;
  denoiseLevel?: number;
  tileColsLog2?: number;
  tileRowsLog2?: number;
  /** Encoder effort 0 (slowest/best) – 10 (fastest). Default 6. */
  speed?: number;
  subsample?: number;
  chromaDeltaQ?: boolean;
  sharpness?: number;
  /** 0 = auto, 1 = psnr, 2 = ssim. Default 0. */
  tune?: number;
  enableSharpYUV?: boolean;
  /** 8, 10, or 12. Default 8 (RGBA `Uint8`). */
  bitDepth?: number;
  lossless?: boolean;
}

const DEFAULT_OPTIONS: Required<AvifEncodeOptions> = {
  quality: 50,
  qualityAlpha: -1,
  denoiseLevel: 0,
  tileColsLog2: 0,
  tileRowsLog2: 0,
  speed: 6,
  subsample: 1,
  chromaDeltaQ: false,
  sharpness: 0,
  tune: 0,
  enableSharpYUV: false,
  bitDepth: 8,
  lossless: false,
};

type AvifModule = {
  // deno-lint-ignore no-explicit-any -- emscripten module surface is dynamic.
  encode(data: Uint8Array, w: number, h: number, opts: any): Uint8Array | null;
};

let modulePromise: Promise<AvifModule> | undefined;

/** Compile the vendored wasm and hand it to the emscripten module via `instantiateWasm`. */
function loadModule(): Promise<AvifModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const wasmUrl = new URL("./lib/avif_enc.wasm", import.meta.url);
      const wasmModule = await WebAssembly.compileStreaming(fetch(wasmUrl));
      // deno-lint-ignore no-explicit-any
      return await (moduleFactory as any)({
        noInitialRun: true,
        instantiateWasm: (
          // deno-lint-ignore no-explicit-any
          imports: any,
          callback: (i: WebAssembly.Instance) => void,
        ) => {
          const instance = new WebAssembly.Instance(wasmModule, imports);
          callback(instance);
          return instance.exports;
        },
      }) as AvifModule;
    })();
  }
  return modulePromise;
}

/**
 * Encode raw RGBA pixels to AVIF. Returns the encoded file as an `ArrayBuffer`.
 *
 * @param image RGBA pixels + dimensions.
 * @param options Encode options; `quality` (0–100) is the usual knob.
 */
export async function encode(
  image: AvifImageData,
  options: AvifEncodeOptions = {},
): Promise<ArrayBuffer> {
  const module = await loadModule();
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const bytes = image.data instanceof Uint8Array ? image.data : new Uint8Array(
    image.data.buffer,
    image.data.byteOffset,
    image.data.byteLength,
  );
  const output = module.encode(bytes, image.width, image.height, opts);
  if (!output) throw new Error("@denext/avif: AVIF encoding failed");
  return output.buffer as ArrayBuffer;
}
