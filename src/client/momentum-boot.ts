// The client runtime's automatic install of the iOS momentum-safe scroll shim
// (`installMomentumSafeScroll` in `denext/mobile`). Every root (`createRoot` / `hydrateRoot`)
// calls `bootMomentumSafeScroll()`: off iOS/iPadOS WebKit it costs one user-agent test; on it,
// the shim is fetched as its own chunk through the dynamic `import()` below (its only
// importer, as with class-loader.ts) and installed once. A build seeds
// `globalThis.__DENEXT_MOMENTUM_SCROLL__ = false` for `momentumSafeScroll: false`.

import { isIosWebKit } from "../mobile/ios-webkit.ts";

/** The global a client entry sets to `false` when the app opted out. */
export const MOMENTUM_SCROLL_OPT_OUT = "__DENEXT_MOMENTUM_SCROLL__";

let mod: Promise<typeof import("../mobile/momentum-scroll.ts")> | undefined;

/**
 * Install the momentum-safe scroll shim when the page runs in iOS/iPadOS WebKit and the app did
 * not opt out. The chunk import is memoized; the install is idempotent. Never rejects.
 *
 * @returns Resolves once the shim is installed, or `undefined` when it does not apply.
 */
export function bootMomentumSafeScroll(): Promise<void> | undefined {
  const flag = (globalThis as Record<string, unknown>)[MOMENTUM_SCROLL_OPT_OUT];
  if (flag === false || !isIosWebKit()) return undefined;
  mod ??= import("../mobile/momentum-scroll.ts").catch((err) => {
    mod = undefined;
    throw err;
  });
  return mod.then((m) => void m.startMomentumSafeScroll()).catch(() => {});
}
