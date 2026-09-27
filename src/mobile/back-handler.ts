/**
 * The system back action for `denext/mobile`: Android's back button and back gesture (with
 * predictive-back progress), and the browser's back button on the web, as a LIFO stack of
 * handlers like React Native's `BackHandler`.
 *
 * - Android shell with denext's `DenextBack` plugin (`denext mobile add back`): an
 *   `OnBackPressedCallback` that is enabled only while a handler is registered, forwarding the
 *   predictive-back gesture's start / progress / cancel and the commit.
 * - Android shell with only `@capacitor/app`: its `backButton` event (no progress).
 * - iOS shell: nothing (there is no back button; swipe-back is the navigation's job).
 * - Web: a same-URL history entry pushed while a handler is registered, so the browser's back
 *   button pops it and the handlers run instead of the page leaving.
 *
 * @module
 */

import { useEffect, useRef, useState } from "../runtime/hooks.ts";
import { nativePlatform } from "./bridge.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";

/**
 * A back handler: return `true` to consume the back action (nothing below it runs, the app
 * stays where it is); anything else passes it to the handler registered before it, and after
 * the last one to the default (history back, else leave the app).
 */
export type BackHandler = () => boolean | void;

/** Which screen edge a back gesture started from (`"none"`: a button, or unknown). */
export type BackEdge = "left" | "right" | "none";

/** A back gesture in flight, as {@linkcode useBackProgress} reports it. */
export interface BackGesture {
  /** How far the gesture has gone, from 0 to 1. */
  readonly progress: number;
  /** The edge it started from. */
  readonly edge: BackEdge;
}

/**
 * One predictive-back event: the gesture `start`s and makes `progress`, then is `cancel`led
 * (the user let go short of the threshold) or `commit`ted (the back action runs next).
 */
export type BackProgressEvent =
  | { readonly type: "start" | "progress"; readonly progress: number; readonly edge: BackEdge }
  | { readonly type: "cancel" | "commit" };

/** A predictive-back event's payload from the `DenextBack` plugin. */
interface NativeBackEvent {
  progress?: number;
  swipeEdge?: string;
}

