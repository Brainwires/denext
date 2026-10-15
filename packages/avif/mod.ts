/**
 * `@denext/avif` — a Deno-native AVIF **encoder and decoder**, the first-party
 * replacement for the npm `@jsquash/avif` peer codec denext's image optimizer used to
 * lazily import.
 *
 * It wraps the **libavif** (AOM/AV1) WebAssembly codecs from
 * [jSquash](https://github.com/jamsinclair/jSquash) `@jsquash/avif@2.1.1` (itself
 * repackaged from Google's Squoosh, Apache-2.0). denext forks the **prebuilt
 * single-threaded encoder and decoder** (`lib/avif_enc.{js,wasm}`,
 * `lib/avif_dec.{js,wasm}`) and drives them through the emscripten module's
 * `instantiateWasm` hook, so the codec carries **zero npm dependencies** and runs
 * under Deno with no `--unstable-*` flag. See `THIRD-PARTY-LICENSES.md` for the
 * libavif / libaom / emscripten licenses it embeds.
 *
 * denext's image optimizer decodes AVIF sources with {@linkcode decode} (Photon
 * decodes the other formats) and encodes AVIF output with {@linkcode encode}. The
 * wasm is compiled from `fetch(new URL(..., import.meta.url))`, so a consumer needs
 * read access to the package file locally (`--allow-read`) or net access when loaded
 * from JSR (`--allow-net`); it is a server-only codec and is never shipped to the
 * browser.
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
import decoderFactory from "./lib/avif_dec.js";

/** Raw pixel input: RGBA (8-bit) bytes plus dimensions. Mirrors the DOM `ImageData` shape. */
export interface AvifImageData {
  /** Row-major RGBA bytes, length `width * height * 4`. */
  data: Uint8ClampedArray | Uint8Array;
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
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
  /** AV1 denoising strength, 0 (off) – 50. Default 0. */
  denoiseLevel?: number;
  /** log2 of the tile columns (0 = one column). Default 0. */
  tileColsLog2?: number;
  /** log2 of the tile rows (0 = one row). Default 0. */
  tileRowsLog2?: number;
  /** Encoder effort 0 (slowest/best) – 10 (fastest). Default 6. */
  speed?: number;
  /** Chroma subsampling: 0 = 4:4:4, 1 = 4:2:0 (default), 2 = 4:2:2, 3 = 4:0:0. */
  subsample?: number;
  /** Adjust chroma quantization relative to luma. Default false. */
  chromaDeltaQ?: boolean;
  /** Loop-filter sharpness 0–7. Default 0. */
  sharpness?: number;
  /** 0 = auto, 1 = psnr, 2 = ssim. Default 0. */
  tune?: number;
  /** Sharper RGB → YUV conversion (slower). Default false. */
  enableSharpYUV?: boolean;
  /** 8, 10, or 12. Default 8 (RGBA `Uint8`). */
  bitDepth?: number;
  /** Lossless encoding (ignores `quality`). Default false. */
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

/** A decoded AVIF image: 8-bit RGBA pixels plus dimensions (the DOM `ImageData` shape). */
export interface AvifDecodedImage {
  /** Row-major RGBA bytes, length `width * height * 4`. */
  data: Uint8ClampedArray;
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
}

type AvifDecoderModule = {
  decode(data: Uint8Array, bitDepth: 8): AvifDecodedImage | null;
};

let decoderWasm: Promise<WebAssembly.Module> | undefined;

/**
 * The decoder: the wasm is compiled once, but every call gets a fresh instance, so the memory a
 * large image grew is released with it instead of staying with the process.
 */
async function newDecoder(): Promise<AvifDecoderModule> {
  decoderWasm ??= WebAssembly.compileStreaming(
    fetch(new URL("./lib/avif_dec.wasm", import.meta.url)),
  ).catch((error) => {
    decoderWasm = undefined;
    throw error;
  });
  const wasmModule = await decoderWasm;
  // deno-lint-ignore no-explicit-any
  return await (decoderFactory as any)({
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
  }) as AvifDecoderModule;
}

/**
 * Decode an AVIF file (still image, or the first frame of an image sequence) to 8-bit RGBA.
 * Check the image's dimensions before calling it on untrusted input: the decoder allocates the
 * whole raster.
 *
 * @example Decode, then re-encode smaller
 * ```ts
 * import { decode } from "@denext/avif";
 * const { data, width, height } = await decode(await Deno.readFile("photo.avif"));
 * ```
 *
 * @param bytes The AVIF file.
 * @returns Its pixels and dimensions.
 * @throws {Error} When the bytes are not an AVIF image libavif can decode.
 */
export async function decode(bytes: Uint8Array | ArrayBuffer): Promise<AvifDecodedImage> {
  const module = await newDecoder();
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const image = module.decode(input, 8);
  if (!image) throw new Error("@denext/avif: AVIF decoding failed");
  // Copied out of the instance (and plain RGBA whatever ImageData class the glue used).
  return {
    data: new Uint8ClampedArray(image.data),
    width: image.width,
    height: image.height,
  };
}
