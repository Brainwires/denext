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
