/**
 * React Native's `AppState` for React Native mode: the page's visibility in a browser, and
 * `@capacitor/app`'s `appStateChange` / `pause` / `resume` inside the Capacitor shell (which
 * add iOS's `inactive`), plus the OS's low-memory warning in the shell. react-native-web's
 * `AppState` reads only `visibilitychange`, and its `addEventListener` returns nothing where that
 * is unavailable.
 *
 * @module
 */

import { isNativeShell, nativePlatform } from "../mobile/bridge.ts";
import { listenAll } from "../mobile/safe-area.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "../mobile/plugin.ts";
import { type EmitterSubscription, type Listeners, listeners } from "./internal.ts";

/** React Native's app states. */
export type AppStateStatus = "active" | "background" | "inactive" | "unknown" | "extension";

/**
 * The window event the Capacitor shell's bridge fires when the OS is low on memory: iOS's
 * `UIApplication.didReceiveMemoryWarningNotification`, Android's `onTrimMemory` / `onLowMemory`
 * (the bridge view controller and the MainActivity every denext native feature composes; see
 * src/build/bridge-memory-warning-native-template.ts).
 */
export const MEMORY_WARNING_EVENT = "denext:memorywarning";

/** The events `AppState.addEventListener` accepts. */
export type AppStateEvent = "change" | "memoryWarning" | "focus" | "blur";

/** React Native's `AppState` module. */
export interface AppStateStatic {
  /** The state now. */
  readonly currentState: AppStateStatus;
  /** Always `true` in a browser. */
  readonly isAvailable: boolean;
  addEventListener(
    type: AppStateEvent,
    listener: (state: AppStateStatus) => void,
  ): EmitterSubscription;
}

/** The slice of `@capacitor/app` app state uses. */
interface AppPlugin {
  addListener(
    eventName: "appStateChange" | "pause" | "resume",
    listener: (event?: { isActive?: boolean }) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** The hub: listeners, the last state, and the sources while any listener is registered. */
interface AppStateHub {
  readonly listeners: Listeners<AppStateEvent, AppStateStatus>;
  state: AppStateStatus;
  stop?: () => void;
}

let hub: AppStateHub | undefined;

/** The state the page's visibility implies. */
function visibilityState(): AppStateStatus {
  if (typeof document === "undefined") return "active";
  return document.visibilityState === "hidden" ? "background" : "active";
}

/** Move to `next`, emitting `change` when it differs. */
function moveTo(h: AppStateHub, next: AppStateStatus): void {
  if (next === h.state) return;
  h.state = next;
  h.listeners.emit("change", next);
}

/** Start the state sources; returns the stop function. */
function startSources(h: AppStateHub): () => void {
  const stops = [
    listenAll(globalThis.document, ["visibilitychange"], () => moveTo(h, visibilityState())),
    listenAll(globalThis, ["focus"], () => h.listeners.emit("focus", h.state)),
    listenAll(globalThis, ["blur"], () => h.listeners.emit("blur", h.state)),
  ];
  // Only the shell's bridge fires it; in a browser or a Deno Desktop window nothing does, and a
  // page's own event of that name is not the OS's.
  if (isNativeShell()) {
    stops.push(listenAll(globalThis, [MEMORY_WARNING_EVENT], () => {
      // React Native's memoryWarning listeners receive no argument.
      h.listeners.emit("memoryWarning", undefined as unknown as AppStateStatus);
    }));
  }
  const app = nativePlugin<AppPlugin>("App", ["addListener"]);
  if (app) {
    // iOS resigns active (the app switcher, Control Center) before it backgrounds: React
    // Native reports that as "inactive". Android has no such state.
    const idle = nativePlatform() === "ios" ? "inactive" : "background";
    stops.push(
      listenerDisposer(app.addListener("appStateChange", (event) => {
        if (event?.isActive === true) moveTo(h, "active");
        else if (event?.isActive === false && h.state === "active") moveTo(h, idle);
      })),
      listenerDisposer(app.addListener("pause", () => moveTo(h, "background"))),
      listenerDisposer(app.addListener("resume", () => moveTo(h, "active"))),
    );
  }
  return () => {
    for (const stop of stops) stop();
  };
}

/** The hub, created on first use; its sources run while any listener is registered. */
function appStateHub(): AppStateHub {
  if (hub) return hub;
  const created: AppStateHub = {
    state: visibilityState(),
    listeners: listeners((count) => {
      if (count > 0 && !created.stop) {
        created.state = visibilityState();
        created.stop = startSources(created);
      } else if (count === 0 && created.stop) {
        created.stop();
        created.stop = undefined;
      }
    }),
  };
  return hub = created;
}

/** Test hook: stop the sources and forget every listener. */
export function resetAppStateForTesting(): void {
  hub?.listeners.clear();
  hub = undefined;
}

/**
 * React Native's `AppState`:
 *
 * - `currentState`: `"background"` while the page is hidden, else `"active"`; while a listener
 *   is registered inside the Capacitor shell it also follows `@capacitor/app` (installed by
 *   `denext mobile add deep-links` or `back`): `"inactive"` when iOS resigns active (the app
 *   switcher, Control Center), `"background"` on `pause`, `"active"` on `resume`.
 * - `addEventListener("change", fn)`: each state change. `"focus"` / `"blur"`: the window's
 *   focus. `"memoryWarning"`: the OS's low-memory warning inside the Capacitor shell (iOS's
 *   `didReceiveMemoryWarningNotification`, Android's `onLowMemory` and `onTrimMemory` from
 *   `TRIM_MEMORY_RUNNING_LOW`), forwarded by the bridge every denext native feature installs
 *   (any `denext mobile add` capability with a denext plugin, or `denext mobile add
 *   export-routes`); the listener receives no argument, as in React Native. A browser and a Deno
 *   Desktop window have no such signal: it never fires there.
 *
 * @example
 * ```ts
 * import { AppState } from "react-native";
 *
 * const sub = AppState.addEventListener("change", (state) => {
 *   if (state === "active") refetch();
 * });
 * ```
 */
export const AppState: AppStateStatic = {
  get currentState() {
    const h = hub;
    return h?.stop ? h.state : visibilityState();
  },
  get isAvailable() {
    return typeof document !== "undefined";
  },
  addEventListener(type, listener) {
    return appStateHub().listeners.add(type, listener);
  },
};
