/**
 * Screen reader state for `denext/mobile`: whether VoiceOver (iOS) or TalkBack (Android) is on,
 * read from denext's native `DenextAccessibility` plugin (`denext mobile add accessibility`).
 * The web has no API that reveals a screen reader, so there (and in a shell without the plugin)
 * it reads `false` and never changes.
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";

/** The JS side of the `DenextAccessibility` plugin: `{ value }` answers and events. */
interface AccessibilityPlugin {
  isScreenReaderEnabled(): Promise<{ value?: boolean }>;
  addListener(
    eventName: "screenReaderChanged",
    listener: (event: { value?: boolean }) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** The native plugin, when the shell has it. */
function accessibilityPlugin(): AccessibilityPlugin | undefined {
  return nativePlugin<AccessibilityPlugin>("DenextAccessibility", [
    "isScreenReaderEnabled",
    "addListener",
  ]);
}

/**
 * Whether a screen reader is on: VoiceOver on iOS, a touch-exploration service (TalkBack) on
 * Android, through the `DenextAccessibility` plugin that `denext mobile add accessibility`
 * installs. On the web, during SSR, in a shell without the plugin, or when the plugin fails, it
 * resolves `false`.
 *
 * @returns Whether a screen reader is running.
 * @example
 * ```ts
 * import { isScreenReaderEnabled } from "denext/mobile";
 *
 * if (await isScreenReaderEnabled()) carousel.stopAutoplay();
 * ```
 */
export async function isScreenReaderEnabled(): Promise<boolean> {
  const plugin = accessibilityPlugin();
  if (!plugin) return false;
  try {
    return (await plugin.isScreenReaderEnabled())?.value === true;
  } catch {
    return false;
  }
}

/**
 * Call `callback` with the new state whenever the screen reader is turned on or off; returns a
 * function that stops listening. Without the native plugin (the web, SSR) it never fires and the
 * returned function does nothing.
 *
 * @param callback Called with `true` when a screen reader starts, `false` when it stops.
 * @returns A function that removes the listener.
 * @example
 * ```ts
 * import { onScreenReaderChange } from "denext/mobile";
 *
 * const stop = onScreenReaderChange((on) => document.body.classList.toggle("sr", on));
 * ```
 */
export function onScreenReaderChange(callback: (enabled: boolean) => void): () => void {
  const plugin = accessibilityPlugin();
  if (!plugin) return () => {};
  return listenerDisposer(
    plugin.addListener("screenReaderChanged", (event) => callback(event?.value === true)),
  );
}

/**
 * Hook form: whether a screen reader is on, read on mount and kept current until unmount. It is
 * `false` before the first answer (and always on the web), so render the sighted layout first and
 * let the screen-reader one replace it.
 *
 * @returns Whether a screen reader is running.
 * @example
 * ```tsx
 * "use client";
 * import { useScreenReader } from "denext/mobile";
 *
 * export function Slides({ items }: { items: string[] }) {
 *   const screenReader = useScreenReader();
 *   return screenReader ? <ol>{items.map((i) => <li key={i}>{i}</li>)}</ol> : <Carousel items={items} />;
 * }
 * ```
 */
export function useScreenReader(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    let changed = false;
    const stop = onScreenReaderChange((on) => {
      changed = true;
      if (active) setEnabled(on);
    });
    // The first read loses to any change event that beats it.
    isScreenReaderEnabled().then((on) => active && !changed && setEnabled(on));
    return () => {
      active = false;
      stop();
    };
  }, []);
  return enabled;
}
