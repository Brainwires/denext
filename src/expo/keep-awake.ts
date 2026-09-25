/**
 * `expo-keep-awake` for denext: tagged screen-awake holds over `denext/mobile`'s keep-awake
 * (`@capacitor-community/keep-awake` in the Capacitor shell, the Screen Wake Lock API on
 * the web). The screen may sleep again once every tag is released.
 *
 * @example
 * ```ts
 * import { activateKeepAwakeAsync, deactivateKeepAwake } from "denext/expo/keep-awake";
 *
 * await activateKeepAwakeAsync("recording");
 * // …
 * await deactivateKeepAwake("recording");
 * ```
 *
 * @module
 */

import { useEffect, useId } from "../runtime/hooks.ts";
import { holdAwake } from "../mobile/keep-awake.ts";
import { type Subscription, subscription } from "./internal/common.ts";

export type { Subscription };

/** The tag used when a call names none. */
export const ExpoKeepAwakeTag = "ExpoKeepAwakeDefaultTag";

/** A keep-awake state change. */
export enum KeepAwakeEventState {
  /** The platform released the lock. */
  RELEASE = "release",
}

/** What a keep-awake listener receives. */
export interface KeepAwakeEvent {
  /** The new state. */
  state: KeepAwakeEventState;
}

/** A keep-awake listener. */
export type KeepAwakeListener = (event: KeepAwakeEvent) => void;

/** Options for {@linkcode useKeepAwake}. */
export interface KeepAwakeOptions {
  /** Do not warn when deactivation fails (there is no warning here). */
  suppressDeactivateWarnings?: boolean;
  /** Called when the platform releases the lock (never, here). */
  listener?: KeepAwakeListener;
}

/** The release function of each active tag. */
let holdMap: Map<string, () => void> | undefined;

/** The active holds, created on first use (nothing runs at import time). */
function holds(): Map<string, () => void> {
  return holdMap ??= new Map();
}

/**
 * Whether keeping the screen on is possible: in the native shell, or where the browser has
 * the Screen Wake Lock API.
 *
 * @returns `true` when it can work.
 */
export function isAvailableAsync(): Promise<boolean> {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  const wakeLock = (globalThis as { navigator?: { wakeLock?: unknown } }).navigator?.wakeLock;
  return Promise.resolve(cap?.isNativePlatform?.() === true || wakeLock !== undefined);
}

/**
 * Keep the screen on until {@linkcode deactivateKeepAwake} with the same `tag`.
 *
 * @param tag The hold's name (default {@linkcode ExpoKeepAwakeTag}).
 * @returns A promise that settles once requested.
 */
export function activateKeepAwakeAsync(tag: string = ExpoKeepAwakeTag): Promise<void> {
  if (!holds().has(tag)) holds().set(tag, holdAwake());
  return Promise.resolve();
}

/**
 * Keep the screen on until {@linkcode deactivateKeepAwake} with the same `tag`.
 *
 * @param tag The hold's name (default {@linkcode ExpoKeepAwakeTag}).
 * @returns A promise that settles once requested.
 * @deprecated Use {@linkcode activateKeepAwakeAsync}.
 */
export function activateKeepAwake(tag: string = ExpoKeepAwakeTag): Promise<void> {
  return activateKeepAwakeAsync(tag);
}

/**
 * Release the hold named `tag`.
 *
 * @param tag The hold's name (default {@linkcode ExpoKeepAwakeTag}).
 * @returns A promise that settles once released.
 */
export function deactivateKeepAwake(tag: string = ExpoKeepAwakeTag): Promise<void> {
  holds().get(tag)?.();
  holds().delete(tag);
  return Promise.resolve();
}

/**
 * Keep the screen on while the component is mounted.
 *
 * @param tag The hold's name (default: one unique to the component).
 * @param _options Accepted for compatibility.
 */
export function useKeepAwake(tag?: string, _options?: KeepAwakeOptions): void {
  const id = useId();
  const name = tag ?? `${ExpoKeepAwakeTag}:${id}`;
  useEffect(() => {
    activateKeepAwakeAsync(name);
    return () => void deactivateKeepAwake(name);
  }, [name]);
}

/**
 * Listen for the platform releasing the lock. denext re-acquires the web wake lock itself
 * when the page becomes visible again, so there is no release to report: the listener is
 * never called.
 *
 * @param _tagOrListener A tag, or the listener.
 * @param _listener The listener, when a tag comes first.
 * @returns A subscription to remove.
 */
export function addListener(
  _tagOrListener: string | KeepAwakeListener,
  _listener?: KeepAwakeListener,
): Subscription {
  return subscription(() => {});
}
