/**
 * `desktop.bundle.libraries`: the app's own native libraries (loaded with `Deno.dlopen`), one build
 * per target, which the package scripts copy into each bundle and the running app finds with
 * {@linkcode bundledLibraryPath}.
 *
 * This module is the part both sides share: the config's shape check
 * ({@linkcode desktopBundleLibrariesProblem}), each entry resolved for one target
 * ({@linkcode desktopLibrariesForTarget}), where a bundle keeps them
 * ({@linkcode desktopLibraryDir}), and the run-time lookup. The copy itself is
 * `src/build/desktop-bundle-libraries.ts`.
 *
 * Where the running app learns what it has: the desktop sync writes a table into
 * `.deno-desktop/config.json` (`bundledLibraries`: per target, each name's project-relative file),
 * which the generated `desktop.ts` imports and hands to `resolveDesktopCapabilities`, which
 * registers it here. So the lookup reads no file and needs no permission (a strict
 * `--allow-read` included). A `denext desktop run` / `dev` build's table also names the project
 * directory, and the lookup then answers the project's own file for the host.
 *
 * Runtime-safe (no build-time imports; Deno APIs only when called).
 *
 * @module
 */

/** A target a bundled library is built for: `"<os>-<arch>"`. */
export type DesktopLibraryTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "windows-arm64"
  | "windows-x64";

/** What one {@linkcode DesktopLibraryTarget} expands its placeholders to. */
export interface DesktopLibraryTargetInfo {
  /** `{os}`. */
  readonly os: "darwin" | "linux" | "windows";
  /** `{arch}`. */
  readonly arch: "arm64" | "x64";
  /** `{target}`: the Rust target triple denext's desktop builds use. */
  readonly triple: string;
  /** `{ext}`: the OS's shared-library extension. */
  readonly ext: "dylib" | "so" | "dll";
}

/** Every target, with its placeholder values. */
export const DESKTOP_LIBRARY_TARGETS: Readonly<
  Record<DesktopLibraryTarget, DesktopLibraryTargetInfo>
> = {
  "darwin-arm64": { os: "darwin", arch: "arm64", triple: "aarch64-apple-darwin", ext: "dylib" },
  "darwin-x64": { os: "darwin", arch: "x64", triple: "x86_64-apple-darwin", ext: "dylib" },
  "linux-arm64": { os: "linux", arch: "arm64", triple: "aarch64-unknown-linux-gnu", ext: "so" },
  "linux-x64": { os: "linux", arch: "x64", triple: "x86_64-unknown-linux-gnu", ext: "so" },
  "windows-arm64": { os: "windows", arch: "arm64", triple: "aarch64-pc-windows-msvc", ext: "dll" },
  "windows-x64": { os: "windows", arch: "x64", triple: "x86_64-pc-windows-msvc", ext: "dll" },
};

/** The targets, in a stable order. */
const TARGET_KEYS = Object.keys(DESKTOP_LIBRARY_TARGETS) as DesktopLibraryTarget[];

/** The config path every problem names. */
const FIELD = "desktop.bundle.libraries";

/** The placeholders a path pattern may use. */
const PLACEHOLDERS = ["os", "arch", "target", "ext"] as const;

/** A shared library's file name: `.dylib`, `.dll`, `.so` or a versioned `.so.N[.N…]`. */
const LIBRARY_FILE = /\.(?:dylib|dll|so(?:\.\d+)*)$/i;

/** A library name `bundledLibraryPath` takes. */
const LIBRARY_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** One entry resolved for one target. */
export interface DesktopLibraryResolution {
  /** The name `bundledLibraryPath` takes. */
  readonly name: string;
  /** The project-relative file, `/`-separated (no leading `./`). */
  readonly path: string;
  /** The file name inside the bundle (the path's last segment). */
  readonly file: string;
  /** Whether a missing file is skipped rather than failing packaging. */
  readonly optional: boolean;
}

/**
 * The table the desktop sync writes into `.deno-desktop/config.json` as `bundledLibraries`: for
 * each target, each library name's project-relative file (only files that exist), and for a
 * `denext desktop run` / `dev` build the absolute project directory.
 */
export interface BundledLibraryTable {
  /** Per target, name → project-relative file (`/`-separated). */
  readonly targets: Partial<Record<DesktopLibraryTarget, Record<string, string>>>;
  /** The project, for an unpackaged build (the lookup then answers the project's file). */
  readonly projectDir?: string;
}

