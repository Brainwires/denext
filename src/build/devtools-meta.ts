// Build-time DevTools metadata: the source location and hook names of each
// component-shaped declaration in a module.
//
// The Fast Refresh footer already gives every component a stable family id
// (`<fileUrl>#<Export>`, see `spa-refresh-plugin.ts`) — but that is only a *name*.
// The inspector wants the line and column the component is declared at (so its
// "Source" row can open an editor there), and the variable a hook's result was bound
// to (so a `useState` cell reads `noteText` instead of "State"). Both are already in
// the AST the refresh pass parses; they were simply thrown away.
//
// This module collects them. `parseModule()` (`swc-ast.ts`) gives exact UTF-8 byte
// offsets, `positionAt()` turns one into a 1-based line + 1-based UTF-16 column, and
// `metaFooter()` serialises the result as `__dnxMeta("<url>#<Name>", {…})` calls the
// dev-only client registry (`src/client/devtools-meta.ts`) consumes.
//
// It is dev-only by construction: the only emitters are the dev transforms (the SPA Fast
// Refresh esbuild plugin, the unbundled dev per-module transform) and the BUNDLED App
// Router dev entry (`dev-server/route-meta.ts` → `generateRouteEntry`'s dev-only footer),
// so a production bundle contains no reference to `registerComponentMeta` at all.

import {
  collectPatternNames,
  type Ctx,
  forEachChild,
  isRelativeSpecifier,
  lineIndex,
  type Node,
  type ParsedModule,
  positionAt,
  startOf,
} from "./swc-ast.ts";

// The metadata record types are owned by the client registry (`src/client/devtools-meta.ts`)
// so the build side and the browser side can never drift; this is a type-only import.
import type { ComponentDevMeta } from "../client/devtools-meta.ts";

/** A top-level declaration the dev metadata pass tracks. */
export interface ComponentDecl {
  /** The binding name. */
  name: string;
  /** Whether it is component-shaped (PascalCase) rather than a `use*` custom hook. */
  component: boolean;
  /** The name identifier node (the position reported as the declaration's location). */
  ident: Node;
  /** The callable node whose body is scanned for hook calls. */
  fn: Node;
}

/** At most this many hooks are recorded per component (a runaway module stays cheap). */
export const MAX_HOOKS = 64;
/** A module whose serialised metadata exceeds this many UTF-8 BYTES emits none at all. */
export const MAX_META_BYTES = 16 * 1024;

/** The cap above counts bytes, not UTF-16 code units (a CJK/emoji name is up to 3× longer). */
const ENCODER = new TextEncoder();

/** The React/JSX naming rule for a hook call (`useX`, `use2`). */
const HOOK_RE = /^use[A-Z0-9]/;

/** A PascalCase identifier is the React/JSX signal for a component (vs a hook/helper). */
function isComponentName(name: string | undefined): name is string {
  return typeof name === "string" && /^[A-Z]/.test(name);
}

/** True for an initializer that produces a callable (an arrow or function expression). */
function isCallableInit(init: Node): boolean {
  return !!init &&
    (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression");
}

/** A name the metadata pass tracks: a component, or a `use*` custom hook. */
function isTracked(name: string | undefined): name is string {
  return isComponentName(name) || (typeof name === "string" && HOOK_RE.test(name));
}

/** The hook name a callee denotes (`useX` / `obj.useX` → `useX`), or undefined. */
function calleeName(callee: Node): string | undefined {
  if (!callee || typeof callee !== "object") return undefined;
  if (callee.type === "Identifier") {
    return HOOK_RE.test(callee.value) ? callee.value as string : undefined;
  }
  if (callee.type === "MemberExpression" && callee.property?.type === "Identifier") {
    return HOOK_RE.test(callee.property.value) ? callee.property.value as string : undefined;
  }
  return undefined;
}

/**
 * The label a hook call's result is shown under: the first name bound by the enclosing
 * declarator's pattern — `[count, setCount]` → `count`, `[, setOnly]` → `setOnly`,
 * `{ data }` → `data`, `{ data: d }` → `d` (the LOCAL name), `ref` → `ref`. `""` when
 * the call is not bound to anything (`useEffect(…)`).
 *
 * @param pat The declarator's binding pattern (or nothing).
 * @returns The display label, or `""`.
 */
function bindingLabel(pat: Node): string {
  if (!pat) return "";
  const names = new Set<string>();
  collectPatternNames(pat, names);
  for (const n of names) return n;
  return "";
}

/** Push the tracked declarations of one top-level statement's declaration onto `out`. */
function declsOf(decl: Node, out: ComponentDecl[]): void {
  if (!decl || typeof decl !== "object") return;
  if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
    const name = decl.identifier?.value;
    if (isTracked(name)) {
      out.push({ name, component: isComponentName(name), ident: decl.identifier, fn: decl });
    }
    return;
  }
  if (decl.type !== "VariableDeclaration") return;
  for (const d of decl.declarations ?? []) {
    if (d?.id?.type !== "Identifier" || !isCallableInit(d.init)) continue;
    if (isTracked(d.id.value)) {
      out.push({
        name: d.id.value,
        component: isComponentName(d.id.value),
        ident: d.id,
        fn: d.init,
      });
    }
  }
}

