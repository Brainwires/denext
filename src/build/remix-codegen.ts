// The Remix route-module codegen shared by `denext migrate --from remix` (which rewrites an app
// in place) and the `@denext/react-router` plugin (which generates the same wrappers into
// `.denext/` and leaves the app untouched): the swc-based split of a route module into a
// `"use client"` component module + a server data module, and the generated denext wrappers
// (page/layout/error/route.ts) that wire them to the `denext/remix` runtime.
//
// The data model is preserved (not inverted): the runtime implements Remix's hooks/components,
// so codegen keeps the Remix code and only (a) remaps the `@remix-run/*` import specifiers to
// `denext/remix`(`/server`) and (b) splits each route module — because a `loader`/`action`
// (server) and the component (client) cannot share one `"use client"` module.

import {
  collectPatternNames,
  type Ctx,
  encoder,
  MARKER,
  type Node,
  swcParse,
  txt,
} from "./swc-ast.ts";

// ── Source transforms (import remap + server/client split) ────────────────────
//
// The data model is preserved (not inverted): the `denext/remix` runtime implements
// Remix's hooks/components, so migration keeps the Remix code and only (a) remaps the
// `@remix-run/*` import specifiers to `denext/remix`(`/server`) and (b) splits each route
// module into a client component + a server data module wired by a generated denext
// wrapper — because a `loader`/`action` (server) and the component (client) cannot share
// one `"use client"` module.

/**
 * `@remix-run/*` (and react-router v7) specifier → denext runtime subpath, most-specific
 * first. Sources use only non-capturing groups so the quote-wrapped replace below can rely
 * on positional capture groups being exactly the two quotes.
 */
const REMIX_SPEC_MAP: Array<[string, string]> = [
  ["@remix-run\\/react", "denext/remix"],
  // `@remix-run/css-bundle` (its only export is `cssBundleHref`) → the server runtime, which
  // re-exports `cssBundleHref` as `undefined` (denext owns CSS; there's no Remix CSS bundle).
  ["@remix-run\\/css-bundle", "denext/remix/server"],
  ["@remix-run\\/(?:node|cloudflare|deno|server-runtime)", "denext/remix/server"],
  ["react-router-dom", "denext/remix"],
  ["react-router", "denext/remix"],
];

/** Remap a module's `@remix-run/*` import specifiers (quote-delimited) to the denext runtime. */
export function rewriteRemixImports(code: string): string {
  let out = code;
  for (const [src, to] of REMIX_SPEC_MAP) {
    // Match only a full quoted specifier (quote…quote) so a substring can't be rewritten.
    out = out.replace(
      new RegExp(`(["'])${src}(["'])`, "g"),
      (_m, q1: string, q2: string) => `${q1}${to}${q2}`,
    );
  }
  return out;
}

/** Server-side route exports that move into the generated data module. */
export const SERVER_EXPORTS = new Set([
  "loader",
  "action",
  "headers",
  "shouldRevalidate",
  "meta",
  "links",
  "handle",
]);

/**
 * A top-level helper/type declaration, with the names it binds and the free
 * identifiers it references — so a generated module includes it only when it
 * actually uses it (transitively), instead of duplicating every helper into both
 * splits.
 */
export interface HelperDecl {
  /** The declaration's source text. */
  code: string;
  /** Top-level names this declaration binds (e.g. `["formatDate"]`). */
  names: string[];
  /** Free identifiers this declaration references (for transitive inclusion). */
  free: Set<string>;
  /** An `export`ed type: part of the module's public surface, always kept in the client module. */
  exported?: boolean;
  /** A pure type declaration (interface/type alias): carries no runtime code. */
  isType?: boolean;
  /** Position among the module's top-level items (source order is preserved on emit). */
  index?: number;
  /**
   * Identifiers referenced ONLY from `typeof X` type positions. They don't make X's
   * declaration part of this split (a `useFetcher<typeof action>()` must not drag a
   * server helper into the client) — an unselected value helper gets a `declare` stub.
   */
  typeOnly?: Set<string>;
}

/** A route module partitioned into the pieces the wrappers need. */
export interface ModuleParts {
  /** Import statements (pruned per generated file by {@link usedImports}). */
  imports: string[];
  /** Top-level helpers + types, included per file by reference (see {@link selectHelpers}). */
  helpers: HelperDecl[];
  /** `loader`/`action`/`meta`/… declarations (the server data module). */
  serverStatements: string[];
  /** The default component + `ErrorBoundary` + other client exports. */
  clientStatements: string[];
  /** Free identifiers referenced by the server statements (helper-inclusion seed). */
  serverFree: Set<string>;
  /** Free identifiers referenced by the client statements (helper-inclusion seed). */
  clientFree: Set<string>;
  /** `typeof X` type-position references of the server statements (see {@link HelperDecl.typeOnly}). */
  serverTypeOnly: Set<string>;
  /** `typeof X` type-position references of the client statements. */
  clientTypeOnly: Set<string>;
  /** Source position of each `serverStatements` entry (parallel array). */
  serverOrder: number[];
  /** Source position of each `clientStatements` entry (parallel array). */
  clientOrder: number[];
  /** The top-level item being classified (its source position). */
  cursor: number;
  hasLoader: boolean;
  hasAction: boolean;
  hasMeta: boolean;
  hasLinks: boolean;
  hasHandle: boolean;
  hasHeaders: boolean;
  hasDefault: boolean;
  hasErrorBoundary: boolean;
  /** A Remix v1 `CatchBoundary` export (deprecated in v2 — merged into `ErrorBoundary`). */
  hasCatchBoundary: boolean;
  /** A `shouldRevalidate` export (extracted, but denext always revalidates — see the note). */
  hasShouldRevalidate: boolean;
  /**
   * A root `Layout` export (Remix ≥ 2.8): the document shell that wraps the default
   * component AND the ErrorBoundary — the migrated root boundary renders through it.
   */
  hasLayoutExport: boolean;
}

