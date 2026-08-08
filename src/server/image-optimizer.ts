// Self-hosted image optimization for the built-in `/_denext/image` endpoint,
// backed by `@cf-wasm/photon` (decode → resize → re-encode as webp). Local
// `public/` assets are optimized by default; remote sources require an explicit
// host allowlist (SSRF protection).

import { PhotonImage, resize, SamplingFilter } from "@cf-wasm/photon";
import { serveStatic } from "./static.ts";

/** Options for {@linkcode optimizeImage}. */
export interface ImageOptimizeOptions {
  /** Directory of local static assets (for `url` values beginning with `/`). */
  publicDir?: string;
  /** Remote hosts allowed as image sources (empty → local-only, SSRF-safe). */
  allowedHosts?: string[];
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
  if (!(opts.allowedHosts ?? []).includes(url.host)) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
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

  const bytes = await loadSource(src, opts);
  if (!bytes) return new Response("image not found", { status: 404 });

  let img: PhotonImage | undefined;
  let resized: PhotonImage | undefined;
  try {
    img = PhotonImage.new_from_byteslice(bytes);
    const height = Math.max(1, Math.round(width * (img.get_height() / img.get_width())));
    resized = resize(img, width, height, SamplingFilter.Lanczos3);
    const webp = resized.get_bytes_webp();
    return new Response(webp as BodyInit, {
      headers: {
        "content-type": "image/webp",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    console.error("denext: image optimization failed", err);
    return new Response("image optimization failed", { status: 500 });
  } finally {
    img?.free();
    resized?.free();
  }
}
