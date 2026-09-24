/**
 * Internal helpers the `denext/mobile` capability functions share: reach a natively
 * registered Capacitor plugin by its JS name, and dispose a plugin event listener whose
 * handle may still be on its way. Not re-exported from `denext/mobile`.
 *
 * @module
 */

import { shellPlugin } from "./bridge.ts";

/**
 * `Capacitor.Plugins[name]` inside the iOS/Android shell when it has every method in
 * `methods`, else `undefined` (on the web, during SSR, or when the plugin is not installed
 * natively). The shell seeds a stub for each natively registered method, so a missing method
 * means the plugin (or that version of it) is not there.
 */
export function nativePlugin<T extends object>(
  name: string,
  methods: readonly (keyof T & string)[],
): T | undefined {
  const plugin = shellPlugin(name);
  if (typeof plugin !== "object" || plugin === null) return undefined;
  const record = plugin as Record<string, unknown>;
  return methods.every((m) => typeof record[m] === "function") ? plugin as T : undefined;
}

/** A plugin listener handle: the native bridge returns it directly, `@capacitor/core` in a promise. */
export interface ListenerHandle {
  remove(): unknown;
}

/** Call `handle.remove()`, swallowing a synchronous throw or a rejected promise. */
function removeQuietly(handle: ListenerHandle | undefined): void {
  if (typeof handle?.remove !== "function") return;
  try {
    Promise.resolve(handle.remove()).catch(() => {});
  } catch {
    // A listener that cannot be removed is already gone.
  }
}

/**
 * A dispose function for a listener handle that may be a promise. Disposing before the
 * promise settles removes the listener as soon as it arrives, so an unmount that races the
 * registration never leaks it.
 */
export function listenerDisposer(
  handle: ListenerHandle | Promise<ListenerHandle> | undefined,
): () => void {
  let disposed = false;
  let settled: ListenerHandle | undefined;
  Promise.resolve(handle).then(
    (h) => disposed ? removeQuietly(h) : void (settled = h),
    () => {},
  );
  return () => {
    if (disposed) return;
    disposed = true;
    removeQuietly(settled);
    settled = undefined;
  };
}
