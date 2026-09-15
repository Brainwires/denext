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
   * same-module hook, and a hook from a bare/`npm:`/`jsr:`/URL or namespace import.
   */
  from?: string;
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
   * custom-hook expansion follows it one hop.
   */
  aliasOf?: string;
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
 * relative import names (`HookDevMeta.from`) — and otherwise gives up on naming that
 * component (there is no way to know how many cells an opaque hook consumed).
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
  useEffectEvent: [5, 4], // runtime/hooks.ts:206-209 → useRef + useMemo
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

/** The cursor a naming walk carries: the cells to match and what has been named so far. */
interface NameWalk {
  /** The component's live hook cells (only their `kind` tag is read). */
  cells: ReadonlyArray<{ kind?: number }>;
  /** One entry per consumed cell, in cell order. */
  out: ResolvedHookName[];
  /** How many cells have been consumed. */
  i: number;
}

/** One declaration being walked: its hook calls, where it lives, and its breadcrumb. */
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

/**
 * Consume the cells one hook call takes, checking each against the expected kind.
 *
 * @param w The walk cursor.
 * @param entry The hook call from the metadata.
 * @param kinds The cell kinds the hook consumes ({@link HOOK_CELL_KINDS}).
 * @param prefix The breadcrumb prefix of the enclosing expansion (`""` at the top).
 * @returns Whether every cell matched (a mismatch aborts the whole component).
 */
function takeCells(
  w: NameWalk,
  entry: HookDevMeta,
  kinds: readonly number[],
  prefix: string,
): boolean {
  for (let k = 0; k < kinds.length; k++) {
    if (w.cells[w.i]?.kind !== kinds[k]) return false;
    // Only the call's FIRST cell carries the binding name; a composite's remaining cells
    // are internal to it and read as the hook alone.
    w.out.push({
      hook: prefix + entry.hook,
      name: k === 0 && entry.name ? prefix + entry.name : "",
    });
    w.i++;
  }
  return true;
}

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

/**
 * The level a custom-hook call expands into: the hook's registered metadata, looked up in
 * the module that declares it (`from`, else the calling module), breadcrumbed under the
 * hook's declared name. Undefined when that module registered nothing for it — an
 * uninstrumented or not-yet-evaluated importee, a re-export, an opaque package hook.
 */
function expandCustomHook(entry: HookDevMeta, level: HookLevel): HookLevel | undefined {
  const base = entry.from ?? level.moduleUrl;
  for (const moduleUrl of entry.from ? moduleCandidates(base) : [base]) {
    const found = followAlias(metaById.get(`${moduleUrl}#${entry.hook}`), moduleUrl);
    if (!found) continue;
    // The declared name reads better than the imported one for a default import (`default`).
    const label = found.meta.name || entry.hook;
    return {
      hooks: found.meta.hooks,
      moduleUrl: found.moduleUrl,
      prefix: level.prefix + label + CRUMB,
    };
  }
  return undefined;
}

/**
 * A registry hit, following a barrel's re-export alias one hop to the declaring module (whose
 * URL may still need the extension / `index` probe). A second alias is not followed.
 */
function followAlias(
  meta: ComponentDevMeta | undefined,
  moduleUrl: string,
): { meta: ComponentDevMeta; moduleUrl: string } | undefined {
  if (!meta?.aliasOf) return meta && { meta, moduleUrl };
  const hash = meta.aliasOf.lastIndexOf("#");
  const name = meta.aliasOf.slice(hash + 1);
  for (const candidate of moduleCandidates(meta.aliasOf.slice(0, hash))) {
    const hit = metaById.get(`${candidate}#${name}`);
    if (hit && !hit.aliasOf) return { meta: hit, moduleUrl: candidate };
  }
  return undefined;
}

/**
 * Walk one declaration's hook calls in lockstep with the live cells, expanding a custom
 * hook — declared in the same module or imported by a static relative import — into its
 * own calls (breadcrumbed).
 *
 * @param w The walk cursor.
 * @param level The declaration being walked.
 * @param depth How many expansions deep this level is.
 * @returns Whether the level matched the cells.
 */
function walkHookMeta(w: NameWalk, level: HookLevel, depth: number): boolean {
  for (const entry of level.hooks) {
    const kinds = HOOK_CELL_KINDS[entry.hook];
    if (kinds) {
      if (!takeCells(w, entry, kinds, level.prefix)) return false;
      continue;
    }
    // A custom hook: expand it when its declaring module registered it, else stop — an
    // opaque hook consumed an unknown number of cells, so every later name would be a guess.
    if (depth >= MAX_HOOK_DEPTH) return false;
    const nested = expandCustomHook(entry, level);
    if (!nested || !walkHookMeta(w, nested, depth + 1)) return false;
  }
  return true;
}

/**
 * Join a component's build-time hook metadata to its live hook cells.
 *
 * The walk is correct by construction: each recorded call consumes exactly the cells
 * {@link HOOK_CELL_KINDS} says it does, and the tags are compared as it goes. ANY
 * divergence — a conditional hook, a stale module registration, an opaque custom hook,
 * or leftover cells — abandons naming for the whole component rather than pairing a
 * name with the wrong cell.
 *
 * @param familyId The component's Fast Refresh family id (`"<fileUrl>#<Name>"`).
 * @param meta The component's registered metadata.
 * @param cells Its live hook cells (only `kind` is read).
 * @returns One entry per cell, or `null` when the metadata does not line up.
 */
export function resolveHookNames(
  familyId: string,
  meta: ComponentDevMeta,
  cells: ReadonlyArray<{ kind?: number }>,
): ResolvedHookName[] | null {
  const hash = familyId.lastIndexOf("#");
  const moduleUrl = hash >= 0 ? familyId.slice(0, hash) : familyId;
  const w: NameWalk = { cells, out: [], i: 0 };
  if (!walkHookMeta(w, { hooks: meta.hooks, moduleUrl, prefix: "" }, 0)) return null;
  return w.i === cells.length ? w.out : null; // leftover cells ⇒ metadata is stale
}
