/**
 * Screen orientation for `denext/mobile`: read it, follow it, lock and unlock it. The native
 * `ScreenOrientation` plugin in the shell (`@capacitor/screen-orientation`, installed by
 * `denext mobile add screen-orientation`), else the web's Screen Orientation API
 * (`screen.orientation`), else the `(orientation: portrait)` media query.
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";

/** The screen's orientation: portrait or landscape, and which way up. */
export type Orientation =
  | "portrait-primary"
  | "portrait-secondary"
  | "landscape-primary"
  | "landscape-secondary";

/**
 * What {@linkcode lockOrientation} locks to: a family (`portrait`, `landscape`), one exact
 * orientation, the device's `natural` one, or `any` (every orientation the app allows).
 */
export type OrientationLock =
  | "any"
  | "natural"
  | "portrait"
  | "landscape"
  | Orientation;

/** The JS side of `@capacitor/screen-orientation`. */
interface ScreenOrientationPlugin {
  orientation(): Promise<{ type?: string }>;
  lock(options: { orientation: OrientationLock }): Promise<void>;
  unlock(): Promise<void>;
  addListener(
    event: "screenOrientationChange",
    fn: (result: { type?: string }) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** The slice of the web's `ScreenOrientation` object used here. */
interface WebScreenOrientation extends EventTarget {
  readonly type?: string;
  lock?(orientation: string): Promise<void>;
  unlock?(): void;
}

/** Every lock value {@linkcode lockOrientation} accepts. */
const LOCKS: readonly string[] = [
  "any",
  "natural",
  "portrait",
  "landscape",
  "portrait-primary",
  "portrait-secondary",
  "landscape-primary",
  "landscape-secondary",
];

/** The native plugin, when the shell has it. */
function orientationPlugin(): ScreenOrientationPlugin | undefined {
  return nativePlugin<ScreenOrientationPlugin>("ScreenOrientation", [
    "orientation",
    "lock",
    "unlock",
  ]);
}

/** `screen.orientation`, when the browser has it. */
function webOrientation(): WebScreenOrientation | undefined {
  const screen = (globalThis as { screen?: { orientation?: WebScreenOrientation } }).screen;
  const o = screen?.orientation;
  return typeof o === "object" && o !== null ? o : undefined;
}

/** Whether the viewport is portrait by the media query (`true` without `matchMedia`). */
function portraitByMedia(): boolean {
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  return typeof mm === "function" ? mm("(orientation: portrait)").matches : true;
}

/** A reported orientation type, checked; anything else is read from the media query. */
function normalize(type: unknown): Orientation {
  if (
    type === "portrait-primary" || type === "portrait-secondary" ||
    type === "landscape-primary" || type === "landscape-secondary"
  ) return type;
  return portraitByMedia() ? "portrait-primary" : "landscape-primary";
}

/**
 * The screen's orientation right now, synchronously from the web API or media query (the
 * native plugin answers asynchronously: see {@linkcode getOrientation}). SSR: `portrait-primary`.
 */
function currentWebOrientation(): Orientation {
  return normalize(webOrientation()?.type);
}

/**
 * Read the screen's orientation.
 *
 * @returns It, from the native plugin in the shell, else `screen.orientation.type`, else the
 * `(orientation: portrait)` media query (as `-primary`). SSR: `"portrait-primary"`.
 * @example
 * ```ts
 * import { getOrientation } from "denext/mobile";
 * const landscape = (await getOrientation()).startsWith("landscape");
 * ```
 */
export async function getOrientation(): Promise<Orientation> {
  const plugin = orientationPlugin();
  if (plugin) return normalize((await plugin.orientation())?.type);
  return currentWebOrientation();
}

/**
 * Lock the screen to an orientation (a video player going landscape, a scanner staying
 * portrait). Undo it with {@linkcode unlockOrientation}.
 *
 * - Inside the native shell with `@capacitor/screen-orientation`, the app's own lock. On iPad
 *   it holds only with `UIRequiresFullScreen` (multitasking apps cannot lock); on Android 16+
 *   large screens ignore it for apps targeting SDK 36.
 * - On the web, `screen.orientation.lock()`, which most browsers allow only in fullscreen and
 *   installed web apps; there the promise rejects (Safari has no lock at all).
 *
 * @param orientation What to lock to.
 * @returns A promise that settles once locked. It rejects with a `TypeError` for an unknown
 * value, and when the platform refuses or cannot lock.
 * @example
 * ```ts
 * import { lockOrientation, unlockOrientation } from "denext/mobile";
 * await lockOrientation("landscape");
 * // …on leaving the player:
 * await unlockOrientation();
 * ```
 */
export async function lockOrientation(orientation: OrientationLock): Promise<void> {
  if (!LOCKS.includes(orientation)) {
    throw new TypeError(`lockOrientation: unknown orientation "${orientation}"`);
  }
  const plugin = orientationPlugin();
  if (plugin) return await plugin.lock({ orientation });
  const web = webOrientation();
  if (typeof web?.lock !== "function") {
    throw new Error("lockOrientation: this browser cannot lock the screen orientation");
  }
  await web.lock(orientation);
}

/**
 * Release a {@linkcode lockOrientation} lock (a no-op when nothing is locked, or on a browser
 * without the API).
 *
 * @returns A promise that settles once unlocked.
 * @example
 * ```ts
 * import { unlockOrientation } from "denext/mobile";
 * await unlockOrientation();
 * ```
 */
export async function unlockOrientation(): Promise<void> {
  const plugin = orientationPlugin();
  if (plugin) return await plugin.unlock();
  const web = webOrientation();
  if (typeof web?.unlock === "function") web.unlock();
}

/** Follow the media query's portrait/landscape flips (a browser without `screen.orientation`). */
function onMediaOrientation(cb: (o: Orientation) => void): () => void {
  const mm = (globalThis as {
    matchMedia?: (q: string) => {
      matches: boolean;
      addEventListener?: (t: string, fn: () => void) => void;
      removeEventListener?: (t: string, fn: () => void) => void;
    };
  }).matchMedia;
  if (typeof mm !== "function") return () => {};
  const query = mm("(orientation: portrait)");
  const fn = () => cb(query.matches ? "portrait-primary" : "landscape-primary");
  query.addEventListener?.("change", fn);
  return () => query.removeEventListener?.("change", fn);
}

/**
 * Call `cb` with the new orientation each time the screen rotates.
 *
 * @param cb Called with the orientation after each change.
 * @returns A function that stops listening. SSR: a no-op.
 * @example
 * ```ts
 * import { onOrientationChange } from "denext/mobile";
 * const stop = onOrientationChange((o) => player.setLayout(o.startsWith("landscape")));
 * ```
 */
export function onOrientationChange(cb: (orientation: Orientation) => void): () => void {
  const plugin = nativePlugin<ScreenOrientationPlugin>("ScreenOrientation", ["addListener"]);
  if (plugin) {
    return listenerDisposer(
      plugin.addListener("screenOrientationChange", (r) => cb(normalize(r?.type))),
    );
  }
  const web = webOrientation();
  if (web && typeof web.addEventListener === "function") {
    const fn = () => cb(currentWebOrientation());
    web.addEventListener("change", fn);
    return () => web.removeEventListener("change", fn);
  }
  return onMediaOrientation(cb);
}

/**
 * The screen's orientation, live: re-renders on every rotation. The first render reads the web
 * API (or `portrait-primary` during SSR); in the native shell the plugin's answer follows.
 *
 * @returns The current orientation.
 * @example
 * ```tsx
 * "use client";
 * import { useOrientation } from "denext/mobile";
 *
 * export function Gallery() {
 *   const orientation = useOrientation();
 *   return <Grid columns={orientation.startsWith("landscape") ? 4 : 2} />;
 * }
 * ```
 */
export function useOrientation(): Orientation {
  const [orientation, setOrientation] = useState<Orientation>(() =>
    typeof document === "undefined" ? "portrait-primary" : currentWebOrientation()
  );
  useEffect(() => {
    let live = true;
    getOrientation().then((o) => live && setOrientation(o), () => {});
    const stop = onOrientationChange(setOrientation);
    return () => {
      live = false;
      stop();
    };
  }, []);
  return orientation;
}
