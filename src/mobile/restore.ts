/**
 * Surviving Android process death for `denext/mobile`.
 *
 * Android may kill a backgrounded app to free memory, including while the camera, the photo
 * picker or the document picker (separate activities) is in front of it. When the user comes
 * back, Android relaunches the app, the web page starts from scratch, and the `pickImage()`
 * promise that was waiting is gone. Capacitor keeps the picker's result and hands it over on
 * the next launch as `@capacitor/app`'s `appRestoredResult` event:
 * {@linkcode onRestoredResult} delivers it to a handler the app registers at startup.
 *
 * {@linkcode restoreRouteOnRelaunch} is the other half: it remembers the route the app was on
 * when it went to the background and, when the app cold-starts on its start page soon after,
 * navigates back there. iOS kills backgrounded apps too, so it works on both.
 *
 * @module
 */

import { useEffect, useRef } from "../runtime/hooks.ts";
import { type NativePlatform, nativePlatform } from "./bridge.ts";
import {
  type PickedDocument,
  pickedDocumentFrom,
  type PickedImage,
  pickedImageFrom,
} from "./pickers.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";

/** `@capacitor/app`'s `RestoredListenerEvent`. */
interface RawRestored {
  pluginId?: string;
  methodName?: string;
  data?: unknown;
  success?: boolean;
  error?: { message?: string };
}

