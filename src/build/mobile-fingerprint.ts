// `denext mobile fingerprint`: a stable hash of everything that makes a Capacitor app's native
// layer, so CI can tell a change that ships over the air (same fingerprint) from one that needs
// a new app binary (a different one). The Expo equivalent is `@expo/fingerprint`.
//
// Inputs, each one line of the hashed text:
//
// - every file under `ios/` and `android/`, minus build output, dependency caches, machine-local
//   files, and what `cap sync` copies in (the web UI, the copied capacitor.config.json); text
//   files hash with CRLF normalised to LF, so git's autocrlf does not change the result;
// - `capacitor.config.*` without its `server` block (which `denext mobile dev` edits);
// - the Capacitor packages (`@capacitor/core`, `ios`, `android`, `cli`) and every Capacitor or
//   Cordova plugin the project depends on, by name and installed version.
//
// The fingerprint is lowercase hex SHA-256 over `"denext-native-fingerprint-v1\n"` followed by
// the lines `"<key>\t<sha256>\n"` sorted by key (UTF-16 code-unit order, as the OTA version is
// computed): a file's key is its project-relative path and its hash the SHA-256 of its
// (normalised) bytes; a package's key is `npm:<name>` and its hash the SHA-256 of its version.
//
// `--write` embeds the fingerprint in the binary (Info.plist `DenextNativeFingerprint`,
// AndroidManifest `<meta-data android:name="dev.denext.native.FINGERPRINT">`), where the native
// OTA plugin compares it with a manifest's `nativeFingerprint`. Those two entries are removed
// before hashing, so writing them never changes the fingerprint.

import { basename, dirname, join } from "@std/path";
import { sha256Hex } from "../mobile/ota-manifest.ts";
import { capacitorConfigFile, withoutServerBlock } from "./mobile-dev.ts";
import {
  manifestMetaDataValue,
  plistEntry,
  plistTopDict,
  withManifestMetaData,
  withPlistString,
} from "./mobile-native-config.ts";

/** The Info.plist string key the iOS OTA plugin reads the binary's fingerprint from. */
export const NATIVE_FINGERPRINT_INFO_KEY = "DenextNativeFingerprint";
/** The AndroidManifest `<meta-data>` name the Android OTA plugin reads it from. */
export const NATIVE_FINGERPRINT_META = "dev.denext.native.FINGERPRINT";

/** The first line of the hashed text; a new algorithm gets a new tag. */
const FORMAT_TAG = "denext-native-fingerprint-v1\n";

/** One input of a fingerprint, as `--json` prints it. */
export type FingerprintInput =
  | {
    /** A file under `ios/` or `android/`, or the Capacitor config (`config`). */
    readonly kind: "file" | "config";
    /** Project-relative, forward-slash path. */
    readonly path: string;
    /** Lowercase hex SHA-256 of the (normalised) content. */
    readonly hash: string;
  }
  | {
    /** A `@capacitor/{core,ios,android,cli}` package, or a Capacitor / Cordova plugin. */
    readonly kind: "capacitor" | "plugin";
    /** The npm package name. */
    readonly name: string;
    /** Its installed version (`not installed (<range>)` for a missing `@capacitor/*`). */
    readonly version: string;
  };

/** The result of {@linkcode computeNativeFingerprint}. */
export interface NativeFingerprint {
  /** Lowercase hex SHA-256 over the sorted input lines. */
  readonly fingerprint: string;
  /** Every input, sorted by its line key. */
  readonly inputs: readonly FingerprintInput[];
  /** Dependencies that could not be resolved in `node_modules` (not part of the hash). */
  readonly warnings: readonly string[];
}

/** Directory names skipped wherever they appear: build output, caches, per-user state. */
const IGNORED_DIRS = new Set([
  ".build",
  ".cxx",
  ".externalNativeBuild",
  ".git",
  ".gradle",
  ".idea",
  ".swiftpm",
  "DerivedData",
  "Pods",
  "build",
  "capacitor-cordova-android-plugins",
  "capacitor-cordova-ios-plugins",
  "captures",
  "fastlane",
  "node_modules",
  "xcuserdata",
]);

