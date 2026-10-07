// Platform-specific files (`BigButton.ios.tsx`, `.android`, `.mobile`, `.macos` / `.windows` /
// `.linux`, `.desktop`, `.web`): React Native's platform extensions, resolved by denext's own
// bundlers for every app (`platformExtensions: false` turns them off).
//
// denext builds one export per target, and only where a target is chosen: `denext export
// --platform <target>`, `denext mobile build ios|android` and `denext desktop package` / `run`.
// Everything else (`build`, `start`, `dev`, a plain `export`) is the `web` target. Each target
// probes its suffixes most-specific first and ends with the plain file:
//
//   web      .web
//   ios      .ios → (.native) → .mobile → .web
//   android  .android → (.native) → .mobile → .web
//   macos    .macos → .desktop → .web          (windows, linux: the same, with their OS)
//
// `.native` is opt-in (`platformExtensions: { native: true }`): in React Native it means native
// code, which a WebView cannot run. In React Native mode the app's own `.ios` / `.android` files
// are native code too, so there they are opt-in as well (`{ osFiles: true }`).
//
// Only the app's OWN modules take a platform variant. A package in node_modules keeps its own
// resolution (React Native mode still probes `.web` there): React Native libraries ship
// `.ios.js` / `.android.js` files that call native modules, and must keep loading their web
// build inside the shell.
//
// Two resolvers apply it. The esbuild paths (SPA, React Native, the next-compat client and SSR
// bundles, unbundled dev) probe {@linkcode PlatformResolution.extensions} ahead of the plain
// ones ({@linkcode probePlatformSource}). The native App Router path (`deno bundle` for the
// client, Deno's own loader for the server render) cannot probe, so a scan of the project
// ({@linkcode scanPlatformGroups}) becomes import-map redirects keyed by file URL
// ({@linkcode platformRedirects}): the plain path, with and without its extension, maps to the
// target's variant.
//
// An import-map alias (`@/components/BigButton.tsx`, or an exact `"#button"` key) resolves
// through the project's import map FIRST, and the variant then applies to the file it names
// ({@linkcode resolvePlatformImport}, the one rule). The client side gets it as more import-map
// keys ({@linkcode aliasRedirects}: an import map applies once, so the alias itself must name
// the variant); the server render's copy loader follows aliases with the same rule.

import { walk } from "@std/fs";
import { getCookies } from "@std/http/cookie";
import { parse as parseJsonc } from "@std/jsonc";
import { basename, dirname, join, relative, resolve, toFileUrl } from "@std/path";
import type { DenextConfig } from "../server/config.ts";

/** A build target. */
export type Platform = "web" | "ios" | "android" | "macos" | "windows" | "linux";

/** Every build target, in the order the docs and `doctor` list them. */
export const PLATFORMS: readonly Platform[] = [
  "web",
  "ios",
  "android",
  "macos",
  "windows",
  "linux",
];

/** Every platform suffix a file may carry (`BigButton.<suffix>.tsx`). */
const PLATFORM_SUFFIXES: readonly string[] = [
  "web",
  "ios",
  "android",
  "mobile",
  "macos",
  "windows",
  "linux",
  "desktop",
  "native",
];

/** The source extensions a platform file may have, in probe order. */
const PLATFORM_SOURCE_EXTS: readonly string[] = [".tsx", ".ts", ".jsx", ".js", ".mjs"];

/** The environment variable a parent sets to choose the export's target (`--platform` wins). */
export const PLATFORM_ENV = "DENEXT_PLATFORM";

/** How one target resolves platform files. */
export interface PlatformResolution {
  /** The target. */
  readonly platform: Platform;
  /** Its suffixes, most specific first (`[".ios", ".mobile", ".web"]`). */
  readonly suffixes: readonly string[];
  /** Every suffix × source extension, in probe order (`.ios.tsx`, `.ios.ts`, …). */
  readonly extensions: readonly string[];
}

/** Whether `value` names a target. */
function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

/**
 * Parse a `--platform` / {@linkcode PLATFORM_ENV} value.
 *
 * @param value The raw value; `undefined` or empty is `web`.
 * @param source What set it, for the error (`--platform`).
 * @returns The target.
 * @throws When the value names no target.
 */
