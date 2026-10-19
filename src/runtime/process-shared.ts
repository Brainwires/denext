// State shared by every copy of a denext module loaded in one process (or page).
//
// A compat (Next drop-in) build prebuilds denext's runtime entries (`denext`, `denext/live`,
// `denext/gleam`, the React compat modules, …) into a graph of their own, while the server keeps
// loading denext's source. So the same module can be loaded twice in one process: the app's
// `defineLiveView`, `serverAction` or `experimental_taintObjectReference` runs in one copy and the
// server's Live hub, action dispatch or Flight serializer reads the other. A registry those two
// must agree on lives on `globalThis` under a `Symbol.for` key instead of at module level.

/**
 * The process's one value for `name`, created by `create` the first time any copy asks. Call it at
 * module level as `/* @__PURE__ *\/ processShared(…)`, so a bundle that never reads the value drops
 * the call.
 *
 * @param name The value's name (`"liveViews"`); namespaced under `denext.`.
 * @param create Builds the value the first time.
 * @returns The shared value.
 */
export function processShared<T>(name: string, create: () => T): T {
  const slots = globalThis as unknown as Record<symbol, T | undefined>;
  const key = Symbol.for(`denext.shared.${name}`);
  return slots[key] ??= create();
}