/** A plain object (not an array, not `null`). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `path` with placeholders expanded for `target`. */
function expand(path: string, target: DesktopLibraryTarget): string {
  const t = DESKTOP_LIBRARY_TARGETS[target];
  return path.replace(
    /\{(os|arch|target|ext)\}/g,
    (_, key: string) => key === "target" ? t.triple : t[key as "os" | "arch" | "ext"],
  );
}

/** The last `/`-separated segment. */
function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `path` without a leading `./`. */
function stripDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

/**
 * Why a project-relative path (pattern) is unsafe, else `null`: empty, absolute, `\`-separated, an
 * empty / `.` / `..` segment (after an optional leading `./`), or an unknown `{placeholder}`.
 */
function pathProblem(path: unknown, allowPlaceholders: boolean): string | null {
  if (typeof path !== "string" || path.trim() === "") return "must be a non-empty path";
  return shapeProblem(path) ?? placeholderProblem(path, allowPlaceholders);
}

/** Why a path is absolute, `\`-separated or leaves the project, else `null`. */
function shapeProblem(path: string): string | null {
  if (/^(?:\/|[A-Za-z]:|\\\\)/.test(path)) return `must be relative to the project (got "${path}")`;
  if (path.includes("\\")) return `must use / separators (got "${path}")`;
  const segments = stripDotSlash(path).split("/");
  return segments.some((s) => s === "" || s === "." || s === "..")
    ? `must stay inside the project: no empty, "." or ".." segment (got "${path}")`
    : null;
}