export function parsePlatform(value: string | undefined, source = "--platform"): Platform {
  if (value === undefined || value === "") return "web";
  if (isPlatform(value)) return value;
  throw new Error(
    `${source} must be one of ${PLATFORMS.join(", ")} (got ${JSON.stringify(value)})`,
  );
}

/** The target a Deno Desktop OS packages for (`Deno.build.os` spelling). */
export function desktopPlatform(os: string): Platform {
  if (os === "darwin" || os === "macos") return "macos";
  return os === "windows" ? "windows" : "linux";
}

/** The suffix family between the OS and `.web`: phones are `.mobile`, the rest `.desktop`. */
function familyOf(platform: Platform): string | null {
  if (platform === "web") return null;
  return platform === "ios" || platform === "android" ? ".mobile" : ".desktop";
}

/**
 * A target's suffixes, most specific first. Every list ends with `.web`.
 *
 * @param platform The target.
 * @param options `native`: probe `.native` after the OS on ios / android. `osFiles: false`
 *   leaves out the phone OS suffix (`.ios` / `.android`), as React Native mode does by default.
 */
export function platformSuffixes(
  platform: Platform,
  options: { native?: boolean; osFiles?: boolean } = {},
): string[] {
  const family = familyOf(platform);
  if (!family) return [".web"];
  const phone = family === ".mobile";
  const native = options.native && phone ? [".native"] : [];
  const os = phone && options.osFiles === false ? [] : [`.${platform}`];
  return [...os, ...native, family, ".web"];
}

/**
 * How `platform` resolves under `config`, or null when the app turned platform files off
 * (`platformExtensions: false`).
 *
 * @param config The app config.
 * @param platform The target (default `web`).
 */
export function platformResolution(
  config: DenextConfig | null | undefined,
  platform: Platform = "web",
): PlatformResolution | null {
  const option = config?.platformExtensions;
  if (option === false) return null;
  const native = typeof option === "object" && option?.native === true;
  // In React Native mode the app's `.ios` / `.android` files are native code: opt-in.
  const osFiles = !config?.reactNative || (typeof option === "object" && option?.osFiles === true);
  const suffixes = platformSuffixes(platform, { native, osFiles });
  const extensions = suffixes.flatMap((s) => PLATFORM_SOURCE_EXTS.map((e) => s + e));
  return { platform, suffixes, extensions };
}

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** `base` without a trailing source extension, or null when it has none. */
function stripSourceExt(base: string): string | null {
  for (const ext of PLATFORM_SOURCE_EXTS) {
    if (base.endsWith(ext) && base.length > ext.length) return base.slice(0, -ext.length);
  }
  return null;
}

/**
 * The platform variant an import with an explicit source extension (`./BigButton.tsx`, the
 * Deno spelling) resolves to, or null. An extensionless import is the extension probe's job.
 *
 * @param base The import's absolute path.
 * @param resolution The target's resolution.
 */
export function explicitVariant(base: string, resolution: PlatformResolution): string | null {
  const stem = stripSourceExt(base);
  if (stem === null) return null;
  for (const ext of resolution.extensions) {
    if (isFile(stem + ext)) return stem + ext;
  }
  return null;
}

/** One platform file: its suffix (without the dot) and absolute path. */
export interface PlatformVariant {
  readonly suffix: string;
  readonly file: string;
}

const VARIANT_NAME = new RegExp(
  `^(.+)\\.(${PLATFORM_SUFFIXES.join("|")})(${
    PLATFORM_SOURCE_EXTS.map((e) => e.replace(".", "\\.")).join("|")
  })$`,
);

/**
 * Split a file name into its stem and platform suffix (`BigButton.ios.tsx` → `BigButton`,
 * `ios`), or null when it carries none.
 */
export function splitPlatformName(name: string): { stem: string; suffix: string } | null {
  const m = VARIANT_NAME.exec(name);
  return m ? { stem: m[1], suffix: m[2] } : null;
}

/**
 * The platform files beside an extensionless (or explicitly extended) import path:
 * `…/BigButton` → `BigButton.ios.tsx`, `BigButton.android.tsx`.
 *
 * @param base The import's absolute path.
 */
