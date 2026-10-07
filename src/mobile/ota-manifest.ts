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
 * The optional `required` and `notes` fields describe the release for the app's own update
 * prompt (`prepareUiUpdate`). They are not part of what the version covers: two manifests
 * over the same files have the same version whatever their metadata says.
 *
 * The optional `sequence` and `minNative` integers are signed release metadata too: the native
 * plugin refuses a manifest whose `sequence` is lower than the highest it has accepted (code
 * `downgrade`), and one whose `minNative` is above the app binary's build number (code
 * `native_too_old`). The optional `nativeFingerprint` (`denext mobile fingerprint`) names the
 * native layer the UI was built for: a binary that embeds a different one refuses it (code
 * `native_mismatch`); either side without one skips that check.
 *
 * The optional `signature` binds the release to a key the app binary embeds: an ECDSA P-256 /
 * SHA-256 signature over {@linkcode otaSignaturePayload} (the version, `required`, a hash of
 * `notes`, `sequence` / `minNative` in the v2 format, and `nativeFingerprint` too in the v3
 * format), so neither the files nor the metadata can be swapped without the private key. The native plugin recomputes the version from the file
 * list and verifies the signature; the web side only forwards it.
 *
 * The optional `platform` names the target the export was built for (`denext export --platform
 * ios`, see https://denext.dev/docs/platform-files): `checkForUiUpdate` and the desktop updater
 * refuse a manifest built for another target (code `platform_mismatch`). A platform export
 * carries the stamp file {@linkcode OTA_PLATFORM_PATH} (its content is the target's name), which
 * the file list — and so the version and the signature — covers; the field must agree with it.
 * The field itself is not signed: a shell checks the stamp against its own target, so stripping
 * or changing the field cannot move a stamped export to another target. A manifest with neither
 * (a `web` export, which carries no stamp) is accepted by every shell.
 *
 * File paths may not contain control characters (U+0000–U+001F, U+007F): a path holding a tab or
 * a newline could otherwise forge the `"<path>\t<sha256>\n"` lines the version hashes.
 *
 * Web-standard only (`crypto.subtle`), with no Deno APIs and nothing run at import, so the
 * client can use it without pulling in anything else.
 *
 * @module
 */

/** Where the manifest lives, relative to the web root it describes. */
export const OTA_MANIFEST_PATH = "_denext/ota.json";

/**
 * The stamp a platform export carries (`denext export --platform <target>`), relative to the web
 * root: a file holding the target's name (`ios`). Listed like any file, so the signed version
 * covers it.
 */
export const OTA_PLATFORM_PATH = "_denext/platform.txt";

/**
 * The header a shell sends with its manifest request and file downloads to name its target, so a
 * server with one export per target (`createOtaHandler({ platforms })`) serves its own.
 */
export const OTA_PLATFORM_HEADER = "x-denext-ota-platform";

/** The targets a manifest's `platform` may name (`denext export --platform`). */
const OTA_PLATFORMS: readonly string[] = ["web", "ios", "android", "macos", "windows", "linux"];

/** Whether `value` names an export target (`web`, `ios`, `android`, `macos`, `windows`, `linux`). */
export function isOtaPlatform(value: unknown): value is string {
  return typeof value === "string" && OTA_PLATFORMS.includes(value);
}

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
  /**
   * Whether the app should not let the user decline this UI (`denext ota manifest --required`).
   * A hint for the app's own update prompt; absent means `false`. Not part of the version.
   */
  readonly required?: boolean;
  /**
   * Release notes for the app's update prompt (`denext ota manifest --notes <text>`), at most
   * {@linkcode OTA_NOTES_MAX_LENGTH} characters. Not part of the version.
   */
  readonly notes?: string;
  /**
   * A release counter that only grows (`denext ota manifest --sign` stamps the current Unix time
   * in seconds; `--sequence <n>` sets it). The native plugin remembers the highest one it accepted
   * and refuses a lower one, or a manifest without one after that (code `downgrade`). A
   * non-negative integer no larger than `Number.MAX_SAFE_INTEGER`. Not part of the version;
   * signed in the v2 payload.
   */
  readonly sequence?: number;
  /**
   * The lowest native build number (iOS `CFBundleVersion`, Android `versionCode`) this UI runs on
   * (`denext ota manifest --min-native <n>`). An older app binary refuses it before downloading
   * (code `native_too_old`). A non-negative safe integer. Not part of the version; signed in the
   * v2 payload.
   */
  readonly minNative?: number;
  /**
   * The native fingerprint of the app binary this UI was built for (`denext ota manifest
   * --native-fingerprint <fp|auto>`, the value `denext mobile fingerprint` prints): 64 lowercase
   * hex digits. A binary that embeds a fingerprint (`denext mobile fingerprint --write`) refuses
   * a manifest carrying a different one before downloading (code `native_mismatch`); when either
   * side has none, the check is skipped. Not part of the version; signed in the v3 payload.
   */
  readonly nativeFingerprint?: string;
  /**
   * The target the export was built for (`ios`, `android`, `macos`, `windows`, `linux`): a shell
   * of another target refuses it (code `platform_mismatch`). Must match the export's
   * {@linkcode OTA_PLATFORM_PATH} stamp, which the version covers; the field is not signed, so a
   * shell also checks the stamp itself. Absent with no stamp: a `web` export every shell accepts
   * (`web` names no stamp, so it is never written here).
   */
  readonly platform?: string;
  /**
   * Standard (padded) base64 of the raw 64-byte `r‖s` ECDSA P-256 / SHA-256 signature over
   * {@linkcode otaSignaturePayload} (`denext ota manifest --sign <keyfile>`). An app whose binary
   * embeds a public key refuses a manifest without a valid one.
   */
  readonly signature?: string;
  /** Every file of the UI, sorted by path. */
  readonly files: ReadonlyArray<OtaManifestFile>;
}

/** Release metadata a manifest may carry besides its files (see {@linkcode OtaManifest}). */
export interface OtaManifestMeta {
  /** See {@linkcode OtaManifest.required}. Omitted from the manifest unless `true`/`false`. */
  readonly required?: boolean;
  /** See {@linkcode OtaManifest.notes}. Omitted from the manifest unless a string. */
  readonly notes?: string;
  /** See {@linkcode OtaManifest.sequence}. Omitted from the manifest unless a number. */
  readonly sequence?: number;
  /** See {@linkcode OtaManifest.minNative}. Omitted from the manifest unless a number. */
  readonly minNative?: number;
  /** See {@linkcode OtaManifest.nativeFingerprint}. Omitted from the manifest unless a string. */
  readonly nativeFingerprint?: string;
  /**
   * See {@linkcode OtaManifest.platform}. The files must include the {@linkcode OTA_PLATFORM_PATH}
   * stamp holding the same name.
   */
  readonly platform?: string;
}

/** The longest `notes` a manifest may carry, in UTF-16 code units. */
export const OTA_NOTES_MAX_LENGTH = 2000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Whether `value` is a lowercase 64-digit hex string (a SHA-256, or a manifest version). */
function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/** Whether `value` is an integer in `0 … Number.MAX_SAFE_INTEGER` (a `sequence` / `minNative`). */
function isReleaseInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// deno-lint-ignore no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Whether `path` may name a file in an OTA manifest: a non-empty string without control
 * characters (U+0000–U+001F, U+007F). A tab or newline in a path could forge the
 * `"<path>\t<sha256>\n"` lines the version hashes, so every side refuses them. (Traversal is
 * refused separately, where a path is resolved.)
 */
export function isOtaManifestPath(path: unknown): path is string {
  return typeof path === "string" && path !== "" && !CONTROL_CHARACTER.test(path);
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

/**
 * The bytes an OTA manifest signature covers, as UTF-8 with `\n` (0x0A) separators and no
 * trailing newline. A manifest with a `nativeFingerprint` (and a `sequence`) uses the v3 format,
 * one with a `sequence` but no fingerprint v2, one without a `sequence` v1:
 *
 * - v3: `"denext-ota-v3\n" + version + "\n" + ("1" | "0") + "\n" + sha256hex(notes ?? "") + "\n"
 *   + sequence + "\n" + (minNative ?? "") + "\n" + nativeFingerprint`
 * - v2: `"denext-ota-v2\n" + version + "\n" + ("1" | "0") + "\n" + sha256hex(notes ?? "") + "\n"
 *   + sequence + "\n" + (minNative ?? "")`
 * - v1: `"denext-ota-v1\n" + version + "\n" + ("1" | "0") + "\n" + sha256hex(notes ?? "")`
 *
 * `"1"` is `required === true`, anything else `"0"`; `sha256hex` is lowercase hex of the SHA-256
 * of the notes' UTF-8 (the empty string when absent); `sequence` and `minNative` are plain
 * decimal integers (no sign, no leading zeros, no exponent), and an absent `minNative` is the
 * empty string; `nativeFingerprint` is 64 lowercase hex digits. The version already covers every
 * file, so the chain is files → version → signature, and none of the metadata can change under a
 * valid signature. The native `DenextOta` plugin builds the same bytes (v3 when the manifest has a
 * `sequence` and a `nativeFingerprint`, v2 with a `sequence` alone, else v1). A v2 manifest
 * (no fingerprint) is signed and verified exactly as before v3 existed.
 *
 * @param manifest The version and the signed metadata.
 * @returns The payload bytes.
 * @throws RangeError when `sequence` or `minNative` is not a non-negative safe integer, when
 *   `nativeFingerprint` is not 64 lowercase hex digits, or when `minNative` /
 *   `nativeFingerprint` is set without a `sequence` (v1 cannot carry them).
 * @example
 * ```ts
 * import { otaSignaturePayload } from "denext/mobile";
 * const bytes = await otaSignaturePayload({ version, required: true, sequence: 1758700000 });
 * // "denext-ota-v2\n<version>\n1\n<sha256 of "">\n1758700000\n"
 * ```
 */
export async function otaSignaturePayload(
  manifest: Pick<
    OtaManifest,
    "version" | "required" | "notes" | "sequence" | "minNative" | "nativeFingerprint"
  >,
): Promise<Uint8Array> {
  const notesHash = await sha256Hex(new TextEncoder().encode(manifest.notes ?? ""));
  const required = manifest.required === true ? "1" : "0";
  const { sequence, minNative, nativeFingerprint } = manifest;
  if (sequence === undefined) {
    if (minNative !== undefined || nativeFingerprint !== undefined) {
      throw new RangeError(
        "minNative and nativeFingerprint are only signed together with a sequence (payload v2/v3)",
      );
    }
    return new TextEncoder().encode(
      `denext-ota-v1\n${manifest.version}\n${required}\n${notesHash}`,
    );
  }
  if (!isReleaseInteger(sequence) || (minNative !== undefined && !isReleaseInteger(minNative))) {
    throw new RangeError("sequence and minNative must be non-negative safe integers");
  }
  const v2 = `${manifest.version}\n${required}\n${notesHash}\n${sequence}\n${minNative ?? ""}`;
  if (nativeFingerprint === undefined) return new TextEncoder().encode(`denext-ota-v2\n${v2}`);
  if (!isSha256Hex(nativeFingerprint)) {
    throw new RangeError("nativeFingerprint must be 64 lowercase hex digits");
  }
  return new TextEncoder().encode(`denext-ota-v3\n${v2}\n${nativeFingerprint}`);
}

/**
 * Sort `files` by path and stamp the version over them, adding `meta`'s `required`, `notes`,
 * `sequence`, `minNative` and `nativeFingerprint` when given (they never change the version).
 *
 * @throws RangeError when `meta.notes` is longer than {@linkcode OTA_NOTES_MAX_LENGTH}, when
 *   `sequence` / `minNative` is not a non-negative safe integer, when `nativeFingerprint` is not
 *   64 lowercase hex digits, or when a file path is not a valid manifest path
 *   ({@linkcode isOtaManifestPath}).
 */
export async function makeOtaManifest(
  files: ReadonlyArray<OtaManifestFile>,
  meta: OtaManifestMeta = {},
): Promise<OtaManifest> {
  assertOtaMeta(meta);
  if (meta.platform === "web") {
    // A `web` export carries no stamp, and its manifest names no target: every shell takes it.
    if (files.some((f) => f.path === OTA_PLATFORM_PATH)) {
      throw new RangeError(`a web export carries no ${OTA_PLATFORM_PATH} stamp`);
    }
    meta = { ...meta, platform: undefined };
  }
  if (meta.platform !== undefined) await assertPlatformStamp(files, meta.platform);
  const bad = files.find((f) => !isOtaManifestPath(f.path));
  if (bad) {
    throw new RangeError(
      `${
        JSON.stringify(bad.path)
      } cannot be listed in an OTA manifest (empty, or a control character)`,
    );
  }
  const sorted = [...files].sort(byPath);
  return { version: await otaManifestVersion(sorted), ...metaFields(meta), files: sorted };
}

/** Throw when `meta`'s notes are too long, or a number or the fingerprint is malformed. */
function assertOtaMeta(meta: OtaManifestMeta): void {
  if (typeof meta.notes === "string" && meta.notes.length > OTA_NOTES_MAX_LENGTH) {
    throw new RangeError(
      `the release notes are ${meta.notes.length} characters; the limit is ${OTA_NOTES_MAX_LENGTH}`,
    );
  }
  for (const key of ["sequence", "minNative"] as const) {
    const value = meta[key];
    if (value !== undefined && !isReleaseInteger(value)) {
      throw new RangeError(`${key} must be a non-negative safe integer, not ${value}`);
    }
  }
  if (meta.nativeFingerprint !== undefined && !isSha256Hex(meta.nativeFingerprint)) {
    throw new RangeError(
      `nativeFingerprint must be 64 lowercase hex digits, not ${
        JSON.stringify(meta.nativeFingerprint)
      }`,
    );
  }
}

/** The keys of `meta` a manifest carries: each one given with its type, in manifest order. */
function metaFields(meta: OtaManifestMeta): OtaManifestMeta {
  const isBoolean = (v: unknown) => typeof v === "boolean";
  const isString = (v: unknown) => typeof v === "string";
  const isNumber = (v: unknown) => typeof v === "number";
  const kinds: ReadonlyArray<[keyof OtaManifestMeta, (v: unknown) => boolean]> = [
    ["required", isBoolean],
    ["notes", isString],
    ["sequence", isNumber],
    ["minNative", isNumber],
    ["nativeFingerprint", isString],
    ["platform", isString],
  ];
  const out: Record<string, unknown> = {};
  for (const [key, is] of kinds) if (is(meta[key])) out[key] = meta[key];
  return out as OtaManifestMeta;
}

/** The SHA-256 the {@linkcode OTA_PLATFORM_PATH} stamp of `platform` has. */
function platformStampHash(platform: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(platform));
}

/** Throw unless `platform` is a target and `files` carry its stamp. */
async function assertPlatformStamp(
  files: ReadonlyArray<Pick<OtaManifestFile, "path" | "sha256">>,
  platform: string,
): Promise<void> {
  if (!isOtaPlatform(platform)) {
    throw new RangeError(`platform must be one of ${OTA_PLATFORMS.join(", ")}, not ${platform}`);
  }
  const stamp = files.find((f) => f.path === OTA_PLATFORM_PATH);
  if (stamp?.sha256 !== await platformStampHash(platform)) {
    throw new RangeError(
      `a ${platform} manifest needs the export's ${OTA_PLATFORM_PATH} stamp holding "${platform}"`,
    );
  }
}

/**
 * Why a shell of target `expected` must refuse `manifest`, or null when it may install it: the
 * manifest names another target, its `platform` disagrees with the {@linkcode OTA_PLATFORM_PATH}
 * stamp in its file list, or that stamp names another target. The stamp is what the version (and
 * so the signature) covers; the `platform` field is not signed, so the stamp decides whether or
 * not the field is present. A manifest with neither (an unstamped `web` export) fits every shell.
 * The refusal's code is `platform_mismatch`.
 *
 * @param manifest A manifest that passed {@linkcode isOtaManifest}.
 * @param expected The shell's target (`ios`, `android`, `macos`, `windows`, `linux`).
 */
export async function otaPlatformMismatch(
  manifest: Pick<OtaManifest, "platform" | "files">,
  expected: string,
): Promise<string | null> {
  const { platform } = manifest;
  const stamp = manifest.files.find((f) => f.path === OTA_PLATFORM_PATH);
  if (platform !== undefined && stamp?.sha256 !== await platformStampHash(platform)) {
    return `the manifest says ${platform}, but its files carry no matching ${OTA_PLATFORM_PATH}`;
  }
  if (platform !== undefined && platform !== expected) {
    return `the UI was built for ${platform}; this app runs on ${expected}`;
  }
  if (stamp !== undefined && stamp.sha256 !== await platformStampHash(expected)) {
    return `the UI's ${OTA_PLATFORM_PATH} stamp is another target's; this app runs on ${expected}`;
  }
  return null;
}

/**
 * Whether `file` is a well-formed manifest entry: a path without control characters
 * ({@linkcode isOtaManifestPath}), a SHA-256, a size.
 */
function isManifestFile(file: unknown): file is OtaManifestFile {
  if (typeof file !== "object" || file === null) return false;
  const { path, sha256, size } = file as Record<string, unknown>;
  return isOtaManifestPath(path) && isSha256Hex(sha256) &&
    typeof size === "number" && Number.isInteger(size) && size >= 0;
}

/**
 * Whether `value` has the manifest's shape: a 64-hex `version`, a non-empty `files` array of
 * `{ path, sha256, size }` (paths without control characters), and, when present, a boolean
 * `required`, a string `notes` of at most {@linkcode OTA_NOTES_MAX_LENGTH} characters,
 * non-negative safe-integer `sequence` / `minNative`, a 64-hex `nativeFingerprint`, and a string
 * `signature`. Other keys are ignored. It checks the shape only; the native side re-checks every
 * path, recomputes the version and verifies the signature before it downloads anything.
 */
export function isOtaManifest(value: unknown): value is OtaManifest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const { version, files } = record;
  return isSha256Hex(version) && Array.isArray(files) && files.length > 0 &&
    files.every(isManifestFile) &&
    Object.entries(OPTIONAL_FIELDS).every(([key, valid]) =>
      record[key] === undefined || valid(record[key])
    );
}

/** The manifest's optional fields, each with the check its value must pass when present. */
const OPTIONAL_FIELDS: Readonly<Record<string, (value: unknown) => boolean>> = {
  required: (v) => typeof v === "boolean",
  notes: (v) => typeof v === "string" && v.length <= OTA_NOTES_MAX_LENGTH,
  sequence: isReleaseInteger,
  minNative: isReleaseInteger,
  nativeFingerprint: isSha256Hex,
  platform: isOtaPlatform,
  signature: (v) => typeof v === "string",
};
