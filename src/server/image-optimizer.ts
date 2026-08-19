// Self-hosted image optimization for the built-in `/_denext/image` endpoint,
// backed by `@denext/photon` (decode → resize) with WebP output, or AVIF
// (`@denext/avif`) negotiated from the `Accept` header when `images.formats`
// enables it. Local `public/` assets are optimized by default; remote sources
// require an explicit host allowlist (SSRF protection).

// The wasm-backed codecs (@denext/photon, @denext/avif) are imported LAZILY at
// call time, not at module top level — a static import pulls their .wasm into the
// esbuild browser prebuild of the next-compat runtime (which can't load .wasm),
// breaking `next/headers`/`next/image` aliasing (both reach server/mod.ts, which
// re-exports this module). Only the PhotonImage TYPE is imported statically (erased).
// Both are denext's own first-party JSR codecs (zero npm dependencies).
import type { PhotonImage as PhotonImageT } from "@denext/photon";
import { serveStatic } from "./static.ts";
import type { ImagesConfig, LocalPattern, RemotePattern } from "./config.ts";
import { isForbiddenAddress, makePinnedFetch, pinnedFetch } from "./safe-fetch.ts";

// The subset of `@denext/avif` denext calls. Typed structurally here so the lazy
// runtime `import()` (kept off the static graph — see the header note) doesn't
// require a static type import.
interface AvifModule {
  encode(
    data: { data: Uint8ClampedArray; width: number; height: number },
    options?: { quality?: number },
  ): Promise<ArrayBuffer>;
}

// Re-exported: the SSRF host guard lives in safe-fetch alongside the pinned fetch.
export { isForbiddenAddress } from "./safe-fetch.ts";

// Server-side cache of encoded output so a self-hosted deployment (no CDN in
// front) does not re-decode/resize/re-encode on every request. Byte-bounded LRU
// (Map insertion order): re-insert on hit, evict oldest until under the cap.
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const outputCache = new Map<string, Uint8Array>();
let outputCacheBytes = 0;

function cacheGet(key: string): Uint8Array | undefined {
  const hit = outputCache.get(key);
  if (hit) {
    outputCache.delete(key);
    outputCache.set(key, hit); // mark most-recently-used
  }
  return hit;
}

function cacheSet(key: string, bytes: Uint8Array): void {
  if (bytes.byteLength > CACHE_MAX_BYTES) return; // never cache a single huge item
  outputCache.set(key, bytes);
  outputCacheBytes += bytes.byteLength;
  while (outputCacheBytes > CACHE_MAX_BYTES) {
    const oldestKey = outputCache.keys().next().value;
    if (oldestKey === undefined) break;
    outputCacheBytes -= outputCache.get(oldestKey)!.byteLength;
    outputCache.delete(oldestKey);
  }
}

// Hardening limits for remote fetches and decoding (SSRF + resource exhaustion).
/** Default max redirect hops to follow for a remote source (each re-validated). */
const DEFAULT_MAX_REDIRECTS = 3;
/** Per-request timeout for a remote source fetch. */
const FETCH_TIMEOUT_MS = 10_000;
/** Max bytes to download for a remote source (declared or streamed). */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** Max decoded source pixels (guards against decompression bombs). */
const MAX_SOURCE_PIXELS = 40_000_000;
/** Max decoded source width/height. */
const MAX_SOURCE_DIMENSION = 12_000;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

// Default responsive width allowlist — Next's standard `deviceSizes ∪ imageSizes`.
// Only these widths (or a config override) are honored by `/_denext/image`; any
// other `w=` is refused before a decode, bounding the endpoint's distinct-work
// surface (an attacker can't enumerate thousands of arbitrary widths, each a fresh
// WASM decode/resize/encode).
/** Next's default `images.deviceSizes` (full-width breakpoints). */
export const DEFAULT_DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
/** Next 16's default `images.imageSizes` (icon/thumbnail widths; `16` was dropped). */
export const DEFAULT_IMAGE_SIZES = [32, 48, 64, 96, 128, 256, 384];
/** Next 16's default `images.qualities` — the only allowed `q=` value by default. */
export const DEFAULT_QUALITIES = [75];
/** Next 16's default `images.minimumCacheTTL` (seconds): 4 hours. */
export const DEFAULT_MIN_CACHE_TTL = 14_400;
/** Next's default `images.formats`: WebP only (add `"image/avif"` to enable AVIF). */
export const DEFAULT_FORMATS = ["image/webp"];