// ── AST substrate (swc): top-level items, bound names, free identifiers ────────
//
// A route module is split by parsing it once with swc and reading each top-level
// item's exact source text from its byte span (robust where the old hand-rolled
// scanner was fragile — regex literals, JSX `<`/`>`, template interpolation, class
// bodies). Scope-aware free-variable analysis then lets each generated split
// include only the helpers it actually references.

/** Collect the names a function/arrow parameter list binds into `scope`. */
function collectParams(params: Node[] | undefined, scope: Set<string>): void {
  for (const p of params ?? []) {
    // swc wraps a function param as `{ type: "Parameter", pat }`; an arrow param is
    // the pattern directly. A TS parameter property carries `.param`.
    const pat = p?.pat ?? p?.param ?? p;
    collectPatternNames(pat, scope);
  }
}

/** Declaration node types that bind a single name (on `.identifier` or `.id`). */
const SINGLE_NAME_DECLS = new Set([
  "FunctionDeclaration",
  "ClassDeclaration",
  "TsTypeAliasDeclaration",
  "TsInterfaceDeclaration",
  "TsEnumDeclaration",
]);

/** The names a declaration binds: a function/class/type name, or a variable's patterns. */
function declKindNames(decl: Node): string[] {
  if (!decl) return [];
  if (decl.type === "VariableDeclaration") {
    const names = new Set<string>();
    for (const d of decl.declarations ?? []) collectPatternNames(d.id, names);
    return [...names];
  }
  const named = decl.identifier ?? decl.id; // function/class use `.identifier`, types use `.id`
  return SINGLE_NAME_DECLS.has(decl.type) && named ? [named.value] : [];
}

/** Add the names declared DIRECTLY in a block/module body to `scope` (hoisting-safe). */
function collectHoisted(stmts: Node[] | undefined, scope: Set<string>): void {
  for (const s of stmts ?? []) {
    const decl = s?.type === "ExportDeclaration" ? s.declaration : s;
    for (const name of declKindNames(decl)) scope.add(name);
  }
}

/** The names a single top-level declaration binds (for its own identity/self-reference). */
export function declaredNames(item: Node): string[] {
  const scope = new Set<string>();
  collectHoisted([item], scope);
  return [...scope];
}

/**
 * Free identifiers referenced by `root` — those not bound by any enclosing scope
 * within it. Scope-aware (function/arrow params, block `let`/`const`, `catch`, loop
 * vars, hoisted decls) so a name shadowed by a local binding is NOT reported free
 * (e.g. a component's `const { visits } = useLoaderData()` shadows a module-level
 * `visits`). Binding detection is conservative and reference detection liberal, so
 * the result only ever OVER-approximates the free set — a needed helper is never
 * dropped, at worst an unused one is kept.
 */
export function freeIdentifiers(root: Node): Set<string> {
  const free = new Set<string>();
  // Seed the top scope with `root`'s own bindings so a self-reference isn't "free".
  walkFreeIds(root, [new Set<string>(declaredNames(root))], free);
  return free;
}

/** The lexical scope stack (innermost last) during a free-identifier walk. */
type Scopes = Set<string>[];
type ScopeWalker = (node: Node, scopes: Scopes, free: Set<string>) => void;

/** Push a fresh scope populated by `bind` onto the stack (for a nested lexical scope). */
function pushScope(scopes: Scopes, bind: (scope: Set<string>) => void): Scopes {
  const scope = new Set<string>();
  bind(scope);
  return [...scopes, scope];
}

/** A function declaration/expression: its own name, params and hoisted body decls. */
const walkFunctionScope: ScopeWalker = (node, scopes, free) => {
  const inner = pushScope(scopes, (s) => {
    if (node.identifier) s.add(node.identifier.value); // name visible to its own body
    collectParams(node.params, s);
    if (node.body) collectHoisted(node.body.stmts, s);
  });
  for (const p of node.params ?? []) walkFreeIds(p, inner, free); // default-value exprs
  for (const st of node.body?.stmts ?? []) walkFreeIds(st, inner, free);
};

const walkArrowScope: ScopeWalker = (node, scopes, free) => {
  const inner = pushScope(scopes, (s) => {
    collectParams(node.params, s);
    if (node.body?.type === "BlockStatement") collectHoisted(node.body.stmts, s);
  });
  for (const p of node.params ?? []) walkFreeIds(p, inner, free);
  walkFreeIds(node.body, inner, free);
};

const walkBlockScope: ScopeWalker = (node, scopes, free) => {
  const inner = pushScope(scopes, (s) => collectHoisted(node.stmts, s));
  for (const st of node.stmts ?? []) walkFreeIds(st, inner, free);
};

const walkCatchScope: ScopeWalker = (node, scopes, free) => {
  const inner = pushScope(scopes, (s) => {
    if (node.param) collectPatternNames(node.param, s);
    if (node.body) collectHoisted(node.body.stmts, s);
  });
  for (const st of node.body?.stmts ?? []) walkFreeIds(st, inner, free);
};

/** `for`/`for…in`/`for…of`: a `let`/`const` head binds for the whole statement. */
const walkForScope: ScopeWalker = (node, scopes, free) => {
  const inner = pushScope(scopes, (s) => {
    const head = node.init ?? node.left;
    if (head?.type === "VariableDeclaration") {
      for (const d of head.declarations ?? []) collectPatternNames(d.id, s);
    }
  });
  for (const k of ["init", "left", "test", "update", "right", "body"]) {
    if (node[k]) walkFreeIds(node[k], inner, free);
  }
};

/** `a.b` — `b` is a property name, not a reference; `a[b]` (computed) is. */
const walkMemberRefs: ScopeWalker = (node, scopes, free) => {
  walkFreeIds(node.object, scopes, free);
  const prop = node.property;
  if (node.computed || prop?.type === "Computed") walkFreeIds(prop, scopes, free);
  else if (prop && prop.type !== "Identifier") walkFreeIds(prop, scopes, free);
};

/** `{ key: value }` — a non-computed identifier key is not a reference. */
const walkKeyValueRefs: ScopeWalker = (node, scopes, free) => {
  if (node.key?.type === "Computed") walkFreeIds(node.key, scopes, free);
  walkFreeIds(node.value, scopes, free);
};

