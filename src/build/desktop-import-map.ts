// A relocatable import map for `deno desktop` / `deno compile`.
//
// A compiled binary embeds every module of its graph, but it does not relocate an import map
// target written as an ABSOLUTE local path: Deno serializes the map as written, so at launch
// `"denext/desktop": "file:///Users/me/denext/src/build/desktop.ts"` (or `"/Users/me/…"`) still
// resolves to the build machine's path, never to the embedded copy. The binary then reads that
// module from the build machine's disk while it exists and fails with `Module not found` once it is
// moved or deleted, or on any other machine. A RELATIVE target (`"../../src/build/desktop.ts"`) is
// resolved against the embedded deno.json and finds the embedded copy.
//
// So when the project's import map has an absolute local target (or scope), packaging writes a
// copy of the map with every local target made relative (`.deno-desktop/import-map.json`) and
// builds with `--import-map` pointing at it. Remote, `jsr:`, `npm:`, `node:` and bare targets are
// kept as written: they are embedded under their own specifier. A map without an absolute local
// entry is left alone (no flag), so ordinary projects build exactly as before.

import { dirname, fromFileUrl, isAbsolute, join, relative, SEPARATOR, toFileUrl } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { isInjectedCssShimEntry } from "./css-config-guard.ts";

/** Where the relocatable map is written, relative to the project. */
export const DESKTOP_IMPORT_MAP_FILE = ".deno-desktop/import-map.json";

/** An import map's two keys (the only ones Deno reads from an import map). */
export interface DesktopImportMap {
  /** Top-level specifier → target. */
  readonly imports?: Record<string, string>;
  /** Scope prefix → (specifier → target). */
  readonly scopes?: Record<string, Record<string, string>>;
}

/** Whether `value` is an absolute local target: a `file:` URL or a path-absolute `/…` (or a
 * Windows drive path), which a compiled binary would resolve on the build machine's disk. */
function isAbsoluteLocal(value: string): boolean {
  return value.startsWith("file:") || value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value);
}

/** Whether `value` resolves against the map's base: a relative or absolute local target. */
function isLocal(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../") || isAbsoluteLocal(value);
}

/** `value` as a local target relative to `outDir` (POSIX separators, keeping a trailing `/`), or
 * unchanged when it is not local or cannot be made relative (another Windows drive). */
function relocate(value: string, baseUrl: URL, outDir: string): string {
  if (!isLocal(value)) return value;
  const url = /^[a-zA-Z]:[\\/]/.test(value)
    ? new URL(`file:///${value.replaceAll("\\", "/")}`)
    : new URL(value, baseUrl);
  if (url.protocol !== "file:") return value;
  const rel = relative(outDir, fromFileUrl(url));
  if (isAbsolute(rel)) return url.href; // another drive: nothing relative reaches it
  const posix = SEPARATOR === "/" ? rel : rel.replaceAll(SEPARATOR, "/");
  const prefixed = posix.startsWith("../") || posix === ".." ? posix : `./${posix}`;
  return value.endsWith("/") && !prefixed.endsWith("/") ? `${prefixed}/` : prefixed;
}

/**
 * `entries` with every target relocated (non-string targets dropped, as Deno would refuse them).
 * With `expand` (a deno.json map), a `jsr:` / `npm:` package entry also gets the subpath entry Deno
 * derives for deno.json's `imports` but not for an `--import-map` file: `"@std/http":
 * "jsr:@std/http@^1"` adds `"@std/http/": "jsr:/@std/http@^1/"`, so `@std/http/cookie` resolves.
 */
function relocateEntries(
  entries: Record<string, unknown>,
  baseUrl: URL,
  outDir: string,
  expand: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== "string") continue;
    // A css→shim redirect denext injects for the length of a build is kept as written.
    out[key] = isInjectedCssShimEntry(key, value) ? value : relocate(value, baseUrl, outDir);
  }
  if (!expand) return out;
  for (const [key, value] of Object.entries(out)) {
    const pkg = /^(jsr|npm):\/?(.+)$/.exec(value);
    if (!pkg || key.endsWith("/") || value.endsWith("/") || Object.hasOwn(out, `${key}/`)) continue;
    out[`${key}/`] = `${pkg[1]}:/${pkg[2]}/`;
  }
  return out;
}

/** Whether an entry of `entries` targets an absolute local path. The css→shim redirects a denext
 * build injects into deno.json while it runs (`denext desktop run` builds inside that window) do
 * not count: they are transient, and the desktop entry's graph imports no stylesheet. */
