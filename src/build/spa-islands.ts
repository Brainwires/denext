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
// `interaction` / `media` / `only`), so one component works in both modes. Only a component
// imported by name (default or named) is rewritten; correctness first: an unparseable module, a
// name an inner scope re-binds, and a member tag (`<UI.Chart client:visible />`) are left as
// written (the directive then reaches the component as a plain prop and it mounts eagerly).

import { fromFileUrl, relative, SEPARATOR, toFileUrl } from "@std/path";
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

/** One imported value binding. */
interface Binding {
  /** The `import` declaration it comes from. */
  readonly decl: Node;
  /** The module specifier. */
  readonly spec: string;
  /** The imported name (`default` for a default import). */
  readonly imported: string;
}

/** A directive element: the JSX element and the binding its tag names. */
interface DirectiveElement {
  readonly el: Node;
  readonly local: string;
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

/** The local name and imported name of a value import specifier (null: a type or namespace). */
function specifierNames(s: Node): { local: string; imported: string } | null {
  if (s.type === "ImportDefaultSpecifier") return { local: s.local.value, imported: "default" };
  if (s.type !== "ImportSpecifier" || s.isTypeOnly) return null;
  return { local: s.local.value, imported: s.imported?.value ?? s.local.value };
}

/** Every value binding of the module's `import` declarations (type-only ones skipped). */
function importBindings(body: Node[]): Map<string, Binding> {
  const out = new Map<string, Binding>();
  for (const decl of body) {
    if (decl.type !== "ImportDeclaration" || decl.typeOnly) continue;
    for (const s of decl.specifiers ?? []) {
      const names = specifierNames(s);
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

/** The directive elements whose tag is one of `bindings` (by local name). */
function directiveElements(body: Node[], bindings: Map<string, Binding>): DirectiveElement[] {
  const out: DirectiveElement[] = [];
  for (const item of body) {
    walkAst(item, (n) => {
      if (n.type !== "JSXElement") return;
      const tag = n.opening?.name;
      if (tag?.type !== "Identifier" || !bindings.has(tag.value)) return;
      if ((n.opening.attributes ?? []).some(isDirective)) out.push({ el: n, local: tag.value });
    });
  }
  return out;
}

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
        (s.type === "ImportDefaultSpecifier" || (s.type === "ImportSpecifier" && !s.isTypeOnly)) &&
        deferredOnly(s.local.value)
      );
    if (allDeferred) out.add(decl);
  }
  return out;
}

/** The loader's import specifier: absolute when the module is being relocated. */
function loaderSpecifier(spec: string, moduleUrl: string | undefined): string {
  return moduleUrl && isRelativeSpecifier(spec) ? new URL(spec, moduleUrl).href : spec;
}

/** The header the rewritten module starts with: the runtime import and one loader per binding. */
function header(
  used: readonly string[],
  bindings: Map<string, Binding>,
  moduleUrl: string | undefined,
): string {
  const loaders = used.map((local, i) => {
    const b = bindings.get(local)!;
    const spec = JSON.stringify(loaderSpecifier(b.spec, moduleUrl));
    return `const __dnxLoad${i} = () => import(${spec}).then((m) => m[${
      JSON.stringify(b.imported)
    }]);\n`;
  });
  return `\nimport { SpaIsland as __DnxSpaIsland } from "${SPA_ISLAND_SPECIFIER}";\n` +
    loaders.join("");
}

/** The edits that turn each directive element into a `SpaIsland` with its binding's loader. */
function elementEdits(
  ctx: Ctx,
  elements: readonly DirectiveElement[],
  used: readonly string[],
): Edit[] {
  const edits: Edit[] = [];
  for (const { el, local } of elements) {
    const name = el.opening.name;
    edits.push({
      start: startOf(ctx, name),
      end: endOf(ctx, name),
      text: `__DnxSpaIsland __dnxLoad={__dnxLoad${used.indexOf(local)}}`,
    });
    if (el.closing) {
      edits.push({
        start: startOf(ctx, el.closing.name),
        end: endOf(ctx, el.closing.name),
        text: "__DnxSpaIsland",
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
export async function transformSpaIslands(
  source: string,
  opts: { moduleUrl?: string } = {},
): Promise<SpaIslandResult> {
  const identity: SpaIslandResult = { code: source, changed: false, islands: 0, split: [] };
  if (!MAYBE.test(source)) return identity;
  const parsed = await parseModule(source);
  if (!parsed) return identity;
  const { ctx, body } = parsed;
  const bindings = importBindings(body);
  for (const name of shadowedNames(body, new Set(bindings.keys()))) bindings.delete(name);
  const elements = directiveElements(body, bindings);
  if (elements.length === 0) return identity;
  const used = [...new Set(elements.map((e) => e.local))];
  const dropped = droppableImports(body, bindings, elements);
  const removed: [number, number][] = [...dropped].map((d) => [startOf(ctx, d), endOf(ctx, d)]);
  const edits: Edit[] = [
    {
      start: prologueEnd(ctx, body),
      end: prologueEnd(ctx, body),
      text: header(used, bindings, opts.moduleUrl),
    },
    ...removed.map(([start, end]) => ({ start, end, text: "" })),
    ...elementEdits(ctx, elements, used),
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

/** The app's JSX/TSX source files under `projectDir` that carry a `client:*` directive. */
export async function spaIslandSources(projectDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const path of await appSourceFiles(projectDir)) {
    if (!/\.[cm]?[jt]sx$/.test(path)) continue;
    if (relative(projectDir, path).split(SEPARATOR).some((part) => part.startsWith("."))) continue;
    if (MAYBE.test(await Deno.readTextFile(path))) out.push(path);
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
