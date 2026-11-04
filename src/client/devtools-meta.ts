// The dev-only DevTools metadata registry (the runtime half of `build/devtools-meta.ts`).
//
// In dev, each first-party module's Fast Refresh footer appends one
// `registerComponentMeta("<fileUrl>#<Name>", {…})` call per component-shaped declaration,
// carrying the declaration's source position and the variable each of its hook calls was
// bound to. This module is where those land: a plain id → metadata map the inspector
// joins against a live component type through its Fast Refresh family id.
//
// Production never reaches it — the emitters are dev-only transforms, so nothing in a
// production bundle references `registerComponentMeta` and the whole module (whose only
// module-level work is creating an empty `Map`) is tree-shaken away.
//
// The types are re-declared here rather than imported from `src/build/`: the client
// runtime must never pull a build module into the browser graph.

import { familyIdOf } from "./refresh-runtime.ts";

/** One hook call inside a component, as recorded by the build-time metadata pass. */
export interface HookDevMeta {
  /** The hook's callee name (`useState`, `useApi`, … — a member call is its property). */
  hook: string;
  /** The variable the call's result was bound to, or `""` when it was not bound. */
  name: string;
  /** 1-based line of the call in the source module. */
  line: number;
  /**
   * The absolute URL of the module that declares the called hook, when the callee is bound
   * by a static relative import (`import { useAuth } from "./auth.ts"`). `hook` is then the
   * name that module exports it under (`"default"` for a default import), so
   * `"<from>#<hook>"` is the importee's own registry key. Absent for a primitive, a
   * same-module hook, and a hook from a `jsr:` / URL import; a hook from a package (a bare
   * specifier, in the unbundled dev loop's npm bundle) records `npm:<specifier>`. A namespace import's
   * member call (`hooks.useAuth()`) records the namespace's module.
   */
  from?: string;
  /**
   * The call may not run on every render: it sits in a branch (`if`, `?:`, `&&` / `||` / `??`,
   * `switch`, a loop) or after an early `return`. Naming then tries the render both with and
   * without it.
   */
  cond?: true;
}

/** The dev metadata of one component (or `use*` custom hook) declaration. */
export interface ComponentDevMeta {
  /** The declaration's binding name (the family id's `#` suffix). */
  name: string;
  /** 1-based line of the declaration in its source module. */
  line: number;
  /** 1-based UTF-16 column of the declaration in its source module. */
  column: number;
  /** The hook calls the declaration makes, in source order. */
  hooks: HookDevMeta[];
  /**
   * For a barrel's named re-export (`export { useAuth } from "./auth.ts"`): the declaring
   * module's registry key (`"<fileUrl>#useAuth"`). Such a record makes no calls of its own; a
   * custom-hook expansion follows it (up to three re-export hops).
   */
  aliasOf?: string;
  /**
   * For a module's `export * from "…"` lines (the record keyed `"<fileUrl>#*"`): the absolute
   * URL of each module it re-exports everything from, so a hook imported through such a barrel
   * is looked up in them.
   */
  reExportsAll?: string[];
}

/** Family id (`<fileUrl>#<Name>`) → the declaration's dev metadata. */
const metaById = new Map<string, ComponentDevMeta>();

/**
 * Record a declaration's dev metadata under its Fast Refresh family id. Called only by
 * the footer the dev transforms append; a re-imported module simply overwrites its own
 * entries, so an edit's fresh positions replace the stale ones.
 *
 * @param familyId The family id the declaration is registered under (`<fileUrl>#<Name>`).
 * @param meta The declaration's source position and hook names.
 */
export function registerComponentMeta(familyId: string, meta: ComponentDevMeta): void {
  metaById.set(familyId, meta);
}

/**
 * The metadata registered under a family id, or `undefined`. Also the join a breadcrumb
 * uses to expand a custom hook: `"<fileUrl>#useAuth"` resolves to the hook's own metadata
 * (its nested hook calls included), whether it was declared in the calling module or in
 * one the caller imports by a static relative import (`HookDevMeta.from`).
 *
 * @param familyId The family id to look up.
 * @returns The metadata, or `undefined` when the module was not instrumented.
 */
export function componentMetaById(familyId: string): ComponentDevMeta | undefined {
  return metaById.get(familyId);
}

/**
 * The metadata for a live component type, resolved through its Fast Refresh family id.
 * `undefined` in production (nothing is ever registered) and for a component whose module
 * the dev transform left uninstrumented.
 *
 * @param type The component type (function, or a memo/forwardRef wrapper object).
 * @returns The metadata, or `undefined`.
 */
export function componentMetaOf(type: unknown): ComponentDevMeta | undefined {
  const id = familyIdOf(type);
  return id === undefined ? undefined : metaById.get(id);
}

