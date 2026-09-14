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
 * uses to expand a same-module custom hook: `"<fileUrl>#useAuth"` resolves to the hook's
 * own metadata (its nested hook calls included).
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
 * A hook that is absent from the table is a custom hook: the runtime expands it when the
 * same module declared it, and otherwise gives up on naming that component (there is no
 * way to know how many cells an opaque hook consumed).
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
  useDebugValue: [], // runtime/hooks.ts:292 — a no-op
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

/** How deep a chain of same-module custom hooks is expanded before naming gives up. */
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
  /** The declaring module's URL, for resolving a same-module custom hook. */
  moduleUrl: string;
  /** One entry per consumed cell, in cell order. */
  out: ResolvedHookName[];
  /** How many cells have been consumed. */
  i: number;
}

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
 * Walk one declaration's hook calls in lockstep with the live cells, expanding a
 * same-module custom hook into its own calls (breadcrumbed).
 *
 * @param w The walk cursor.
 * @param hooks The declaration's hook calls, in source order.
 * @param prefix The breadcrumb prefix for this level.
 * @param depth How many expansions deep this level is.
 * @returns Whether the level matched the cells.
 */
function walkHookMeta(w: NameWalk, hooks: HookDevMeta[], prefix: string, depth: number): boolean {
  for (const entry of hooks) {
    const kinds = HOOK_CELL_KINDS[entry.hook];
    if (kinds) {
      if (!takeCells(w, entry, kinds, prefix)) return false;
      continue;
    }
    // A custom hook: expand it when this module declared it, else stop — an opaque hook
    // consumed an unknown number of cells, so every later name would be a guess.
    if (depth >= MAX_HOOK_DEPTH) return false;
    const nested = metaById.get(`${w.moduleUrl}#${entry.hook}`);
    if (!nested) return false;
    if (!walkHookMeta(w, nested.hooks, `${prefix}${entry.hook}${CRUMB}`, depth + 1)) return false;
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
  const w: NameWalk = {
    cells,
    moduleUrl: hash >= 0 ? familyId.slice(0, hash) : familyId,
    out: [],
    i: 0,
  };
  if (!walkHookMeta(w, meta.hooks, "", 0)) return null;
  return w.i === cells.length ? w.out : null; // leftover cells ⇒ metadata is stale
}
