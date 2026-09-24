// `optimizePackageImports` — Next.js's barrel-import optimization, for the compat (esbuild)
// bundles.
//
// `import { Check } from "lucide-react"` makes the bundler load lucide's barrel, which re-exports
// ~1,670 icon modules. With `"sideEffects": false` esbuild drops the unused ones — unless the same
// icons are ALSO code-splitting entries (lucide's `dynamicIconImports` `import()`s every icon), in
// which case esbuild keeps a bare `import "./chunk-<icon>.js"` for every one of them wherever the
// barrel is used: 1,672 startup chunks for one icon. Rewriting the import to the defining module
// (`import { default as Check } from "…/icons/check.js"`) means the barrel is never loaded, so
// neither problem exists.
//
// Two parts:
//   - `analyzeBarrel` reads a barrel's ESM re-export statements (with the first-party swc parser)
//     into `exported name → { defining file, name there }`, following `export *` chains. A name
//     the barrel defines itself maps back to the barrel ("stay"); a barrel that runs code of its
//     own or carries a directive maps EVERY name back to itself — correctness over coverage.
//   - `rewriteOptimizedImports` rewrites a module's named value imports of a listed package, and
//     `withOptimizedPackageImports` applies it to every JS/TS module an esbuild build loads (app
//     source and node_modules alike): it post-processes the contents other plugins' `onLoad`s
//     return, and loads the remaining files itself.
//
// Rewritten imports name the defining file by ABSOLUTE path, computed exactly the way the compat
// chain's resolvers compute the barrel's own relative imports (the barrel via `resolveNodeFrom`,
// its relatives via `resolve(dirname(barrel), rel)` + the same probe), so a rewritten import and
// e.g. lucide's `dynamicIconImports` `import()` land on ONE module, never two copies.
//
// The contract: listing a package asserts its modules are side-effect free, as Next.js's option
// does. Looking through the barrel skips every sibling module the app doesn't import, so a
// top-level side effect in one of those siblings (a polyfill, a registry `register()` call) no
// longer runs. A barrel that runs code of its OWN is still detected and left alone.

import type * as esbuild from "esbuild";
import { dirname, extname, resolve } from "@std/path";
import type { DenextConfig } from "../server/config.ts";
import { applyEdits, type Edit, endOf, type Node, parseModule, startOf } from "./swc-ast.ts";

/**
 * The packages optimized by default — Next.js's documented default list, trimmed to the
 * packages whose barrels are plain re-export files. An entry ending in `/*` matches every
 * subpath of the package (`react-icons/fa`, `react-icons/md`, …).
 */
export const DEFAULT_OPTIMIZE_PACKAGE_IMPORTS: readonly string[] = [
  "lucide-react",
  "date-fns",
  "lodash-es",
  "ramda",
  "rxjs",
  "@tabler/icons-react",
  "@heroicons/react/20/solid",
  "@heroicons/react/24/solid",
  "@heroicons/react/24/outline",
  "react-icons/*",
  "@mui/icons-material",
  "recharts",
  "react-use",
  "@headlessui/react",
  "effect",
];

/**
 * The effective package list: the built-in {@link DEFAULT_OPTIMIZE_PACKAGE_IMPORTS} plus the
 * configured `optimizePackageImports` (else Next's legacy `experimental.optimizePackageImports`),
 * de-duplicated. `optimizePackageImports: false` disables the optimization entirely (defaults
 * included); a `"!pkg"` entry removes `pkg` from the list (e.g. `"!recharts"` drops a default,
 * `"!react-icons/*"` the wildcard entry).
 *
 * @param config The resolved denext config (may be absent).
 * @returns Every package specifier whose barrel imports are rewritten.
 */
export function optimizePackageImportsList(config: DenextConfig | null | undefined): string[] {
  const configured = config?.optimizePackageImports ??
    config?.experimental?.optimizePackageImports ?? [];
  if (configured === false) return [];
  const excluded = new Set(configured.filter((p) => p.startsWith("!")).map((p) => p.slice(1)));
  const included = configured.filter((p) => !p.startsWith("!"));
  return [...new Set([...DEFAULT_OPTIMIZE_PACKAGE_IMPORTS, ...included])]
    .filter((p) => !excluded.has(p));
}