function hasAbsoluteTarget(entries: Record<string, unknown>): boolean {
  return Object.entries(entries).some(([key, value]) =>
    typeof value === "string" && isAbsoluteLocal(value) && !isInjectedCssShimEntry(key, value)
  );
}

/** `value` when it is a plain object, else `undefined`. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * The import map rewritten so a compiled binary resolves every local target to its embedded copy,
 * or `null` when nothing needs it (no target or scope is an absolute local path).
 *
 * @param map The import map (`imports` / `scopes`), e.g. deno.json's.
 * @param baseUrl The URL the map's relative entries resolve against (the deno.json or map file).
 * @param outDir The directory the rewritten map is written to (its targets are relative to it).
 * @param expand Whether the map is deno.json's `imports` / `scopes` (whose `jsr:` / `npm:` package
 * entries Deno also applies to subpaths); `false` for an import map file.
 * @returns The relocatable map, or `null`.
 */
export function relocatableImportMap(
  map: unknown,
  baseUrl: URL,
  outDir: string,
  expand = false,
): DesktopImportMap | null {
  const imports = record(record(map)?.imports) ?? {};
  const scopes = record(record(map)?.scopes) ?? {};
  const scopeEntries = Object.entries(scopes).map(([k, v]) => [k, record(v) ?? {}] as const);
  const absolute = hasAbsoluteTarget(imports) ||
    scopeEntries.some(([key, entries]) => isAbsoluteLocal(key) || hasAbsoluteTarget(entries));
  if (!absolute) return null;
  const out: { imports?: Record<string, string>; scopes?: Record<string, Record<string, string>> } =
    { imports: relocateEntries(imports, baseUrl, outDir, expand) };
  if (scopeEntries.length > 0) {
    out.scopes = Object.fromEntries(
      scopeEntries.map((
        [key, entries],
      ) => [relocate(key, baseUrl, outDir), relocateEntries(entries, baseUrl, outDir, expand)]),
    );
  }
  return out;
}

/** The project's import map and the URL it resolves against: deno.json(c)'s `imports` / `scopes`,
 * or the local file its `importMap` names. `null` when there is none (or it is remote). */
async function readProjectImportMap(
  projectDir: string,
): Promise<{ map: unknown; baseUrl: URL; expand: boolean } | null> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const path = join(projectDir, name);
    let config: Record<string, unknown> | undefined;
    try {
      config = record(parseJsonc(await Deno.readTextFile(path)));
    } catch {
      continue; // not this one (or unreadable)
    }
    const configUrl = toFileUrl(path);
    const importMap = config?.importMap;
    if (typeof importMap !== "string") return { map: config, baseUrl: configUrl, expand: true };
    const mapUrl = new URL(importMap, configUrl);
    if (mapUrl.protocol !== "file:") return null;
    const text = await Deno.readTextFile(mapUrl).catch(() => undefined);
    return text === undefined ? null : { map: parseJsonc(text), baseUrl: mapUrl, expand: false };
  }
  return null;
}

/**
 * The `--import-map` args a `deno desktop` build of the project in `projectDir` needs so the
 * packaged app is self-contained: when the project's import map has an absolute local target,
 * write a relocatable copy to {@linkcode DESKTOP_IMPORT_MAP_FILE} and return
 * `["--import-map", <its absolute path>]`; otherwise remove a stale copy and return `[]`.
 *
 * @param projectDir The project directory (where deno.json is).
 * @returns The args to splice into the `deno desktop` argv.
 */
export async function desktopImportMapArgsFor(projectDir: string): Promise<string[]> {
  const file = join(projectDir, ...DESKTOP_IMPORT_MAP_FILE.split("/"));
  const found = await readProjectImportMap(projectDir);
  const map = found && relocatableImportMap(found.map, found.baseUrl, dirname(file), found.expand);
  if (!map) {
    await Deno.remove(file).catch(() => {});
    return [];
  }
  for (const path of [dirname(file), file]) {
    const link = await Deno.lstat(path).then((s) => s.isSymlink, () => false);
    if (link) throw new Error(`refusing to write through a symlink at ${path}`);
  }
  await Deno.mkdir(dirname(file), { recursive: true });
  await Deno.writeTextFile(file, `${JSON.stringify(map, null, 2)}\n`);
  return ["--import-map", file];
}
