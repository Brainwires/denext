// The root async context: work that serves every subscriber (a listener, a timer, a slot reader)
// runs outside whichever request happened to start it.

type RootBridge = { __denextInRootContext?: <R>(fn: () => R) => R };

/**
 * Run `fn` in the root async context (see src/server/root-context.ts in denext).
 *
 * @param fn The work.
 * @returns What it returns.
 */
export function inRoot<T>(fn: () => T): T {
  const run = (globalThis as RootBridge).__denextInRootContext;
  return run ? run(fn) : fn();
}
