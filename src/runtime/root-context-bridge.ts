// Client-safe access to the server's root async context (src/server/root-context.ts) for modules
// that can end up in a browser bundle and so must not import `node:async_hooks`. The server
// installs `__denextInRootContext`; in a browser (or before the server module loads) there is no
// request context to detach from, so the work simply runs.

type RootBridge = { __denextInRootContext?: <R>(fn: () => R) => R };

/**
 * Run `fn` in the server's root async context when one is installed, else directly. See
 * `inRootContext` in src/server/root-context.ts for why shared lazy loads need it.
 *
 * @param fn The work to run.
 * @returns What `fn` returns.
 */
export function detachedFromRequest<T>(fn: () => T): T {
  const run = (globalThis as RootBridge).__denextInRootContext;
  return run ? run(fn) : fn();
}