/** File names skipped wherever they appear: machine-local or OS clutter. */
const IGNORED_FILES = new Set([".DS_Store", ".gitignore", "local.properties"]);

/** File (or bundle directory) suffixes skipped: build products, per-user state, signing material. */
const IGNORED_SUFFIXES = [
  ".aab",
  ".ap_",
  ".apk",
  ".class",
  ".dex",
  ".hprof",
  ".iml",
  ".ipa",
  ".jks",
  ".keystore",
  ".log",
  ".mobileprovision",
  ".p12",
  ".xcarchive",
  ".xcuserstate",
];

/**
 * Project-relative paths skipped with everything under them: what `cap sync` / `cap copy` write
 * (the web UI and the copied config, which the OTA channel and the config input cover), and the
 * output folders Xcode / Android Studio exports use.
 */
const IGNORED_PATHS = new Set([
  "android/app/debug",
  "android/app/release",
  "android/app/src/main/assets/capacitor.config.json",
  "android/app/src/main/assets/capacitor.plugins.json",
  "android/app/src/main/assets/public",
  "android/app/src/main/res/xml/config.xml",
  "ios/App/App/capacitor.config.json",
  "ios/App/App/config.xml",
  "ios/App/App/public",
  "ios/App/output",
]);

/** The Capacitor runtime packages, reported as kind `capacitor`. */
const CAPACITOR_PACKAGES = new Set([
  "@capacitor/android",
  "@capacitor/cli",
  "@capacitor/core",
  "@capacitor/ios",
]);

// deno-lint-ignore no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** Whether the project-relative `path` (a file or a directory) is left out of the fingerprint. */
export function isIgnoredNativePath(path: string): boolean {
  if (IGNORED_PATHS.has(path)) return true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return IGNORED_DIRS.has(name) || IGNORED_FILES.has(name) ||
    IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Every regular file under `dir` (as `prefix/…` paths), minus the ignored ones. */
async function nativeFiles(root: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(join(root, prefix)));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return out;
    throw err;
  }
  for (const entry of entries) {
    const rel = `${prefix}/${entry.name}`;
    if (isIgnoredNativePath(rel)) continue;
    if (CONTROL_CHARACTER.test(rel)) {
      throw new RangeError(`${JSON.stringify(rel)} holds a control character`);
    }
    // Symlinks are skipped: they can point outside the project (or at a build cache).
    if (entry.isDirectory) out.push(...await nativeFiles(root, rel));
    else if (entry.isFile) out.push(rel);
  }
  return out;
}

/** Whether `bytes` look like text: no NUL in the first 8000 bytes (git's heuristic). */
function isText(bytes: Uint8Array): boolean {
  return !bytes.subarray(0, 8000).includes(0);
}

/** The Info.plist fingerprint entry `--write` adds, with its line (removed before hashing). */
const PLIST_FINGERPRINT = new RegExp(
  `[ \\t]*<key>${NATIVE_FINGERPRINT_INFO_KEY}</key>\\s*<string>[^<]*</string>[ \\t]*\\n?`,
  "g",
);
/** The AndroidManifest fingerprint `<meta-data>` `--write` adds, with its line. */
const MANIFEST_FINGERPRINT = new RegExp(
  `[ \\t]*<meta-data\\b[^>]*android:name="${
    NATIVE_FINGERPRINT_META.replaceAll(".", "\\.")
  }"[^>]*/>[ \\t]*\\n?`,
  "g",
);

/**
 * The bytes a native file contributes: text with CRLF normalised to LF, and without the embedded
 * fingerprint (Info.plist / AndroidManifest.xml); binary files as they are.
 */
function normalisedContent(path: string, bytes: Uint8Array): Uint8Array {
  if (!isText(bytes)) return bytes;
  let text = new TextDecoder().decode(bytes).replaceAll("\r\n", "\n");
  if (path.endsWith("/Info.plist")) text = text.replace(PLIST_FINGERPRINT, "");
  else if (path.endsWith("/AndroidManifest.xml")) text = text.replace(MANIFEST_FINGERPRINT, "");
  return new TextEncoder().encode(text);
}