/** Per-node-type scope handlers — each opens the node's lexical scope, then recurses. */
/** The `typeof X` (type-position) references recorded alongside a free-identifier set. */
const TYPE_ONLY = new WeakMap<Set<string>, Set<string>>();
const NO_IDS: ReadonlySet<string> = new Set();

/** The `typeof`-only references collected while computing `free` (see {@link HelperDecl.typeOnly}). */
function typeOnlyRefs(free: Set<string>): Set<string> {
  return new Set(TYPE_ONLY.get(free) ?? NO_IDS);
}

/** `typeof X` in a type position: X is a type-level reference, not a runtime dependency. */
function walkTypeQuery(node: Node, scopes: Scopes, free: Set<string>): void {
  let sink = TYPE_ONLY.get(free);
  if (!sink) TYPE_ONLY.set(free, sink = new Set());
  walkFreeIds(node.exprName, scopes, sink);
}

const SCOPE_WALKERS: Record<string, ScopeWalker> = {
  TsTypeQuery: walkTypeQuery,
  FunctionDeclaration: walkFunctionScope,
  FunctionExpression: walkFunctionScope,
  ArrowFunctionExpression: walkArrowScope,
  BlockStatement: walkBlockScope,
  CatchClause: walkCatchScope,
  ForStatement: walkForScope,
  ForInStatement: walkForScope,
  ForOfStatement: walkForScope,
  MemberExpression: walkMemberRefs,
  KeyValueProperty: walkKeyValueRefs,
  JSXOpeningElement: walkJsxOpening,
  JSXClosingElement: walkJsxClosing,
  JSXAttribute: walkJsxAttribute,
  JSXNamespacedName: walkJsxClosing,
};

/**
 * `<form action={x} className="y">`: the tag name of an intrinsic element and every attribute
 * NAME are not identifier references — recording them made `action`/`form` "free", which
 * kept `import { action } from "./login.server.ts"` in the CLIENT split (a server module in
 * the browser bundle). A capitalized tag (`<Form>`) and `<Foo.Bar>`'s root ARE references.
 */
function walkJsxOpening(node: Node, scopes: Scopes, free: Set<string>): void {
  walkJsxName(node.name, scopes, free);
  for (const attr of node.attributes ?? []) walkFreeIds(attr, scopes, free);
}

function walkJsxName(name: Node, scopes: Scopes, free: Set<string>): void {
  if (!name) return;
  if (name.type === "Identifier") {
    if (/^[A-Z_$]/.test(String(name.value))) recordIdentifier(name, scopes, free);
  } else if (name.type === "JSXMemberExpression") {
    let root = name;
    while (root?.type === "JSXMemberExpression") root = root.object;
    if (root?.type === "Identifier") recordIdentifier(root, scopes, free);
  }
  // JSXNamespacedName (`<svg:path>`) binds nothing.
}

/** A closing tag repeats the opening name — never a new reference. */
function walkJsxClosing(_node: Node, _scopes: Scopes, _free: Set<string>): void {}

/** The attribute NAME is not a reference; its value may be one. */
function walkJsxAttribute(node: Node, scopes: Scopes, free: Set<string>): void {
  if (node.value) walkFreeIds(node.value, scopes, free);
}

/** Record an identifier as free unless some enclosing scope binds it. */
function recordIdentifier(node: Node, scopes: Scopes, free: Set<string>): void {
  const name = node.value;
  if (typeof name === "string" && !scopes.some((s) => s.has(name))) free.add(name);
}

function walkFreeIds(node: Node, scopes: Scopes, free: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "Identifier") return recordIdentifier(node, scopes, free);
  const handler = SCOPE_WALKERS[node.type as string];
  if (handler) return handler(node, scopes, free);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) walkFreeIds(c, scopes, free);
    } else if (v && typeof v === "object") {
      walkFreeIds(v, scopes, free);
    }
  }
}

/** The exported name a top-level `export function/const foo` statement declares, or null. */
function exportedName(stmt: string): string | null {
  const m = stmt.match(
    /^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/,
  );
  return m ? m[1] : null;
}

/**
 * The helper declarations a generated split needs: those whose bound name is
 * referenced (free) by the seed statements, closed transitively over helper→helper
 * references. Returned in source order.
 */
export function selectHelpers(
  helpers: HelperDecl[],
  seedFree: Set<string>,
  includeExported = false,
): string[] {
  return selectHelperDecls(helpers, seedFree, includeExported).map((h) => h.code);
}

/** {@link selectHelpers}, returning the declarations (their free identifiers drive import pruning). */
export function selectHelperDecls(
  helpers: HelperDecl[],
  seedFree: Set<string>,
  includeExported = false,
): HelperDecl[] {
  const needed = new Set<string>(seedFree);
  const included = new Set<HelperDecl>();
  const include = (h: HelperDecl) => {
    included.add(h);
    for (const f of h.free) needed.add(f);
  };
  // Exported types are the module's public surface (other modules import them).
  if (includeExported) helpers.filter((h) => h.exported).forEach(include);
  // Transitive closure: a helper is needed when a needed name is one it binds.
  let changed = true;
  while (changed) {
    changed = false;
    for (const h of helpers) {
      if (included.has(h) || !h.names.some((n) => needed.has(n))) continue;
      include(h);
      changed = true;
    }
  }
  return helpers.filter((h) => included.has(h));
}

/** Every identifier `statements` reference (their own free ids + the selected helpers'). */
export function referencedIds(seed: Set<string>, helpers: HelperDecl[]): Set<string> {
  const out = new Set(seed);
  for (const h of helpers) for (const f of h.free) out.add(f);
  return out;
}

/**
 * `declare` stubs for value helpers a split references ONLY through `typeof X` (the
 * component's `useFetcher<typeof profileUpdateAction>()`): the declaration stays out of
 * this split (it may reach server-only code), the type reference still resolves.
 */