export function platformVariantsOf(base: string): PlatformVariant[] {
  const stem = stripSourceExt(base) ?? base;
  const dir = dirname(stem);
  const name = basename(stem);
  const out: PlatformVariant[] = [];
  try {
    for (const entry of Deno.readDirSync(dir)) {
      const split = entry.isFile ? splitPlatformName(entry.name) : null;
      if (split?.stem === name) out.push({ suffix: split.suffix, file: join(dir, entry.name) });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The error for an import whose module exists only as other targets' variants.
 *
 * @param spec The import as written (`./BigButton`).
 * @param variants Its platform files.
 * @param resolution The target being built.
 */
export function missingVariantMessage(
  spec: string,
  variants: readonly PlatformVariant[],
  resolution: PlatformResolution,
): string {
  const suffixes = [...new Set(variants.map((v) => `\`.${v.suffix}\``))];
  const sample = variants[0]?.file ?? spec;
  const split = splitPlatformName(basename(sample));
  const stem = split?.stem ?? basename(spec);
  const ext = sample.slice(sample.lastIndexOf("."));
  const own = resolution.suffixes[0];
  return `\`${spec}\` has ${listOf(suffixes)} variant${suffixes.length === 1 ? "" : "s"} but ` +
    `none for ${resolution.platform}: add \`${stem}${ext}\` or \`${stem}${own}${ext}\``;
}

/**
 * Probe an app import for its platform file: an explicit source extension takes the target's
 * variant first; an extensionless import probes the platform extensions ahead of `defaults`.
 *
 * @param base The import's absolute path.
 * @param resolution The target's resolution, or null when platform files are off.
 * @param probe The plain probe (`probeSourceFile`), given the extension list to try.
 * @param defaults The plain extensions.
 */
export function probePlatformSource(
  base: string,
  resolution: PlatformResolution | null,
  probe: (base: string, exts: readonly string[]) => string | null,
  defaults: readonly string[],
): string | null {
  if (!resolution) return probe(base, defaults);
  return explicitVariant(base, resolution) ??
    probe(base, [...resolution.extensions, ...defaults]);
}

/** A module that has platform files: its extensionless path, plain file and variants. */
export interface PlatformGroup {
  /** The extensionless absolute path (`…/BigButton`). */
  readonly stem: string;
  /** The plain file (`BigButton.tsx`), or null when only variants exist. */
  readonly plain: string | null;
  /** Its platform files. */
  readonly variants: readonly PlatformVariant[];
}

/**
 * Folders a platform scan never enters: dependencies and denext's output anywhere, and the
 * project root's own output folders and native shells (`out/`, `dist/`, `ios/`, `android/`).
 * Anchored at the root, so a project that itself lives under a folder named `android` scans.
 */
function scanSkip(root: string): RegExp[] {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    /[/\\](?:node_modules|\.denext|\.git)(?:[/\\]|$)/,
    new RegExp(`^${escaped}[/\\\\](?:out|dist|ios|android|coverage)(?:[/\\\\]|$)`),
  ];
}

/**
 * The app's own source modules under `rootDir` (absolute paths): every file a platform file
 * scan considers, outside dependencies, denext's output and the native shells.
 *
 * @param rootDir The project root.
 */
export async function* projectSourceFiles(rootDir: string): AsyncGenerator<string> {
  const root = resolve(rootDir);
  for await (
    const entry of walk(root, {
      includeDirs: false,
      exts: PLATFORM_SOURCE_EXTS.map((e) => e.slice(1)),
      skip: scanSkip(root),
    })
  ) yield entry.path;
}

/**
 * Every module under `rootDir` with platform files (the native App Router path's redirect
 * source, and `doctor`'s gap report).
 *
 * @param rootDir The project root.
 */
export async function scanPlatformGroups(rootDir: string): Promise<PlatformGroup[]> {
  const byStem = new Map<string, PlatformVariant[]>();
  for await (const path of projectSourceFiles(rootDir)) {
    const split = splitPlatformName(basename(path));
    if (!split) continue;
    const stem = join(dirname(path), split.stem);
    const list = byStem.get(stem) ?? [];
    list.push({ suffix: split.suffix, file: path });
    byStem.set(stem, list);
  }
  return [...byStem].sort(([a], [b]) => a.localeCompare(b)).map(([stem, variants]) => ({
    stem,
    plain: PLATFORM_SOURCE_EXTS.map((e) => stem + e).find(isFile) ?? null,
    variants: variants.sort((a, b) => a.file.localeCompare(b.file)),
  }));
}

/**
 * The file `group` resolves to for a target: its most specific variant, else the plain file,
 * else null (a gap).
 */
export function chooseVariant(group: PlatformGroup, resolution: PlatformResolution): string | null {
  for (const suffix of resolution.suffixes) {
    for (const ext of PLATFORM_SOURCE_EXTS) {
      const hit = group.variants.find((v) => v.file === group.stem + suffix + ext);
      if (hit) return hit.file;
    }
  }
  return group.plain;
}

/**
 * The import-map redirects that make Deno's resolver (`deno bundle`, `deno info`, a server
 * loader) pick each group's variant for a target: the plain path's file URL, with and without
 * each source extension, maps to the variant's. A group whose target is the plain file
 * contributes nothing.
 *
 * @param groups The scan.
 * @param resolution The target's resolution, or null (no redirects).
 */
export function platformRedirects(
  groups: readonly PlatformGroup[],
  resolution: PlatformResolution | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!resolution) return out;
  for (const group of groups) {
    const target = chooseVariant(group, resolution);
    if (!target || target === group.plain) continue;
    const url = toFileUrl(target).href;
    out[toFileUrl(group.stem).href] = url;
    for (const ext of PLATFORM_SOURCE_EXTS) out[toFileUrl(group.stem + ext).href] = url;
  }
  return out;
}

/**
 * A project's local import-map aliases, longest key first: each key (exact, or a prefix ending
 * in `/`) with the file URL it maps to. Only entries that name a local path count (`./`, `../`,
 * `/`, `file:`); package and remote entries never reach an app module.
 */
export type ImportAliases = ReadonlyArray<readonly [key: string, url: string]>;

/** `value`'s string entries, when it is a JSON object. */
function stringEntries(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string");
}

/** The local aliases among an import map's `imports`, resolved against `base`. */
function localAliases(imports: unknown, base: URL): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of stringEntries(imports)) {
    const local = value.startsWith("./") || value.startsWith("../") || value.startsWith("/") ||
      value.startsWith("file:");
    if (!local || key.endsWith("/") !== value.endsWith("/")) continue;
    out.push([key, new URL(value, base).href]);
  }
  return out;
}