/** The first `node_modules/<name>` directory from `root` upwards (Node's resolution), if any. */
async function resolvePackageDir(root: string, name: string): Promise<string | undefined> {
  for (let dir = root;;) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    try {
      if ((await Deno.stat(join(candidate, "package.json"))).isFile) return candidate;
    } catch { /* not here */ }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** A file's existence. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** `dependencies` and `devDependencies` of the project's package.json, by name. */
async function declaredDependencies(root: string): Promise<Map<string, string>> {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await Deno.readTextFile(join(root, "package.json")));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return new Map();
    throw new Error(`${join(root, "package.json")}: ${err instanceof Error ? err.message : err}`);
  }
  const out = new Map<string, string>();
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field];
    if (typeof deps !== "object" || deps === null) continue;
    for (const [name, range] of Object.entries(deps)) out.set(name, String(range));
  }
  return out;
}

/**
 * The Capacitor packages and plugins the project depends on (the set `cap sync` links): each
 * declared dependency that resolves to `@capacitor/*`, to a package with a `capacitor` field, or
 * to a Cordova plugin (`plugin.xml`), with its installed version.
 */
async function nativePackages(
  root: string,
): Promise<{ inputs: FingerprintInput[]; warnings: string[] }> {
  const inputs: FingerprintInput[] = [];
  const warnings: string[] = [];
  for (const [name, range] of await declaredDependencies(root)) {
    const kind = CAPACITOR_PACKAGES.has(name) ? "capacitor" : "plugin";
    const dir = await resolvePackageDir(root, name);
    if (dir === undefined) {
      if (!name.startsWith("@capacitor/")) {
        warnings.push(`${name} is not installed; install dependencies before fingerprinting`);
        continue;
      }
      warnings.push(`${name} is not installed (declared ${range})`);
      inputs.push({ kind, name, version: `not installed (${range})` });
      continue;
    }
    const pkg = JSON.parse(await Deno.readTextFile(join(dir, "package.json"))) as {
      version?: unknown;
      capacitor?: unknown;
    };
    const native = name.startsWith("@capacitor/") || pkg.capacitor !== undefined ||
      await isFile(join(dir, "plugin.xml"));
    if (native) inputs.push({ kind, name, version: String(pkg.version ?? "") });
  }
  return { inputs, warnings };
}

/** The line key of an input. */
function keyOf(input: FingerprintInput): string {
  return "path" in input ? input.path : `npm:${input.name}`;
}

/** The hash on an input's line. */
async function lineHash(input: FingerprintInput): Promise<string> {
  return "hash" in input ? input.hash : await sha256Hex(new TextEncoder().encode(input.version));
}