function typeOnlyStubs(
  parts: ModuleParts,
  seedTypeOnly: Set<string>,
  selected: HelperDecl[],
): string[] {
  const refs = new Set(seedTypeOnly);
  for (const h of selected) for (const t of h.typeOnly ?? []) refs.add(t);
  const present = new Set(selected.flatMap((h) => h.names));
  const stubs: string[] = [];
  for (const id of refs) {
    if (present.has(id)) continue;
    const helper = parts.helpers.find((h) => h.names.includes(id) && !h.isType);
    if (!helper) continue;
    const isFn = /^\s*(?:export\s+)?(?:async\s+)?function\b/.test(helper.code);
    stubs.push(
      isFn
        ? `declare const ${id}: (...args: never[]) => Promise<unknown>;`
        : `declare const ${id}: unknown;`,
    );
  }
  return stubs;
}

/** Whether an `export`/declaration item is a pure type (no runtime value). */
export function isTypeDecl(decl: Node): boolean {
  return decl?.type === "TsTypeAliasDeclaration" || decl?.type === "TsInterfaceDeclaration" ||
    decl?.type === "TsEnumDeclaration";
}

/** The `ModuleParts` presence flag a server export name sets (no flag for `shouldRevalidate`). */
type ServerFlag =
  | "hasLoader"
  | "hasAction"
  | "hasMeta"
  | "hasLinks"
  | "hasHandle"
  | "hasHeaders"
  | "hasShouldRevalidate";
const SERVER_FLAG: Record<string, ServerFlag> = {
  loader: "hasLoader",
  action: "hasAction",
  meta: "hasMeta",
  links: "hasLinks",
  handle: "hasHandle",
  headers: "hasHeaders",
  shouldRevalidate: "hasShouldRevalidate",
};

/**
 * Partition a route module into server/client/helper statements by parsing it with
 * swc and classifying each top-level item. `loader`/`action`/`meta`/`links`/`handle`/
 * `headers`/`shouldRevalidate` exports become the server data module; the default
 * component + `ErrorBoundary` + other named exports become the client component;
 * imports and plain top-level declarations/types are helpers, included per split by
 * reference. Falls back to treating the module as a single client statement if it
 * cannot be parsed (so migration never crashes on exotic-but-valid source).
 */
export async function analyzeModule(code: string): Promise<ModuleParts> {
  const parts = emptyParts();
  const parsed = await parseRouteModule(code);
  if (!parsed) {
    // Unparseable (shouldn't happen for valid TSX) → treat the whole module as the
    // client component so the migration degrades instead of crashing.
    parts.clientStatements.push(code);
    parts.clientOrder.push(0);
    parts.hasDefault = /export\s+default\b/.test(code);
    return parts;
  }
  parsed.items.forEach((item, i) => {
    parts.cursor = i;
    classifyItem(parts, item, txt(parsed.ctx, item));
  });
  return parts;
}

function emptyParts(): ModuleParts {
  return {
    imports: [],
    helpers: [],
    serverStatements: [],
    clientStatements: [],
    serverFree: new Set(),
    clientFree: new Set(),
    serverTypeOnly: new Set(),
    clientTypeOnly: new Set(),
    serverOrder: [],
    clientOrder: [],
    cursor: 0,
    hasLoader: false,
    hasAction: false,
    hasMeta: false,
    hasLinks: false,
    hasHandle: false,
    hasHeaders: false,
    hasDefault: false,
    hasErrorBoundary: false,
    hasCatchBoundary: false,
    hasShouldRevalidate: false,
    hasLayoutExport: false,
  };
}

/** Parse a route module (marker-prefixed so offsets have an exact base); null when unparseable. */
export async function parseRouteModule(code: string): Promise<{ ctx: Ctx; items: Node[] } | null> {
  const bytes = encoder.encode(MARKER + code);
  let ast: Node;
  try {
    const parse = await swcParse();
    ast = await parse(MARKER + code);
  } catch {
    return null;
  }
  const items: Node[] = (ast.body ?? []).slice(1); // drop the "0;" marker statement
  const base = ast.body?.[0]?.span?.start ?? 0;
  return { ctx: { bytes, base }, items };
}

function addFree(target: Set<string>, n: Node, typeOnlyTarget?: Set<string>): void {
  const free = freeIdentifiers(n);
  for (const f of free) target.add(f);
  if (typeOnlyTarget) { for (const t of typeOnlyRefs(free)) typeOnlyTarget.add(t); }
}

function pushHelper(
  parts: ModuleParts,
  code: string,
  names: string[],
  node: Node,
  exported = false,
): void {
  const free = freeIdentifiers(node);
  parts.helpers.push({
    code,
    names,
    free,
    typeOnly: typeOnlyRefs(free),
    exported,
    isType: isTypeDecl(node),
    index: parts.cursor,
  });
}

/**
 * A named `export <decl>` — a type helper, a server-data export, an ErrorBoundary, or any
 * other named export (which stays client-side).
 */
function classifyExport(parts: ModuleParts, decl: Node, itemCode: string): void {
  const names = declKindNames(decl);
  if (isTypeDecl(decl)) return pushHelper(parts, itemCode, names, decl, true);
  const serverName = names.find((n) => SERVER_EXPORTS.has(n));
  if (serverName) {
    parts.serverStatements.push(itemCode);
    parts.serverOrder.push(parts.cursor);
    addFree(parts.serverFree, decl, parts.serverTypeOnly);
    const flag = SERVER_FLAG[serverName];
    if (flag) parts[flag] = true;
    return;
  }
  parts.clientStatements.push(itemCode);
  parts.clientOrder.push(parts.cursor);
  addFree(parts.clientFree, decl, parts.clientTypeOnly);
  if (names.includes("Layout")) parts.hasLayoutExport = true;
  if (names.includes("ErrorBoundary")) parts.hasErrorBoundary = true;
  if (names.includes("CatchBoundary")) parts.hasCatchBoundary = true;
}

