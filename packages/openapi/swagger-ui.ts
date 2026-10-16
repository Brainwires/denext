/**
 * The vendored Swagger UI behind `openapi({ ui: "swagger" })`: `swagger-ui-dist`'s bundle and
 * stylesheet, copied verbatim into `vendor/swagger-ui/` and served from the app's own origin, so
 * the docs page loads nothing from a CDN and runs under a strict `script-src 'self'` CSP. Each
 * file's SHA-256 is recorded here and checked before it is served: bytes that differ (a bad
 * merge, a tampered re-vendor, a corrupted download from JSR) are refused, never run with the
 * app origin's trust.
 *
 * Re-vendor with `deno run -A scripts/vendor-swagger-ui.ts <version>`, which downloads the npm
 * tarball, checks its registry integrity and rewrites the files and the constants below.
 *
 * @module
 */

/** The `swagger-ui-dist` version vendored under `vendor/swagger-ui/` (Apache-2.0). */
export const SWAGGER_UI_VERSION = "5.32.15";

/** One vendored asset: its file, content type and recorded digest. */
export interface VendoredAsset {
  /** The file under `vendor/swagger-ui/`. */
  file: string;
  /** Its `content-type`. */
  contentType: string;
  /** SHA-256 (hex) of the exact upstream bytes. */
  sha256: string;
  /** Its byte length (a cheap first check). */
  bytes: number;
}

/** The assets the docs page loads, by the name it requests them under. */
export const SWAGGER_UI_ASSETS: Readonly<Record<string, VendoredAsset>> = {
  "swagger-ui-bundle.js": {
    file: "swagger-ui-bundle.js",
    contentType: "text/javascript; charset=utf-8",
    sha256: "a7e344f2770b2f07527ce828e0951626983b8f2dcdb7a826689c0232023f995b",
    bytes: 1552209,
  },
  "swagger-ui.css": {
    file: "swagger-ui.css",
    contentType: "text/css; charset=utf-8",
    sha256: "d7f39f764aa18c7b47dd05b9af5613e373e4ac0f3557c2693d52d0abc2464d76",
    bytes: 185784,
  },
};

/**
 * The page's own start-up script, served same-origin beside the bundle (an inline script would
 * need `'unsafe-inline'`): it reads the document URL off the mount point's `data-url`.
 */
export const SWAGGER_UI_INIT = `"use strict";
window.addEventListener("load", function () {
  var el = document.getElementById("swagger-ui");
  window.ui = SwaggerUIBundle({ url: el.getAttribute("data-url"), dom_id: "#swagger-ui" });
});
`;

/** Hex SHA-256 of `bytes`. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cache = new Map<string, Promise<Uint8Array>>();

/**
 * Read one vendored asset and check it against its recorded digest. `fetch` of the
 * module-relative URL works from a checkout (`file:`) and from JSR (`https:`).
 *
 * @param name A key of {@linkcode SWAGGER_UI_ASSETS}.
 * @returns The verified bytes.
 * @throws {Error} When the bytes do not match the recorded SHA-256.
 */
export function readSwaggerAsset(name: string): Promise<Uint8Array> {
  const asset = SWAGGER_UI_ASSETS[name];
  if (!asset) return Promise.reject(new Error(`no vendored Swagger UI asset ${name}`));
  let pending = cache.get(name);
  if (!pending) {
    pending = (async () => {
      const res = await fetch(new URL(`./vendor/swagger-ui/${asset.file}`, import.meta.url));
      const bytes = new Uint8Array(await res.arrayBuffer());
      const digest = bytes.byteLength === asset.bytes ? await sha256Hex(bytes) : "";
      if (digest !== asset.sha256) {
        throw new Error(
          `[@denext/openapi] vendor/swagger-ui/${asset.file} does not match its recorded SHA-256 ` +
            `(swagger-ui-dist ${SWAGGER_UI_VERSION}); refusing to serve it`,
        );
      }
      return bytes;
    })();
    // A failed read is not cached: the next request tries again.
    pending.catch(() => cache.delete(name));
    cache.set(name, pending);
  }
  return pending;
}