/** Where one exported name of a barrel really lives. */
export interface BarrelExport {
  /** Absolute path of the module to import the name from. */
  file: string;
  /** The name to import there: `"default"`, a named export, or `"*"` for the namespace. */
  importName: string;
}

/** How the analysis resolves specifiers — injected so it shares the bundle's resolvers. */
export interface BarrelResolvers {
  /** Resolve a bare package specifier from a directory (the compat `resolveNodeFrom`). */
  resolveBare(fromDir: string, spec: string): Promise<string | null>;
  /** Probe an extensionless base path for a real source file (the compat `probeSourceFile`). */
  probe(base: string): string | null;
}

/** Nested `export *` levels followed before a name is given up on (it then stays). */
const MAX_STAR_DEPTH = 8;

/** A module's exports as analysed; `self` is the module's own path. */
type ExportMap = Map<string, BarrelExport>;

/** The string value of an Identifier / string-literal module export name. */
const nameOf = (n: Node): string => n?.value;

/** Resolve a module specifier found in `file`: relative via the probe, bare via the resolver. */
async function resolveSpecifier(
  file: string,
  spec: string,
  r: BarrelResolvers,
): Promise<string | null> {
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    return r.probe(resolve(dirname(file), spec));
  }
  if (spec.startsWith("/")) return r.probe(spec);
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return null; // node:/npm:/https: — not a package file
  return await r.resolveBare(dirname(file), spec);
}

const PURE_LITERALS = new Set([
  "StringLiteral",
  "NumericLiteral",
  "BooleanLiteral",
  "NullLiteral",
  "BigIntLiteral",
  "RegExpLiteral",
  "Identifier",
  "ArrowFunctionExpression",
  "FunctionExpression",
]);

/**
 * Whether evaluating `expr` provably runs no code: literals, identifiers, functions, and
 * object/array/template literals of those. Anything else (a call, `new`, a member read that
 * could hit a getter) counts as a side effect.
 */
function isPureExpr(expr: Node | undefined): boolean {
  if (!expr) return true;
  if (PURE_LITERALS.has(expr.type)) return true;
  switch (expr.type) {
    case "ParenthesisExpression":
    case "TsAsExpression":
    case "TsSatisfiesExpression":
    case "TsConstAssertion":
      return isPureExpr(expr.expression);
    case "TemplateLiteral":
      return (expr.expressions ?? []).every(isPureExpr);
    case "ArrayExpression":
      return (expr.elements ?? []).every((el: Node) =>
        !el || (!el.spread && isPureExpr(el.expression))
      );
    case "ObjectExpression":
      return (expr.properties ?? []).every((p: Node) =>
        p.type === "MethodProperty" || p.type === "GetterProperty" || p.type === "SetterProperty" ||
        p.type === "Identifier" ||
        (p.type === "KeyValueProperty" && p.key?.type !== "Computed" && isPureExpr(p.value))
      );
    case "UnaryExpression":
      return expr.operator !== "delete" && isPureExpr(expr.argument);
    default:
      return false;
  }
}

/** Names bound by a declaration (`const a = …, b`, `function f`, `class C`, `enum E`). */
function declaredNames(decl: Node): string[] {
  switch (decl.type) {
    case "VariableDeclaration":
      return (decl.declarations ?? []).flatMap((d: Node) =>
        d.id?.type === "Identifier" ? [d.id.value] : []
      );
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return decl.identifier ? [decl.identifier.value] : [];
    case "TsEnumDeclaration":
      return decl.id ? [decl.id.value] : [];
    default:
      return []; // interfaces / type aliases / `declare` blocks: types only
  }
}

/** Whether a node carries decorators (each one is a call that runs at class definition). */
const isDecorated = (n: Node | undefined): boolean => (n?.decorators?.length ?? 0) > 0;

/** Whether a class member runs code when the class is defined. */
function memberRunsCode(m: Node): boolean {
  if (m.type === "StaticBlock" || m.key?.type === "Computed" || isDecorated(m)) return true;
  if (m.type === "Constructor") return (m.params ?? []).some(isDecorated); // parameter decorators
  if ((m.function?.params ?? []).some(isDecorated)) return true;
  return m.isStatic && m.type === "ClassProperty" && !isPureExpr(m.value);
}