/** The slice of `@capacitor/app` used here. */
interface AppPlugin {
  addListener(
    event: "appRestoredResult",
    fn: (event: RawRestored) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/**
 * A plugin call that finished while the app was dead, as {@linkcode onRestoredResult}
 * delivers it:
 *
 * - `image`: `pickImage()`'s camera or photo-library result (`Camera.getPhoto`).
 * - `documents`: `pickDocument()`'s result (`FilePicker.pickFiles`, every picked file).
 * - `cancelled`: the user backed out of the picker.
 * - `error`: the call failed; `message` says why.
 * - `other`: any other plugin's restored call, with its raw `data`.
 */
export type RestoredResult =
  | { readonly kind: "image"; readonly image: PickedImage }
  | { readonly kind: "documents"; readonly documents: readonly PickedDocument[] }
  | { readonly kind: "cancelled"; readonly pluginId: string; readonly methodName: string }
  | {
    readonly kind: "error";
    readonly pluginId: string;
    readonly methodName: string;
    readonly message: string;
  }
  | {
    readonly kind: "other";
    readonly pluginId: string;
    readonly methodName: string;
    readonly data: unknown;
  };

/** Whether a failed call's message is a user dismissal (the plugins' cancel wording). */
function isCancelMessage(message: string): boolean {
  return /cancel/i.test(message);
}

/** A picked file list from `FilePicker.pickFiles`, normalized. */
function documentsOf(data: unknown): PickedDocument[] {
  const files = (data as { files?: unknown } | undefined)?.files;
  if (!Array.isArray(files)) return [];
  return files.filter((f) => typeof f === "object" && f !== null).map(pickedDocumentFrom);
}

/** The Android restored-call event, classified. */
function toRestoredResult(raw: RawRestored): RestoredResult {
  const pluginId = String(raw.pluginId ?? "");
  const methodName = String(raw.methodName ?? "");
  if (raw.success === false) {
    const message = String(raw.error?.message ?? "the call failed");
    return isCancelMessage(message)
      ? { kind: "cancelled", pluginId, methodName }
      : { kind: "error", pluginId, methodName, message };
  }
  if (pluginId === "Camera" && methodName === "getPhoto" && raw.data) {
    return {
      kind: "image",
      image: pickedImageFrom(raw.data as Parameters<typeof pickedImageFrom>[0]),
    };
  }
  if (pluginId === "FilePicker") {
    const documents = documentsOf(raw.data);
    if (documents.length > 0) return { kind: "documents", documents };
  }
  return { kind: "other", pluginId, methodName, data: raw.data };
}

/**
 * Receive the result of a picker or camera call that finished after Android killed the app
 * (see the module docs). Register it at startup, before the first render settles: Capacitor
 * holds the result until a listener takes it, and a listener added later still gets it.
 *
 * It needs `@capacitor/app` (`denext mobile add restore` installs it; so do `deep-links` and
 * `back`). On iOS, whose pickers run inside the app's own process, and on the web, nothing is
 * ever delivered.
 *
 * @param handler Called with each restored result.
 * @returns A function that stops listening.
 * @example
 * ```ts
 * // app/providers.tsx ("use client"), or the SPA entry
 * import { onRestoredResult } from "denext/mobile";
 *
 * onRestoredResult((result) => {
 *   if (result.kind === "image") avatarDraft.set(result.image.webPath);
 *   if (result.kind === "documents") uploads.queue(result.documents);
 * });
 * ```
 */
export function onRestoredResult(handler: (result: RestoredResult) => void): () => void {
  const plugin = nativePlugin<AppPlugin>("App", ["addListener"]);
  if (!plugin) return () => {};
  return listenerDisposer(
    plugin.addListener("appRestoredResult", (raw) => handler(toRestoredResult(raw ?? {}))),
  );
}

/**
 * Hook form of {@linkcode onRestoredResult}: listens while mounted, always calling the latest
 * `handler`. Mount it high (the root layout's client provider) so it is listening when the
 * relaunched app starts.
 *
 * @param handler Called with each restored result.
 * @example
 * ```tsx
 * "use client";
 * import { useRestoredResult } from "denext/mobile";
 *
 * export function Providers({ children }: { children: unknown }) {
 *   useRestoredResult((r) => r.kind === "image" && draft.setPhoto(r.image));
 *   return children;
 * }
 * ```
 */
export function useRestoredResult(handler: (result: RestoredResult) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => onRestoredResult((result) => ref.current(result)), []);
}

// ---- Last route ------------------------------------------------------------------------------

/** Options for {@linkcode restoreRouteOnRelaunch}. */
export interface RestoreRouteOptions {
  /**
   * How old a saved route may be and still be restored, in ms. Default 30 minutes: a relaunch
   * much later is a fresh start, not a return.
   */
  readonly maxAgeMs?: number;
  /**
   * The paths a cold start lands on (the app's start page). A relaunch that lands elsewhere
   * (a deep link, a notification tap) is left alone. Default `["/", "/index.html"]`.
   */
  readonly startPaths?: readonly string[];
  /**
   * How to go to the saved route. Default: `history.replaceState` to it, then a `popstate`
   * event, which denext's router (and react-router, TanStack Router, expo-router's web
   * history) follow like a back/forward navigation.
   */
  readonly navigate?: (path: string) => void;
  /** Where it runs. Default `["android", "ios"]` (the web never loses its tab this way). */
  readonly platforms?: readonly NativePlatform[];
  /** The storage key. Default `"denext:last-route"`. */
  readonly key?: string;
}

/** The saved route. */
interface SavedRoute {
  readonly path: string;
  readonly at: number;
}

/** The slice of `@capacitor/preferences` used here. */
interface PreferencesPlugin {
  get(options: { key: string }): Promise<{ value?: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
}

/** Durable storage: the Preferences plugin natively when installed, else `localStorage`. */
interface RouteStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): void;
}

/** `localStorage`, when it can be reached (a private window or a sandbox may throw). */
function local(): Storage | undefined {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** The store {@linkcode restoreRouteOnRelaunch} uses. */
function routeStore(): RouteStore {
  const prefs = nativePlugin<PreferencesPlugin>("Preferences", ["get", "set"]);
  if (prefs) {
    return {
      read: async (key) => (await prefs.get({ key }))?.value ?? null,
      write: (key, value) => void prefs.set({ key, value }).catch(() => {}),
    };
  }
  return {
    read: (key) => {
      try {
        return Promise.resolve(local()?.getItem(key) ?? null);
      } catch {
        return Promise.resolve(null);
      }
    },
    write: (key, value) => {
      try {
        local()?.setItem(key, value);
      } catch {
        // Storage full or blocked: the route is simply not remembered.
      }
    },
  };
}

/** A same-origin path worth restoring: `/…`, never `//host` or a scheme. */
function isAppPath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") &&
    !path.includes("\\") && path.length <= 2048;
}