/**
 * The module's top-level component-shaped declarations and `use*` custom hooks, in
 * source order, deduplicated by name: PascalCase function/class declarations, PascalCase
 * consts bound to an arrow/function expression, and the same two shapes for `use*` names,
 * whether or not they are `export`ed. Object/value consts are excluded (only callables).
 *
 * @param parsed The module parsed by `parseModule()`.
 * @returns One entry per tracked declaration.
 */
export function componentDecls(parsed: ParsedModule): ComponentDecl[] {
  const out: ComponentDecl[] = [];
  for (const stmt of parsed.body) {
    if (!stmt || typeof stmt !== "object") continue;
    if (stmt.type === "ExportDeclaration") declsOf(stmt.declaration, out);
    else if (stmt.type === "ExportDefaultDeclaration") {
      const decl = stmt.decl;
      const name = decl?.identifier?.value;
      if (isTracked(name)) {
        out.push({ name, component: isComponentName(name), ident: decl.identifier, fn: decl });
      }
    } else declsOf(stmt, out);
  }
  return out.filter((d, i) => out.findIndex((o) => o.name === d.name) === i);
}

/** A hook call site before its byte offset is resolved to a line. */
interface RawHook {
  hook: string;
  name: string;
  at: number;
  /** The declaring module's URL, for a hook bound by a static relative import. */
  from?: string;
}

/** Where an imported binding comes from: the module's absolute URL and the exported name. */
interface ImportBinding {
  /** The absolute URL of the imported module (`new URL(specifier, moduleUrl)`). */
  url: string;
  /** The name the module exports it under (`"default"` for a default import). */
  imported: string;
}

/** Local binding name → where a static relative import binds it from. */
type ImportTable = Map<string, ImportBinding>;

/**
 * Maps a non-relative import specifier — an import-map alias such as `@/hooks/auth.ts` — to the
 * first-party module's `file://` URL, or `undefined` when it is not first-party source.
 */
export type SpecifierResolver = (specifier: string) => string | undefined;

/** The importee's URL: a relative specifier against the module, else the resolver's answer. */
function importeeUrl(
  spec: string,
  moduleUrl: string,
  resolve: SpecifierResolver | undefined,
): string | undefined {
  return isRelativeSpecifier(spec) ? new URL(spec, moduleUrl).href : resolve?.(spec);
}

/**
 * The exported name an import specifier binds, or undefined when it cannot name a hook's
 * declaring module: a type-only specifier, or a namespace import (`import * as h` —
 * `h.useX()` stays opaque).
 */
function importedName(spec: Node): string | undefined {
  if (!spec?.local || spec.isTypeOnly) return undefined;
  if (spec.type === "ImportDefaultSpecifier") return "default";
  if (spec.type !== "ImportSpecifier") return undefined;
  return (spec.imported?.value ?? spec.local.value) as string;
}

/**
 * The module's static RELATIVE import bindings (`./`, `../`), each resolved against
 * `moduleUrl` — the same URL form the importee's own Fast Refresh footer keys its family ids
 * by, so a call's `from` + imported name IS the importee's registry key. A bare, `npm:`,
 * `jsr:` or URL specifier is not first-party source the dev transforms instrument, so it
 * binds nothing here (naming stops at such a call, as before).
 *
 * @param body The module's top-level statements.
 * @param moduleUrl The module's `file://` URL, or undefined (⇒ an empty table).
 * @param resolve Maps an import-map alias to its first-party module's URL (optional).
 * @returns Local name → the imported module's URL and exported name.
 */