/** Why a path's `{placeholders}` are unknown, unbalanced or not allowed here, else `null`. */
function placeholderProblem(path: string, allowed: boolean): string | null {
  const used = [...path.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  if (used.length > 0 && !allowed) return `cannot use placeholders (got "${path}")`;
  const unknown = used.find((name) => !(PLACEHOLDERS as readonly string[]).includes(name));
  if (unknown !== undefined) {
    return `has an unknown placeholder {${unknown}} (use {os}, {arch}, {target} or {ext})`;
  }
  return /[{}]/.test(path.replace(/\{(?:os|arch|target|ext)\}/g, ""))
    ? `has an unbalanced brace (got "${path}")`
    : null;
}

/**
 * A pattern's default name: its file name without the extension (`{ext}` or a library extension)
 * and a `lib` prefix; `null` when that leaves nothing or still holds a placeholder (the name would
 * differ per target).
 */
function defaultName(pattern: string): string | null {
  let base = lastSegment(pattern);
  base = base.endsWith(".{ext}") ? base.slice(0, -".{ext}".length) : base.replace(LIBRARY_FILE, "");
  if (base.startsWith("lib") && base.length > 3) base = base.slice(3);
  return LIBRARY_NAME.test(base) ? base : null;
}

/** An entry in its normal form: a name, a file per target (before existence), optional. */
interface NormalEntry {
  readonly name: string;
  readonly files: Partial<Record<DesktopLibraryTarget, string>>;
  readonly optional: boolean;
}

/** Unknown keys of an entry object, as a problem. */
function unknownKeys(
  entry: Record<string, unknown>,
  known: readonly string[],
  at: string,
): [string, string] | null {
  const extra = Object.keys(entry).find((k) => !known.includes(k));
  return extra === undefined
    ? null
    : [`${at}.${extra}`, `is not a key of a library entry (${known.join(", ")})`];
}

/** Why a file of `files` is not a shared library, as a problem at `at`, else `null`. */
function extensionProblem(
  files: Partial<Record<DesktopLibraryTarget, string>>,
  at: string,
): [string, string] | null {
  for (const t of TARGET_KEYS) {
    const file = files[t] === undefined ? undefined : lastSegment(files[t]!);
    if (file !== undefined && !LIBRARY_FILE.test(file)) {
      return [at, `must name a .dylib, .so (.so.N) or .dll file (got "${file}" for ${t})`];
    }
  }
  return null;
}

/** One `{ path, name?, optional? }` (or string) entry checked and normalized. */
function normalizePathEntry(
  entry: Record<string, unknown>,
  at: string,
): NormalEntry | [string, string] {
  const extra = unknownKeys(entry, ["path", "name", "optional"], at);
  if (extra) return extra;
  const problem = pathProblem(entry.path, true);
  if (problem) return [`${at}.path`, problem];
  const path = stripDotSlash(entry.path as string);
  const files: Partial<Record<DesktopLibraryTarget, string>> = {};
  for (const t of TARGET_KEYS) files[t] = expand(path, t);
  const ext = extensionProblem(files, at);
  if (ext) return ext;
  const name = entry.name === undefined ? defaultName(path) : entry.name;
  if (name === null) {
    return [
      at,
      `needs a name: the file name of "${path}" varies by target or makes no name ` +
      '(give the entry { path, name: "audio" })',
    ];
  }
  return { name: name as string, files, optional: entry.optional === true };
}

/** One `{ name, files, optional? }` entry checked and normalized. */
function normalizeFilesEntry(
  entry: Record<string, unknown>,
  at: string,
): NormalEntry | [string, string] {
  const extra = unknownKeys(entry, ["name", "files", "optional"], at);
  if (extra) return extra;
  if (entry.name === undefined) return [`${at}.name`, "is required with files"];
  if (!isRecord(entry.files) || Object.keys(entry.files).length === 0) {
    return [`${at}.files`, 'must map targets to files ({ "darwin-arm64": "native/libx.dylib" })'];
  }
  const files: Partial<Record<DesktopLibraryTarget, string>> = {};
  for (const [key, value] of Object.entries(entry.files)) {
    if (!(TARGET_KEYS as string[]).includes(key)) {
      return [`${at}.files.${key}`, `is not a target (${TARGET_KEYS.join(", ")})`];
    }
    const problem = pathProblem(value, false);
    if (problem) return [`${at}.files.${key}`, problem];
    files[key as DesktopLibraryTarget] = stripDotSlash(value as string);
  }
  const ext = extensionProblem(files, at);
  if (ext) return ext;
  return { name: entry.name as string, files, optional: entry.optional === true };
}

/** One entry of the list, checked and normalized. */
function normalizeEntry(entry: unknown, at: string): NormalEntry | [string, string] {
  if (typeof entry === "string") return normalizePathEntry({ path: entry }, at);
  if (!isRecord(entry)) {
    return [at, "must be a path pattern, { path, name?, optional? } or { name, files, optional? }"];
  }
  const shared = sharedKeysProblem(entry, at);
  if (shared) return shared;
  if (entry.files !== undefined) return normalizeFilesEntry(entry, at);
  if (entry.path !== undefined) return normalizePathEntry(entry, at);
  return [at, "needs a path (a pattern) or files (a per-target map)"];
}

/** Why an entry object's `path` / `files` / `optional` / `name` keys conflict or are malformed. */
function sharedKeysProblem(entry: Record<string, unknown>, at: string): [string, string] | null {
  if (entry.path !== undefined && entry.files !== undefined) {
    return [at, "takes path or files, not both"];
  }
  if (entry.optional !== undefined && typeof entry.optional !== "boolean") {
    return [`${at}.optional`, "must be a boolean"];
  }
  const name = entry.name;
  if (name !== undefined && (typeof name !== "string" || !LIBRARY_NAME.test(name))) {
    return [`${at}.name`, "must be a name of letters, digits, '.', '_', '+' or '-'"];
  }
  return null;
}

/** Whether a normalizer's result is a `[field, message]` problem. */
function isProblem<T>(v: T | [string, string]): v is [string, string] {
  return Array.isArray(v) && typeof v[0] === "string";
}

/** The normalized entries, or the first problem. */
function normalizeAll(value: unknown): NormalEntry[] | [string, string] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [FIELD, "must be an array of library entries"];
  const out: NormalEntry[] = [];
  for (const [i, entry] of value.entries()) {
    const normal = normalizeEntry(entry, `${FIELD}[${i}]`);
    if (isProblem(normal)) return normal;
    out.push(normal);
  }
  return out;
}

/** Why the entries' names or (per target) bundled file names collide, else `null`. */
function collisionProblem(entries: readonly NormalEntry[]): [string, string] | null {
  const names = new Map<string, number>();
  for (const [i, e] of entries.entries()) {
    const seen = names.get(e.name);
    if (seen !== undefined) {
      return [`${FIELD}[${i}]`, `repeats the name "${e.name}" of ${FIELD}[${seen}]`];
    }
    names.set(e.name, i);
  }
  for (const t of TARGET_KEYS) {
    const files = new Map<string, number>();
    for (const [i, e] of entries.entries()) {
      const path = e.files[t];
      if (path === undefined) continue;
      const file = lastSegment(path);
      // macOS and Windows file systems ignore case.
      const key = file.toLowerCase();
      const other = files.get(key);
      if (other !== undefined) {
        return [
          `${FIELD}[${i}]`,
          `bundles the file "${file}" for ${t}, as ${FIELD}[${other}] does (file names must be unique)`,
        ];
      }
      files.set(key, i);
    }
  }
  return null;
}