/**
 * Cap on concurrent optimizations (decode + resize + encode). Each is CPU- and
 * memory-heavy WASM work; without a ceiling a burst of distinct sources/widths
 * would spawn unbounded parallel decodes. Cache hits and the 400/404 fast paths
 * bypass the gate — only the actual heavy work is serialized behind it.
 */
const MAX_CONCURRENT_OPTIMIZATIONS = 4;

/** Options for {@linkcode optimizeImage}. */
export interface ImageOptimizeOptions {
  /** Directory of local static assets (for `url` values beginning with `/`). */
  publicDir?: string;
  /** Remote hosts allowed as image sources (empty → local-only, SSRF-safe). */
  allowedHosts?: string[];
  /** Pattern-based remote allowlist (protocol/host-wildcard/pathname). */
  remotePatterns?: RemotePattern[];
  /** Allowed local source patterns (pathname glob + optional query). Any when omitted. */
  localPatterns?: LocalPattern[];
  /** Allowed full-width breakpoints (defaults to {@linkcode DEFAULT_DEVICE_SIZES}). */
  deviceSizes?: number[];
  /** Allowed fixed widths (defaults to {@linkcode DEFAULT_IMAGE_SIZES}). */
  imageSizes?: number[];
  /** Allowed `q=` values; any other quality is coerced to the nearest. Defaults to `[75]`. */
  qualities?: number[];
  /** Minimum cache seconds for the `Cache-Control` header (defaults to `14400`). */
  minimumCacheTTL?: number;
  /** Output formats to negotiate from `Accept`, in preference order. Defaults to `["image/webp"]`. */
  formats?: string[];
  /** Max redirect hops for a remote source (defaults to `3`; `0` disables redirects). */
  maximumRedirects?: number;
  /** **Dangerous.** Allow remote sources resolving to loopback/private IPs (SSRF guard off). */
  dangerouslyAllowLocalIP?: boolean;
}

/** Rejection from a {@linkcode createGate} `acquire()` when the waiter queue is full. */
export class GateOverloadError extends Error {
  /** Create a gate-overload error. */
  constructor() {
    super("optimization queue full");
    this.name = "GateOverloadError";
  }
}

/**
 * A tiny FIFO semaphore: `acquire()` resolves when a slot is free, and the
 * returned function releases it (handing the slot to the next waiter). Bounds
 * concurrent image optimizations so the endpoint can't be turned into a
 * CPU-amplification lever.
 *
 * The waiter queue is itself bounded (`maxWaiters`): once that many requests are
 * already queued, `acquire()` rejects with a {@linkcode GateOverloadError} so the
 * caller can shed load (503 + Retry-After) instead of accumulating an unbounded
 * backlog of pending requests (and, before the gate, their source buffers).
 *
 * @param max Maximum concurrent holders.
 * @param maxWaiters Maximum queued waiters before `acquire()` sheds (defaults to `max * 8`).
 */
export function createGate(
  max: number,
  maxWaiters: number = max * 8,
): () => Promise<() => void> {
  let active = 0;
  const waiters: Array<() => void> = [];
  const release = (): void => {
    active--;
    const next = waiters.shift();
    if (next) {
      active++;
      next();
    }
  };
  return function acquire(): Promise<() => void> {
    if (active < max) {
      active++;
      return Promise.resolve(release);
    }
    if (waiters.length >= maxWaiters) {
      return Promise.reject(new GateOverloadError());
    }
    return new Promise<() => void>((resolve) => {
      waiters.push(() => resolve(release));
    });
  };
}

const optimizeGate = createGate(MAX_CONCURRENT_OPTIMIZATIONS);

