/**
 * The over-the-air (OTA) UI manifest shared by the build side (`denext export` with
 * `spa.ota`, `denext ota manifest <dir>`), any server that offers the UI, the
 * `denext/mobile` client (`checkForUiUpdate`) and the native `DenextOta` plugin.
 *
 * The manifest lists every file of a static export with its SHA-256 and size, and
 * stamps a `version` over them. All sides must derive the same version from the same
 * files, or a phone would re-download a UI it already bundles, so the algorithm is
 * pinned by a fixture test (`tests/ota-manifest.test.ts`):
 *
 * `version` = lowercase hex SHA-256 over the lines `"<path>\t<sha256>\n"`, sorted by
 * path (plain UTF-16 code-unit order, as `<` compares strings).
 *
 * Web-standard only (`crypto.subtle`), with no Deno APIs and nothing run at import, so the
 * client can use it without pulling in anything else.
 *
 * @module
 */

/** Where the manifest lives, relative to the web root it describes. */
export const OTA_MANIFEST_PATH = "_denext/ota.json";

/** One file of an OTA UI. */
export interface OtaManifestFile {
  /** Forward-slash path relative to the web root, e.g. `_denext/client/app.js`. */
  readonly path: string;
  /** Lowercase hex SHA-256 of the file's bytes. */
  readonly sha256: string;
  /** The file's size in bytes. */
  readonly size: number;
}

/** The `_denext/ota.json` document: a version stamped over the sorted file list. */
export interface OtaManifest {
  /** Lowercase hex SHA-256 over the sorted `"<path>\t<sha256>\n"` lines. */
  readonly version: string;
  /** Every file of the UI, sorted by path. */
  readonly files: ReadonlyArray<OtaManifestFile>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Whether `value` is a lowercase 64-digit hex string (a SHA-256, or a manifest version). */
function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/**
 * Files that never belong to the manifest: precompressed `*.gz` siblings (a webview never
 * requests them) and the manifest itself (it holds the version, so it cannot be part of
 * what the version covers).
 */
export function isExcludedFromOtaManifest(relativePath: string): boolean {
  return relativePath.endsWith(".gz") || relativePath === OTA_MANIFEST_PATH;
}

const byPath = (a: { readonly path: string }, b: { readonly path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** Lowercase hex of a digest. */
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lowercase hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** The manifest version: SHA-256 over the lines `"<path>\t<sha256>\n"`, sorted by path. */
export async function otaManifestVersion(
  files: ReadonlyArray<Pick<OtaManifestFile, "path" | "sha256">>,
): Promise<string> {
  const lines = [...files].sort(byPath).map((f) => `${f.path}\t${f.sha256}\n`).join("");
  return await sha256Hex(new TextEncoder().encode(lines));
}

/** Sort `files` by path and stamp the version over them. */
export async function makeOtaManifest(
  files: ReadonlyArray<OtaManifestFile>,
): Promise<OtaManifest> {
  const sorted = [...files].sort(byPath);
  return { version: await otaManifestVersion(sorted), files: sorted };
}

/** Whether `file` is a well-formed manifest entry (a non-empty path, a SHA-256, a size). */
function isManifestFile(file: unknown): file is OtaManifestFile {
  if (typeof file !== "object" || file === null) return false;
  const { path, sha256, size } = file as Record<string, unknown>;
  return typeof path === "string" && path !== "" && isSha256Hex(sha256) &&
    typeof size === "number" && Number.isInteger(size) && size >= 0;
}

/**
 * Whether `value` has the manifest's shape: a 64-hex `version` and a non-empty `files`
 * array of `{ path, sha256, size }`. It checks the shape only; the native side re-checks
 * every path before it writes anything.
 */
export function isOtaManifest(value: unknown): value is OtaManifest {
  if (typeof value !== "object" || value === null) return false;
  const { version, files } = value as Record<string, unknown>;
  return isSha256Hex(version) && Array.isArray(files) && files.length > 0 &&
    files.every(isManifestFile);
}
