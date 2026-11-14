// A seam between the client reconciler and Preact's `options` hooks (src/compat/preact/options.ts).
// A Preact or Fresh app's `denext/preact` entry installs its `options` object here; the reconciler
// reads the hooks off it at the points Preact calls them: `__r` / `_render` before a component
// renders, `diffed` after a commit's DOM changes (child before parent), `__c` / `_commit` once
// per commit, `unmount` for each removed vnode (parent before child), `debounceRendering` to
// schedule an update's render, and `requestAnimationFrame` to schedule `useEffect`s. With no
// Preact entry loaded the slot is null and each call site is one `?.` short-circuit.

/** The hooks the reconciler calls, as Preact's `options` object holds them. */
export interface PreactOptionHooks {
  /** Before a component renders (Preact's `options._render`, mangled `__r`). */
  __r?: (vnode: unknown) => void;
  /** After a vnode and its children are in the DOM. */
  diffed?: (vnode: unknown) => void;
  /** After a commit (Preact's `options._commit`, mangled `__c`): the root vnode, the queue. */
  __c?: (vnode: unknown, commitQueue: unknown[]) => void;
  /** For each vnode removed from the tree, before its children. */
  unmount?: (vnode: unknown) => void;
  /** Schedules the render of a state update (Preact defaults to a microtask). */
  debounceRendering?: (cb: () => void) => void;
  /** Schedules the `useEffect` flush after paint. */
  requestAnimationFrame?: (cb: () => void) => void;
  /** Any other hook a library set. */
  [hook: string]: unknown;
}

/** The installed `options` object, or null (no Preact entry loaded). */
export let preactOptions: PreactOptionHooks | null = null;

/** Install Preact's `options` object (called once by `denext/preact`'s options module). */
export function setPreactOptions(options: PreactOptionHooks | null): void {
  preactOptions = options;
}

/** `options._render` / `__r`, whichever is set. */
export function preactRenderHook(): ((vnode: unknown) => void) | undefined {
  const o = preactOptions;
  if (o === null) return undefined;
  return (o.__r ?? o._render) as ((vnode: unknown) => void) | undefined;
}

/** `options._commit` / `__c`, whichever is set. */
export function preactCommitHook(): ((vnode: unknown, queue: unknown[]) => void) | undefined {
  const o = preactOptions;
  if (o === null) return undefined;
  return (o.__c ?? o._commit) as ((vnode: unknown, queue: unknown[]) => void) | undefined;
}