/**
 * Does `url` satisfy the exact-host allowlist (`allowedHosts`/`images.domains`)
 * or any `remotePatterns` entry? The SSRF gate for remote image sources —
 * everything is refused when neither is configured.
 *
 * @param url The remote source URL.
 * @param opts The optimizer options carrying the allowlist.
 * @returns Whether the source may be fetched.
 */
export function isAllowedRemote(url: URL, opts: ImageOptimizeOptions): boolean {
  if ((opts.allowedHosts ?? []).includes(url.host)) return true;
  const proto = url.protocol.replace(/:$/, "");
  for (const p of opts.remotePatterns ?? []) {
    if (p.protocol && p.protocol !== proto) continue;
    const host = p.hostname.startsWith("*.")
      ? url.hostname.endsWith(p.hostname.slice(1)) // "*.example.com" → sub.example.com (not apex)
      : url.hostname === p.hostname;
    if (!host) continue;
    if (p.pathname && !url.pathname.startsWith(p.pathname)) continue;
    return true;
  }
  return false;
}

/**
 * Read an image's intrinsic pixel dimensions straight from its header bytes —
 * PNG, GIF, JPEG, and WebP — WITHOUT decoding it. Lets the optimizer reject a
 * decompression bomb (a tiny file that expands to an enormous raster) *before*
 * `new_from_byteslice` allocates the full bitmap. Returns null when the format
 * is unrecognized or the header is truncated; the caller then falls back to the
 * post-decode dimension guard.
 *
 * @param b The raw source bytes.
 * @returns The intrinsic `{ width, height }`, or null if it can't be read.
 */
