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

import { readVerified, type VendoredAsset } from "./vendored.ts";

/** The `swagger-ui-dist` version vendored under `vendor/swagger-ui/` (Apache-2.0). */
export const SWAGGER_UI_VERSION = "5.32.15";

export type { VendoredAsset } from "./vendored.ts";

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

/**
 * Read one vendored asset and check it against its recorded digest. `fetch` of the
 * module-relative URL works from a checkout (`file:`) and from JSR (`https:`).
 *
 * @param name A key of {@linkcode SWAGGER_UI_ASSETS}.
 * @returns The verified bytes.
 * @throws {Error} When the bytes do not match the recorded SHA-256.
 */
export function readSwaggerAsset(name: string): Promise<Uint8Array> {
  if (!Object.hasOwn(SWAGGER_UI_ASSETS, name)) {
    return Promise.reject(new Error(`no vendored Swagger UI asset ${name}`));
  }
  const asset = SWAGGER_UI_ASSETS[name];
  return readVerified(
    new URL(`./vendor/swagger-ui/${asset.file}`, import.meta.url),
    asset,
    `swagger-ui-dist ${SWAGGER_UI_VERSION}`,
  );
}