/** The JS side of denext's `DenextBack` Android plugin (its native template). */
interface DenextBackPlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>;
  addListener(
    eventName: "backStarted" | "backProgressed" | "backCancelled" | "backInvoked",
    listener: (event?: NativeBackEvent & { canGoBack?: boolean }) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** The slice of `@capacitor/app` the back handling uses. */
interface AppPlugin {
  addListener(
    eventName: "backButton",
    listener: (event?: { canGoBack?: boolean }) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
  exitApp(): Promise<void>;
  minimizeApp?(): Promise<void>;
}

/** The registered handlers and progress listeners, and the driver while one is needed. */
interface BackRegistry {
  /** Handlers in registration order (wrapped, so one function can be registered twice). */
  readonly handlers: Array<{ readonly fn: BackHandler }>;
  readonly listeners: Set<(event: BackProgressEvent) => void>;
  /** Stops the platform driver; set while it runs. */
  stop?: () => void;
  /** A pending stop, deferred a tick so an unregister + register pair keeps the driver. */
  stopTimer?: ReturnType<typeof setTimeout>;
}

/** Created on first use; nothing runs at import. */
let registry: BackRegistry | undefined;

/** The history-state key of the web driver's sentinel entry. */
const SENTINEL_KEY = "__denextBack";

/** The shell's `@capacitor/app`, when installed. */
function appPlugin(): AppPlugin | undefined {
  return nativePlugin<AppPlugin>("App", ["addListener", "exitApp"]);
}

/** Run the handlers newest first; whether one consumed the back action. */
function runHandlers(reg: BackRegistry): boolean {
  for (const entry of [...reg.handlers].reverse()) {
    if (entry.fn() === true) return true;
  }
  return false;
}

/** The unconsumed back action in the Android shell: history back, else leave the app. */
function defaultBack(canGoBack: boolean): void {
  if (canGoBack) {
    globalThis.history?.back();
    return;
  }
  const app = appPlugin();
  if (!app) return;
  const leave = typeof app.minimizeApp === "function" ? app.minimizeApp() : app.exitApp();
  Promise.resolve(leave).catch(() => {});
}

/** Tell every progress listener about `event`. */
function emitProgress(reg: BackRegistry, event: BackProgressEvent): void {
  for (const listener of [...reg.listeners]) listener(event);
}

/** A native swipe edge as a {@linkcode BackEdge}. */
function edgeOf(edge: string | undefined): BackEdge {
  return edge === "left" || edge === "right" ? edge : "none";
}

/** A progress value clamped to 0…1 (0 when missing). */
function unit(progress: number | undefined): number {
  return typeof progress === "number" && Number.isFinite(progress)
    ? Math.min(1, Math.max(0, progress))
    : 0;
}

/** Drive the stack from the `DenextBack` plugin: its callback is enabled while this runs. */
function denextBackDriver(plugin: DenextBackPlugin, reg: BackRegistry): () => void {
  const gesture = (type: "start" | "progress") => (event?: NativeBackEvent) =>
    emitProgress(reg, { type, progress: unit(event?.progress), edge: edgeOf(event?.swipeEdge) });
  const stops = [
    listenerDisposer(plugin.addListener("backStarted", gesture("start"))),
    listenerDisposer(plugin.addListener("backProgressed", gesture("progress"))),
    listenerDisposer(
      plugin.addListener("backCancelled", () => emitProgress(reg, { type: "cancel" })),
    ),
    listenerDisposer(plugin.addListener("backInvoked", (event) => {
      emitProgress(reg, { type: "commit" });
      if (!runHandlers(reg)) defaultBack(event?.canGoBack === true);
    })),
  ];
  plugin.setEnabled({ enabled: true }).catch(() => {});
  return () => {
    plugin.setEnabled({ enabled: false }).catch(() => {});
    for (const stop of stops) stop();
  };
}

/** Drive the stack from `@capacitor/app`'s `backButton` (which it fires once listened to). */
function appBackDriver(app: AppPlugin, reg: BackRegistry): () => void {
  return listenerDisposer(app.addListener("backButton", (event) => {
    if (!runHandlers(reg)) defaultBack(event?.canGoBack === true);
  }));
}

/** Whether `state` is the web driver's sentinel entry for `token`. */
function isSentinel(state: unknown, token: string): boolean {
  return typeof state === "object" && state !== null &&
    (state as Record<string, unknown>)[SENTINEL_KEY] === token;
}

/** The sentinel's history state: the current entry's own (when an object) plus the token. */
function sentinelState(state: unknown, token: string): Record<string, unknown> {
  const own = typeof state === "object" && state !== null ? state : {};
  return { ...own, [SENTINEL_KEY]: token };
}

/** The page's history, location and event target, or undefined outside a browser. */
function browserHistory():
  | { history: History; location: Location; win: EventTarget & { navigation?: EventTarget } }
  | undefined {
  const win = globalThis as unknown as {
    history?: History;
    location?: Location;
    navigation?: EventTarget;
    addEventListener?: unknown;
  };
  if (!win.history || !win.location || typeof win.addEventListener !== "function") return undefined;
  return {
    history: win.history,
    location: win.location,
    win: win as EventTarget & { navigation?: EventTarget },
  };
}

/**
 * Drive the stack from the browser's back button: push a same-URL sentinel entry, and when a
 * `popstate` pops it, run the handlers. The listener is a capturing one, which the DOM runs
 * before the non-capturing listeners at the target (the router's), so it can stop the event
 * before the router sees it even though the router registered first. A consumed back
 * re-pushes the sentinel; an unconsumed one goes back once more for real, which the router
 * handles, and the sentinel is re-pushed on arrival (and after each soft navigation where the
 * browser has the Navigation API). Stopping pops the sentinel when it is still the current
 * entry.
 */
function webDriver(reg: BackRegistry): () => void {
  const env = browserHistory();
  if (!env) return () => {};
  const { history, location, win } = env;
  const token = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
  const flags = { passNext: false, closing: false, href: "" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onSentinel = () => isSentinel(history.state, token);
  const arm = () => {
    if (flags.closing || onSentinel()) return;
    flags.href = location.href;
    history.pushState(sentinelState(history.state, token), "", location.href);
  };
  const detach = () => {
    win.removeEventListener("popstate", onPop, true);
    win.navigation?.removeEventListener("navigatesuccess", onNavigated);
    if (timer !== undefined) clearTimeout(timer);
  };
  const onNavigated = () => void setTimeout(arm, 0);
  function onPop(event: Event): void {
    if (flags.closing) {
      // The pop that removed the sentinel on stop: the router must not see it.
      event.stopImmediatePropagation();
      detach();
    } else if (flags.passNext) {
      // The real back after an unconsumed one: the router handles it; re-arm on arrival.
      flags.passNext = false;
      onNavigated();
    } else if (!onSentinel() && location.href === flags.href) {
      // Back popped the sentinel: the handlers decide.
      event.stopImmediatePropagation();
      if (runHandlers(reg)) arm();
      else {
        flags.passNext = true;
        history.back();
      }
    }
  }
  win.addEventListener("popstate", onPop, true);
  win.navigation?.addEventListener("navigatesuccess", onNavigated);
  arm();
  return () => {
    if (!onSentinel()) return detach();
    flags.closing = true;
    history.back();
    timer = setTimeout(detach, 1000);
  };
}

/** The driver for this platform; returns its stop function. */
function startDriver(reg: BackRegistry): () => void {
  const platform = nativePlatform();
  if (platform === "ios") return () => {};
  if (platform === "web") return webDriver(reg);
  const back = nativePlugin<DenextBackPlugin>("DenextBack", ["setEnabled", "addListener"]);
  if (back) return denextBackDriver(back, reg);
  const app = appPlugin();
  return app ? appBackDriver(app, reg) : () => {};
}

/**
 * Whether the registry needs its driver: any handler, or (on Android, the only platform that
 * reports progress) a progress listener, whose gesture needs the native callback enabled.
 */
function needsDriver(reg: BackRegistry): boolean {
  return reg.handlers.length > 0 || (reg.listeners.size > 0 && nativePlatform() === "android");
}

/** Start the driver when it is needed and not running (cancelling a pending stop). */
function retain(reg: BackRegistry): void {
  if (reg.stopTimer !== undefined) {
    clearTimeout(reg.stopTimer);
    reg.stopTimer = undefined;
  }
  if (reg.stop === undefined && needsDriver(reg)) reg.stop = startDriver(reg);
}

/** Stop the driver a tick after it stops being needed. */
function release(reg: BackRegistry): void {
  if (reg.stop === undefined || needsDriver(reg) || reg.stopTimer !== undefined) return;
  reg.stopTimer = setTimeout(() => {
    reg.stopTimer = undefined;
    if (needsDriver(reg)) return;
    const stop = reg.stop;
    reg.stop = undefined;
    stop?.();
  }, 0);
}

/** The registry, created on first use. */
function backRegistry(): BackRegistry {
  return registry ??= { handlers: [], listeners: new Set() };
}

/** Test hook: stop the driver and forget every handler and listener. */
export function resetBackForTesting(): void {
  const reg = registry;
  registry = undefined;
  if (reg?.stopTimer !== undefined) clearTimeout(reg.stopTimer);
  reg?.stop?.();
}

/**
 * Register `handler` for the system back action, on top of the handlers already registered
 * (a LIFO stack, like React Native's `BackHandler`). On a back action the newest handler runs
 * first; returning `true` consumes it. When no handler consumes it, the default runs: history
 * back when there is somewhere to go back to, else the app leaves the foreground
 * (`@capacitor/app`'s `minimizeApp`, `exitApp` where that is missing).
 *
 * Where it applies:
 * - **Android shell**: the back button and back gesture. With `denext mobile add back` (the
 *   `DenextBack` plugin) the native callback is enabled only while a handler is registered, so
 *   without one the system's own predictive back-to-home animation plays. With only
 *   `@capacitor/app` it listens to its `backButton` event.
 * - **iOS shell**: nothing; there is no back button.
 * - **Web**: the browser's back button. While a handler is registered, a same-URL history
 *   entry sits on top of the page's, so back pops it and the handlers run. An unconsumed back
 *   then goes back for real. After a soft navigation the entry is re-added where the browser
 *   has the Navigation API; elsewhere register handlers on the page that uses them.
 *
 * SSR-safe: without a `window` it registers nothing.
 *
 * @param handler Returns `true` to consume the back action.
 * @returns A function that unregisters it (idempotent).
 * @example
 * ```ts
 * import { onBack } from "denext/mobile";
 *
 * const off = onBack(() => {
 *   if (!sheet.open) return false;
 *   sheet.close(); // back closes the sheet instead of leaving the page
 *   return true;
 * });
 * ```
 */
export function onBack(handler: BackHandler): () => void {
  if (typeof document === "undefined") return () => {};
  const reg = backRegistry();
  const entry = { fn: handler };
  reg.handlers.push(entry);
  retain(reg);
  return () => {
    const at = reg.handlers.indexOf(entry);
    if (at < 0) return;
    reg.handlers.splice(at, 1);
    release(reg);
  };
}

/**
 * Hook form of {@linkcode onBack}: `handler` is registered while the component is mounted and
 * `enabled` is true, and it always sees the latest props (re-renders do not re-register it, so
 * its place in the stack stays put). A component mounted later sits above it.
 *
 * @param handler Returns `true` to consume the back action.
 * @param enabled Whether to register it (default `true`).
 * @example
 * ```tsx
 * "use client";
 * import { useBackHandler } from "denext/mobile";
 *
 * export function Sheet({ open, onClose }: { open: boolean; onClose: () => void }) {
 *   useBackHandler(() => (onClose(), true), open);
 *   return open ? <div role="dialog">…</div> : null;
 * }
 * ```
 */
export function useBackHandler(handler: BackHandler, enabled = true): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => (enabled ? onBack(() => latest.current()) : undefined), [enabled]);
}

/**
 * Call `cb` with each predictive-back event: the back gesture's `start`, its `progress` (0…1,
 * with the edge it started from), then `cancel` or `commit`. Only the Android shell with
 * `denext mobile add back` reports them (Android 14+ animates the gesture; earlier versions
 * report only the `commit`). Elsewhere `cb` never runs.
 *
 * On Android a listener enables the native back callback like a handler does, so the system's
 * back-to-home animation gives way to yours; a committed back with no handler consuming it
 * still runs the default (history back, else leave the app).
 *
 * @param cb Called with each {@linkcode BackProgressEvent}.
 * @returns A function that unsubscribes (idempotent).
 * @example
 * ```ts
 * import { onBackProgress } from "denext/mobile";
 *
 * const off = onBackProgress((e) => {
 *   page.style.transform = e.type === "progress" ? `translateX(${e.progress * 40}px)` : "";
 * });
 * ```
 */
export function onBackProgress(cb: (event: BackProgressEvent) => void): () => void {
  if (typeof document === "undefined") return () => {};
  const reg = backRegistry();
  const listener = (event: BackProgressEvent) => cb(event);
  reg.listeners.add(listener);
  retain(reg);
  return () => {
    if (!reg.listeners.delete(listener)) return;
    release(reg);
  };
}

/**
 * Hook form of {@linkcode onBackProgress}: the back gesture in flight (`progress` 0…1 and the
 * `edge` it started from), or `null` when there is none, e.g. to drive a peek of the previous
 * screen. Always `null` outside the Android shell with `denext mobile add back`.
 *
 * @returns The gesture, or `null`.
 * @example
 * ```tsx
 * "use client";
 * import { useBackProgress } from "denext/mobile";
 *
 * export function Page({ children }: { children: unknown }) {
 *   const gesture = useBackProgress();
 *   const scale = gesture ? 1 - gesture.progress * 0.08 : 1;
 *   return <main style={{ transform: `scale(${scale})` }}>{children}</main>;
 * }
 * ```
 */
export function useBackProgress(): BackGesture | null {
  const [gesture, setGesture] = useState<BackGesture | null>(null);
  useEffect(
    () =>
      onBackProgress((event) =>
        setGesture(
          event.type === "start" || event.type === "progress"
            ? { progress: event.progress, edge: event.edge }
            : null,
        )
      ),
    [],
  );
  return gesture;
}
