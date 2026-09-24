/**
 * Haptic feedback for `denext/mobile`: the native `Haptics` plugin in the shell, else the
 * Vibration API, else nothing.
 *
 * @module
 */

import { nativePlugin } from "./plugin.ts";

/** A haptic feedback kind {@linkcode haptic} can play. */
export type HapticKind =
  | "light"
  | "medium"
  | "heavy"
  | "success"
  | "warning"
  | "error"
  | "selection";

/** The JS side of `@capacitor/haptics`. */
interface HapticsPlugin {
  impact(options: { style: "LIGHT" | "MEDIUM" | "HEAVY" }): Promise<void>;
  notification(options: { type: "SUCCESS" | "WARNING" | "ERROR" }): Promise<void>;
  selectionStart(): Promise<void>;
  selectionChanged(): Promise<void>;
  selectionEnd(): Promise<void>;
}

/** The vibration pattern (ms) each kind falls back to where `navigator.vibrate` exists. */
const VIBRATION: Readonly<Record<HapticKind, number | readonly number[]>> = {
  light: 10,
  medium: 20,
  heavy: 30,
  success: [10, 60, 10],
  warning: [20, 80, 20],
  error: [30, 60, 30, 60, 30],
  selection: 5,
};

/** Play `kind` through the native plugin. */
async function playNative(plugin: HapticsPlugin, kind: HapticKind): Promise<void> {
  switch (kind) {
    case "light":
    case "medium":
    case "heavy":
      return await plugin.impact({ style: kind.toUpperCase() as "LIGHT" | "MEDIUM" | "HEAVY" });
    case "success":
    case "warning":
    case "error":
      return await plugin.notification({
        type: kind.toUpperCase() as "SUCCESS" | "WARNING" | "ERROR",
      });
    default:
      // iOS only emits a selection tick between selectionStart and selectionEnd.
      await plugin.selectionStart();
      await plugin.selectionChanged();
      await plugin.selectionEnd();
  }
}

/**
 * Play a short haptic.
 *
 * - Inside the native shell with `@capacitor/haptics` installed (`denext mobile add
 *   haptics`), `light`/`medium`/`heavy` are an impact, `success`/`warning`/`error` a
 *   notification, and `selection` a selection tick.
 * - Elsewhere it calls `navigator.vibrate` with a short pattern where the browser has it
 *   (Android Chrome), and does nothing otherwise (iOS Safari, desktop, SSR).
 *
 * @param kind The feedback to play.
 * @returns A promise that settles once the haptic was requested. It rejects with a
 * `TypeError` for an unknown kind, or if the native plugin rejects.
 * @example
 * ```tsx
 * "use client";
 * import { haptic } from "denext/mobile";
 *
 * export function LikeButton() {
 *   return <button type="button" onClick={() => haptic("light")}>Like</button>;
 * }
 * ```
 */
export async function haptic(kind: HapticKind): Promise<void> {
  if (!Object.hasOwn(VIBRATION, kind)) {
    throw new TypeError(`haptic: unknown kind "${String(kind)}"`);
  }
  const plugin = nativePlugin<HapticsPlugin>("Haptics", [
    "impact",
    "notification",
    "selectionStart",
    "selectionChanged",
    "selectionEnd",
  ]);
  if (plugin) return await playNative(plugin, kind);
  const nav = (globalThis as { navigator?: { vibrate?: (p: number | number[]) => boolean } })
    .navigator;
  if (typeof nav?.vibrate !== "function") return;
  const pattern = VIBRATION[kind];
  nav.vibrate(typeof pattern === "number" ? pattern : [...pattern]);
}