/**
 * Why `value` is not a valid `desktop.bundle.libraries`, as `[field, message]`, else `null`: each
 * entry a path pattern (a string or `{ path, name?, optional? }`) or `{ name, files, optional? }`,
 * every path relative to the project with no `..`, only the `{os}` / `{arch}` / `{target}` /
 * `{ext}` placeholders (patterns only), each file a `.dylib` / `.so` (`.so.N`) / `.dll`, names and
 * (per target) bundled file names unique.
 *
 * @param value The configured `desktop.bundle.libraries`.
 * @returns The problem, or `null`.
 */
export function desktopBundleLibrariesProblem(value: unknown): [string, string] | null {
  const entries = normalizeAll(value);
  return isProblem(entries) ? entries : collisionProblem(entries);
}

/**
 * Why `bundle` is not a valid `desktop.bundle`, as `[field, message]`, else `null`.
 *
 * @param bundle The configured `desktop.bundle`.
 * @returns The problem, or `null`.
 */
export function desktopBundleProblem(bundle: unknown): [string, string] | null {
  if (bundle === undefined) return null;
  if (!isRecord(bundle)) return ["desktop.bundle", "must be an object ({ libraries: [...] })"];
  const extra = Object.keys(bundle).find((k) => k !== "libraries");
  if (extra !== undefined) return [`desktop.bundle.${extra}`, "is not a key of desktop.bundle"];
  return desktopBundleLibrariesProblem(bundle.libraries);
}

/**
 * The entries of a valid `desktop.bundle.libraries` resolved for `target`: each one that names a
 * file for it, with its name, project-relative path and bundled file name. Throws on an invalid
 * value ({@linkcode desktopBundleLibrariesProblem}).
 *
 * @param value The configured `desktop.bundle.libraries`.
 * @param target The target packaged for.
 * @returns The libraries for that target, in entry order.
 * @throws {Error} When the value is invalid.
 */
export function desktopLibrariesForTarget(
  value: unknown,
  target: DesktopLibraryTarget,
): DesktopLibraryResolution[] {
  const problem = desktopBundleLibrariesProblem(value);
  if (problem) throw new Error(`invalid ${problem[0]}: ${problem[1]}`);
  const entries = normalizeAll(value) as NormalEntry[];
  return entries.flatMap((e) => {
    const path = e.files[target];
    return path === undefined
      ? []
      : [{ name: e.name, path, file: lastSegment(path), optional: e.optional }];
  });
}

/**
 * The target of an OS and architecture as `Deno.build` (or a package script) names them, or
 * `null` for one denext does not build desktop apps for.
 *
 * @param os `darwin`, `linux` or `windows`.
 * @param arch `aarch64` / `arm64`, or `x86_64` / `x64`.
 * @returns The target, or `null`.
 */
export function desktopLibraryTarget(os: string, arch: string): DesktopLibraryTarget | null {
  const a = arch === "aarch64" || arch === "arm64"
    ? "arm64"
    : arch === "x86_64" || arch === "x64"
    ? "x64"
    : null;
  if (a === null || (os !== "darwin" && os !== "linux" && os !== "windows")) return null;
  return `${os}-${a}`;
}

/**
 * Where a bundle keeps its libraries, relative to the bundle: `Contents/Frameworks` in a macOS
 * `.app` (so `@rpath` / `@executable_path/../Frameworks` install names resolve), `lib` in a Linux
 * bundle directory, and the bundle directory itself (beside the `.exe`) on Windows.
 *
 * @param os The target OS.
 * @returns The folder, `/`-separated (`""` for the bundle directory).
 */
export function desktopLibraryDir(os: "darwin" | "linux" | "windows"): string {
  return os === "darwin" ? "Contents/Frameworks" : os === "linux" ? "lib" : "";
}

/** The `Symbol.for` key the registered table lives under (one table per process). */
const REGISTRY_KEY = Symbol.for("denext.desktop.bundledLibraries");

/** Whether `v` is a {@linkcode BundledLibraryTable}. */
function isTable(v: unknown): v is BundledLibraryTable {
  return isRecord(v) && isRecord(v.targets) &&
    (v.projectDir === undefined || typeof v.projectDir === "string");
}