/**
 * The project's local import-map aliases ({@linkcode ImportAliases}): `deno.json(c)`'s `imports`,
 * or the local import map file its `importMap` names. Empty when there is none.
 *
 * @param projectDir The project root.
 */
export async function readImportAliases(projectDir: string): Promise<ImportAliases> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const path = join(resolve(projectDir), name);
    let config: unknown;
    try {
      config = parseJsonc(await Deno.readTextFile(path));
    } catch {
      continue;
    }
    const configUrl = toFileUrl(path);
    const named = (config as { importMap?: unknown } | null)?.importMap;
    let aliases: Array<[string, string]>;
    if (typeof named === "string") {
      const mapUrl = new URL(named, configUrl);
      if (mapUrl.protocol !== "file:") return [];
      try {
        const map = parseJsonc(await Deno.readTextFile(mapUrl)) as { imports?: unknown } | null;
        aliases = localAliases(map?.imports, mapUrl);
      } catch {
        return [];
      }
    } else {
      aliases = localAliases((config as { imports?: unknown } | null)?.imports, configUrl);
    }
    return aliases.sort(([a], [b]) => b.length - a.length || a.localeCompare(b));
  }
  return [];
}

/**
 * The file URL a bare specifier names through the project's aliases (an exact key, else the
 * longest prefix key, as an import map applies them), or null when no local alias covers it.
 *
 * @param spec The specifier as written.
 * @param aliases {@linkcode readImportAliases}.
 */
