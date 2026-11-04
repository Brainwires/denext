// Which exports of the app's `"use server"` modules its other modules reference: the ones the
// production server registers as Server Actions (Next.js exposes only the actions the app
// imports, too). An export nothing imports is never callable, whatever its id.
//
// A reference is an import of the export by name (`import { save } from "./actions"`, a default
// import), directly or through re-exports (`export { save } from`, `export * from`, barrels of
// barrels). Whatever this cannot follow precisely counts as referencing EVERY export, so the
// analysis may expose more than is used but never refuses an action the app imports:
// `import * as actions`, a literal `import()`, a module that does not parse, and an import edge
// the parse does not account for (an import-map rewrite, a CommonJS `require`).

import { fromFileUrl } from "@std/path";
import { literalSpecifiers, parseModule } from "./swc-ast.ts";
import type { Node } from "./swc-ast.ts";

/** A module of the import graph (a `deno info` record): its URL and its import edges. */
export interface GraphModule {
  readonly specifier: string;
  readonly error?: string;
  readonly dependencies?: ReadonlyArray<{
    readonly specifier?: string;
    readonly code?: { readonly specifier?: string };
  }>;
}

/** Every export of a module. */
const ALL = "*";
type Demand = ReadonlySet<string> | typeof ALL;

/** How a module re-exports another's names. */
type ReExport =
  | { readonly kind: "star"; readonly target: string }
  | { readonly kind: "named"; readonly target: string; readonly from: string; readonly as: string }
  | { readonly kind: "namespace"; readonly target: string; readonly as: string };

/** What one module imports (`seeds`) and re-exports (`reExports`), by resolved target URL. */
interface ModuleRefs {
  readonly seeds: Array<{ target: string; demand: Demand }>;
  readonly reExports: ReExport[];
}

/** A module export's name (`Identifier` or a string `"name"`). */
const nameOf = (n: Node): string => n?.value as string;

/** Add `names` (or every export) to `out`'s demand on `target`. */
function addDemand(
  out: Map<string, Set<string> | typeof ALL>,
  target: string,
  names: Demand,
): void {
  const prev = out.get(target);
  if (prev === ALL) return;
  if (names === ALL) out.set(target, ALL);
  else out.set(target, new Set([...prev ?? [], ...names]));
}

/** The names an `import` declaration takes, or every export (a namespace import). */
function importedNames(item: Node): Demand {
  const names = new Set<string>();
  for (const s of item.specifiers ?? []) {
    if (s.type === "ImportNamespaceSpecifier") return ALL;
    if (s.type === "ImportDefaultSpecifier") names.add("default");
    else if (s.type === "ImportSpecifier" && !s.isTypeOnly) {
      names.add(nameOf(s.imported ?? s.local));
    }
  }
  return names;
}

/** The re-exports of an `export … from` declaration. */
function reExportsOf(item: Node, target: string): ReExport[] {
  if (item.type === "ExportAllDeclaration") return [{ kind: "star", target }];
  const out: ReExport[] = [];
  for (const s of item.specifiers ?? []) {
    if (s.type === "ExportNamespaceSpecifier") {
      out.push({ kind: "namespace", target, as: nameOf(s.name) });
    } else if (s.type === "ExportDefaultSpecifier") {
      out.push({ kind: "named", target, from: "default", as: nameOf(s.exported) });
    } else if (s.type === "ExportSpecifier" && !s.isTypeOnly) {
      out.push({ kind: "named", target, from: nameOf(s.orig), as: nameOf(s.exported ?? s.orig) });
    }
  }
  return out;
}

/** The top-level items that name another module: `import`, `export … from`, `export *`. */
const EDGE_ITEMS = new Set(["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"]);

/** Record one top-level item's static import or re-export of a module in `deps`. */
function addStaticRef(item: Node, deps: Map<string, string>, refs: ModuleRefs, seen: Set<string>) {
  const spec = item.source?.value as string | undefined;
  const target = spec === undefined ? undefined : deps.get(spec);
  if (target === undefined || !EDGE_ITEMS.has(item.type)) return;
  seen.add(spec!);
  if (item.typeOnly) return;
  if (item.type === "ImportDeclaration") refs.seeds.push({ target, demand: importedNames(item) });
  else refs.reExports.push(...reExportsOf(item, target));
}

/**
 * The references `source` makes, its edges resolved through `deps` (as written → resolved URL).
 * A literal `import()` takes the namespace; an edge the parse does not account for, or a module
 * that does not parse, references every export of its target.
 */
async function moduleRefs(source: string, deps: Map<string, string>): Promise<ModuleRefs> {
  const refs: ModuleRefs = { seeds: [], reExports: [] };
  const body = (await parseModule(source))?.body ?? [];
  const seen = new Set<string>();
  for (const item of body) addStaticRef(item, deps, refs, seen);
  const sources = new Set(body.map((item: Node) => item.source));
  const dynamic = new Set(
    literalSpecifiers(body).filter((s) => !sources.has(s.node)).map((s) => s.value),
  );
  for (const [spec, target] of deps) {
    // A literal `import()` (also of a module imported statically), or an edge spelled where the
    // source does not show it.
    if (dynamic.has(spec) || !seen.has(spec)) refs.seeds.push({ target, demand: ALL });
  }
  return refs;
}