/**
 * Whether defining a class runs code: a decorator (on the class, a member or a parameter), a
 * static block, a static initializer, a computed key, or a non-trivial `extends` expression.
 */
function classRunsCode(cls: Node): boolean {
  return isDecorated(cls) || !isPureExpr(cls.superClass) || (cls.body ?? []).some(memberRunsCode);
}

/** Whether a (possibly exported) declaration runs code when the module evaluates. */
function declarationRunsCode(decl: Node): boolean {
  if (decl.type === "VariableDeclaration") {
    return (decl.declarations ?? []).some((d: Node) =>
      d.id?.type !== "Identifier" || !isPureExpr(d.init)
    );
  }
  // An enum only assigns constants.
  if (decl.type === "ClassDeclaration" || decl.type === "ClassExpression") {
    return classRunsCode(decl);
  }
  return false;
}

/** What one module's top level contributes, before `export *` targets are merged in. */
interface ModuleFacts {
  /** Explicit exports: name → where it lives (self for local definitions). */
  explicit: ExportMap;
  /** Resolved `export * from` targets (null = unresolvable → its names are unknown). */
  stars: Array<string | null>;
  /** The module runs code of its own (or has a directive): never look through it. */
  effectful: boolean;
}

type Bindings = Map<string, BarrelExport | null>;

/** Record an `import` declaration's bindings (a bare `import "x"` is a side effect). */
async function noteImport(
  item: Node,
  file: string,
  r: BarrelResolvers,
  imports: Bindings,
): Promise<boolean> {
  if (item.typeOnly) return false;
  const specifiers: Node[] = item.specifiers ?? [];
  if (specifiers.length === 0) return true;
  const target = await resolveSpecifier(file, item.source.value, r);
  for (const s of specifiers) {
    if (s.isTypeOnly) continue;
    const importName = s.type === "ImportDefaultSpecifier"
      ? "default"
      : s.type === "ImportNamespaceSpecifier"
      ? "*"
      : nameOf(s.imported ?? s.local);
    imports.set(s.local.value, target ? { file: target, importName } : null);
  }
  return false;
}

/** Record an `export … from "x"` re-export: each name → the target (self when unresolvable). */
async function noteReexport(
  item: Node,
  file: string,
  r: BarrelResolvers,
  facts: ModuleFacts,
): Promise<void> {
  if (item.typeOnly) return;
  const target = await resolveSpecifier(file, item.source.value, r);
  for (const s of item.specifiers ?? []) {
    if (s.isTypeOnly) continue;
    let name: string;
    let importName: string;
    if (s.type === "ExportNamespaceSpecifier") [name, importName] = [nameOf(s.name), "*"];
    else if (s.type === "ExportDefaultSpecifier") {
      [name, importName] = [nameOf(s.exported), "default"];
    } else [name, importName] = [nameOf(s.exported ?? s.orig), nameOf(s.orig)];
    facts.explicit.set(name, target ? { file: target, importName } : { file, importName: name });
  }
}

/** Record `export { a as b }` (no source): an imported binding maps through, a local stays. */
function noteLocalExport(item: Node, file: string, imports: Bindings, facts: ModuleFacts): void {
  if (item.typeOnly) return;
  for (const s of item.specifiers ?? []) {
    if (s.isTypeOnly || s.type !== "ExportSpecifier") continue;
    const local = nameOf(s.orig);
    const name = nameOf(s.exported ?? s.orig);
    const through = imports.get(local);
    facts.explicit.set(name, through ?? { file, importName: name });
  }
}

/** Whether a top-level statement is a directive prologue entry (`"use client"`). */
const isDirective = (item: Node): boolean =>
  item.type === "ExpressionStatement" && item.expression?.type === "StringLiteral";

/** Declarations that are code of the module's own but run nothing unless their initializers do. */
const DECLARATIONS = new Set([
  "FunctionDeclaration",
  "ClassDeclaration",
  "VariableDeclaration",
  "TsEnumDeclaration",
]);
/** Statements that never run code (types, `;`). */
const INERT_STATEMENTS = new Set([
  "EmptyStatement",
  "TsInterfaceDeclaration",
  "TsTypeAliasDeclaration",
]);
/** Exports of something the module defines itself. */
const OWN_EXPORTS = new Set([
  "ExportDeclaration",
  "ExportDefaultDeclaration",
  "ExportDefaultExpression",
]);

