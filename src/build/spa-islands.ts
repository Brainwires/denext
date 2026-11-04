// SPA mode's `client:*` directives at build time: deferred mount + code split.
//
// A SPA has no server render, so an island directive cannot defer hydration. Its SPA meaning is
// the mount itself: `<Chart client:visible data={d} />` renders a placeholder until the trigger
// fires, then imports the component's module and mounts it. This pass rewrites each such element
// of an app module to `denext/spa-island`'s `SpaIsland`, handing it a loader
// (`() => import("./chart.tsx").then((m) => m.default)`). When every reference to an imported
// component is a directive element, its static `import` is dropped, so the bundler moves the
// module (and what only it imports) into its own chunk, fetched when the trigger fires. A
// component also used without a directive keeps its import: its directive elements still defer
// their mount, the module stays in the main bundle.
//
// The same syntax as the Flight-route islands (`client:load` / `idle` / `visible` /
// `interaction` / `media` / `only`), so one component works in both modes. A component imported
// by name (default or named) is rewritten, and so is a member tag on an import
// (`<UI.Chart client:visible />` with `import * as UI`, or a member of a default / named import):
// its loader reads the member off the module. A module-level default is read as the Flight
// islands read it: a component whose module (imported by a relative path) exports
// `const hydrate = "visible"` defers every element written without a directive (a usage-site
// directive still wins; through a namespace import, only its direct members). Correctness
// first: an unparseable module and a name an inner scope re-binds are left as written (the
// directive then reaches the component as a plain prop and it mounts eagerly).
// The isomorphic routes' island split (./iso-islands.ts) shares this rewrite
// ({@linkcode rewriteIslandElements}).

import { fromFileUrl, isAbsolute, relative, SEPARATOR, toFileUrl } from "@std/path";
import {
  absolutizeSpecifiers,
  applyEdits,
  type Ctx,
  type Edit,
  endOf,
  isRelativeSpecifier,
  type Node,
  parseModule,
  prologueEnd,
  startOf,
  walkAst,
  writeTransformedModules,
} from "./swc-ast.ts";
import { shadowedNames } from "./feature-transform.ts";
import { appSourceFiles } from "./spa/features.ts";
import type { SpaModuleRedirects } from "./spa/features.ts";

/** The runtime module the rewritten elements render (a public, prebuilt entry). */
const SPA_ISLAND_SPECIFIER = "denext/spa-island";

/** The directive names (the Flight-route islands' strategies). */
const STRATEGIES: ReadonlySet<string> = new Set([
  "load",
  "idle",
  "visible",
  "interaction",
  "media",
  "only",
]);

/** A module that may carry a directive (the parse is skipped for every other module). */
const MAYBE = /\bclient:(?:load|idle|visible|interaction|media|only)\b/;