export function probeImageDimensions(
  b: Uint8Array,
): { width: number; height: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG: 8-byte signature, then the IHDR chunk (width@16, height@20, BE u32).
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // GIF: "GIF8", then the logical-screen width@6 / height@8 (LE u16).
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  // JPEG: FFD8, then walk marker segments to the first SOF (frame dims, BE u16).
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let off = 2;
    while (off + 9 < b.length) {
      if (b[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = b[off + 1];
      if (marker === 0xff) {
        off++; // fill byte before a marker
        continue;
      }
      // SOF0..SOF15 carry the dimensions; skip DHT/DAC (C4/C8/CC).
      if (
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      ) {
        return { height: dv.getUint16(off + 5), width: dv.getUint16(off + 7) };
      }
      // Standalone markers with no length payload (SOI/EOI/RSTn).
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      const len = dv.getUint16(off + 2);
      if (len < 2) return null;
      off += 2 + len;
    }
    return null;
  }
  // WebP: "RIFF"…"WEBP" then a VP8 / VP8L / VP8X chunk.
  if (
    b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fourcc === "VP8X") {
      return {
        width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
        height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
      };
    }
    if (fourcc === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    }
    if (fourcc === "VP8L" && b[20] === 0x2f) {
      const b0 = b[21], b1 = b[22], b2 = b[23], b3 = b[24];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    return null;
  }
  return null;
}

/** Map a project's `images` config to {@linkcode ImageOptimizeOptions} (shared by dev/prod). */
export function imageOptionsFromConfig(
  images: ImagesConfig | undefined,
  publicDir?: string,
): ImageOptimizeOptions {
  return {
    publicDir,
    allowedHosts: images?.domains,
    remotePatterns: images?.remotePatterns,
    localPatterns: images?.localPatterns,
    deviceSizes: images?.deviceSizes,
    imageSizes: images?.imageSizes,
    qualities: images?.qualities,
    minimumCacheTTL: images?.minimumCacheTTL,
    formats: images?.formats,
    maximumRedirects: images?.maximumRedirects,
    dangerouslyAllowLocalIP: images?.dangerouslyAllowLocalIP,
  };
}

/** Convert a Next-style path glob (`*` = one segment, `**` = any) to an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Does a local source `src` (pathname + optional `?query`) satisfy `localPatterns`?
 * With no patterns configured, every local source is allowed (the default). A
 * pattern matches when its `pathname` glob matches and its `search` (if given)
 * equals the query exactly. Guards query-string enumeration of local assets.
 */
export function isAllowedLocal(src: string, patterns?: LocalPattern[]): boolean {
  if (!patterns || patterns.length === 0) return true;
  const q = src.indexOf("?");
  const pathname = q === -1 ? src : src.slice(0, q);
  const search = q === -1 ? "" : src.slice(q + 1);
  for (const p of patterns) {
    if (p.pathname !== undefined && !globToRegExp(p.pathname).test(pathname)) continue;
    if (p.search !== undefined && p.search !== search) continue;
    return true;
  }
  return false;
}

/** Read the source image bytes for `src`, or `null` when not found/forbidden. */
async function loadSource(src: string, opts: ImageOptimizeOptions): Promise<Uint8Array | null> {
  if (src.startsWith("/")) {
    if (!opts.publicDir) return null;
    // Enforce the local-source allowlist (enumeration guard) before touching disk.
    if (!isAllowedLocal(src, opts.localPatterns)) return null;
    // Reuse serveStatic's path-traversal guard, then take the bytes. Strip any
    // query string (localPatterns validated it) so the file lookup resolves.
    const asset = await serveStatic(opts.publicDir, src.split("?")[0]);
    if (!asset) return null;
    const b = new Uint8Array(await asset.arrayBuffer());
    // Byte-cap local sources too — a huge public/ file would otherwise be decoded
    // in full (remote sources are already bounded by readCapped).
    if (b.byteLength > MAX_SOURCE_BYTES) return null;
    return b;
  }
  // Remote source — only fetch allowlisted hosts.
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  return await fetchRemoteImage(url, opts);
}

/** The `fetch` signature {@linkcode fetchRemoteImage} depends on (injectable for tests). */
export type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

/**
 * Fetch a remote image source with the SSRF policy enforced on *every* hop:
 * redirects are followed manually and each destination must again be an allowed
 * remote (allowlist), use http(s), and not be a loopback/private/link-local IP
 * literal. The download is time- and size-bounded.
 *
 * The default `fetchImpl` ({@linkcode pinnedFetch}) additionally resolves the host,
 * rejects it if any resolved address is internal, and connects to that pinned IP —
 * closing DNS rebinding (an allowlisted name pointed at an internal address).
 *
 * @param start The initial (already-parsed) source URL.
 * @param opts The optimizer options carrying the allowlist.
 * @param fetchImpl Fetch implementation (defaults to the pinned, SSRF-safe fetch; injectable for tests).
 */
export async function fetchRemoteImage(
  start: URL,
  opts: ImageOptimizeOptions,
  fetchImpl?: FetchLike,
): Promise<Uint8Array | null> {
  const allowLocalIP = opts.dangerouslyAllowLocalIP === true;
  // Default to the pinned SSRF-safe fetch; under the (dangerous) local-IP escape
  // hatch, use a pinned fetch that skips the resolved-address guard.
  const doFetch = fetchImpl ??
    (allowLocalIP ? makePinnedFetch({ allowLocalIP: true }) : pinnedFetch);
  const maxRedirects = opts.maximumRedirects ?? DEFAULT_MAX_REDIRECTS;
  let url = start;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isAllowedRemote(url, opts)) return null;
    if (!allowLocalIP && isForbiddenAddress(url.hostname)) return null;

    let res: Response;
    try {
      res = await doFetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      return null;
    }

    if (REDIRECT_STATUS.has(res.status)) {
      const location = res.headers.get("location");
      try {
        await res.body?.cancel();
      } catch { /* ignore */ }
      if (!location) return null;
      try {
        url = new URL(location, url); // re-validated at the top of the next iteration
      } catch {
        return null;
      }
      continue;
    }
    if (!res.ok) return null;
    return await readCapped(res, MAX_SOURCE_BYTES);
  }
  return null; // too many redirects
}

/** Read a response body into memory, refusing anything over `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    return b.byteLength > max ? null : b;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Handle a `/_denext/image?url=…&w=…&q=…` request: load the source, resize to
 * the requested width (preserving aspect ratio), and return a webp response.
 *
 * @param request The optimization request.
 * @param opts Where to load sources from.
 */