/** Whether a non-import, non-export top-level statement runs code (calls, directives, loops). */
function localStatementRunsCode(item: Node): boolean {
  if (INERT_STATEMENTS.has(item.type)) return false;
  if (DECLARATIONS.has(item.type)) return declarationRunsCode(item);
  return !(item.type === "TsModuleDeclaration" && item.declare);
}

/** Record `export const/function/class …` or `export default …` as the module's own names. */
function noteOwnExport(item: Node, file: string, facts: ModuleFacts): boolean {
  const self = (name: string) => facts.explicit.set(name, { file, importName: name });
  if (item.type === "ExportDeclaration") {
    for (const name of declaredNames(item.declaration)) self(name);
    return declarationRunsCode(item.declaration);
  }
  self("default");
  if (item.type === "ExportDefaultDeclaration") return declarationRunsCode(item.decl ?? {});
  return item.type === "ExportDefaultExpression" && !isPureExpr(item.expression);
}

/**
 * Classify one top-level statement into `facts` (async: re-exports resolve their target).
 * Returns whether the statement runs code of the module's own.
 */
async function noteStatement(
  item: Node,
  file: string,
  r: BarrelResolvers,
  imports: Bindings,
  facts: ModuleFacts,
): Promise<boolean> {
  switch (item.type) {
    case "ImportDeclaration":
      return await noteImport(item, file, r, imports);
    case "ExportNamedDeclaration":
      if (item.source) await noteReexport(item, file, r, facts);
      else noteLocalExport(item, file, imports, facts);
      return false;
    case "ExportAllDeclaration":
      if (!item.typeOnly) facts.stars.push(await resolveSpecifier(file, item.source.value, r));
      return false;
  }
  if (OWN_EXPORTS.has(item.type)) return noteOwnExport(item, file, facts);
  return localStatementRunsCode(item);
}

/** A parsed module's top-level statements, cached by path and validated by mtime + size. */
interface ParsedEntry {
  /** The file's modification time when it was parsed. */
  mtime: number;
  /** The file's size when it was parsed. */
  size: number;
  /** The top-level statements, or null when the file couldn't be parsed. */
  body: Promise<Node[] | null>;
}

/**
 * Parses that outlive one build: a dev server rebuilds on every edit, and re-parsing an
 * unchanged barrel (lucide's is ~1,700 statements) each time is the analysis' whole cost. The
 * entry is reused while the file's mtime and size are unchanged. Only the parse is cached —
 * specifier resolution depends on the build's conditions and is redone per build.
 */
const parseCache = new Map<string, ParsedEntry>();

/** The top-level statements of `file` (null when unreadable/unparseable), via {@link parseCache}. */
async function parsedBody(file: string): Promise<Node[] | null> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(file);
  } catch {
    parseCache.delete(file);
    return null;
  }
  const mtime = stat.mtime?.getTime() ?? 0;
  const hit = parseCache.get(file);
  if (hit && hit.mtime === mtime && hit.size === stat.size) return await hit.body;
  // Decorators parse (and then count as code that runs), rather than failing the parse.
  const body = Deno.readTextFile(file)
    .then((source) => parseModule(source, { decorators: true }))
    .then((parsed) => parsed?.body ?? null, () => null);
  parseCache.set(file, { mtime, size: stat.size, body });
  return await body;
}

/**
 * Per-analysis memo of {@link ModuleFacts}, keyed by the resolvers (one per build) — so a module
 * reached through several `export *` chains is resolved once, not once per path to it.
 */
const factsMemo = new WeakMap<BarrelResolvers, Map<string, Promise<ModuleFacts | null>>>();

/** Parse one module's top level into {@link ModuleFacts}; null when unreadable/unparseable. */
function moduleFacts(file: string, r: BarrelResolvers): Promise<ModuleFacts | null> {
  let memo = factsMemo.get(r);
  if (!memo) factsMemo.set(r, memo = new Map());
  let facts = memo.get(file);
  if (!facts) memo.set(file, facts = computeFacts(file, r));
  return facts;
}