/** A module's `export const hydrate = "<strategy>"` (its islands' default directive). */
const HYDRATE_EXPORT =
  /\bexport\s+const\s+hydrate\s*(?::[^=]+)?=\s*(["'`])(load|idle|visible|interaction|media|only)\1/;

/** A relative import specifier of a module (the ones a module default is looked up through). */
const RELATIVE_IMPORT = /\bfrom\s*["'](\.\.?\/[^"']+)["']/g;

/** The extensions (then `/index` files) an extensionless relative specifier is probed with. */
const PROBE_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js", ".mts", ".mjs"];

/** One imported value binding. */
interface Binding {
  /** The `import` declaration it comes from. */
  readonly decl: Node;
  /** The module specifier. */
  readonly spec: string;
  /** The imported name (`default` for a default import, `*` for a namespace import). */
  readonly imported: string;
}

/** A directive element: the JSX element, the binding its tag names and the members it reads. */
interface DirectiveElement {
  readonly el: Node;
  /** The import binding the tag starts with. */
  readonly local: string;
  /** The members read off it (`["Chart"]` for `<UI.Chart>`; empty for a plain tag). */
  readonly path: readonly string[];
  /** The module default to add as the element's directive (it was written without one). */
  readonly inject?: string;
}

/** What a rewrite reads beyond plain imported names (SPA mode reads both; see the module doc). */
interface ElementScope {
  /** Member tags (`<UI.Chart>`) and namespace imports. */
  readonly members: boolean;
  /** `relative specifier → strategy`: the imported modules declaring a `hydrate` default. */
  readonly defaults: ReadonlyMap<string, string>;
}

/** What {@linkcode transformSpaIslands} did. */
export interface SpaIslandResult {
  /** The rewritten source (unchanged when `changed` is false). */
  readonly code: string;
  /** Whether any element was rewritten. */
  readonly changed: boolean;
  /** How many directive elements now defer their mount. */
  readonly islands: number;
  /** The specifiers whose static import was dropped (their modules can split off). */
  readonly split: readonly string[];
}

/**
 * The local name and imported name of a value import specifier (null: a type import, or a
 * namespace one unless `namespaces`).
 */
function specifierNames(
  s: Node,
  namespaces: boolean,
): { local: string; imported: string } | null {
  if (s.type === "ImportDefaultSpecifier") return { local: s.local.value, imported: "default" };
  if (s.type === "ImportNamespaceSpecifier") {
    return namespaces ? { local: s.local.value, imported: "*" } : null;
  }
  if (s.type !== "ImportSpecifier" || s.isTypeOnly) return null;
  return { local: s.local.value, imported: s.imported?.value ?? s.local.value };
}

/** Every value binding of the module's `import` declarations (type-only ones skipped). */
function importBindings(body: Node[], namespaces: boolean): Map<string, Binding> {
  const out = new Map<string, Binding>();
  for (const decl of body) {
    if (decl.type !== "ImportDeclaration" || decl.typeOnly) continue;
    for (const s of decl.specifiers ?? []) {
      const names = specifierNames(s, namespaces);
      if (names) out.set(names.local, { decl, spec: decl.source.value, imported: names.imported });
    }
  }
  return out;
}

/** Whether a JSX attribute is a `client:<strategy>` directive. */
function isDirective(attr: Node): boolean {
  const name = attr?.type === "JSXAttribute" ? attr.name : null;
  return name?.type === "JSXNamespacedName" && name.namespace?.value === "client" &&
    STRATEGIES.has(name.name?.value);
}

/** A tag's root name and the members it reads (`UI.Forms.Field` → `UI`, `[Forms, Field]`). */
function tagPath(tag: Node, members: boolean): { local: string; path: string[] } | null {
  if (tag?.type === "Identifier") return { local: tag.value, path: [] };
  if (!members || tag?.type !== "JSXMemberExpression") return null;
  const inner = tagPath(tag.object, members);
  const prop = tag.property?.value;
  return inner && typeof prop === "string"
    ? { local: inner.local, path: [...inner.path, prop] }
    : null;
}

/**
 * The module default an element written without a directive takes: its binding's module
 * declares one, and the tag names a component of that module (a plain tag on a default or named
 * import, or a direct member of a namespace import).
 */
function moduleDefault(
  binding: Binding,
  path: readonly string[],
  scope: ElementScope,
): string | undefined {
  const strategy = scope.defaults.get(binding.spec);
  if (strategy === undefined) return undefined;
  const component = binding.imported === "*" ? path.length === 1 : path.length === 0;
  return component ? strategy : undefined;
}

/**
 * The directive elements whose tag starts with one of `bindings` (by local name), and the
 * elements a module default makes islands.
 */
function directiveElements(
  body: Node[],
  bindings: Map<string, Binding>,
  scope: ElementScope,
): DirectiveElement[] {
  const out: DirectiveElement[] = [];
  for (const item of body) {
    walkAst(item, (n) => {
      const element = n.type === "JSXElement" ? islandElement(n, bindings, scope) : null;
      if (element) out.push(element);
    });
  }
  return out;
}

/**
 * The import binding a JSX element's tag reads a component from, with the tag's path; null for
 * a tag naming no import, or a bare namespace (no component: only a member of one is).
 */
function taggedBinding(
  n: Node,
  bindings: Map<string, Binding>,
  members: boolean,
): { tag: { local: string; path: string[] }; binding: Binding } | null {
  const tag = tagPath(n.opening?.name, members);
  const binding = tag ? bindings.get(tag.local) : undefined;
  if (!tag || !binding) return null;
  return binding.imported === "*" && tag.path.length === 0 ? null : { tag, binding };
}

/** A JSX element as an island: its tag names an import and it has (or defaults to) a directive. */
function islandElement(
  n: Node,
  bindings: Map<string, Binding>,
  scope: ElementScope,
): DirectiveElement | null {
  const found = taggedBinding(n, bindings, scope.members);
  if (!found) return null;
  if ((n.opening.attributes ?? []).some(isDirective)) return { el: n, ...found.tag };
  const inject = moduleDefault(found.binding, found.tag.path, scope);
  return inject ? { el: n, ...found.tag, inject } : null;
}

/** The key one loader is shared under: the binding and the members its elements read. */
const elementKey = (e: DirectiveElement) => [e.local, ...e.path].join(".");

/** How many times each of `names` is referenced outside the `import` declarations. */
function referenceCounts(body: Node[], names: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of body) {
    if (item.type === "ImportDeclaration") continue;
    walkAst(item, (n) => {
      if (n.type === "Identifier" && names.has(n.value)) {
        counts.set(n.value, (counts.get(n.value) ?? 0) + 1);
      }
    });
  }
  return counts;
}

/** Each element's tag references (its opening and, when not self-closing, closing name). */
function tagReferences(elements: readonly DirectiveElement[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const { el, local } of elements) {
    out.set(local, (out.get(local) ?? 0) + (el.closing ? 2 : 1));
  }
  return out;
}

/**
 * The `import` declarations to drop: those whose every value binding is referenced only by
 * directive elements (a side-effect import, or one also importing a type, stays).
 */
function droppableImports(
  body: Node[],
  bindings: Map<string, Binding>,
  elements: readonly DirectiveElement[],
): Set<Node> {
  const tags = tagReferences(elements);
  const counts = referenceCounts(body, new Set(bindings.keys()));
  const deferredOnly = (local: string) =>
    (tags.get(local) ?? 0) > 0 && tags.get(local) === counts.get(local);
  const out = new Set<Node>();
  for (const decl of new Set([...bindings.values()].map((b) => b.decl))) {
    const specs = (decl.specifiers ?? []) as Node[];
    const allDeferred = specs.length > 0 &&
      specs.every((s) =>
        (s.type === "ImportDefaultSpecifier" || s.type === "ImportNamespaceSpecifier" ||
          (s.type === "ImportSpecifier" && !s.isTypeOnly)) &&
        bindings.has(s.local.value) && deferredOnly(s.local.value)
      );
    if (allDeferred) out.add(decl);
  }
  return out;
}

/** The loader's import specifier: absolute when the module is being relocated. */
function loaderSpecifier(spec: string, moduleUrl: string | undefined): string {
  return moduleUrl && isRelativeSpecifier(spec) ? new URL(spec, moduleUrl).href : spec;
}

/**
 * How a pass rewrites directive elements: SPA mode's deferred mount here, the isomorphic routes'
 * split islands in ./iso-islands.ts. Each rewritten binding gets a loader
 * (`() => import(spec).then((m) => m[name])`).
 */
export interface IslandRewrite {
  /** Rewrite only the elements whose import is dropped (their component splits off). */
  readonly splitOnly: boolean;
  /**
   * Also rewrite member tags (`<UI.Chart client:visible />`) and the elements a module-level
   * `hydrate` default makes islands (SPA mode).
   */
  readonly members: boolean;
  /** The runtime import the rewritten module starts with. */
  readonly runtime: string;
  /** The module-level declaration of binding `i`, given its loader expression. */
  declare(i: number, loader: string): string;
  /** The opening tag name (with any added attribute) of an element of binding `i`. */
  open(i: number): string;
  /** The closing tag name of an element of binding `i`. */
  close(i: number): string;
}

/** SPA mode: a `SpaIsland` handed the binding's loader. */
const SPA_REWRITE: IslandRewrite = {
  splitOnly: false,
  members: true,
  runtime: `import { SpaIsland as __DnxSpaIsland } from "${SPA_ISLAND_SPECIFIER}";\n`,
  declare: (i, loader) => `const __dnxLoad${i} = ${loader};\n`,
  open: (i) => `__DnxSpaIsland __dnxLoad={__dnxLoad${i}}`,
  close: () => "__DnxSpaIsland",
};

/** The loader's property reads: the imported name (none for a namespace), then the members. */
function loaderAccess(b: Binding, path: readonly string[]): string {
  const keys = b.imported === "*" ? path : [b.imported, ...path];
  return keys.map((k) => `[${JSON.stringify(k)}]`).join("");
}

/**
 * The header the rewritten module starts with: the runtime import and one loader per binding
 * and member path (`used` holds one element of each).
 */
function header(
  used: readonly DirectiveElement[],
  bindings: Map<string, Binding>,
  moduleUrl: string | undefined,
  rewrite: IslandRewrite,
): string {
  const loaders = used.map((e, i) => {
    const b = bindings.get(e.local)!;
    const spec = JSON.stringify(loaderSpecifier(b.spec, moduleUrl));
    return rewrite.declare(i, `() => import(${spec}).then((m) => m${loaderAccess(b, e.path)})`);
  });
  return `\n${rewrite.runtime}${loaders.join("")}`;
}

/** The edits that point each directive element at its binding's rewrite. */
function elementEdits(
  ctx: Ctx,
  elements: readonly DirectiveElement[],
  keys: readonly string[],
  rewrite: IslandRewrite,
): Edit[] {
  const edits: Edit[] = [];
  for (const e of elements) {
    const { el } = e;
    const name = el.opening.name;
    const i = keys.indexOf(elementKey(e));
    const open = rewrite.open(i) + (e.inject ? ` client:${e.inject}` : "");
    edits.push({ start: startOf(ctx, name), end: endOf(ctx, name), text: open });
    if (el.closing) {
      edits.push({
        start: startOf(ctx, el.closing.name),
        end: endOf(ctx, el.closing.name),
        text: rewrite.close(i),
      });
    }
  }
  return edits;
}

/** Whether `[start, end)` lies inside one of `ranges`. */
function inside(edit: Edit, ranges: readonly [number, number][]): boolean {
  return ranges.some(([s, e]) => edit.start >= s && edit.end <= e);
}

/**
 * Rewrite a module's `client:*` component elements for SPA mode (see the module header).
 *
 * @param source The module source (TSX/JSX).
 * @param opts.moduleUrl The module's URL: pass it only when the output is written elsewhere
 *   (the `deno bundle` path), so its relative specifiers are made absolute.
 * @returns The rewritten module and what was deferred.
 */
export function transformSpaIslands(
  source: string,
  opts: { moduleUrl?: string; importer?: string } = {},
): Promise<SpaIslandResult> {
  return rewriteIslandElements(source, opts, SPA_REWRITE);
}

/** `path → { mtime, strategy }`: each probed module's `hydrate` default, until it changes. */
const defaultCache = new Map<string, { mtime: number | null; strategy: string | null }>();

/** The `hydrate` default of the module at `path` (null: none, or no such file). */
async function hydrateDefaultOf(path: string): Promise<string | null | undefined> {
  const stat = await Deno.stat(path).catch(() => null);
  if (!stat?.isFile) return undefined;
  const mtime = stat.mtime?.getTime() ?? null;
  const cached = defaultCache.get(path);
  if (cached && cached.mtime === mtime && mtime !== null) return cached.strategy;
  const text = await Deno.readTextFile(path).catch(() => "");
  const strategy = HYDRATE_EXPORT.exec(text)?.[2] ?? null;
  defaultCache.set(path, { mtime, strategy });
  return strategy;
}

/** The `hydrate` default of the module `spec` names from `importer` (probing extensions). */
async function specifierDefault(spec: string, importer: URL): Promise<string | null> {
  const base = fromFileUrl(new URL(spec, importer));
  const candidates = [
    base,
    ...PROBE_EXTENSIONS.map((ext) => base + ext),
    ...PROBE_EXTENSIONS.map((ext) => `${base}${SEPARATOR}index${ext}`),
  ];
  for (const path of candidates) {
    const strategy = await hydrateDefaultOf(path);
    if (strategy !== undefined) return strategy;
  }
  return null;
}

/**
 * `relative specifier → strategy` for the modules `source` imports by a relative path that
 * declare a module-level `hydrate` default (see the module doc). Empty without an `importer`.
 *
 * @param source The importing module's source.
 * @param importer The importing module's path or `file:` URL (where its specifiers resolve).
 */
async function moduleHydrateDefaults(
  source: string,
  importer: string | undefined,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!importer) return out;
  const from = importer.startsWith("file:")
    ? new URL(importer)
    : isAbsolute(importer)
    ? toFileUrl(importer)
    : null;
  if (!from) return out;
  for (const [, spec] of source.matchAll(RELATIVE_IMPORT)) {
    if (out.has(spec)) continue;
    const strategy = await specifierDefault(spec, from);
    if (strategy) out.set(spec, strategy);
  }
  return out;
}

