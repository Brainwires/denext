/**
 * The vendored Scalar API reference behind `openapi({ ui: "scalar" })`:
 * `@scalar/api-reference`'s standalone browser bundle, copied verbatim into `vendor/scalar/` and
 * served from the app's own origin under a content-addressed URL
 * (`<docs>/scalar/standalone.<sha256 prefix>.js`, cached for a year), so the docs page loads
 * nothing from a CDN. The bundle's SHA-256 is recorded here and checked before it is served.
 *
 * The page boots it with {@linkcode SCALAR_BOOT}, an inline script the page's CSP admits by its
 * hash ({@linkcode SCALAR_BOOT_HASH}), never `'unsafe-inline'` script. The boot turns
 * off every call Scalar would make to its own services: the default web fonts
 * (`fonts.scalar.com`), telemetry, the agent chat, and the hosted request proxy
 * (`proxy.scalar.com`), so "try it" sends requests straight to the API.
 *
 * Re-vendor with `deno run -A scripts/vendor-scalar.ts <version>`, which downloads the npm
 * tarball, checks its registry integrity and rewrites the file and the constants below.
 *
 * @module
 */

import { readVerified, type VendoredAsset } from "./vendored.ts";

/** The `@scalar/api-reference` version vendored under `vendor/scalar/` (MIT). */
export const SCALAR_VERSION = "1.72.4";

/** The vendored standalone bundle. */
export const SCALAR_ASSET: VendoredAsset = {
  file: "standalone.js",
  contentType: "text/javascript; charset=utf-8",
  sha256: "f5ac0c3504a7ca77ca9fa96a6bb7c8f98b42c271864df35583f6ed9e6da40c23",
  bytes: 4381105,
};

/**
 * The file name the bundle is served under: content-addressed by its digest, so a re-vendor
 * changes the URL and the year-long `immutable` cache never serves a stale bundle.
 */
export const SCALAR_BUNDLE_NAME = `standalone.${SCALAR_ASSET.sha256.slice(0, 16)}.js`;

/**
 * The page's inline start-up script. It is the same text on every page (the document URL rides
 * the mount point's `data-url`), so the CSP admits it by hash instead of `'unsafe-inline'`.
 */
export const SCALAR_BOOT: string =
  `Scalar.createApiReference("#scalar-docs",{url:document.getElementById("scalar-docs").dataset.url,` +
  `withDefaultFonts:false,telemetry:false,agent:{disabled:true},` +
  `hideClientButton:true,showDeveloperTools:"never"});`;

/**
 * The CSP source admitting {@linkcode SCALAR_BOOT}: `'sha256-<base64>'` of its exact text (a
 * test recomputes it, so an edit to the boot cannot leave a stale hash behind).
 */
export const SCALAR_BOOT_HASH = "'sha256-V31v/+/IFaJ1ygP+dNeQ+n0XlX4ZWGjyo9hs3BarIw4='";

/**
 * Read the vendored bundle and check it against its recorded digest.
 *
 * @returns The verified bytes.
 * @throws {Error} When the bytes do not match the recorded SHA-256.
 */
export function readScalarBundle(): Promise<Uint8Array> {
  return readVerified(
    new URL(`./vendor/scalar/${SCALAR_ASSET.file}`, import.meta.url),
    SCALAR_ASSET,
    `@scalar/api-reference ${SCALAR_VERSION}`,
  );
}
