// The client side of platform files through import-map aliases (`deno bundle`, `deno info`).
//
// Deno resolves a bare specifier in an app module with the app's own `deno.json`, whatever
// config the bundler was handed, and maps the result no further: `@/components/BigButton.tsx`
// lands on the plain file even when the merged config redirects that file's URL to its
// variant (a relative import does reach the redirect, since its specifier is a URL). So every
// app module that imports a redirected module through an alias, directly or through another
// such module, gets a copy with those imports rewritten to the module the target loads
// (by {@linkcode resolvePlatformImport}, the rule the server render's loader applies), and the
// copy stands in for it by file URL. A crawl over the copies reports the originals
// ({@linkcode PlatformImportMap.originals}), so the boundary and hydration scans name the
// app's own files.

import { extname, fromFileUrl, join, resolve, toFileUrl } from "@std/path";
import { djb2 } from "../runtime/djb2.ts";
import {
  type ImportAliases,
  keptPlatformScanner,
  projectSourceFiles,
  readImportAliases,
  resolveImportAlias,
  resolvePlatformImport,
} from "./platform-extensions.ts";
import {
  absolutizeSpecifiers,
  applyEdits,
  type Edit,
  parseModule,
  pinImportMeta,
} from "./swc-ast.ts";

/** A target's import map for `deno bundle` and `deno info`. */
export interface PlatformImportMap {
  /**
   * The platform redirects, plus each rewritten app module's file URL (with and without its
   * extension) → its copy; a redirect whose variant was copied points at the copy.
   */
  readonly importMap: Record<string, string>;
  /** Each copy's file URL → the app module it stands in for. */
  readonly originals: Readonly<Record<string, string>>;
}

/** An app module's import-map alias imports: each specifier and the file URL it names. */
interface AliasImports {
  readonly url: string;
  readonly path: string;
  readonly imports: ReadonlyArray<{ readonly spec: string; readonly url: string }>;
}

/** `url` without its source extension (an extensionless import's spelling), or null. */
function stemOf(url: string): string | null {
  const ext = extname(new URL(url).pathname);
  return ext ? url.slice(0, -ext.length) : null;
}

/** `source`'s alias imports (specifier and the file URL each names), or none. */
async function aliasImportsOf(
  source: string,
  aliases: ImportAliases,
): Promise<Array<{ spec: string; url: string }>> {
  const parsed = await parseModule(source);
  const out: Array<{ spec: string; url: string }> = [];
  for (const item of parsed?.body ?? []) {
    const spec = item.source?.value;
    if (typeof spec !== "string" || spec.startsWith(".")) continue;
    const url = resolveImportAlias(spec, aliases);
    if (url?.startsWith("file:")) out.push({ spec, url });
  }
  return out;
}

/**
 * Each module's alias imports as last parsed, by path: reused while the file's modification time
 * and the alias table are unchanged, so a dev rebuild parses only the files that were edited.
 */
const parsedAliasImports = new Map<
  string,
  { mtime: number; aliases: string; imports: Array<{ spec: string; url: string }> }
>();

/** `path`'s alias imports, from {@linkcode parsedAliasImports} when the file is unchanged. */
async function aliasImportsOfFile(
  path: string,
  aliases: ImportAliases,
  aliasKey: string,
): Promise<Array<{ spec: string; url: string }>> {
  const mtime = (await Deno.stat(path).catch(() => null))?.mtime?.getTime() ?? -1;
  const hit = parsedAliasImports.get(path);
  if (hit && hit.mtime === mtime && mtime !== -1 && hit.aliases === aliasKey) return hit.imports;
  const source = await Deno.readTextFile(path).catch(() => "");
  // Cheap pre-filter: most modules spell no alias at all.
  const imports = aliases.some(([key]) => source.includes(key))
    ? await aliasImportsOf(source, aliases)
    : [];
  parsedAliasImports.set(path, { mtime, aliases: aliasKey, imports });
  return imports;
}

/**
 * The app modules that import anything through an alias, with those imports. A dev session's
 * kept scan ({@linkcode keptPlatformScanner}) supplies the file list, so a rebuild walks nothing.
 */
async function aliasImporters(
  projectDir: string,
  aliases: ImportAliases,
): Promise<AliasImports[]> {
  const aliasKey = JSON.stringify(aliases);
  const files = await keptPlatformScanner(projectDir)?.files() ??
    await Array.fromAsync(projectSourceFiles(projectDir));
  const out: AliasImports[] = [];
  for (const path of files) {
    const imports = await aliasImportsOfFile(path, aliases, aliasKey);
    if (imports.length > 0) out.push({ url: toFileUrl(path).href, path, imports });
  }
  return out;
}

/** `url` and, for a file with a source extension, its extensionless spelling. */
function spellings(url: string): string[] {
  const stem = stemOf(url);
  return stem ? [url, stem] : [url];
}

/**
 * The app modules that must be copied, and every URL an alias import must be rewritten to reach:
 * the redirected modules, then each module that reaches one through an alias (and so is copied
 * itself), until no more do.
 */
