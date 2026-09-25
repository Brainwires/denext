/**
 * `expo` (the core package) for denext, and `expo/fetch`.
 *
 * - `registerRootComponent(App)` mounts the app on the page's `#root`: through
 *   react-native-web's `AppRegistry.runApplication` in React Native mode (what an Expo web
 *   entry does), else with denext's `createRoot`. An Expo app's `index.ts` therefore works
 *   as the SPA entry unchanged, with no hand-written web entry.
 * - The native-module API answers as Expo's web build does: `requireNativeModule` throws,
 *   `requireOptionalNativeModule` returns null, and `requireNativeView` returns a component
 *   that renders nothing. `EventEmitter`, `NativeModule`, `SharedObject`, `SharedRef`,
 *   `registerWebModule`, `useEvent` and `useEventListener` work for JS-implemented modules.
 * - `fetch` (from `expo/fetch`) is the platform's streaming `fetch`.
 *
 * @example
 * ```ts
 * import { registerRootComponent } from "denext/expo/expo";
 * import App from "./src/App";
 *
 * registerRootComponent(App);
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { Component } from "../jsx/types.ts";
import { createRoot } from "../client/mod.ts";
import { useEffect, useRef, useState } from "../runtime/hooks.ts";
import {
  createPermissionHook,
  type PermissionExpiration,
  type PermissionHookOptions,
  type PermissionResponse,
  PermissionStatus,
  type Subscription,
} from "./internal/common.ts";
import * as RN from "./internal/react-native.ts";

export { createPermissionHook, PermissionStatus };
export type { PermissionExpiration, PermissionHookOptions, PermissionResponse, Subscription };

/** The id of the element the app mounts into. */
const ROOT_ID = "root";

/** The page's `#root`, created at the end of `<body>` when missing. */
function rootElement(): HTMLElement {
  const existing = document.getElementById(ROOT_ID);
  if (existing) return existing;
  const root = document.createElement("div");
  root.id = ROOT_ID;
  document.body.appendChild(root);
  return root;
}

/**
 * Mount `component` as the app: react-native-web's `AppRegistry` in React Native mode (the
 * app key `main`, as Expo registers it), else denext's `createRoot`.
 *
 * @param component The root component.
 */
export function registerRootComponent<P extends Record<string, unknown>>(
  component: Component<P>,
): void {
  const rootTag = rootElement();
  if (RN.AppRegistry) {
    RN.AppRegistry.registerComponent("main", () => component);
    RN.AppRegistry.runApplication("main", { rootTag });
    return;
  }
  createRoot(rootTag).render(h(component as Component<Record<string, unknown>>, {}));
}

/**
 * A native module: none exist here, so it throws (as Expo's web build does for a module with
 * no web implementation).
 *
 * @param moduleName The module's name.
 * @returns Never.
 */
export function requireNativeModule<T = unknown>(moduleName: string): T {
  throw new Error(`Cannot find native module '${moduleName}'`);
}

/**
 * A native module when it exists: never here.
 *
 * @param _moduleName The module's name.
 * @returns null.
 */
export function requireOptionalNativeModule<T = unknown>(_moduleName: string): T | null {
  return null;
}

/**
 * A native view: none exist here, so the component renders nothing.
 *
 * @param _moduleName The view's module name.
 * @param _viewName The view's name.
 * @returns A component that renders null.
 */
export function requireNativeView<P = Record<string, unknown>>(
  _moduleName: string,
  _viewName?: string,
): Component<P> {
  // Rendering nothing is a valid component result; `Component` types the non-null case.
  return (() => null) as unknown as Component<P>;
}

/** A typed event emitter, as Expo modules use. */
export class EventEmitter<
  Events extends Record<string, (...args: never[]) => void> = Record<
    string,
    (...args: never[]) => void
  >,
