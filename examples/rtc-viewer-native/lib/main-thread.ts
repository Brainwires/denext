// `Deno.desktop.runOnMainThread`: calls a native `void* fn(void*)` on the app's UI thread (the
// thread AppKit windows belong to). denext's pinned Deno Desktop runtime has it; elsewhere (a
// plain `deno run`, a browser) there is no UI thread to reach and the window can't open.

import type { MainThreadRunner } from "./viewer.ts";

interface DesktopMainThread {
  runOnMainThread?(fn: Deno.PointerValue, context?: Deno.PointerValue): Promise<bigint>;
}

/** The runtime's runner, or null outside a Deno Desktop runtime that has one. */
export function desktopMainThread(): MainThreadRunner | null {
  const desktop = (Deno as unknown as { desktop?: DesktopMainThread }).desktop;
  const run = desktop?.runOnMainThread;
  if (typeof run !== "function") return null;
  return (fn, context) => run.call(desktop, fn, context);
}