/** Classify one top-level item into imports / server / client / helpers. */
function classifyItem(parts: ModuleParts, item: Node, itemCode: string): void {
  switch (item.type) {
    case "ImportDeclaration":
      parts.imports.push(itemCode);
      return;
    case "ExportDeclaration":
      classifyExport(parts, item.declaration, itemCode);
      return;
    case "ExportDefaultDeclaration":
    case "ExportDefaultExpression":
      parts.clientStatements.push(itemCode);
      parts.clientOrder.push(parts.cursor);
      parts.hasDefault = true;
      addFree(parts.clientFree, item.decl ?? item.expression ?? item, parts.clientTypeOnly);
      return;
    case "ExportNamedDeclaration":
      classifyReExport(parts, item, itemCode);
      return;
    case "ExportAllDeclaration":
      // `export * from …` — a re-export; keep it client-side.
      parts.clientStatements.push(itemCode);
      parts.clientOrder.push(parts.cursor);
      return;
    default:
      // A plain top-level declaration (function/const/class) or a type → a helper,
      // included per split only where referenced.
      pushHelper(parts, itemCode, declaredNames(item), item);
  }
}

/**
 * `export { … } [from …]`: a re-exported `loader`/`action`/… (the Epic Stack's
 * `export { action } from './x.server.ts'`) is a SERVER export — it must land in the data
 * module (a server module re-exported from a client one would drag it into the client
 * bundle) and set the same flags a declaration would. A re-exported `default` is the
 * component; anything else stays client-side.
 */
function classifyReExport(parts: ModuleParts, item: Node, itemCode: string): void {
  const specifiers = (item.specifiers ?? []) as Node[];
  const names = specifiers.map((sp) => {
    const exported = sp.exported ?? sp.orig;
    return String(exported?.value ?? "");
  });
  const server = names.filter((n) => SERVER_EXPORTS.has(n));
  if (server.length > 0) {
    parts.serverStatements.push(itemCode);
    parts.serverOrder.push(parts.cursor);
    for (const n of server) {
      const flag = SERVER_FLAG[n];
      if (flag) parts[flag] = true;
    }
    return;
  }
  parts.clientStatements.push(itemCode);
  parts.clientOrder.push(parts.cursor);
  if (names.includes("default")) parts.hasDefault = true;
  if (names.includes("ErrorBoundary")) parts.hasErrorBoundary = true;
}

// ── Wrapper generators ────────────────────────────────────────────────────────

export const GEN_HEADER =
  "// Generated by `denext migrate --from remix` — Remix route on denext.\n";

/** The binding names an import statement introduces (default, namespace, named). */
function importBindings(stmt: string): string[] {
  const names: string[] = [];
  const from = stmt.match(/import\s+([\s\S]*?)\s+from\s/);
  const clause = from?.[1] ?? "";
  const named = clause.match(/\{([^}]*)\}/);
  if (named) {
    for (const raw of named[1].split(",")) {
      const name = raw.replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
  }
  const ns = clause.match(/\*\s+as\s+([A-Za-z0-9_$]+)/);
  if (ns) names.push(ns[1]);
  const def = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+[A-Za-z0-9_$]+/, "")
    .split(",")[0]?.trim();
  if (def && /^[A-Za-z0-9_$]+$/.test(def)) names.push(def);
  return names;
}

/**
 * The bindings an import statement introduces as TYPES only (`import type { X }`,
 * `import { type X }`): they never reach the free-identifier walk (type positions are not
 * references), so their retention is decided textually — keeping a type import is free.
 */
function typeOnlyBindings(stmt: string): string[] {
  if (/^\s*import\s+type\b/.test(stmt)) return importBindings(stmt);
  const named = stmt.match(/\{([^}]*)\}/);
  if (!named) return [];
  return named[1].split(",")
    .filter((raw) => /^\s*type\s+/.test(raw))
    .map((raw) => raw.replace(/^\s*type\s+/, "").split(/\s+as\s+/).pop()?.trim() ?? "")
    .filter(Boolean);
}

