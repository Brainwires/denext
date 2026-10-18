/**
 * The vendored browser assets `@denext/openapi`'s interactive docs pages serve from the app's own
 * origin (Swagger UI, Scalar): each file's SHA-256 and length are recorded in source and checked
 * before the bytes are served, so bytes that differ (a bad merge, a tampered re-vendor, a
 * corrupted download from JSR) are refused, never run with the app origin's trust.
 *
 * @module
 */

/** One vendored asset: its file, content type and recorded digest. */
export interface VendoredAsset {
  /** The file under the renderer's `vendor/` directory. */
  file: string;
  /** Its `content-type`. */
  contentType: string;
  /** SHA-256 (hex) of the exact upstream bytes. */
  sha256: string;
  /** Its byte length (a cheap first check). */
  bytes: number;
}

/** Hex SHA-256 of `bytes`. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cache = new Map<string, Promise<Uint8Array>>();

/**
 * Read one vendored file and check it against its recorded digest. `fetch` of the
 * module-relative URL works from a checkout (`file:`) and from JSR (`https:`). A verified read is
 * cached per URL; a failed one is not (the next request tries again).
 *
 * @param url The file's module-relative URL.
 * @param asset Its recorded length and digest.
 * @param label What to name in the refusal (`swagger-ui-dist 5.32.15`).
 * @returns The verified bytes.
 * @throws {Error} When the bytes do not match the recorded SHA-256.
 */
export function readVerified(url: URL, asset: VendoredAsset, label: string): Promise<Uint8Array> {
  const key = url.href;
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const res = await fetch(url);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const digest = bytes.byteLength === asset.bytes ? await sha256Hex(bytes) : "";
      if (digest !== asset.sha256) {
        throw new Error(
          `[@denext/openapi] ${url.pathname.replace(/^.*\/vendor\//, "vendor/")} does not ` +
            `match its recorded SHA-256 (${label}); refusing to serve it`,
        );
      }
      return bytes;
    })();
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return pending;
}