/** Drop every registered entry (tests only — the registry is otherwise append-only). */
export function clearComponentMeta(): void {
  metaById.clear();
}

// ---- Hook naming (metadata ⇄ live hook cells) ------------------------------

/**
 * How many hook cells each hook consumes, and with which `HookCell.kind` tags, in the
 * order the dispatcher takes them.
 *
 * The primitives mirror the `HK_*` constants of `fiber/hooks-dispatcher.ts:53-63` (one
 * `getHook(kind)` call each); the composites are DERIVED by reading their
 * implementations — each row cites the hook it is derived from. `tests/devtools-hooks-named.test.ts`
 * renders a component that calls every row once and asserts the observed cell sequence
 * equals this table's concatenation, so a dispatcher change that drifts from it fails CI.
 *
 * A hook that is absent from the table is a custom hook: the runtime expands it when its
 * declaring module registered metadata — the calling module itself, or the one a static
 * relative import names (`HookDevMeta.from`) — and otherwise treats it as opaque: it took
 * an unknown number of cells, which the alignment works out from the hooks around it.
 */
export const HOOK_CELL_KINDS: Record<string, readonly number[]> = {
  // Primitives — `hooks-dispatcher.ts:251-401`, one cell tagged with its own `HK_*`.
  useState: [1], // HK_STATE
  useReducer: [2], // HK_REDUCER
  useEffect: [3], // HK_EFFECT
  useMemo: [4], // HK_MEMO
  useRef: [5], // HK_REF
  useId: [6], // HK_ID
  useSyncExternalStore: [7], // HK_STORE
  useMemoCache: [8], // HK_MEMOCACHE
  useDeferredValue: [9], // HK_DEFERRED
  useLayoutEffect: [10], // HK_LAYOUT
  useInsertionEffect: [11], // HK_INSERTION
  // Cell-free: they read the fiber (or nothing at all) and never call `getHook`.
  useContext: [], // hooks-dispatcher.ts:295 — records a context dep only
  useDebugValue: [], // hooks-dispatcher.ts — records on fiber.debugValues (dev only), no cell
  useErrorBoundary: [], // runtime/hooks.ts:479 — reads the boundary provider
  // Composites — derived from their implementations.
  useCallback: [4], // runtime/hooks.ts:175 → dispatcher.useMemo
  useEffectEvent: [5, 11, 4], // runtime/hooks.ts → useRef + useInsertionEffect + useMemo
  useTransition: [1, 4], // runtime/hooks.ts:345-346 → useState + useCallback
  useOptimistic: [5, 1, 5, 4], // runtime/hooks.ts:366-377 → useRef, useState, useRef, useCallback
  useImperativeHandle: [10], // runtime/hooks.ts:404 → useLayoutEffect
  useActionState: [1, 1, 5, 4], // runtime/actions.ts:88-98 → useState×2, useRef, useCallback
  useFormState: [1, 1, 5, 4], // runtime/actions.ts:135 — alias of useActionState
  useFormStatus: [4, 5, 7], // runtime/actions.ts:39-49 → useCallback, useRef, useSyncExternalStore
};

/** How deep a chain of custom hooks (across modules too) is expanded before naming gives up. */
const MAX_HOOK_DEPTH = 3;

/** The breadcrumb separator between an expanded custom hook and what it declares. */
const CRUMB = " › ";

/** One live hook cell, joined to the source call that produced it. */
export interface ResolvedHookName {
  /** The hook's callee name, breadcrumbed through expansions (`useAuth › useState`). */
  hook: string;
  /** The variable it was bound to, breadcrumbed likewise (`useAuth › count`), or `""`. */
  name: string;
}

/** The breadcrumb prefix a level's hooks are named under, and where they resolve. */
interface HookLevel {
  /** The declaration's hook calls, in source order. */
  hooks: HookDevMeta[];
  /** The declaring module's URL — resolves a call with no `from` (a same-module hook). */
  moduleUrl: string;
  /** The breadcrumb prefix for this level (`""` at the top). */
  prefix: string;
}

/**
 * The spellings a `from` URL is tried under, in order: exactly as imported, then the
 * extension and `index` probes an extensionless import resolves through (`./auth` →
 * `auth.tsx`, `./hooks` → `hooks/index.ts`) — the importee registers under its real file.
 */
const MODULE_PROBES = [
  "",
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  "/index.tsx",
  "/index.ts",
  "/index.jsx",
  "/index.js",
];

/** How many re-export hops (`export { x } from`, `export * from`) a lookup follows. */
const MAX_REEXPORT_HOPS = 3;

