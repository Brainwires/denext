// Self-hosted image optimization for the built-in `/_denext/image` endpoint,
// backed by `@cf-wasm/photon` (decode → resize → re-encode as webp). Local
// `public/` assets are optimized by default; remote sources require an explicit
// host allowlist (SSRF protection).

import { PhotonImage, resize, SamplingFilter } from "@cf-wasm/photon";
import { serveStatic } from "./static.ts";
import type { RemotePattern } from "./config.ts";
import { isForbiddenAddress, pinnedFetch } from "./safe-fetch.ts";

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
/** Max redirect hops to follow for a remote source (each re-validated). */
const MAX_REDIRECTS = 3;
/** Per-request timeout for a remote source fetch. */
const FETCH_TIMEOUT_MS = 10_000;
/** Max bytes to download for a remote source (declared or streamed). */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** Max decoded source pixels (guards against decompression bombs). */
const MAX_SOURCE_PIXELS = 40_000_000;
/** Max decoded source width/height. */
const MAX_SOURCE_DIMENSION = 12_000;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Options for {@linkcode optimizeImage}. */
export interface ImageOptimizeOptions {
  /** Directory of local static assets (for `url` values beginning with `/`). */
  publicDir?: string;
  /** Remote hosts allowed as image sources (empty → local-only, SSRF-safe). */
  allowedHosts?: string[];
  /** Pattern-based remote allowlist (protocol/host-wildcard/pathname). */
  remotePatterns?: RemotePattern[];
}

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

/** Read the source image bytes for `src`, or `null` when not found/forbidden. */
async function loadSource(src: string, opts: ImageOptimizeOptions): Promise<Uint8Array | null> {
  if (src.startsWith("/")) {
    if (!opts.publicDir) return null;
    // Reuse serveStatic's path-traversal guard, then take the bytes.
    const asset = await serveStatic(opts.publicDir, src);
    if (!asset) return null;
    return new Uint8Array(await asset.arrayBuffer());
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
  fetchImpl: FetchLike = pinnedFetch,
): Promise<Uint8Array | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isAllowedRemote(url, opts)) return null;
    if (isForbiddenAddress(url.hostname)) return null;

    let res: Response;
    try {
      res = await fetchImpl(url, {
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
export async function optimizeImage(
  request: Request,
  opts: ImageOptimizeOptions,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const src = params.get("url");
  const width = Number(params.get("w"));
  if (!src || !Number.isInteger(width) || width <= 0 || width > 4000) {
    return new Response("bad image request", { status: 400 });
  }

  const headers = {
    "content-type": "image/webp",
    "cache-control": "public, max-age=31536000, immutable",
  };

  // Serve from the server-side cache when we've already encoded this src+width.
  const cacheKey = `${src}|${width}`;
  const cached = cacheGet(cacheKey);
  if (cached) return new Response(cached as BodyInit, { headers });

  const bytes = await loadSource(src, opts);
  if (!bytes) return new Response("image not found", { status: 404 });

  let img: PhotonImage | undefined;
  let resized: PhotonImage | undefined;
  try {
    img = PhotonImage.new_from_byteslice(bytes);
    const sw = img.get_width();
    const sh = img.get_height();
    // Reject decompression bombs before the (CPU/memory-heavy) resize.
    if (sw > MAX_SOURCE_DIMENSION || sh > MAX_SOURCE_DIMENSION || sw * sh > MAX_SOURCE_PIXELS) {
      return new Response("image too large", { status: 413 });
    }
    const height = Math.max(1, Math.round(width * (sh / sw)));
    resized = resize(img, width, height, SamplingFilter.Lanczos3);
    const webp = resized.get_bytes_webp();
    cacheSet(cacheKey, webp);
    return new Response(webp as BodyInit, { headers });
  } catch (err) {
    console.error("denext: image optimization failed", err);
    return new Response("image optimization failed", { status: 500 });
  } finally {
    img?.free();
    resized?.free();
  }
}