/**
 * Register the table the running app's lookup reads: `runtimeConfig.bundledLibraries` (what the
 * desktop sync writes into `.deno-desktop/config.json`). `resolveDesktopCapabilities` calls it; a
 * config without the table registers none (every lookup answers `null`).
 *
 * @param runtimeConfig The desktop entry's config (`.deno-desktop/config.json`).
 */
export function registerBundledLibraries(runtimeConfig: unknown): void {
  const table = isRecord(runtimeConfig) ? runtimeConfig.bundledLibraries : undefined;
  (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = isTable(table) ? table : undefined;
}

/** Where the lookup runs: the host and the running executable. */
export interface BundledLibraryHost {
  /** `Deno.build.os`. */
  readonly os: string;
  /** `Deno.build.arch`. */
  readonly arch: string;
  /** The running executable (`Deno.execPath()`), or `undefined` when it cannot be read. */
  readonly execPath: string | undefined;
}

/** The library folder of the packaged app `execPath` runs from, or `null` outside one. */
function packagedLibraryDir(os: string, execPath: string): string | null {
  const sep = os === "windows" ? /[\\/]/ : /\//;
  const parts = execPath.split(sep);
  const join = (...p: string[]) => p.join(os === "windows" ? "\\" : "/");
  if (os === "darwin") {
    // <X>.app/Contents/MacOS/<exe>
    const n = parts.length;
    if (
      n < 4 || parts[n - 2] !== "MacOS" || parts[n - 3] !== "Contents" ||
      !parts[n - 4].endsWith(".app")
    ) {
      return null;
    }
    return join(...parts.slice(0, n - 2), "Frameworks");
  }
  const dir = parts.slice(0, -1);
  if (dir.length === 0) return null;
  return os === "linux" ? join(...dir, "lib") : join(...dir);
}

/**
 * {@linkcode bundledLibraryPath} against an explicit table and host (the testable core).
 *
 * @param name The library's name.
 * @param table The registered table, or `undefined`.
 * @param host The host OS / arch and the running executable.
 * @returns The absolute path, or `null`.
 */
export function bundledLibraryPathIn(
  name: string,
  table: BundledLibraryTable | undefined,
  host: BundledLibraryHost,
): string | null {
  if (!table) return null;
  const target = desktopLibraryTarget(host.os, host.arch);
  const rel = target ? table.targets[target]?.[name] : undefined;
  if (typeof rel !== "string") return null;
  const sep = host.os === "windows" ? "\\" : "/";
  if (table.projectDir) {
    return table.projectDir.replace(/[\\/]+$/, "") + sep + rel.split("/").join(sep);
  }
  if (host.execPath === undefined) return null;
  const dir = packagedLibraryDir(host.os, host.execPath);
  return dir === null ? null : dir + sep + lastSegment(rel);
}

/**
 * The absolute path of the bundled native library `name` (a `desktop.bundle.libraries` entry) for
 * the running app: inside the packaged bundle (`Contents/Frameworks` on macOS, `lib/` beside the
 * executable on Linux, beside the `.exe` on Windows), or, in a `denext desktop run` / `dev` build,
 * the project's own file for the host OS and architecture. `null` when this build has no such
 * library for the host target, or outside a desktop app built from the generated entry (which
 * imports `.deno-desktop/config.json`). Reads no file: loading the library with `Deno.dlopen`
 * needs `--allow-ffi` (`desktop.extraPermissions: { ffi: ["*"] }`).
 *
 * @example
 * ```ts
 * import { bundledLibraryPath } from "denext/desktop";
 * const path = bundledLibraryPath("audio_ffi");
 * const lib = path ? Deno.dlopen(path, { level: { parameters: [], result: "f32" } }) : null;
 * ```
 *
 * @param name The library's name: an entry's `name`, else its file name without `lib` and the
 *   extension (`libaudio_ffi.dylib` → `audio_ffi`).
 * @returns The absolute path, or `null`.
 */
export function bundledLibraryPath(name: string): string | null {
  let execPath: string | undefined;
  try {
    execPath = Deno.execPath();
  } catch {
    execPath = undefined;
  }
  return bundledLibraryPathIn(
    name,
    (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] as BundledLibraryTable | undefined,
    { os: Deno.build.os, arch: Deno.build.arch, execPath },
  );
}