/** Coerce a requested quality to the nearest allowed value (bounds the encode surface). */
export function coerceQuality(q: number, allowed: number[]): number {
  let best = allowed[0] ?? 75;
  let bestDist = Infinity;
  for (const a of allowed) {
    const d = Math.abs(a - q);
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  return best;
}

/**
 * Negotiate the output format from the request `Accept` header against the
 * configured `formats` (preference order). AVIF is chosen only when it is both
 * configured and accepted; otherwise WebP — denext's broadly-supported baseline —
 * is used (a client that accepts neither still gets WebP, as before).
 */
export function negotiateFormat(
  accept: string | null,
  formats: string[],
): "image/avif" | "image/webp" {
  const a = (accept ?? "").toLowerCase();
  if (formats.includes("image/avif") && a.includes("image/avif")) return "image/avif";
  return "image/webp";
}

/** Encode a resized image to the negotiated format (AVIF honors `quality`; WebP has no knob). */
async function encodeOutput(
  resized: PhotonImageT,
  width: number,
  height: number,
  format: string,
  quality: number,
): Promise<Uint8Array> {
  if (format === "image/avif") {
    // Lazy runtime import, kept off the static module graph (see the header note).
    // @denext/avif is denext's own first-party codec, so it is always resolvable —
    // no peer-codec guard needed (mirrors the @denext/photon load below).
    const { encode: encodeAvif } = await import("@denext/avif") as unknown as AvifModule;
    const raw = resized.get_raw_pixels(); // RGBA, width*height*4
    const data = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength);
    // @denext/avif honors `quality` (0..100, higher = better) directly.
    const buf = await encodeAvif({ data, width, height }, { quality });
    return new Uint8Array(buf);
  }
  // WebP baseline: @cf-wasm/photon's WebP encoder has no quality parameter.
  return resized.get_bytes_webp();
}

/**
 * True when the source bytes look like an SVG/XML document. The optimizer emits
 * only raster webp/avif, and Photon cannot rasterize SVG (it would fail the decode
 * and burn a WASM attempt), while an SVG can carry active script — so an SVG source
 * is refused outright rather than decoded. Sniff the leading bytes; never trust a
 * header or extension.
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  // Skip a UTF-8 BOM and leading ASCII whitespace, then look for "<svg" in the head.
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) i++;
    else break;
  }
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(i, i + 256))
    .toLowerCase();
  return head.includes("<svg");
}

/**
 * Handle a `/_denext/image` optimization request: validate the `url`/`w`/`q` params
 * against the configured allowlists (SSRF-safe fetch, local/remote patterns), decode
 * the source, and re-encode to a negotiated raster format (webp/avif) at the requested
 * width — returning the optimized `Response` (or an error response).
 *
 * @param request The incoming image-optimization request.
 * @param opts Resolved image config (allowed sizes/qualities, patterns, formats, …).
 * @param gate Concurrency gate to serialize the heavy work behind (defaults to the
 *   shared process gate; injectable for tests).
 * @returns The optimized image response, or an error response (400/…).
 */