/**
 * Every module URL a static relative import may name: the specifier as written, its
 * TypeScript sibling when it is spelled with a JS extension (`./auth.js` naming `auth.ts`, the
 * TypeScript convention), then the extension and `index` probes.
 */
function moduleCandidates(base: string): string[] {
  const sibling = base.replace(/\.(m?)js(x?)$/, ".$1ts$2");
  const typescript = sibling === base ? [] : [sibling];
  return [base, ...typescript, ...MODULE_PROBES.slice(1).map((probe) => base + probe)];
}

/** A registry hit and the module it was declared in. */
interface Found {
  meta: ComponentDevMeta;
  moduleUrl: string;
}

/** The first of a module URL's spellings ({@link moduleCandidates}) that `find` resolves. */
function firstCandidate(base: string, find: (url: string) => Found | undefined): Found | undefined {
  for (const url of moduleCandidates(base)) {
    const hit = find(url);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The declaration `name` resolves to in `moduleUrl`: its own record, else through a barrel's
 * named re-export (`aliasOf`) or its `export *` lines (the `#*` record), up to
 * {@link MAX_REEXPORT_HOPS} hops. `export *` never re-exports `default`.
 */
function lookupHook(moduleUrl: string, name: string, hops: number): Found | undefined {
  const meta = metaById.get(`${moduleUrl}#${name}`);
  if (meta && !meta.aliasOf) return { meta, moduleUrl };
  if (hops >= MAX_REEXPORT_HOPS && !moduleUrl.startsWith("npm:")) return undefined;
  return meta?.aliasOf ? viaAlias(meta.aliasOf, hops) : viaStars(moduleUrl, name, hops);
}

/** A named re-export's target (`"<url>#<name>"`), looked up one hop further. */
function viaAlias(aliasOf: string, hops: number): Found | undefined {
  const hash = aliasOf.lastIndexOf("#");
  const target = aliasOf.slice(hash + 1);
  return firstCandidate(aliasOf.slice(0, hash), (u) => lookupHook(u, target, hops + 1));
}

/**
 * `name` in the modules a barrel's `export *` lines name, one hop further (never `default`). A
 * package specifier's record (`npm:<specifier>#*`, which the dev npm bundle registers) names the
 * module the specifier resolves to, and costs no hop: the package's own barrels get the three.
 */
function viaStars(moduleUrl: string, name: string, hops: number): Found | undefined {
  const pkg = moduleUrl.startsWith("npm:");
  if (name === "default" && !pkg) return undefined;
  for (const star of metaById.get(`${moduleUrl}#*`)?.reExportsAll ?? []) {
    const hit = firstCandidate(star, (u) => lookupHook(u, name, pkg ? hops : hops + 1));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The level a custom-hook call expands into: the hook's registered metadata, looked up in
 * the module that declares it (`from`, else the calling module), breadcrumbed under the
 * hook's declared name. Undefined when no module registered it — an uninstrumented or
 * not-yet-evaluated importee, or a package module the dev npm bundle could not instrument
 * (CommonJS, minified) — which leaves the call opaque.
 */
function expandCustomHook(entry: HookDevMeta, level: HookLevel): HookLevel | undefined {
  const find = (url: string) => lookupHook(url, entry.hook, 0);
  const found = entry.from ? firstCandidate(entry.from, find) : find(level.moduleUrl);
  if (!found) return undefined;
  // The declared name reads better than the imported one for a default import (`default`).
  const label = found.meta.name || entry.hook;
  return {
    hooks: found.meta.hooks,
    moduleUrl: found.moduleUrl,
    prefix: level.prefix + label + CRUMB,
  };
}

/**
 * One hook call as the alignment sees it: a known hook's exact cells, a custom hook expanded
 * into its own calls, or an opaque hook that took an unknown number of cells. A `cond` step
 * may also have taken none (it did not run this render).
 */
type Step =
  | { kind: "cells"; cells: readonly number[]; hook: string; name: string; cond: boolean }
  | { kind: "group"; steps: Step[]; cond: boolean }
  | { kind: "opaque"; hook: string; name: string };

/** A declaration's hook calls as {@link Step}s, custom hooks expanded up to the depth cap. */
function stepsOf(level: HookLevel, depth: number): Step[] {
  return level.hooks.map((entry): Step => {
    const cond = entry.cond === true;
    const hook = level.prefix + entry.hook;
    const name = entry.name ? level.prefix + entry.name : "";
    const cells = HOOK_CELL_KINDS[entry.hook];
    if (cells) return { kind: "cells", cells, hook, name, cond };
    const nested = depth < MAX_HOOK_DEPTH ? expandCustomHook(entry, level) : undefined;
    return nested
      ? { kind: "group", steps: stepsOf(nested, depth + 1), cond }
      : { kind: "opaque", hook, name };
  });
}

/** How much work one alignment may do before naming gives up (a pathological component). */
const ALIGN_BUDGET = 20_000;

/** A cell two complete alignments label differently: it stays unnamed. */
const DISAGREE: ResolvedHookName = { hook: "", name: "" };

/** The state of one alignment search over a component's cells. */
interface Align {
  /** The component's live hook cells (only their `kind` tag is read). */
  cells: ReadonlyArray<{ kind?: number }>;
  /** The labels of the alignment being built, by cell index. */
  path: ResolvedHookName[];
  /** Every complete alignment's labels merged: a cell they disagree on is {@link DISAGREE}. */
  agreed: ResolvedHookName[] | null;
  /** Steps left before the search gives up. */
  budget: number;
}

/** Where an alignment continues once a step has consumed its cells (the next cell index). */
type Next = (i: number) => void;

/** Label `n` cells from `i` as one hook call (only the first carries the bound name). */
function labelCells(a: Align, i: number, n: number, hook: string, name: string): void {
  for (let k = 0; k < n; k++) a.path[i + k] = { hook, name: k === 0 ? name : "" };
}

/** Whether a known hook's cells line up with the live ones at `i`. */
function cellsFit(a: Align, i: number, kinds: readonly number[]): boolean {
  if (i + kinds.length > a.cells.length) return false;
  return kinds.every((kind, k) => a.cells[i + k]?.kind === kind);
}

/** Try one step at cell `i`, then the rest through `next`: every way the step can fit. */
function alignStep(a: Align, step: Step, i: number, next: Next): void {
  if (step.kind === "opaque") {
    for (let n = 0; i + n <= a.cells.length && a.budget > 0; n++) {
      labelCells(a, i, n, step.hook, step.name);
      next(i + n);
    }
    return;
  }
  if (step.cond) next(i); // the call did not run this render
  if (step.kind === "group") return alignSteps(a, step.steps, 0, i, next);
  if (!cellsFit(a, i, step.cells)) return;
  labelCells(a, i, step.cells.length, step.hook, step.name);
  next(i + step.cells.length);
}

/** Align `steps[si..]` from cell `i`, handing each way they fit to `done`. */
function alignSteps(a: Align, steps: Step[], si: number, i: number, done: Next): void {
  if (--a.budget < 0) return;
  if (si === steps.length) return done(i);
  alignStep(a, steps[si], i, (j) => alignSteps(a, steps, si + 1, j, done));
}

/** Fold one complete alignment into the agreed labels. */
function agree(a: Align): void {
  if (!a.agreed) {
    a.agreed = a.path.slice(0, a.cells.length);
    return;
  }
  for (let i = 0; i < a.agreed.length; i++) {
    const was = a.agreed[i], now = a.path[i];
    if (was !== DISAGREE && (was.hook !== now.hook || was.name !== now.name)) {
      a.agreed[i] = DISAGREE;
    }
  }
}

/**
 * Join a component's build-time hook metadata to its live hook cells.
 *
 * Each recorded call consumes the cells {@link HOOK_CELL_KINDS} says it does (their kind tags
 * are compared), a conditional call may also consume none, a custom hook expands into its
 * own calls, and an opaque one (a package hook, an uninstrumented module) consumes however
 * many cells the calls around it leave. Every alignment that uses up exactly the live cells
 * is found; a cell they all label the same is named, one they disagree on is left unnamed.
 * No alignment at all (stale metadata, a skipped hook the build pass could not see as
 * conditional) names nothing.
 *
 * @param familyId The component's Fast Refresh family id (`"<fileUrl>#<Name>"`).
 * @param meta The component's registered metadata.
 * @param cells Its live hook cells (only `kind` is read).
 * @returns One entry per cell (`undefined` where the name is not knowable), or `null` when
 *   the metadata does not line up with the cells.
 */
export function resolveHookNames(
  familyId: string,
  meta: ComponentDevMeta,
  cells: ReadonlyArray<{ kind?: number }>,
): Array<ResolvedHookName | undefined> | null {
  const hash = familyId.lastIndexOf("#");
  const moduleUrl = hash >= 0 ? familyId.slice(0, hash) : familyId;
  const steps = stepsOf({ hooks: meta.hooks, moduleUrl, prefix: "" }, 0);
  const a: Align = { cells, path: [], agreed: null, budget: ALIGN_BUDGET };
  alignSteps(a, steps, 0, 0, (i) => {
    if (i === cells.length) agree(a);
  });
  if (a.budget < 0 || !a.agreed) return null; // too many ways to tell, or none at all
  return a.agreed.map((n) => (n === DISAGREE ? undefined : n));
}