/** `m`'s runtime import edges: the specifier as written → the module it resolves to. */
function runtimeDeps(m: GraphModule): Map<string, string> {
  const deps = new Map<string, string>();
  for (const dep of m.dependencies ?? []) {
    const to = dep.code?.specifier;
    if (dep.specifier && to) deps.set(dep.specifier, to);
  }
  return deps;
}

/** A source that may re-export (a cheap pre-filter before parsing). */
const MAY_REEXPORT = /\bexport\b[^;]*?\bfrom\b/;

/**
 * The modules worth parsing: those that import a server module, or import a module that may
 * re-export one (transitively).
 */
function relevantImporters(
  locals: ReadonlyArray<{ m: GraphModule; deps: Map<string, string>; source: string }>,
  servers: ReadonlySet<string>,
): Set<string> {
  const relevant = new Set(servers);
  const touches = (deps: Map<string, string>) => [...deps.values()].some((t) => relevant.has(t));
  for (let grew = true; grew;) {
    grew = false;
    for (const { m, deps, source } of locals) {
      if (relevant.has(m.specifier) || !MAY_REEXPORT.test(source) || !touches(deps)) continue;
      relevant.add(m.specifier);
      grew = true;
    }
  }
  return new Set(locals.filter(({ deps }) => touches(deps)).map(({ m }) => m.specifier));
}

/**
 * Which exports of each `"use server"` module (by URL) the app's other modules reference — see
 * the module comment. Only `locals` are read: the framework's own source and npm packages never
 * import an app's actions.
 *
 * @param locals The app's local modules in the import graph.
 * @param servers The `"use server"` modules: URL → their export names (empty: not known, so a
 *   name reached through `export *` is taken as theirs).
 * @param read Reads a module's source by URL (null when it can't be read).
 * @returns Per server module URL: the referenced export names, or `"*"` for every export. A
 *   module no one references is absent.
 */
export async function referencedActionExports(
  locals: readonly GraphModule[],
  servers: ReadonlyMap<string, readonly string[]>,
  read: (url: string) => Promise<string | null> = readModuleSource,
): Promise<Map<string, Set<string> | "*">> {
  const sources = await Promise.all(
    locals.filter((m) => !m.error).map(async (m) => ({
      m,
      deps: runtimeDeps(m),
      source: await read(m.specifier),
    })),
  );
  const readable = sources.filter((s): s is typeof s & { source: string } => s.source !== null);
  const importers = relevantImporters(readable, new Set(servers.keys()));
  const refsOf = new Map<string, ModuleRefs>();
  for (const { m, deps, source } of readable) {
    if (importers.has(m.specifier)) refsOf.set(m.specifier, await moduleRefs(source, deps));
  }
  // A module that can't be read references every export of everything it imports.
  for (const { m, deps } of sources.filter((s) => s.source === null)) {
    refsOf.set(m.specifier, {
      seeds: [...deps.values()].map((target) => ({ target, demand: ALL })),
      reExports: [],
    });
  }
  return propagate(refsOf, servers);
}

/** What a request for `name` asks of a re-export's target, or null when it does not forward it. */
function forward(r: ReExport, name: string): Demand | null {
  if (r.kind === "named") return r.as === name ? new Set([r.from]) : null;
  if (r.kind === "namespace") return r.as === name ? ALL : null;
  return name === "default" ? null : new Set([name]); // `export *` never forwards a default
}

/** Follow every module's imports through the re-exports to the server modules they reach. */
function propagate(
  refsOf: ReadonlyMap<string, ModuleRefs>,
  servers: ReadonlyMap<string, readonly string[]>,
): Map<string, Set<string> | "*"> {
  // Whether `name` is an export of the server module `url` (a name `export *` forwards may not be).
  const exports = (url: string, name: string) => {
    const names = servers.get(url);
    return names !== undefined && (names.length === 0 || names.includes(name));
  };
  const out = new Map<string, Set<string> | typeof ALL>();
  const visited = new Set<string>();
  const request = (url: string, demand: Demand): void => {
    if (demand === ALL) requestAll(url);
    else for (const name of demand) requestName(url, name);
  };
  const requestAll = (url: string): void => {
    if (visited.has(`${url}\0${ALL}`)) return;
    visited.add(`${url}\0${ALL}`);
    if (servers.has(url)) addDemand(out, url, ALL);
    for (const r of refsOf.get(url)?.reExports ?? []) {
      request(r.target, r.kind === "named" ? new Set([r.from]) : ALL);
    }
  };
  const requestName = (url: string, name: string): void => {
    const key = `${url}\0${name}`;
    if (visited.has(key) || visited.has(`${url}\0${ALL}`)) return;
    visited.add(key);
    if (exports(url, name)) addDemand(out, url, new Set([name]));
    for (const r of refsOf.get(url)?.reExports ?? []) {
      const forwarded = forward(r, name);
      if (forwarded) request(r.target, forwarded);
    }
  };
  for (const refs of refsOf.values()) {
    for (const { target, demand } of refs.seeds) request(target, demand);
  }
  return out;
}

/** A local module's source, or null. */
async function readModuleSource(url: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(fromFileUrl(url));
  } catch {
    return null;
  }
}