export async function optimizeImage(
  request: Request,
  opts: ImageOptimizeOptions,
  gate: () => Promise<() => void> = optimizeGate,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const src = params.get("url");
  const width = Number(params.get("w"));
  if (!src || !Number.isInteger(width) || width <= 0) {
    return new Response("bad image request", { status: 400 });
  }
  // The width must be one of the configured breakpoints (deviceSizes ∪ imageSizes).
  // Refusing arbitrary widths caps the endpoint's distinct-work surface: a bounded
  // set of widths → a bounded number of decode/resize/encode operations per source,
  // instead of one per attacker-chosen integer up to 4000.
  const allowedWidths = new Set([
    ...(opts.deviceSizes ?? DEFAULT_DEVICE_SIZES),
    ...(opts.imageSizes ?? DEFAULT_IMAGE_SIZES),
  ]);
  if (!allowedWidths.has(width)) {
    return new Response(`width ${width} is not allowed`, { status: 400 });
  }

  // Coerce the requested quality to the nearest configured value: this bounds the
  // distinct-encode surface (at most |qualities| encodes per src+width+format),
  // just as the width allowlist bounds resizes. Defaults to Next 16's `[75]`.
  const requestedQ = Number(params.get("q"));
  const quality = coerceQuality(
    Number.isFinite(requestedQ) && requestedQ > 0 ? requestedQ : 75,
    opts.qualities ?? DEFAULT_QUALITIES,
  );
  // Negotiate the output format from Accept against the configured formats.
  const format = negotiateFormat(request.headers.get("accept"), opts.formats ?? DEFAULT_FORMATS);
  const ttl = opts.minimumCacheTTL ?? DEFAULT_MIN_CACHE_TTL;

  const headers = {
    "content-type": format,
    "cache-control": `public, max-age=${ttl}, immutable`,
    // Output depends on the Accept header (format negotiation) — key any shared
    // cache on it so an AVIF response is never served to a WebP-only client.
    "vary": "Accept",
  };

  // Serve from the server-side cache when we've already encoded this exact variant.
  // Cache hits skip the concurrency gate entirely — only the heavy first-encode
  // work below is serialized.
  const cacheKey = `${src}|${width}|${quality}|${format}`;
  const cached = cacheGet(cacheKey);
  if (cached) return new Response(cached as BodyInit, { headers });

  // Acquire the concurrency gate BEFORE loading the source. The source can be a
  // remote fetch of tens of MB, so gating only the decode (as before) let a burst
  // of concurrent requests hold that many large source buffers resident at once
  // and issue that many unbounded parallel network fetches (M2/M3). Gating first
  // caps both to MAX_CONCURRENT_OPTIMIZATIONS. Over the (bounded) queue cap, shed
  // load with 503 + Retry-After instead of accumulating a backlog.
  let release: () => void;
  try {
    release = await gate();
  } catch (err) {
    if (err instanceof GateOverloadError) {
      return new Response("image optimizer busy", {
        status: 503,
        headers: { "retry-after": "1" },
      });
    }
    throw err;
  }

  let img: PhotonImageT | undefined;
  let resized: PhotonImageT | undefined;
  try {
    const bytes = await loadSource(src, opts);
    if (!bytes) return new Response("image not found", { status: 404 });

    // Refuse an SVG source explicitly (CVE-2026-64644 class): the endpoint only
    // produces webp, Photon can't decode SVG, and an SVG can smuggle active script.
    if (looksLikeSvg(bytes)) return new Response("unsupported image type", { status: 400 });

    // Reject a decompression bomb from its header dimensions BEFORE decoding — the
    // decode itself is what allocates the full raster, so the post-decode check
    // below is too late for a hostile PNG/GIF/WebP. Unrecognized headers fall
    // through and are still caught by the post-decode guard.
    const probed = probeImageDimensions(bytes);
    if (
      probed &&
      (probed.width > MAX_SOURCE_DIMENSION || probed.height > MAX_SOURCE_DIMENSION ||
        probed.width * probed.height > MAX_SOURCE_PIXELS)
    ) {
      return new Response("image too large", { status: 413 });
    }

    const { PhotonImage, resize, SamplingFilter } = await import("@denext/photon");
    img = PhotonImage.new_from_byteslice(bytes);
    const sw = img.get_width();
    const sh = img.get_height();
    // Belt-and-suspenders: reject anything the header probe couldn't (unknown
    // format) before the CPU/memory-heavy resize.
    if (sw > MAX_SOURCE_DIMENSION || sh > MAX_SOURCE_DIMENSION || sw * sh > MAX_SOURCE_PIXELS) {
      return new Response("image too large", { status: 413 });
    }
    const height = Math.max(1, Math.round(width * (sh / sw)));
    resized = resize(img, width, height, SamplingFilter.Lanczos3);
    const out = await encodeOutput(resized, width, height, format, quality);
    cacheSet(cacheKey, out);
    return new Response(out as BodyInit, { headers });
  } catch (err) {
    console.error("denext: image optimization failed", err);
    return new Response("image optimization failed", { status: 500 });
  } finally {
    img?.free();
    resized?.free();
    release();
  }
}
