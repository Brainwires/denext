/**
 * Keep the screen on for `denext/mobile`: the native `KeepAwake` plugin in the shell, else
 * the Screen Wake Lock API.
 *
 * @module
 */

import { useEffect } from "../runtime/hooks.ts";
import { nativePlugin } from "./plugin.ts";

/** The JS side of `@capacitor-community/keep-awake`. */
interface KeepAwakePlugin {
  keepAwake(): Promise<void>;
  allowSleep(): Promise<void>;
}

/** The slice of a `WakeLockSentinel` used here. */
interface WakeLockSentinelLike {
  readonly released?: boolean;
  release(): Promise<void>;
}

/** The slice of `navigator.wakeLock` used here. */
interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

/** How many mounted {@linkcode useKeepAwake} calls hold the native plugin awake. */
let nativeHolders = 0;

/** Hold the screen on through the native plugin; the last release lets it sleep again. */
function holdNative(plugin: KeepAwakePlugin): () => void {
  if (nativeHolders++ === 0) plugin.keepAwake().catch(() => {});
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--nativeHolders === 0) plugin.allowSleep().catch(() => {});
  };
}

/**
 * Hold a screen wake lock, re-requesting it each time the page becomes visible again (the
 * browser drops it whenever the page is hidden).
 */
function holdWakeLock(wakeLock: WakeLockLike): () => void {
  let active = true;
  let sentinel: WakeLockSentinelLike | undefined;
  let pending = false;
  const acquire = () => {
    if (!active || pending || (sentinel && !sentinel.released)) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    pending = true;
    wakeLock.request("screen").then(
      (lock) => {
        pending = false;
        if (active) sentinel = lock;
        else lock.release().catch(() => {});
      },
      () => void (pending = false),
    );
  };
  const onVisibility = () => acquire();
  const doc = typeof document === "undefined" ? undefined : document;
  doc?.addEventListener("visibilitychange", onVisibility);
  acquire();
  return () => {
    active = false;
    doc?.removeEventListener("visibilitychange", onVisibility);
    sentinel?.release().catch(() => {});
    sentinel = undefined;
  };
}

/** Start keeping the screen on with whatever the platform offers; returns the release. */
function holdAwake(): () => void {
  const plugin = nativePlugin<KeepAwakePlugin>("KeepAwake", ["keepAwake", "allowSleep"]);
  if (plugin) return holdNative(plugin);
  const wakeLock = (globalThis as { navigator?: { wakeLock?: Partial<WakeLockLike> } })
    .navigator?.wakeLock;
  if (typeof wakeLock?.request !== "function") return () => {};
  return holdWakeLock(wakeLock as WakeLockLike);
}

/**
 * Keep the screen from dimming and locking while the component is mounted and `active` is
 * true (a video call, a recipe, a boarding pass).
 *
 * - Inside the native shell with `@capacitor-community/keep-awake` installed (`denext mobile
 *   add keep-awake`), the native flag. Several mounted callers share it: the screen may sleep
 *   again once the last one unmounts or turns `active` off.
 * - Otherwise the Screen Wake Lock API (`navigator.wakeLock`), re-acquired whenever the page
 *   becomes visible again, since the browser releases it on every hide. Where the browser has
 *   no wake lock, or refuses one, it does nothing.
 *
 * @param active Whether to hold the screen on (default `true`).
 * @example
 * ```tsx
 * "use client";
 * import { useKeepAwake } from "denext/mobile";
 *
 * export function Recipe({ cooking }: { cooking: boolean }) {
 *   useKeepAwake(cooking);
 *   return <Steps />;
 * }
 * ```
 */
export function useKeepAwake(active = true): void {
  useEffect(() => (active ? holdAwake() : undefined), [active]);
}