export function resolveImportAlias(spec: string, aliases: ImportAliases): string | null {
  for (const [key, url] of aliases) {
    if (key === spec) return url;
    if (key.endsWith("/") && spec.startsWith(key)) {
      try {
        return new URL(spec.slice(key.length), url).href;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The one rule both sides of a native App Router build resolve an app import by: a relative
 * specifier against its importer, a bare one through the project's aliases, and then the
 * target's platform redirect for the file it names. Null for a specifier that names no app
 * file (a package, `node:`, a remote URL).
 *
 * @param spec The specifier as written.
 * @param importerUrl The importing module's URL.
 * @param aliases {@linkcode readImportAliases}.
 * @param redirects {@linkcode platformRedirects} for the target.
 * @returns `url`, the file the specifier names, and `target`, the module the target loads.
 */
export function resolvePlatformImport(
  spec: string,
  importerUrl: string,
  aliases: ImportAliases,
  redirects: Readonly<Record<string, string>>,
): { url: string; target: string } | null {
  const relativeSpec = spec.startsWith("./") || spec.startsWith("../");
  const url = relativeSpec ? new URL(spec, importerUrl).href : resolveImportAlias(spec, aliases);
  if (url === null || !url.startsWith("file:")) return null;
  return { url, target: redirects[url] ?? url };
}

/**
 * The import-map keys that make each alias spelling of a redirected file name its variant, for
 * the client bundle and the module-graph crawls (an import map applies once, so the file-URL
 * redirect alone never sees `@/components/BigButton.tsx`). Each key resolves, by
 * {@linkcode resolvePlatformImport}'s rule, to the redirect's target.
 *
 * @param aliases {@linkcode readImportAliases}.
 * @param redirects {@linkcode platformRedirects} for the target.
 */
export function aliasRedirects(
  aliases: ImportAliases,
  redirects: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(redirects)) {
    for (const [key, url] of aliases) {
      if (!key.endsWith("/")) {
        if (url === from) out[key] = to;
      } else if (from.startsWith(url)) {
        const spelled = key + decodeURIComponent(from.slice(url.length));
        // Only where the import map would resolve the spelling through THIS key.
        if (resolveImportAlias(spelled, aliases) === from) out[spelled] = to;
      }
    }
  }
  return out;
}

/**
 * {@linkcode platformRedirects} for a project and target: scans `projectDir`, empty when the
 * app has no platform files or turned them off. The project's import-map aliases that reach a
 * redirected file get keys of their own ({@linkcode aliasRedirects}).
 *
 * @param projectDir The project root.
 * @param config The app config.
 * @param platform The target.
 */
export async function projectPlatformRedirects(
  projectDir: string,
  config: DenextConfig | null | undefined,
  platform: Platform = "web",
): Promise<Record<string, string>> {
  const resolution = platformResolution(config, platform);
  if (!resolution) return {};
  const redirects = platformRedirects(await scanPlatformGroups(projectDir), resolution);
  if (Object.keys(redirects).length === 0) return redirects;
  return { ...redirects, ...aliasRedirects(await readImportAliases(projectDir), redirects) };
}

/**
 * Compose platform redirects over another import map whose keys are file URLs (the client
 * transforms' rewritten copies): a redirect whose variant was itself rewritten points at the
 * rewritten copy, since an import map applies once.
 */
export function composeRedirects(
  redirects: Record<string, string>,
  rewritten: Record<string, string> | undefined,
): Record<string, string> {
  if (!rewritten) return redirects;
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(redirects)) out[from] = rewritten[to] ?? to;
  return out;
}

/** A module with no file for some targets. */
export interface PlatformGap {
  /** The extensionless path, relative to the project. */
  readonly module: string;
  /** Its variants' suffixes. */
  readonly suffixes: readonly string[];
  /** The targets with no file to resolve to. */
  readonly missing: readonly Platform[];
}

/**
 * The modules some target cannot resolve: variants only, none of which that target probes.
 *
 * @param projectDir The project root.
 * @param groups The scan.
 * @param config The app config (`native`).
 */
export function platformGaps(
  projectDir: string,
  groups: readonly PlatformGroup[],
  config: DenextConfig | null | undefined,
): PlatformGap[] {
  const out: PlatformGap[] = [];
  for (const group of groups) {
    if (group.plain) continue;
    const missing = PLATFORMS.filter((p) => {
      const resolution = platformResolution(config, p);
      return resolution !== null && chooseVariant(group, resolution) === null;
    });
    if (missing.length === 0) continue;
    out.push({
      module: relative(projectDir, group.stem).replaceAll("\\", "/"),
      suffixes: [...new Set(group.variants.map((v) => v.suffix))],
      missing,
    });
  }
  return out;
}

/** What `denext doctor` reports about an app's platform files. */
export interface PlatformFilesReport {
  /** False when some module has no file for some target. */
  readonly ok: boolean;
  /** One line: the gaps per module, else a summary. */
  readonly detail: string;
}

/**
 * `denext doctor`'s platform-files check: the modules some target cannot resolve, and the
 * variants-only modules type checking cannot see (it resolves the plain path, as in React
 * Native). Null when the app has no platform files or turned them off.
 *
 * @param projectDir The project root.
 * @param config The app config.
 */
export async function platformFilesReport(
  projectDir: string,
  config: DenextConfig | null | undefined,
): Promise<PlatformFilesReport | null> {
  if (config?.platformExtensions === false) return null;
  const groups = await scanPlatformGroups(projectDir);
  if (groups.length === 0) return null;
  const gaps = platformGaps(projectDir, groups, config);
  if (gaps.length > 0) {
    const lines = gaps.map((g) =>
      `${g.module} (${g.suffixes.map((s) => `.${s}`).join(", ")}) has no file for ` +
      `${g.missing.join(", ")}`
    );
    const first = basename(gaps[0].module);
    return {
      ok: false,
      detail: `${lines.join("; ")}: add a plain \`${first}.tsx\` (or one variant per target); ` +
        `a plain file also gives type checking a module to resolve`,
    };
  }
  const variantsOnly = groups.filter((g) => !g.plain).length;
  return {
    ok: true,
    detail: `${groups.length} module(s) with platform files` +
      (variantsOnly === 0
        ? ""
        : `; ${variantsOnly} without a plain file — type checking resolves the plain path, so ` +
          `add one (or a \`.d.ts\` for extensionless imports)`),
  };
}

/**
 * The query parameter a shell adds to the dev server URL to name its target
 * (`?__denext_platform=ios`); the dev server pins it in a cookie of the same name.
 */
export const DEV_PLATFORM_PARAM = "__denext_platform";

/** The request header the desktop dev window's proxy sends on every request (its OS). */
export const DEV_PLATFORM_HEADER = "x-denext-platform";

/**
 * The target a `denext dev` request resolves platform files for: the desktop proxy's
 * {@linkcode DEV_PLATFORM_HEADER}, else a {@linkcode DEV_PLATFORM_PARAM} query, else the cookie
 * {@linkcode pinDevPlatform} set, else `web` (a browser with no hint). An unknown value is
 * ignored.
 *
 * @param request The request.
 */
export function devPlatformOf(request: Request): Platform {
  const candidates = [
    request.headers.get(DEV_PLATFORM_HEADER),
    new URL(request.url).searchParams.get(DEV_PLATFORM_PARAM),
    getCookies(request.headers)[DEV_PLATFORM_PARAM],
  ];
  return candidates.find(isPlatform) ?? "web";
}

/**
 * Pin a {@linkcode DEV_PLATFORM_PARAM} query in a cookie on the response, so the page's later
 * requests (its modules, client navigations, the HMR re-imports) resolve the same target. A
 * request without the query is returned as is.
 *
 * @param request The request.
 * @param response Its response.
 */
export function pinDevPlatform(request: Request, response: Response): Response {
  const value = new URL(request.url).searchParams.get(DEV_PLATFORM_PARAM);
  if (!isPlatform(value)) return response;
  // A session cookie (no expiry): it ends with the browser session, and `?__denext_platform=web`
  // pins `web` back before that.
  const cookie = `${DEV_PLATFORM_PARAM}=${value}; Path=/; SameSite=Lax`;
  try {
    response.headers.append("set-cookie", cookie);
    return response;
  } catch {
    // An immutable response (a fetch() passthrough): copy it.
    const headers = new Headers(response.headers);
    headers.append("set-cookie", cookie);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/**
 * `url` with {@linkcode DEV_PLATFORM_PARAM} set to `platform` (what `denext mobile dev` writes
 * into each native config's `server.url`, and `denext desktop dev` into the window's dev URL).
 *
 * @param url The dev server URL.
 * @param platform The shell's target.
 */
export function withDevPlatform(url: string, platform: Platform): string {
  const u = new URL(url);
  u.searchParams.set(DEV_PLATFORM_PARAM, platform);
  return u.href;
}