/**
 * Rewrite a module's `client:*` component elements as `rewrite` says, dropping each import only
 * directive elements reference (see the module header).
 *
 * @param source The module source (TSX/JSX).
 * @param opts.moduleUrl The module's URL, when the output is written elsewhere.
 * @param rewrite What a directive element becomes.
 * @returns The rewritten module and what was deferred.
 */
export async function rewriteIslandElements(
  source: string,
  opts: { moduleUrl?: string; importer?: string },
  rewrite: IslandRewrite,
): Promise<SpaIslandResult> {
  const identity: SpaIslandResult = { code: source, changed: false, islands: 0, split: [] };
  const defaults = rewrite.members
    ? await moduleHydrateDefaults(source, opts.importer ?? opts.moduleUrl)
    : new Map<string, string>();
  if (!MAYBE.test(source) && defaults.size === 0) return identity;
  const parsed = await parseModule(source);
  if (!parsed) return identity;
  const { ctx, body } = parsed;
  const bindings = importBindings(body, rewrite.members);
  for (const name of shadowedNames(body, new Set(bindings.keys()))) bindings.delete(name);
  const all = directiveElements(body, bindings, { members: rewrite.members, defaults });
  const dropped = droppableImports(body, bindings, all);
  const elements = rewrite.splitOnly
    ? all.filter((e) => dropped.has(bindings.get(e.local)!.decl))
    : all;
  if (elements.length === 0) return identity;
  const keys = [...new Set(elements.map(elementKey))];
  const used = keys.map((k) => elements.find((e) => elementKey(e) === k)!);
  const removed: [number, number][] = [...dropped].map((d) => [startOf(ctx, d), endOf(ctx, d)]);
  const edits: Edit[] = [
    {
      start: prologueEnd(ctx, body),
      end: prologueEnd(ctx, body),
      text: header(used, bindings, opts.moduleUrl, rewrite),
    },
    ...removed.map(([start, end]) => ({ start, end, text: "" })),
    ...elementEdits(ctx, elements, keys, rewrite),
  ];
  if (opts.moduleUrl) {
    const relocated: Edit[] = [];
    absolutizeSpecifiers(ctx, body, opts.moduleUrl, relocated);
    edits.push(...relocated.filter((e) => !inside(e, removed)));
  }
  return {
    code: applyEdits(ctx.bytes, edits),
    changed: true,
    islands: elements.length,
    split: [...dropped].map((d) => d.source.value as string),
  };
}