/** {@link moduleFacts}, uncached. */
async function computeFacts(file: string, r: BarrelResolvers): Promise<ModuleFacts | null> {
  const body = await parsedBody(file);
  if (!body) return null;
  const facts: ModuleFacts = { explicit: new Map(), stars: [], effectful: false };
  const imports: Bindings = new Map();
  // A directive (`"use client"`) makes the barrel itself the boundary: looking through it
  // would hand a server component the undirected modules behind it.
  if (body.some(isDirective)) facts.effectful = true;
  for (const item of body) {
    if (await noteStatement(item, file, r, imports, facts)) facts.effectful = true;
  }
  return facts;
}

/**
 * Merge the names of every `export *` target into one map. A name two stars disagree on is
 * ambiguous (ESM exports neither) and is dropped; `default` is never star-exported.
 */
async function starExports(
  stars: Array<string | null>,
  r: BarrelResolvers,
  stack: Set<string>,
): Promise<ExportMap> {
  const merged: ExportMap = new Map();
  const ambiguous = new Set<string>();
  for (const target of stars) {
    if (!target) continue;
    const exports = await exportsOf(target, r, stack);
    for (const [name, where] of exports ?? []) mergeStarExport(merged, ambiguous, name, where);
  }
  return merged;
}

/** Whether two export locations are the same binding. */
const sameExport = (a: BarrelExport, b: BarrelExport): boolean =>
  a.file === b.file && a.importName === b.importName;

/** Add one star-exported name to `merged`, dropping it (for good) when two stars disagree. */
function mergeStarExport(
  merged: ExportMap,
  ambiguous: Set<string>,
  name: string,
  where: BarrelExport,
): void {
  if (name === "default" || ambiguous.has(name)) return;
  const prior = merged.get(name);
  if (prior && !sameExport(prior, where)) {
    merged.delete(name);
    ambiguous.add(name);
  } else merged.set(name, where);
}

/**
 * Every name a module exports and where it lives, following `export *` chains. A module that
 * runs code of its own maps every name to itself (importing it directly keeps its effects).
 * `null` when the module can't be read or parsed, or the chain is too deep.
 */
async function exportsOf(
  file: string,
  r: BarrelResolvers,
  stack: Set<string>,
): Promise<ExportMap | null> {
  if (stack.has(file)) return new Map(); // a cycle contributes nothing new
  if (stack.size >= MAX_STAR_DEPTH) return null;
  const facts = await moduleFacts(file, r);
  if (!facts) return null;
  stack.add(file);
  try {
    const out = await starExports(facts.stars, r, stack);
    for (const [name, where] of facts.explicit) out.set(name, where); // explicit wins
    if (facts.effectful) {
      for (const name of out.keys()) out.set(name, { file, importName: name });
    }
    return out;
  } finally {
    stack.delete(file);
  }
}

/**
 * Analyse a barrel module: every name it exports → the module that defines it (and the name
 * there). A name mapped back to `barrel` itself must stay on the barrel import. An unreadable or
 * unparseable barrel yields an empty map (nothing is rewritten).
 *
 * @param barrel Absolute path of the resolved barrel file.
 * @param resolvers The bundle's own specifier resolution.
 * @returns The export map.
 */
export async function analyzeBarrel(
  barrel: string,
  resolvers: BarrelResolvers,
): Promise<Map<string, BarrelExport>> {
  return (await exportsOf(barrel, resolvers, new Set())) ?? new Map();
}

// --- The import rewrite -----------------------------------------------------------------