function importBindings(
  body: Node[],
  moduleUrl: string | undefined,
  resolve?: SpecifierResolver,
): ImportTable {
  const out: ImportTable = new Map();
  if (!moduleUrl) return out;
  for (const stmt of body) {
    if (stmt?.type !== "ImportDeclaration" || stmt.typeOnly) continue;
    const spec = stmt.source?.value;
    const url = typeof spec === "string" ? importeeUrl(spec, moduleUrl, resolve) : undefined;
    if (!url) continue;
    for (const s of stmt.specifiers ?? []) {
      const imported = importedName(s);
      if (imported) out.set(s.local.value as string, { url, imported });
    }
  }
  return out;
}

/**
 * The call-site record of one hook call: a callee bound by a static relative import keeps
 * its IMPORTED name and gains `from` (so `import { useAuth as useA }` records `useAuth`);
 * anything else — a primitive, a same-module hook, a member callee — keeps its own name.
 */
function hookCall(node: Node, label: string, at: number, imports: ImportTable): RawHook | null {
  const hook = calleeName(node.callee);
  if (!hook) return null;
  const bound = node.callee.type === "Identifier" ? imports.get(hook) : undefined;
  return bound
    ? { hook: bound.imported, name: label, at, from: bound.url }
    : { hook, name: label, at };
}

/**
 * Every hook call inside `fn`, in source order, each labelled from the declarator that
 * binds its result. A hook call's own ARGUMENTS are not descended into — a hook nested
 * inside a `useMemo`/`useCallback` factory is not recorded, because it does not produce a
 * cell of the enclosing component (it runs, if at all, inside the memoized callback), and
 * recording it would mis-align the metadata with the runtime's hook list.
 *
 * @param fn The callable node to scan.
 * @param ctx The module's byte-offset context.
 * @param imports The module's relative import bindings ({@link importBindings}).
 * @returns The call sites, ascending by byte offset.
 */