/**
 * The app's JSX/TSX source files under `projectDir` that carry a `client:*` directive, or import
 * (by a relative path) a module declaring a `hydrate` default.
 */
export async function spaIslandSources(projectDir: string): Promise<string[]> {
  const files: [string, string][] = [];
  let anyDefault = false;
  for (const path of await appSourceFiles(projectDir)) {
    if (relative(projectDir, path).split(SEPARATOR).some((part) => part.startsWith("."))) continue;
    const text = await Deno.readTextFile(path);
    anyDefault ||= HYDRATE_EXPORT.test(text);
    if (/\.[cm]?[jt]sx$/.test(path)) files.push([path, text]);
  }
  const out: string[] = [];
  for (const [path, text] of files) {
    if (MAYBE.test(text) || (anyDefault && (await moduleHydrateDefaults(text, path)).size > 0)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * SPA mode's island rewrite for a `deno bundle` build: each app module with a directive is
 * rewritten into a temp dir and substituted through the bundle's import map (composed over
 * `prior`, an earlier pass's substitutions: the feature fold's).
 *
 * @param projectDir The app's root.
 * @param prior `original module URL → substituted module URL` from an earlier pass.
 * @returns The import-map redirects and their cleanup.
 */
export async function spaIslandRedirects(
  projectDir: string,
  prior: Record<string, string>,
): Promise<SpaModuleRedirects> {
  const files = await spaIslandSources(projectDir);
  if (files.length === 0) return { importMap: {}, cleanup: () => Promise.resolve() };
  const outDir = await Deno.makeTempDir({ prefix: "denext_spa_islands_" });
  const importMap = await writeTransformedModules(
    files,
    outDir,
    (source, url) => transformSpaIslands(source, { moduleUrl: url }),
    (file) => {
      const earlier = prior[toFileUrl(file).href];
      return earlier ? fromFileUrl(earlier) : file;
    },
  );
  return {
    importMap,
    cleanup: () => Deno.remove(outDir, { recursive: true }).catch(() => {}),
  };
}