/** Matches a specifier against the package list (`pkg` exactly, `pkg/*` any subpath). */
export interface PackageMatcher {
  /** Whether an import specifier names a listed package. */
  matches(spec: string): boolean;
  /** A cheap textual pre-filter: can `source` contain a static import of a listed package? */
  mentions(source: string): boolean;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Build a {@link PackageMatcher} for a package list. */
export function packageMatcher(packages: readonly string[]): PackageMatcher {
  const exact = new Set(packages.filter((p) => !p.endsWith("/*")));
  const prefixes = packages.filter((p) => p.endsWith("/*")).map((p) => p.slice(0, -1));
  const alternatives = [
    ...[...exact].map(escapeRe),
    ...prefixes.map((p) => `${escapeRe(p)}[^"'\\s]+`),
  ];
  const mentionRe = alternatives.length === 0
    ? null
    : new RegExp(`\\bfrom\\s*["'](?:${alternatives.join("|")})["']`);
  return {
    matches: (spec) =>
      exact.has(spec) ||
      prefixes.some((p) => spec.startsWith(p) && spec.length > p.length && !spec.includes("..")),
    mentions: (source) => mentionRe !== null && mentionRe.test(source),
  };
}

/** What {@link rewriteOptimizedImports} needs: the matcher plus a barrel → exports lookup. */
export interface RewriteContext {
  /** Which specifiers are optimized. */
  matcher: PackageMatcher;
  /** Resolve a listed specifier imported from `fromDir` to its barrel file. */
  resolveBarrel(fromDir: string, spec: string): Promise<string | null>;
  /** The (cached) export map of a barrel file. */
  exportsOf(barrel: string): Promise<Map<string, BarrelExport>>;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
/** An import-clause name: an identifier as-is, anything else as a string literal. */
const clauseName = (name: string) => IDENT.test(name) ? name : JSON.stringify(name);

/** `{ a as b, default as C }` — each binding, with `as` only where the names differ. */
function namedClause(pairs: Array<[imported: string, local: string]>): string {
  return pairs.map(([imp, local]) => imp === local ? local : `${clauseName(imp)} as ${local}`)
    .join(", ");
}

/** `[imported, local]` for an import specifier. */
const bindingPair = (s: Node): [string, string] => [nameOf(s.imported ?? s.local), s.local.value];

/** Where each named import of a declaration goes once the barrel is looked through. */
interface ImportPlan {
  /** Names that stay on the original specifier (`[imported, local]`). */
  kept: Array<[string, string]>;
  /** Defining file → `[name there, local]` pairs. */
  byFile: Map<string, Array<[string, string]>>;
  /** `[defining file, local]` for each namespace re-export. */
  namespaces: Array<[string, string]>;
}

/** Sort each named value specifier onto the barrel, a defining file, or a namespace import. */
function planImports(named: Node[], exports: ExportMap, barrel: string): ImportPlan {
  const plan: ImportPlan = { kept: [], byFile: new Map(), namespaces: [] };
  for (const s of named) {
    const [imported, local] = bindingPair(s);
    const where = exports.get(imported);
    if (!where || where.file === barrel) plan.kept.push([imported, local]);
    else if (where.importName === "*") plan.namespaces.push([where.file, local]);
    else {plan.byFile.set(where.file, [...(plan.byFile.get(where.file) ?? []), [
        where.importName,
        local,
      ]]);}
  }
  return plan;
}

/** The import that stays on the barrel (its default + unmapped names), or null when none. */
function barrelImport(
  def: Node | undefined,
  kept: Array<[string, string]>,
  quoted: string,
): string | null {
  if (!def && kept.length === 0) return null;
  const clause = [def?.local.value, kept.length > 0 ? `{ ${namedClause(kept)} }` : null]
    .filter(Boolean).join(", ");
  return `import ${clause} from ${quoted};`;
}

/**
 * The type-only specifiers as `import type`, or null when none. `import type` is erased under
 * every TS setting (a lone `{ type X }` survives `verbatimModuleSyntax` as `import {} from
 * "pkg"` — the barrel again).
 */
function typeImport(specifiers: Node[], quoted: string): string | null {
  const types = specifiers.filter((s) => s.type === "ImportSpecifier" && s.isTypeOnly);
  return types.length === 0
    ? null
    : `import type { ${namedClause(types.map(bindingPair))} } from ${quoted};`;
}

/** Render a plan as import statements on one line (the caller pads it to the original's lines). */
function renderPlan(spec: string, specifiers: Node[], plan: ImportPlan): string {
  const quoted = JSON.stringify(spec);
  const def = specifiers.find((s) => s.type === "ImportDefaultSpecifier");
  const out = [barrelImport(def, plan.kept, quoted), typeImport(specifiers, quoted)]
    .filter((line): line is string => line !== null);
  for (const [file, pairs] of plan.byFile) {
    out.push(`import { ${namedClause(pairs)} } from ${JSON.stringify(file)};`);
  }
  for (const [file, local] of plan.namespaces) {
    out.push(`import * as ${local} from ${JSON.stringify(file)};`);
  }
  return out.join(" ");
}

/**
 * The named value specifiers of an import declaration, or null when there are none or the
 * declaration is `import * as all` (which keeps the whole barrel by definition).
 */
function valueSpecifiers(specifiers: Node[]): Node[] | null {
  if (specifiers.some((s) => s.type === "ImportNamespaceSpecifier")) return null;
  const named = specifiers.filter((s) => s.type === "ImportSpecifier" && !s.isTypeOnly);
  return named.length === 0 ? null : named;
}

/** The replacement text for one import declaration, or null when nothing maps off the barrel. */
async function rewriteDeclaration(
  item: Node,
  fromDir: string,
  ctx: RewriteContext,
): Promise<string | null> {
  const spec: string = item.source.value;
  const specifiers: Node[] = item.specifiers ?? [];
  const named = valueSpecifiers(specifiers);
  if (!named) return null;
  const barrel = await ctx.resolveBarrel(fromDir, spec);
  if (!barrel) return null;
  const plan = planImports(named, await ctx.exportsOf(barrel), barrel);
  if (plan.byFile.size === 0 && plan.namespaces.length === 0) return null;
  return renderPlan(spec, specifiers, plan);
}

/**
 * Whether a top-level statement is a plain, evaluated value import of a listed package — not
 * `import type`, not `import source`/`import defer`, and without import attributes.
 */
function isRewritableImport(item: Node, matcher: PackageMatcher): boolean {
  if (item.type !== "ImportDeclaration" || item.typeOnly) return false;
  if (item.phase && item.phase !== "evaluation") return false;
  if (item.asserts || item.with) return false;
  return matcher.matches(item.source.value);
}

/**
 * Rewrite a module's named value imports of optimized packages to the modules that define each
 * name. Type-only specifiers, default and namespace imports, re-exports (`export … from`) and
 * dynamic `import()` are left alone; a name the barrel defines itself (or doesn't export) stays
 * on an import of the original specifier. The rewrite keeps every line of the module where it
 * was: a multi-line import becomes one line followed by the newlines it spanned.
 *
 * @param source The module source.
 * @param path Absolute path of the module (barrels resolve from its directory).
 * @param ctx The package matcher and barrel lookup.
 * @returns The rewritten source, or null when nothing changed.
 */
export async function rewriteOptimizedImports(
  source: string,
  path: string,
  ctx: RewriteContext,
): Promise<string | null> {
  if (!ctx.matcher.mentions(source)) return null;
  const parsed = await parseModule(source, { decorators: true }); // only imports are edited
  if (!parsed) return null;
  const edits: Edit[] = [];
  for (const item of parsed.body) {
    if (!isRewritableImport(item, ctx.matcher)) continue;
    const text = await rewriteDeclaration(item, dirname(path), ctx);
    if (text === null) continue;
    const start = startOf(parsed.ctx, item);
    const end = endOf(parsed.ctx, item);
    // The replacement is one line; pad it with the newlines the original import spanned so
    // every line below keeps its number (sourcemaps, stack traces, the dev overlay).
    edits.push({ start, end, text: text + "\n".repeat(newlinesIn(parsed.ctx.bytes, start, end)) });
  }
  return edits.length === 0 ? null : applyEdits(parsed.ctx.bytes, edits);
}

/** How many `\n` bytes lie in `bytes[start, end)`. */
function newlinesIn(bytes: Uint8Array, start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end; i++) if (bytes[i] === 10) n++;
  return n;
}

// --- The esbuild wiring -------------------------------------------------------------------

/** Options for {@link withOptimizedPackageImports}. */
export interface OptimizePackageImportsOptions {
  /** The effective package list (see {@link optimizePackageImportsList}). */
  packages: readonly string[];
  /** The bundle's resolvers (so rewritten imports resolve to the very files esbuild loads). */
  resolvers: BarrelResolvers;
}

/** The JS/TS loaders whose output is an ES module the rewrite can parse. */
const JS_LOADERS = new Set(["js", "jsx", "ts", "tsx"]);

/** The loader esbuild's default would pick for a path (null: not a JS/TS module). */
function loaderForPath(path: string): esbuild.Loader | null {
  if (path.endsWith(".d.ts")) return null;
  const ext = extname(path).slice(1);
  if (ext === "mjs" || ext === "cjs" || ext === "js") return "js";
  return JS_LOADERS.has(ext) ? ext as esbuild.Loader : null;
}

/** A `.js`/`.mjs`/`.cjs` file inside `node_modules` — no JSX/TS, no import-map semantics. */
/** Build the per-bundle rewrite context: barrel resolution + analysis, cached per path. */
function rewriteContext(options: OptimizePackageImportsOptions): RewriteContext {
  const analyses = new Map<string, Promise<Map<string, BarrelExport>>>();
  const barrels = new Map<string, Promise<string | null>>();
  return {
    matcher: packageMatcher(options.packages),
    resolveBarrel(fromDir, spec) {
      const key = `${fromDir}\0${spec}`;
      let hit = barrels.get(key);
      if (!hit) barrels.set(key, hit = options.resolvers.resolveBare(fromDir, spec));
      return hit;
    },
    exportsOf(barrel) {
      let hit = analyses.get(barrel);
      if (!hit) {
        hit = analyzeBarrel(barrel, options.resolvers).catch(() => new Map());
        analyses.set(barrel, hit);
      }
      return hit;
    },
  };
}

/** Rewrite a loaded module's contents in place (identity when nothing applies). */
async function rewriteResult(
  result: esbuild.OnLoadResult | null | undefined,
  args: esbuild.OnLoadArgs,
  ctx: RewriteContext,
): Promise<esbuild.OnLoadResult | null | undefined> {
  if (!result || result.contents == null || args.namespace !== "file") return result;
  const loader = result.loader ?? loaderForPath(args.path);
  if (!loader || !JS_LOADERS.has(loader)) return result;
  const text = typeof result.contents === "string"
    ? result.contents
    : new TextDecoder().decode(result.contents);
  try {
    const out = await rewriteOptimizedImports(text, args.path, ctx);
    return out === null ? result : { ...result, contents: out };
  } catch {
    return result; // never fail a build over an optimization
  }
}

/**
 * Apply `optimizePackageImports` to an esbuild plugin chain: every `onLoad` result the given
 * plugins produce for a JS/TS file is post-processed by {@link rewriteOptimizedImports} (so the
 * rewrite composes with the Fast Refresh, auto-memo, `"use cache"` and MDX transforms rather
 * than competing with them for the one `onLoad` esbuild honors), and a trailing plugin loads —
 * and rewrites — every other JS/TS file that imports a listed package. Place the result BEFORE
 * any catch-all loader (the deno-loader). An empty package list returns `plugins` unchanged.
 *
 * @param plugins The chain to wrap, in precedence order.
 * @param options The package list and the bundle's resolvers.
 * @returns The wrapped chain plus the fallback loader.
 */
export function withOptimizedPackageImports(
  plugins: esbuild.Plugin[],
  options: OptimizePackageImportsOptions,
): esbuild.Plugin[] {
  if (options.packages.length === 0) return plugins;
  const ctx = rewriteContext(options);
  const wrapped = plugins.map((plugin): esbuild.Plugin => ({
    name: plugin.name,
    setup(build) {
      return plugin.setup({
        ...build,
        onLoad(opts, callback) {
          build.onLoad(opts, async (args) => rewriteResult(await callback(args), args, ctx));
        },
      });
    },
  }));
  const fallback: esbuild.Plugin = {
    name: "denext-optimize-package-imports",
    setup(build) {
      build.onLoad({ filter: /\.(?:[cm]?js|jsx|tsx?)$/, namespace: "file" }, async (args) => {
        const loader = loaderForPath(args.path);
        if (!loader) return undefined;
        let source: string;
        try {
          source = await Deno.readTextFile(args.path);
        } catch {
          return undefined;
        }
        const out = ctx.matcher.mentions(source)
          ? await rewriteResult({ contents: source, loader }, args, ctx)
          : undefined;
        if (out && out.contents !== source) return { ...out, resolveDir: dirname(args.path) };
        // Unchanged: fall through so every later onLoad plugin (denext patch, the deno loader)
        // still sees the file. Serving it from here would skip them.
        return undefined;
      });
    },
  };
  return [...wrapped, fallback];
}