function copiedImporters(
  importers: readonly AliasImports[],
  redirects: Readonly<Record<string, string>>,
): { copied: AliasImports[]; reached: Set<string> } {
  const reached = new Set(Object.keys(redirects).filter((k) => k.startsWith("file:")));
  const copied: AliasImports[] = [];
  let pending = [...importers];
  for (let grew = true; grew;) {
    const next = pending.filter((m) => m.imports.some((i) => reached.has(i.url)));
    grew = next.length > 0;
    for (const m of next) {
      copied.push(m);
      for (const url of spellings(m.url)) reached.add(url);
    }
    pending = pending.filter((m) => !next.includes(m));
  }
  return { copied, reached };
}

/**
 * The import map `deno bundle` and `deno info` resolve a target's app modules through: the
 * platform redirects, and copies of the app modules whose alias imports reach a redirected
 * module (see the module comment). Without aliases, or without redirects, the redirects alone.
 *
 * A redirect need not be a platform file: the client bundles also redirect each `"use server"`
 * module to its action stub (./client-imports.ts), so an alias import of an action is rewritten
 * to the stub by the same rule.
 *
 * @param projectDir The project root.
 * @param redirects {@linkcode projectPlatformRedirects} for the target (plus, for a client
 *   bundle, the action stubs).
 * @param copyDir Where the copies are written (emptied first).
 * @param rewritten The client transforms (module file URL → its transformed file's URL): a
 *   module that has one is copied from the transformed source, so the copy keeps the transform.
 */
export async function platformImportMap(
  projectDir: string,
  redirects: Readonly<Record<string, string>>,
  copyDir: string,
  rewritten: Readonly<Record<string, string>> = {},
): Promise<PlatformImportMap> {
  const none = { importMap: { ...redirects }, originals: {} };
  if (!Object.keys(redirects).some((k) => k.startsWith("file:"))) return none;
  const aliases = await readImportAliases(projectDir);
  if (aliases.length === 0) return none;
  const { copied, reached } = copiedImporters(await aliasImporters(projectDir, aliases), redirects);
  if (copied.length === 0) return none;

  await Deno.remove(copyDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(copyDir, { recursive: true });
  const copyOf = new Map<string, string>();
  for (const m of copied) {
    const copy = toFileUrl(join(copyDir, `p_${djb2(m.url)}${extname(m.path)}`)).href;
    for (const url of spellings(m.url)) copyOf.set(url, copy);
  }
  // Where an import of `url` must go: the target's variant (or the variant's copy), else the
  // module's own copy.
  const loadOf = (url: string): string => {
    const target = redirects[url] ?? url;
    return copyOf.get(target) ?? target;
  };
  const rewrite = (m: AliasImports) => (spec: string) => {
    const hit = resolvePlatformImport(spec, m.url, aliases, redirects);
    return hit && reached.has(hit.url) ? loadOf(hit.url) : null;
  };
  const originals: Record<string, string> = {};
  for (const m of copied) {
    const source = rewritten[m.url] ? fromFileUrl(rewritten[m.url]) : m.path;
    Object.assign(originals, await writeCopy(m, source, copyOf.get(m.url)!, rewrite(m)));
  }
  const importMap: Record<string, string> = {};
  for (const [from, to] of Object.entries(redirects)) importMap[from] = copyOf.get(to) ?? to;
  for (const [from, copy] of copyOf) importMap[from] ??= copy;
  return { importMap: await withRealPathKeys(projectDir, importMap), originals };
}

/**
 * Write `m`'s copy (of `source`: the module, or its transformed file) to `copy` with its relative
 * imports made absolute and the alias imports `rewrite` names replaced. Returns the original for
 * each spelling of the copy `deno info` may report (it names modules by their real path).
 */
async function writeCopy(
  m: AliasImports,
  source: string,
  copy: string,
  rewrite: (spec: string) => string | null,
): Promise<Record<string, string>> {
  const parsed = await parseModule(await Deno.readTextFile(source));
  if (!parsed) return {};
  const edits: Edit[] = [];
  absolutizeSpecifiers(parsed.ctx, parsed.body, m.url, edits, (u) => u, rewrite);
  const path = fromFileUrl(copy);
  // The copy lives in the copy dir; its `import.meta` keeps naming the module it stands in for.
  await Deno.writeTextFile(path, await pinImportMeta(applyEdits(parsed.ctx.bytes, edits), m.url));
  const original = toFileUrl(await Deno.realPath(m.path)).href;
  return { [copy]: original, [toFileUrl(await Deno.realPath(path)).href]: original };
}

/**
 * `map` with each project file-URL key also spelled through the project's real path: a crawl
 * reports modules by their real path (a temp dir under macOS's `/var` is `/private/var`), and
 * the Flight entry imports the islands it found by those URLs.
 */
async function withRealPathKeys(
  projectDir: string,
  map: Record<string, string>,
): Promise<Record<string, string>> {
  const root = toFileUrl(resolve(projectDir)).href + "/";
  const real = toFileUrl(await Deno.realPath(projectDir)).href + "/";
  if (root === real) return map;
  const out = { ...map };
  for (const [from, to] of Object.entries(map)) {
    if (from.startsWith(root)) out[real + from.slice(root.length)] ??= to;
  }
  return out;
}