/** A stored value, parsed and checked. */
function parseSaved(value: string | null): SavedRoute | null {
  if (value === null) return null;
  try {
    const saved = JSON.parse(value) as Partial<SavedRoute>;
    return isAppPath(saved.path) && typeof saved.at === "number" ? saved as SavedRoute : null;
  } catch {
    return null;
  }
}

/** The page's current path, search and hash. */
function currentPath(): string {
  const loc = (globalThis as { location?: Location }).location;
  return loc ? `${loc.pathname}${loc.search}${loc.hash}` : "/";
}

/** The default navigation: replace the entry, then tell the router it changed. */
function replaceAndNotify(path: string): void {
  history.replaceState(history.state, "", path);
  const PopState = (globalThis as { PopStateEvent?: typeof PopStateEvent }).PopStateEvent;
  globalThis.dispatchEvent(
    typeof PopState === "function"
      ? new PopState("popstate", { state: history.state })
      : new Event("popstate"),
  );
}

/** Whether this page load already set up the saving listeners. */
let saving = false;

/** Save the current route each time the app goes to the background. */
function saveOnHide(store: RouteStore, key: string): void {
  if (saving || typeof document === "undefined") return;
  saving = true;
  const save = () => {
    const path = currentPath();
    if (isAppPath(path)) store.write(key, JSON.stringify({ path, at: Date.now() }));
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save();
  });
  // Capacitor's iOS shell fires `pause` on the document when the scene backgrounds.
  document.addEventListener("pause", save);
  globalThis.addEventListener?.("pagehide", save);
}

/**
 * Opt in to returning to the last route after the OS killed the app in the background.
 *
 * It saves the current path (with its search and hash) each time the app goes to the
 * background, in `@capacitor/preferences` when the app has it (`npm i @capacitor/preferences`),
 * else `localStorage`. When the app then cold-starts on one of `startPaths` within `maxAgeMs`,
 * it navigates to the saved path. Only the route comes back: component state, scroll positions
 * and the back stack do not (persist what matters yourself, for example a draft in
 * `secureStore` or `localStorage`).
 *
 * Call it once, early (the client entry or the root layout's provider effect). A second call
 * in the same page load only restores; the saving listeners are installed once.
 *
 * @param options The age limit, the start paths, the navigation, the platforms and the key.
 * @returns The path it navigated to, or `null` when there was nothing to restore.
 * @example
 * ```tsx
 * "use client";
 * import { useEffect, useRouter } from "denext";
 * import { restoreRouteOnRelaunch } from "denext/mobile";
 *
 * export function Providers({ children }: { children: unknown }) {
 *   const router = useRouter();
 *   useEffect(() => void restoreRouteOnRelaunch({ navigate: (p) => router.replace(p) }), []);
 *   return children;
 * }
 * ```
 */
export async function restoreRouteOnRelaunch(
  options: RestoreRouteOptions = {},
): Promise<string | null> {
  const platforms = options.platforms ?? ["android", "ios"];
  if (!platforms.includes(nativePlatform()) || typeof document === "undefined") return null;
  const key = options.key ?? "denext:last-route";
  const store = routeStore();
  saveOnHide(store, key);
  const saved = parseSaved(await store.read(key).catch(() => null));
  if (!saved) return null;
  const age = Date.now() - saved.at;
  const here = currentPath();
  const startPaths = options.startPaths ?? ["/", "/index.html"];
  const onStart = startPaths.includes(
    (globalThis as { location?: Location }).location?.pathname ?? "/",
  );
  if (age < 0 || age > (options.maxAgeMs ?? 30 * 60_000) || !onStart || saved.path === here) {
    return null;
  }
  (options.navigate ?? replaceAndNotify)(saved.path);
  return saved.path;
}

/** Test hook: forget that the saving listeners were installed. */
export function resetRestoreRouteForTesting(): void {
  saving = false;
}