function hookCalls(fn: Node, ctx: Ctx, imports: ImportTable): RawHook[] {
  const out: RawHook[] = [];
  const visit = (node: Node, label: string): void => {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;
    if (node.type === "VariableDeclarator") {
      if (node.init) visit(node.init, bindingLabel(node.id));
      return;
    }
    if (node.type === "CallExpression") {
      const call = hookCall(node, label, startOf(ctx, node), imports);
      if (call) out.push(call);
      forEachChild(node, (c) => visit(c, ""));
      return;
    }
    forEachChild(node, (c) => visit(c, label));
  };
  visit(fn, "");
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The binding a module default-exports, when it names one: `export default function useX`,
 * `export default useX;`, or `export { useX as default }`. Undefined otherwise.
 */
function defaultExportName(body: Node[]): string | undefined {
  for (const stmt of body) {
    if (stmt?.type === "ExportDefaultDeclaration") return stmt.decl?.identifier?.value;
    if (stmt?.type === "ExportDefaultExpression" && stmt.expression?.type === "Identifier") {
      return stmt.expression.value;
    }
    if (stmt?.type !== "ExportNamedDeclaration" || stmt.source) continue;
    const spec = (stmt.specifiers ?? []).find((s: Node) => s?.exported?.value === "default");
    if (spec?.orig?.type === "Identifier") return spec.orig.value;
  }
  return undefined;
}

/**
 * The dev metadata of every tracked declaration in a parsed module, keyed by binding name
 * (the family id's `#` suffix). Lines are 1-based; columns are 1-based UTF-16 code units.
 *
 * Hook names are recorded per call site — a call to a same-module custom hook keeps the
 * hook's own name (`useAuth`), which the runtime registry expands into a breadcrumb by
 * joining on `"<fileUrl>#useAuth"`. A custom hook bound by a static RELATIVE import also
 * records `from` (the importee's absolute URL) and its imported name, so the join crosses
 * the module boundary (`"<importeeUrl>#useAuth"`), and so does one bound by an import-map alias
 * the `resolve` hook maps to first-party source. A barrel's named re-export of a hook
 * (`export { useAuth } from "./auth.ts"`) is recorded as an alias to the declaring module, which
 * the runtime follows one hop. A bare/`npm:`/`jsr:`/URL import, a namespace import and
 * `export *` stay opaque. A default-exported `use*` hook is also
 * keyed `default`, the name a default import of it records.
 *
 * @param parsed The module parsed by `parseModule()`.
 * @param moduleUrl The module's `file://` URL (the family id prefix); without it no call
 *   records `from`.
 * @param resolve Maps an import-map alias to its first-party module's URL, so a hook imported
 *   that way records `from` too (optional).
 * @returns Binding name → its metadata (empty when the module declares nothing tracked).
 */
export function collectComponentMeta(
  parsed: ParsedModule,
  moduleUrl?: string,
  resolve?: SpecifierResolver,
): Record<string, ComponentDevMeta> {
  const aliases = reExportAliases(parsed.body, moduleUrl, resolve);
  const decls = componentDecls(parsed);
  if (decls.length === 0) return aliases;
  const scan = scanOf(parsed, moduleUrl, resolve);
  const metas: Record<string, ComponentDevMeta> = { ...aliases };
  for (const decl of decls) metas[decl.name] = declMeta(scan, decl.name, decl.ident, decl.fn);
  const def = defaultExportName(parsed.body);
  if (def && HOOK_RE.test(def) && metas[def]) metas.default = metas[def];
  return metas;
}

/** What one module's metadata pass shares across its declarations. */
interface MetaScan {
  ctx: Ctx;
  index: number[];
  imports: ImportTable;
}

function scanOf(
  parsed: ParsedModule,
  moduleUrl: string | undefined,
  resolve?: SpecifierResolver,
): MetaScan {
  const { ctx } = parsed;
  const imports = importBindings(parsed.body, moduleUrl, resolve);
  return { ctx, index: lineIndex(ctx.bytes), imports };
}

/** One `name` / `name as alias` entry of an `export { … } from`, or undefined. */
function reExportPair(spec: Node): { imported: string; exported: string } | undefined {
  if (spec?.type !== "ExportSpecifier" || spec.isTypeOnly) return undefined;
  const imported = spec.orig?.value;
  const exported = spec.exported?.value ?? imported;
  return typeof imported === "string" && typeof exported === "string"
    ? { imported, exported }
    : undefined;
}

/**
 * A barrel's hook-shaped named re-exports — `export { useAuth } from "./auth.ts"`,
 * `export { useA as useAlias } from "@/hooks.ts"` — each as an alias record pointing at the
 * declaring module's registry key. One level: the target's own re-exports are not followed,
 * and `export *` names nothing here.
 */
function reExportAliases(
  body: Node[],
  moduleUrl: string | undefined,
  resolve: SpecifierResolver | undefined,
): Record<string, ComponentDevMeta> {
  const out: Record<string, ComponentDevMeta> = {};
  if (!moduleUrl) return out;
  for (const stmt of body) {
    const url = reExportSource(stmt, moduleUrl, resolve);
    if (url) addAliases(out, url, stmt.specifiers ?? []);
  }
  return out;
}

/** The module a value re-export (`export { … } from "…"`) reads from, or undefined. */
function reExportSource(
  stmt: Node,
  moduleUrl: string,
  resolve: SpecifierResolver | undefined,
): string | undefined {
  if (stmt?.type !== "ExportNamedDeclaration" || stmt.typeOnly) return undefined;
  const spec = stmt.source?.value;
  return typeof spec === "string" ? importeeUrl(spec, moduleUrl, resolve) : undefined;
}

/** One alias record per hook-shaped name a re-export lists, pointing into `url`. */
function addAliases(out: Record<string, ComponentDevMeta>, url: string, specifiers: Node[]): void {
  for (const pair of specifiers.map(reExportPair)) {
    if (!pair || !HOOK_RE.test(pair.exported)) continue;
    const aliasOf = `${url}#${pair.imported}`;
    out[pair.exported] = { name: pair.exported, line: 0, column: 0, hooks: [], aliasOf };
  }
}

/** The metadata of one callable: `at` is the node reported as its position, `fn` is scanned. */
function declMeta(scan: MetaScan, name: string, at: Node, fn: Node): ComponentDevMeta {
  const { ctx, index, imports } = scan;
  const pos = positionAt(ctx.bytes, index, startOf(ctx, at));
  const hooks = hookCalls(fn, ctx, imports).slice(0, MAX_HOOKS).map((h) => ({
    hook: h.hook,
    name: h.name,
    line: positionAt(ctx.bytes, index, h.at).line,
    ...(h.from ? { from: h.from } : {}),
  }));
  return { name, line: pos.line, column: pos.column, hooks };
}

/** The module's `export default <function|class|arrow>` node, named or anonymous. */
function defaultCallable(body: Node[]): Node | undefined {
  for (const stmt of body) {
    if (stmt?.type === "ExportDefaultDeclaration") {
      const t = stmt.decl?.type;
      return t === "FunctionExpression" || t === "ClassExpression" ? stmt.decl : undefined;
    }
    if (stmt?.type === "ExportDefaultExpression") {
      return isCallableInit(stmt.expression) ? stmt.expression : undefined;
    }
  }
  return undefined;
}

/** The file stem of a module URL (`file:///app/blog/page.tsx` → `page`). */
function fileStem(moduleUrl: string): string {
  const base = moduleUrl.slice(moduleUrl.lastIndexOf("/") + 1);
  const dot = base.indexOf(".");
  return decodeURIComponent(dot > 0 ? base.slice(0, dot) : base);
}

/**
 * The dev metadata of a ROUTE-STRUCTURAL module (page, layout, template, loading, error,
 * slot page): {@link collectComponentMeta}, plus the default export keyed `default` — the
 * `"<url>#default"` family id the bundled route entry registers it under
 * (`routeRefreshBlock` in `bundle.ts`). A tracked default (`export default function Page`,
 * `export default Page`) reuses its own record (`name` stays `Page`); a lowercase-named or
 * ANONYMOUS default (`export default function () {}`, `export default () => …`) is
 * recorded from its own node, named after its identifier or else the file stem (`page`).
 *
 * @param parsed The module parsed by `parseModule()`.
 * @param moduleUrl The module's `file://` URL (the family id prefix).
 * @returns Binding name → its metadata, `default` included when the module has one.
 */
export function routeModuleMeta(
  parsed: ParsedModule,
  moduleUrl: string,
): Record<string, ComponentDevMeta> {
  const metas = collectComponentMeta(parsed, moduleUrl);
  const def = defaultExportName(parsed.body);
  if (def && metas[def]) {
    metas.default = metas[def];
    return metas;
  }
  const fn = defaultCallable(parsed.body);
  if (!fn) return metas;
  const name = (fn.identifier?.value as string | undefined) ?? fileStem(moduleUrl);
  metas.default = declMeta(scanOf(parsed, moduleUrl), name, fn.identifier ?? fn, fn);
  return metas;
}

/** Whether metadata emission is enabled (`DENEXT_DEV_META=0` is the kill switch). */
export function metaEnabled(): boolean {
  try {
    return Deno.env.get("DENEXT_DEV_META") !== "0";
  } catch {
    return true; // no env permission — emission is harmless dev-only code
  }
}

/**
 * The `registerComponentMeta` import + one `__dnxMeta("<url>#<Name>", {…})` call per
 * tracked declaration — the sidecar appended next to the Fast Refresh registrations
 * (`registerFamily` is a frozen 2.0 export and never grows an argument). Returns `""`
 * when there is nothing to emit, when the serialised payload exceeds
 * {@link MAX_META_BYTES}, or when `DENEXT_DEV_META=0`.
 *
 * @param sourceUrl The module's `file://` URL (the family id prefix).
 * @param metas The metadata from {@link collectComponentMeta}.
 * @returns The footer source, or `""`.
 */
export function metaFooter(sourceUrl: string, metas: Record<string, ComponentDevMeta>): string {
  const body = metaCalls(sourceUrl, metas);
  return body ? META_IMPORT + body : "";
}

/** The import every metadata footer opens with (`__dnxMeta` never shadows a user binding). */
export const META_IMPORT =
  `import { registerComponentMeta as __dnxMeta } from "denext/client-runtime";\n`;

/**
 * Just the `__dnxMeta("<url>#<Name>", {…});` lines of one module (newline-terminated),
 * without {@link META_IMPORT} — so several modules' calls can share ONE import (the bundled
 * route entry's footer). `""` when there is nothing to emit, the module's calls exceed
 * {@link MAX_META_BYTES}, or `DENEXT_DEV_META=0`.
 *
 * @param sourceUrl The module's `file://` URL (the family id prefix).
 * @param metas The module's metadata.
 * @returns The calls, or `""`.
 */
export function metaCalls(sourceUrl: string, metas: Record<string, ComponentDevMeta>): string {
  const entries = Object.entries(metas);
  if (entries.length === 0 || !metaEnabled()) return "";
  const body = entries
    .map(([name, meta]) =>
      `__dnxMeta(${JSON.stringify(`${sourceUrl}#${name}`)}, ${JSON.stringify(meta)});`
    )
    .join("\n");
  // UTF-8 bytes, not `.length`: a module of non-ASCII names measures up to 3× larger on
  // the wire than in code units, and this cap exists to bound what the dev bundle carries.
  if (ENCODER.encode(body).length > MAX_META_BYTES) return ""; // a huge module: no metadata
  return body + "\n";
}