const byKey = (a: FingerprintInput, b: FingerprintInput): number => {
  const [x, y] = [keyOf(a), keyOf(b)];
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * The fingerprint over `inputs`: SHA-256 over the format tag and the sorted
 * `"<key>\t<sha256>\n"` lines.
 *
 * @param inputs The inputs, in any order.
 * @returns Lowercase hex SHA-256.
 */
async function fingerprintOf(inputs: readonly FingerprintInput[]): Promise<string> {
  const lines: string[] = [];
  for (const input of [...inputs].sort(byKey)) {
    lines.push(`${keyOf(input)}\t${await lineHash(input)}\n`);
  }
  return await sha256Hex(new TextEncoder().encode(FORMAT_TAG + lines.join("")));
}

/**
 * Compute the native fingerprint of the Capacitor project at `root`.
 *
 * @param root The project directory (the folder holding `capacitor.config.*`).
 * @returns The fingerprint, its inputs, and dependency warnings.
 * @throws When `root` has no `capacitor.config.*`, or a native path holds a control character.
 */
export async function computeNativeFingerprint(root: string): Promise<NativeFingerprint> {
  const config = await capacitorConfigFile(root);
  if (!config) throw new Error(`no Capacitor project (capacitor.config.*) in ${root}`);
  const inputs: FingerprintInput[] = [];
  for (const path of [...await nativeFiles(root, "ios"), ...await nativeFiles(root, "android")]) {
    const bytes = await Deno.readFile(join(root, ...path.split("/")));
    inputs.push({ kind: "file", path, hash: await sha256Hex(normalisedContent(path, bytes)) });
  }
  const configName = basename(config);
  const configText = (await Deno.readTextFile(config)).replaceAll("\r\n", "\n");
  const withoutServer = await withoutServerBlock(config, configText);
  inputs.push({
    kind: "config",
    path: configName,
    hash: await sha256Hex(new TextEncoder().encode(withoutServer)),
  });
  const packages = await nativePackages(root);
  inputs.push(...packages.inputs);
  inputs.sort(byKey);
  return { fingerprint: await fingerprintOf(inputs), inputs, warnings: packages.warnings };
}

/** What changed between two fingerprints' inputs (see {@linkcode diffNativeFingerprints}). */
export interface FingerprintDiff {
  /** Whether the fingerprints differ. */
  readonly changed: boolean;
  /** The earlier and the current fingerprint. */
  readonly previous: string;
  readonly current: string;
  /** Inputs only in the current one. */
  readonly added: readonly FingerprintInput[];
  /** Inputs only in the earlier one. */
  readonly removed: readonly FingerprintInput[];
  /** Inputs in both whose hash / version differs. */
  readonly modified: ReadonlyArray<{ before: FingerprintInput; after: FingerprintInput }>;
}

/** Whether `value` is a `--json` fingerprint document (`{ fingerprint, inputs }`). */
export function isFingerprintDocument(
  value: unknown,
): value is { fingerprint: string; inputs: FingerprintInput[] } {
  if (typeof value !== "object" || value === null) return false;
  const { fingerprint, inputs } = value as Record<string, unknown>;
  return typeof fingerprint === "string" && Array.isArray(inputs) &&
    inputs.every((i) =>
      typeof i === "object" && i !== null &&
      (typeof (i as { path?: unknown }).path === "string" ||
        typeof (i as { name?: unknown }).name === "string")
    );
}

/** The value an input's line compares on (its hash, or its version). */
function valueOf(input: FingerprintInput): string {
  return "hash" in input ? input.hash : input.version;
}

/**
 * Which inputs were added, removed or modified between an earlier `--json` document and now.
 *
 * @param previous The earlier `{ fingerprint, inputs }`.
 * @param current The current one.
 * @returns The difference, each list sorted by key.
 */
export function diffNativeFingerprints(
  previous: { fingerprint: string; inputs: readonly FingerprintInput[] },
  current: { fingerprint: string; inputs: readonly FingerprintInput[] },
): FingerprintDiff {
  const before = new Map(previous.inputs.map((i) => [`${i.kind}\0${keyOf(i)}`, i]));
  const after = new Map(current.inputs.map((i) => [`${i.kind}\0${keyOf(i)}`, i]));
  const added = [...after].filter(([k]) => !before.has(k)).map(([, i]) => i).sort(byKey);
  const removed = [...before].filter(([k]) => !after.has(k)).map(([, i]) => i).sort(byKey);
  const modified = [...after]
    .filter(([k, i]) => before.has(k) && valueOf(before.get(k)!) !== valueOf(i))
    .map(([k, i]) => ({ before: before.get(k)!, after: i }))
    .sort((a, b) => byKey(a.after, b.after));
  return {
    changed: previous.fingerprint !== current.fingerprint,
    previous: previous.fingerprint,
    current: current.fingerprint,
    added,
    removed,
    modified,
  };
}

/** An input as one human-readable line: `file ios/App/App/Info.plist` / `plugin @x/y 1.2.0`. */
function describe(input: FingerprintInput): string {
  return "path" in input ? `${input.kind} ${input.path}` : `${input.kind} ${input.name}`;
}

/**
 * A diff as text: one line per changed input (`+` added, `-` removed, `~` modified), under a
 * verdict line.
 *
 * @param diff The diff.
 * @returns The lines, newline-joined.
 */
export function formatFingerprintDiff(diff: FingerprintDiff): string {
  if (!diff.changed) {
    return `  native fingerprint unchanged (${diff.current}): the change can ship over the air`;
  }
  const lines = [
    `  native fingerprint changed: ${diff.previous} → ${diff.current}`,
    "  this change needs a new app binary",
    "",
  ];
  for (const input of diff.added) {
    lines.push(`  + ${describe(input)}${"version" in input ? ` ${input.version}` : ""}`);
  }
  for (const input of diff.removed) {
    lines.push(`  - ${describe(input)}${"version" in input ? ` ${input.version}` : ""}`);
  }
  for (const { before, after } of diff.modified) {
    lines.push(
      `  ~ ${describe(after)}${
        "version" in after && "version" in before ? ` ${before.version} → ${after.version}` : ""
      }`,
    );
  }
  if (diff.added.length + diff.removed.length + diff.modified.length === 0) {
    lines.push("  (no input differs: the fingerprint algorithm or its format tag changed)");
  }
  return lines.join("\n");
}

/** What {@linkcode writeNativeFingerprint} did, as project-relative paths. */
export interface WriteFingerprintReport {
  /** The fingerprint written. */
  readonly fingerprint: string;
  /** Files changed. */
  readonly written: string[];
  /** Files that already carried it. */
  readonly unchanged: string[];
  /** Platforms without a native project (or without an editable file), with the reason. */
  readonly skipped: string[];
  /** Dependencies that could not be resolved (see {@linkcode NativeFingerprint.warnings}). */
  readonly warnings: readonly string[];
}

const IOS_INFO_PLIST = "ios/App/App/Info.plist";
const ANDROID_MANIFEST = "android/app/src/main/AndroidManifest.xml";

/** `plist`'s `DenextNativeFingerprint` string, if any. */
function plistFingerprint(plist: string): string | undefined {
  const top = plistTopDict(plist);
  return (top && plistEntry(plist, top, NATIVE_FINGERPRINT_INFO_KEY)?.value?.value) ?? undefined;
}

/** Read a file, or undefined when it is missing. */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

/** Write `fingerprint` into one native file with `inject`, recording the outcome in `report`. */
async function embedIn(
  root: string,
  rel: string,
  fingerprint: string,
  current: (text: string) => string | undefined,
  inject: (text: string) => string | null,
  report: WriteFingerprintReport,
): Promise<void> {
  const path = join(root, ...rel.split("/"));
  const text = await readOptional(path);
  if (text === undefined) return void report.skipped.push(`${rel} (not found)`);
  if (current(text) === fingerprint) return void report.unchanged.push(rel);
  const next = inject(text);
  if (next === null) return void report.skipped.push(`${rel} (no place to add it)`);
  await Deno.writeTextFile(path, next);
  report.written.push(rel);
}

/**
 * Compute the fingerprint of the project at `root` and embed it in the native projects: Info.plist
 * `DenextNativeFingerprint` and the AndroidManifest `<meta-data>` `dev.denext.native.FINGERPRINT`,
 * replacing an earlier value. Idempotent; the embedded values never change the fingerprint.
 *
 * @param root The Capacitor project.
 * @returns The fingerprint and what was written.
 */
export async function writeNativeFingerprint(root: string): Promise<WriteFingerprintReport> {
  const { fingerprint, warnings } = await computeNativeFingerprint(root);
  const report: WriteFingerprintReport = {
    fingerprint,
    written: [],
    unchanged: [],
    skipped: [],
    warnings,
  };
  await embedIn(
    root,
    IOS_INFO_PLIST,
    fingerprint,
    plistFingerprint,
    (t) => withPlistString(t, NATIVE_FINGERPRINT_INFO_KEY, fingerprint, true),
    report,
  );
  await embedIn(
    root,
    ANDROID_MANIFEST,
    fingerprint,
    (t) => manifestMetaDataValue(t, NATIVE_FINGERPRINT_META),
    (t) => withManifestMetaData(t, NATIVE_FINGERPRINT_META, fingerprint),
    report,
  );
  return report;
}