> {
  #listeners = new Map<keyof Events, Set<(...args: never[]) => void>>();

  /** Add `listener` for `eventName`. */
  addListener<E extends keyof Events>(eventName: E, listener: Events[E]): Subscription {
    let set = this.#listeners.get(eventName);
    if (!set) this.#listeners.set(eventName, set = new Set());
    set.add(listener);
    return { remove: () => this.removeListener(eventName, listener) };
  }

  /** Remove `listener` for `eventName`. */
  removeListener<E extends keyof Events>(eventName: E, listener: Events[E]): void {
    this.#listeners.get(eventName)?.delete(listener);
  }

  /** Remove every listener for `eventName`. */
  removeAllListeners(eventName: keyof Events): void {
    this.#listeners.delete(eventName);
  }

  /** Call every listener for `eventName` with `args`. */
  emit<E extends keyof Events>(eventName: E, ...args: Parameters<Events[E]>): void {
    for (const listener of [...this.#listeners.get(eventName) ?? []]) {
      (listener as (...a: Parameters<Events[E]>) => void)(...args);
    }
  }

  /** How many listeners `eventName` has. */
  listenerCount(eventName: keyof Events): number {
    return this.#listeners.get(eventName)?.size ?? 0;
  }
}

/** A module implemented in JS (see {@linkcode registerWebModule}). */
export class NativeModule<
  Events extends Record<string, (...args: never[]) => void> = Record<
    string,
    (...args: never[]) => void
  >,
> extends EventEmitter<Events> {}

/** An object shared with native code: a JS object here, released explicitly. */
export class SharedObject<
  Events extends Record<string, (...args: never[]) => void> = Record<
    string,
    (...args: never[]) => void
  >,
> extends EventEmitter<Events> {
  /** Release the object (drops its listeners here). */
  release(): void {}
}

/** A reference to a native resource (an image, a file): a JS object here. */
export class SharedRef<
  Type extends string = "unknown",
  Events extends Record<string, (...args: never[]) => void> = Record<
    string,
    (...args: never[]) => void
  >,
> extends SharedObject<Events> {
  /** The kind of resource. */
  nativeRefType: Type | string = "unknown";
}

/**
 * Register a module implemented in JS: a class is instantiated, an object returned as is.
 *
 * @param moduleImplementation The module class or object.
 * @param _moduleName The module's name.
 * @returns The module.
 */
export function registerWebModule<T>(
  moduleImplementation: T | (new () => T),
  _moduleName?: string,
): T {
  return typeof moduleImplementation === "function"
    ? new (moduleImplementation as new () => T)()
    : moduleImplementation;
}

/**
 * Reload the app (the page).
 *
 * @param _reason Why (ignored).
 * @returns A promise that settles as the page reloads.
 */
export function reloadAppAsync(_reason?: string): Promise<void> {
  (globalThis as { location?: { reload(): void } }).location?.reload();
  return Promise.resolve();
}

/** Install a worklet runtime helper (there is no UI runtime here): does nothing. */
export function installOnUIRuntime(): void {}

/** Turn off Expo's global error handler (there is none here): does nothing. */
export function disableErrorHandling(): void {}

/**
 * Whether the app runs in Expo Go: never.
 *
 * @returns `false`.
 */
export function isRunningInExpoGo(): boolean {
  return false;
}

/**
 * The Expo Go project config: none.
 *
 * @returns null.
 */
export function getExpoGoProjectConfig(): null {
  return null;
}

/** The slice of an emitter {@linkcode useEvent} and {@linkcode useEventListener} use. */
export interface Listenable {
  /** Add a listener; the result removes it. */
  addListener(eventName: string, listener: (...args: never[]) => void): { remove(): void };
}

/**
 * The latest payload of `eventName` on `emitter`.
 *
 * @param emitter The emitter (a module or shared object).
 * @param eventName The event.
 * @param initialValue The value before the first event (default null).
 * @returns The latest payload.
 */
export function useEvent<T>(
  emitter: Listenable,
  eventName: string,
  initialValue: T | null = null,
): T | null {
  const [value, setValue] = useState<T | null>(initialValue);
  useEffect(() => {
    const sub = emitter.addListener(
      eventName,
      ((payload: T) => setValue(payload)) as (...a: never[]) => void,
    );
    return () => sub.remove();
  }, [emitter, eventName]);
  return value;
}

/**
 * Call `listener` for each `eventName` on `emitter` while mounted.
 *
 * @param emitter The emitter.
 * @param eventName The event.
 * @param listener The listener (the latest one is always called).
 */
export function useEventListener(
  emitter: Listenable,
  eventName: string,
  listener: (...args: never[]) => void,
): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => {
    const sub = emitter.addListener(
      eventName,
      ((...args: never[]) => latest.current(...args)) as (...a: never[]) => void,
    );
    return () => sub.remove();
  }, [emitter, eventName]);
}

/**
 * `expo/fetch`: the platform's WinterCG `fetch` (streaming bodies included).
 *
 * @param input The resource.
 * @param init The request options.
 * @returns The response.
 */
export function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}
