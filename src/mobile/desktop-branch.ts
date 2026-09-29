/**
 * The one seam through which `denext/mobile` capability functions reach their Deno Desktop
 * halves (`../desktop/native.ts`). It is loaded with a dynamic `import()` only when the page
 * runs in a Deno Desktop window, so web and mobile bundles never fetch it. Internal; not
 * re-exported from `denext/mobile`.
 *
 * @module
 */

import { runtimePlatform } from "./bridge.ts";

/** The desktop module's exports, as the capability functions call them. */
export type DesktopNative = typeof import("../desktop/native.ts");

/**
 * Whether the page runs in a Deno Desktop window. Call sites test it before awaiting
 * {@linkcode viaDesktop} (`onDesktop() && await viaDesktop(…)`), so the web and mobile paths
 * keep their exact timing: no extra `await` off desktop.
 *
 * @returns `true` in a Deno Desktop window.
 */
export function onDesktop(): boolean {
  return runtimePlatform() === "desktop";
}

/**
 * Run `call` against the desktop module when the page is in a Deno Desktop window.
 *
 * @param cap The desktop capability (`desktop.capabilities` key) `call` uses, for the fallback
 * warning.
 * @param call The desktop call.
 * @param persistent Whether the web fallback loses data on desktop (browser storage does not
 * survive a relaunch there): such a fallback warns once.
 * @returns `{ value }` from the desktop call; `undefined` off desktop, or when the capability is
 * not enabled (`unavailable`), so the caller takes its web path as before. Any other failure
 * rejects.
 */
export async function viaDesktop<T>(
  cap: string,
  call: (desktop: DesktopNative) => Promise<T>,
  persistent = false,
): Promise<{ value: T } | undefined> {
  if (runtimePlatform() !== "desktop") return undefined;
  const desktop = await import("../desktop/native.ts");
  try {
    return { value: await call(desktop) };
  } catch (err) {
    if ((err as { code?: unknown })?.code !== "unavailable") throw err;
    if (persistent) desktop.warnStorageFallback(cap);
    return undefined;
  }
}

/**
 * A rejection shaped like the bridge client's errors (`name` `"DesktopBridgeError"`, a `code`),
 * so `isDesktopBridgeError` from `denext/desktop/client` narrows it without loading that module.
 *
 * @param fn The function's name, for the message.
 * @param code The machine-readable code (`"unavailable"`, `"forbidden"`, …).
 * @param message What went wrong.
 * @returns The error to throw.
 */
export function capabilityError<C extends string>(
  fn: string,
  code: C,
  message: string,
): Error & { code: C } {
  const err = new Error(`${fn}: ${code}: ${message}`) as Error & { code: C };
  err.name = "DesktopBridgeError";
  err.code = code;
  return err;
}

/**
 * The rejection for a desktop-only function called elsewhere: code `"unavailable"` (see
 * {@linkcode capabilityError}).
 *
 * @param fn The function's name, for the message.
 * @returns The error to throw.
 */
export function desktopOnlyError(fn: string): Error & { code: "unavailable" } {
  return capabilityError(fn, "unavailable", "only in a Deno Desktop window");
}