/** Keep only imports whose bindings are referenced in `body` (side-effect imports always). */
export function usedImports(imports: string[], body: string, referenced?: Set<string>): string[] {
  const mentioned = (b: string) => new RegExp(`\\b${escapeRe(b)}\\b`).test(body);
  return imports.filter((stmt) => {
    if (!/\bfrom\b/.test(stmt)) return true; // side-effect import — keep
    const bindings = importBindings(stmt);
    if (bindings.length === 0) return true;
    // With the AST's free identifiers, an import is kept only when a binding is actually
    // REFERENCED — the word appearing in a string (`<Form action="/logout">`) must not drag
    // `auth.server.ts` (and Prisma) into a client module. The textual check is the
    // fallback for callers without an AST — and decides the type-only bindings, which a
    // reference walk never sees (`{ type LoaderFunctionArgs }` in a signature).
    if (referenced) {
      return bindings.some((b) => referenced.has(b)) || typeOnlyBindings(stmt).some(mentioned);
    }
    return bindings.some(mentioned);
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Turn a route module's `export default <component>` into a local declaration + its name. */
function delocalizeDefault(stmt: string): { code: string; name: string } {
  let m = stmt.match(/export\s+default\s+function\s+([A-Za-z0-9_$]+)/);
  if (m) return { code: stmt.replace(/export\s+default\s+function/, "function"), name: m[1] };
  m = stmt.match(/export\s+default\s+function\b/); // anonymous function
  if (m) {
    return {
      code: stmt.replace(/export\s+default\s+function/, "function __RemixUserComponent"),
      name: "__RemixUserComponent",
    };
  }
  m = stmt.match(/export\s+default\s+class\s+([A-Za-z0-9_$]+)/);
  if (m) return { code: stmt.replace(/export\s+default\s+class/, "class"), name: m[1] };
  m = stmt.match(/^\s*export\s+default\s+([A-Za-z0-9_$]+)\s*;?\s*$/);
  if (m) return { code: "", name: m[1] }; // `export default Name;` — Name declared elsewhere
  // `export default <expr>` (arrow, HOC call, …) → bind to a local const.
  return {
    code: stmt.replace(/export\s+default\s+/, "const __RemixUserComponent = "),
    name: "__RemixUserComponent",
  };
}

/**
 * The client route module (`"use client"`): the user's Remix component + `ErrorBoundary` +
 * helpers, plus a generated default boundary that composes `RemixRouteProvider` (and, for a
 * layout, `OutletProvider`) around the user component and receives its loader data as a
 * **prop** — so `useLoaderData`/matches/action context resolve within one client unit
 * (server SSR + hydrate). Keeps only the imports it uses; `typeof loader`/`typeof action`
 * references get an erased `import type` from the server data module.
 */
export function clientModuleSource(
  parts: ModuleParts,
  dataFile: string,
  role: "page" | "layout",
  root = false,
): string {
  const { clientStmts, userName } = delocalizedClientStatements(parts, root);
  // Include only the helpers the client body references (transitively) — a server-only
  // helper (e.g. a loader's private constant) is not duplicated here — plus every exported
  // type, which other modules import from this route.
  const helpers = selectHelperDecls(parts.helpers, parts.clientFree, true)
    // The root's document shell may live in a helper (`function Document() { <html>… }`).
    .map((h) => (root ? { ...h, code: renameDocumentTags(h.code) } : h));
  const bodyStatements = [
    ...typeOnlyStubs(parts, parts.clientTypeOnly, helpers),
    ...inSourceOrder(helpers, clientStmts),
  ];
  const bodyText = bodyStatements.join("\n");
  const referenced = referencedIds(parts.clientFree, helpers);
  for (const t of parts.clientTypeOnly) referenced.add(t);
  for (const h of helpers) for (const t of h.typeOnly ?? []) referenced.add(t);
  if (!parts.hasDefault) {
    // A resource route that also exports components/hooks/constants (the Epic Stack's
    // `theme-switch.tsx`): no route boundary, just the client-side exports.
    const plain = [
      ...usedImports(parts.imports, bodyText, referenced),
      ...serverTypeImports(parts, bodyText, dataFile),
      ...bodyStatements,
    ].map((st) => rewriteRemixImports(st).trim()).join("\n\n");
    return `"use client";\n${GEN_HEADER}${plain}\n`;
  }
  const runtime = ["RemixRouteProvider"];
  if (role === "layout") runtime.push("OutletProvider");
  if (parts.hasErrorBoundary || parts.hasCatchBoundary) runtime.push("RemixErrorProvider");
  for (const tag of ["DocumentBody", "DocumentHead", "DocumentHtml"]) {
    if (bodyText.includes(`<${tag}`)) runtime.push(tag);
  }
  const body = [
    ...usedImports(parts.imports, bodyText, referenced),
    ...serverTypeImports(parts, bodyText, dataFile),
    `import { ${runtime.join(", ")} } from "denext/remix";`,
    ...bodyStatements,
  ].map((s) => rewriteRemixImports(s).trim()).join("\n\n");
  return `"use client";\n${GEN_HEADER}${body}\n\n${
    boundarySource(userName, role, root && parts.hasLayoutExport)
  }${errorBoundaryExport(parts)}\n`;
}

/** Delocalize the user's default component so the generated boundary can wrap it. */
function delocalizedClientStatements(
  parts: ModuleParts,
  root = false,
): { clientStmts: Indexed[]; userName: string } {
  const clientStmts: Indexed[] = [];
  let userName = "__RemixUserComponent";
  parts.clientStatements.forEach((raw, i) => {
    // The root's document shell renders through denext's document (see `renameDocumentTags`).
    const stmt = root ? renameDocumentTags(raw) : raw;
    const index = parts.clientOrder[i] ?? i;
    if (!/^\s*export\s+default\b/.test(stmt.trimStart())) {
      clientStmts.push({ code: stmt, index });
      return;
    }
    const d = delocalizeDefault(stmt);
    userName = d.name;
    if (d.code) clientStmts.push({ code: d.code, index });
  });
  return { clientStmts, userName };
}

/** A statement with its source position. */
interface Indexed {
  code: string;
  index: number;
}

/**
 * Helpers + statements in their ORIGINAL source order: a module's top-level order is
 * semantic (`const Match = z.object({ handle: Handle })` after `export const Handle`, a
 * side-effecting call after what it uses), so a split must not hoist helpers ahead.
 */
function inSourceOrder(helpers: HelperDecl[], statements: Indexed[]): string[] {
  return [...helpers.map((h) => ({ code: h.code, index: h.index ?? 0 })), ...statements]
    .sort((a, b) => a.index - b.index)
    .map((s) => s.code);
}

/** `typeof loader`/`typeof action`/… references get an erased `import type` from the data module. */
function serverTypeImports(parts: ModuleParts, bodyText: string, dataFile: string): string[] {
  const typeNames = ["loader", "action", "meta", "links"].filter(
    (n) =>
      new RegExp(`typeof\\s+${n}\\b`).test(bodyText) &&
      parts.serverStatements.some((s) => exportedName(s.trimStart()) === n),
  );
  return typeNames.length ? [`import type { ${typeNames.join(", ")} } from "./${dataFile}";`] : [];
}

/**
 * The generated default boundary: `RemixRouteProvider` (and, for a layout, `OutletProvider`)
 * around the user component, receiving its loader data as a prop.
 */
function boundarySource(userName: string, role: "page" | "layout", viaLayout = false): string {
  // Remix renders the root's `Layout` export around the page component (and around the
  // ErrorBoundary): `<Layout><App/></Layout>`.
  const user = viaLayout ? `<Layout><${userName} /></Layout>` : `<${userName} />`;
  const inner = role === "layout"
    ? `      <OutletProvider outlet={props.children}>\n` +
      `        ${user}\n` +
      `      </OutletProvider>`
    : `      ${user}`;
  return `export default function __RemixRouteBoundary(props: {
  id: string;
  loaderData: unknown;
  params: Record<string, string>;
  handle?: unknown;
  formAction?: (formData: FormData) => Promise<unknown>;
  children?: unknown;
}) {
  return (
    <RemixRouteProvider
      id={props.id}
      loaderData={props.loaderData}
      params={props.params}
      handle={props.handle}
      formAction={props.formAction}
    >
${inner}
    </RemixRouteProvider>
  );
}`;
}

/**
 * The `__RemixError` export the generated `error.tsx` renders, or `""` when the route has no
 * error boundary. Prefers the v2 `ErrorBoundary`; falls back to a v1 `CatchBoundary` (deprecated)
 * when that's the only one the route defines — both read the caught value from
 * `RemixErrorProvider` (`useRouteError`/`isRouteErrorResponse`/`useCatch`).
 */
function errorBoundaryExport(parts: ModuleParts): string {
  const boundaryComponent = parts.hasErrorBoundary
    ? "ErrorBoundary"
    : parts.hasCatchBoundary
    ? "CatchBoundary"
    : null;
  if (!boundaryComponent) return "";
  const inner = parts.hasLayoutExport
    ? `<Layout><${boundaryComponent} /></Layout>`
    : `<${boundaryComponent} />`;
  return `\n\nexport function __RemixError(props: { error: unknown }) {
  return (
    <RemixErrorProvider error={props.error}>
      ${inner}
    </RemixErrorProvider>
  );
}`;
}

/** The server data module — loader/action/meta/links/handle/headers + helpers, imports it uses. */
export function dataModuleSource(parts: ModuleParts): string {
  const helpers = selectHelperDecls(parts.helpers, parts.serverFree);
  const serverStmts = parts.serverStatements.map((code, i) => ({
    code,
    index: parts.serverOrder[i] ?? i,
  }));
  const bodyStatements = [
    ...typeOnlyStubs(parts, parts.serverTypeOnly, helpers),
    ...inSourceOrder(helpers, serverStmts),
  ];
  const referenced = referencedIds(parts.serverFree, helpers);
  for (const t of parts.serverTypeOnly) referenced.add(t);
  for (const h of helpers) for (const t of h.typeOnly ?? []) referenced.add(t);
  const imports = usedImports(parts.imports, bodyStatements.join("\n"), referenced);
  const body = [...imports, ...bodyStatements]
    .map((s) => rewriteRemixImports(s).trim())
    .join("\n\n");
  return `${GEN_HEADER}${body}\n`;
}

/** The generated denext `page.tsx` (server wrapper) around a Remix route. */
/** The generated `generateMetadata` line: meta bridge + match registration for `id`. */
/**
 * The marker `remixServerBuild()` reads to map a denext route back to its Remix module
 * (id + data exports) — what `context.serverBuild.routes` reflects over.
 */
function remixRouteExport(id: string, hasServer: boolean): string {
  return `export const remixRoute = { id: ${JSON.stringify(id)}, module: ${
    hasServer ? "data" : "{}"
  } };\n`;
}

function metaExport(id: string, parts: ModuleParts): string {
  const args = [
    parts.hasMeta ? "data.meta" : "undefined",
    parts.hasLoader ? "data.loader" : "undefined",
    JSON.stringify(id),
    parts.hasHandle ? "data.handle" : "undefined",
    parts.hasLinks ? "data.links" : "undefined",
  ];
  return `export const generateMetadata = remixMeta(${args.join(", ")});`;
}

/**
 * The generated denext `page.tsx` / `layout.tsx` (server wrapper) around a Remix route: it
 * imports the client component + the server data module and renders `RemixRoute` /
 * `RemixLayout` with the route's loader/action/handle. `meta` gets Remix's `matches`
 * (ancestors' loader data): every level with a loader registers itself, meta or not, and the
 * loader result is reused by the render; a layout's `meta` merges into every level's.
 */
function routeWrapperSource(
  role: "page" | "layout",
  id: string,
  parts: ModuleParts,
  clientFile: string,
  dataFile: string,
): string {
  const hasServer = parts.serverStatements.length > 0;
  const runtimeFn = role === "page" ? "RemixRoute" : "RemixLayout";
  const imports = [`import Route from "./${clientFile}";`];
  if (hasServer) imports.push(`import * as data from "./${dataFile}";`);
  const withMeta = parts.hasMeta || parts.hasLoader || parts.hasLinks;
  const runtime = withMeta ? `${runtimeFn}, remixMeta` : runtimeFn;
  imports.push(`import { ${runtime} } from "denext/remix/server";`);
  const meta = withMeta ? `\n${metaExport(id, parts)}\n` : "";
  const opts = [
    `    id: ${JSON.stringify(id)},`,
    parts.hasLoader ? "    loader: data.loader," : null,
    parts.hasAction ? "    action: data.action," : null,
    parts.hasHandle ? "    handle: data.handle," : null,
    parts.hasShouldRevalidate ? "    shouldRevalidate: data.shouldRevalidate," : null,
    "    Route,",
    "    params: props.params,",
    role === "layout" ? "    children: props.children," : null,
  ].filter(Boolean).join("\n");
  const signature = role === "page"
    ? "export default function Page(props: { params: Record<string, string> }) {"
    : "export default function Layout(\n  props: { children: unknown; params: Record<string, string> },\n) {";
  return `${GEN_HEADER}${imports.join("\n")}\n${meta}${remixRouteExport(id, hasServer)}${
    role === "layout" ? "\n" : ""
  }
${signature}
  return ${runtimeFn}({
${opts}
  });
}
`;
}

/** The generated denext `page.tsx` (server wrapper) around a Remix page route. */
export function pageWrapperSource(
  id: string,
  parts: ModuleParts,
  clientFile: string,
  dataFile: string,
): string {
  return routeWrapperSource("page", id, parts, clientFile, dataFile);
}

/** The generated denext `layout.tsx` (server wrapper) around a Remix layout route. */
export function layoutWrapperSource(
  id: string,
  parts: ModuleParts,
  clientFile: string,
  dataFile: string,
): string {
  return routeWrapperSource("layout", id, parts, clientFile, dataFile);
}

/** The generated denext `error.tsx` — renders the client error boundary with the caught error. */
export function errorWrapperSource(clientFile: string): string {
  return `${GEN_HEADER}import { __RemixError } from "./${clientFile}";

export default function ErrorRoute(props: { error: Error; reset: () => void }) {
  return <__RemixError error={props.error} />;
}
`;
}

/**
 * Whether a Remix root layout must be a client component. A pure document shell
 * (`<html><head>…</head><body><Outlet/></body></html>` with no data/interactivity) can be
 * denext's server document root; anything with a React hook, a JSX event handler, or a
 * loader/action must run through the client boundary instead.
 */
export function rootNeedsClient(parts: ModuleParts): boolean {
  const body = [...parts.helpers.map((h) => h.code), ...parts.clientStatements].join("\n");
  return /\buse[A-Z]\w*\s*\(/.test(body) || /\bon[A-Z]\w+\s*=/.test(body) ||
    parts.hasLoader || parts.hasAction;
}

/**
 * A Remix root renders the document itself (`<html lang className={theme}><head>…</head>
 * <body className>…</body></html>`); denext owns the real document, so the root's three tags
 * become the `denext/remix` document-shell components: their attributes flow onto denext's
 * `<html>`/`<body>` (server: merged into the document; client: applied live, so a theme class
 * toggled on `<html>` works) and their children render through (head tags are hoisted).
 */
function renameDocumentTags(stmt: string): string {
  return mapOutsideStrings(stmt, (code) =>
    code
      .replace(/<html(?=[\s>])/g, "<DocumentHtml")
      .replace(/<\/html>/g, "</DocumentHtml>")
      .replace(/<head(?=[\s>])/g, "<DocumentHead")
      .replace(/<\/head>/g, "</DocumentHead>")
      .replace(/<body(?=[\s>])/g, "<DocumentBody")
      .replace(/<\/body>/g, "</DocumentBody>"));
}

/**
 * Apply `fn` to the parts of `code` that are NOT string or template literals — a JSX
 * rewrite must not touch `"<body>"` inside a string (a `dangerouslySetInnerHTML` payload,
 * a test fixture). Template `${…}` holes are treated as code.
 */
function mapOutsideStrings(code: string, fn: (chunk: string) => string): string {
  let out = "";
  let chunk = "";
  let i = 0;
  while (i < code.length) {
    const quote = code[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      chunk += quote;
      i++;
      continue;
    }
    out += fn(chunk);
    chunk = "";
    const end = literalEnd(code, i, quote);
    out += code.slice(i, end);
    i = end;
  }
  return out + fn(chunk);
}

/** The index just past the string/template literal opening at `start` (escapes honored). */
function literalEnd(code: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < code.length) {
    const c = code[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (quote === "`" && c === "$" && code[i + 1] === "{") {
      i = templateHoleEnd(code, i + 2);
      continue;
    }
    i++;
  }
  return code.length;
}

/** The index just past a template `${…}` hole starting at `start` (nested braces/literals honored). */
function templateHoleEnd(code: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < code.length && depth > 0) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      i = literalEnd(code, i, c);
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  return i;
}

/**
 * The generated denext `app/layout.tsx` for a document-shell root: a SERVER component that
 * renders the root's in-body chrome (denext supplies `<html>/<head>/<body>`), with
 * `<Outlet/>` mapped to `children` and the root's `meta` bridged to `generateMetadata`.
 */
export function serverRootLayoutSource(parts: ModuleParts): string {
  const clientStmts = parts.clientStatements.map((stmt) => {
    if (!/^\s*export\s+default\b/.test(stmt.trimStart())) return renameDocumentTags(stmt);
    return renameDocumentTags(stmt)
      .replace(/<Outlet\s*\/>/g, "{children}")
      .replace(/<Outlet\b[^>]*>\s*<\/Outlet>/g, "{children}")
      .replace(
        /export\s+default\s+function\s+([A-Za-z0-9_$]+)\s*\(\s*\)/,
        "export default function $1({ children }: { children?: unknown })",
      );
  });
  const rootSeed = new Set<string>([...parts.serverFree, ...parts.clientFree]);
  const helpers = selectHelpers(parts.helpers, rootSeed).map(renameDocumentTags);
  const bodyStatements = [...helpers, ...parts.serverStatements, ...clientStmts];
  const bodyText = bodyStatements.join("\n");
  const imports = usedImports(parts.imports, bodyText);
  const runtimeImport = parts.hasMeta ? [`import { remixMeta } from "denext/remix/server";`] : [];
  const docTags = ["DocumentBody", "DocumentHead", "DocumentHtml"].filter((t) =>
    bodyText.includes(`<${t}`)
  );
  if (docTags.length) runtimeImport.push(`import { ${docTags.join(", ")} } from "denext/remix";`);
  const metaGen = parts.hasMeta
    ? [`export const generateMetadata = remixMeta(meta, undefined);`]
    : [];
  const body = [...imports, ...runtimeImport, ...bodyStatements, ...metaGen]
    .map((s) => rewriteRemixImports(s).trim())
    .join("\n\n");
  return `${GEN_HEADER}${body}\n`;
}

/**
 * A denext `route.ts` emitted ALONGSIDE a page route that has an `action`, so a plain
 * POST to the page URL runs the action — the Remix model (a POST to a route runs its
 * action). This makes `fetcher.submit`/`<Form action>` cross-route submit to a page's
 * action work, and the no-JS progressive-enhancement post to another page. Only a POST
 * handler is emitted; the page's GET is served by `page.tsx` (denext dispatch falls a
 * method-less API match through to the page). The action's URL params are threaded from
 * the matched pattern.
 */
export function pageActionRouteSource(dataFile: string): string {
  return `${GEN_HEADER}import * as data from "./${dataFile}";
import { runActionResponse } from "denext/remix/server";

export function POST(request: Request, ctx: { params: Record<string, string> }) {
  return runActionResponse(data.action, request, ctx.params);
}
`;
}

/** A denext API `route.ts` for a Remix resource route (a loader/action with no component). */
export function resourceRouteSource(id: string, dataFile: string, parts: ModuleParts): string {
  const methods: string[] = [];
  if (parts.hasLoader) {
    methods.push(
      `export function GET(request: Request) {\n` +
        `  return runLoaderResponse(data.loader, request);\n}`,
    );
  }
  if (parts.hasAction) {
    methods.push(
      `export function POST(request: Request) {\n` +
        `  return runActionResponse(data.action, request);\n}`,
    );
  }
  const runtime = [
    parts.hasLoader ? "runLoaderResponse" : null,
    parts.hasAction ? "runActionResponse" : null,
  ]
    .filter(Boolean).join(", ");
  return `${GEN_HEADER}import * as data from "./${dataFile}";
import { ${runtime} } from "denext/remix/server";

${remixRouteExport(id, true)}
${methods.join("\n\n")}
`;
}
