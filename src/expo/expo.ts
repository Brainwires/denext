/**
 * `expo` (the core package) for denext, and `expo/fetch`.
 *
 * - `registerRootComponent(App)` mounts the app on the page's `#root`: through
 *   react-native-web's `AppRegistry.runApplication` in React Native mode (what an Expo web
 *   entry does), else with denext's `createRoot`. An Expo app's `index.ts` therefore works
 *   as the SPA entry unchanged, with no hand-written web entry.
 * - The native-module API reaches the app's own native code: `requireNativeModule(name)` /
 *   `requireOptionalNativeModule(name)` return a client for the Capacitor plugin `name`
 *   inside the iOS/Android shell, or the desktop extension `name` on Deno Desktop
 *   (`nativeModule` from `denext/mobile`, positional arguments). Every function returns a
 *   Promise (the bridge is async; Expo's synchronous functions and properties cannot be
 *   served), and the module's `addListener` receives its native events. Where neither exists
 *   they answer as Expo's web build does: `requireNativeModule` throws,
 *   `requireOptionalNativeModule` returns null. `requireNativeView` returns a native view slot
 *   (`denext mobile add native-views`) that renders its children where the view type is not
 *   registered natively. `EventEmitter`, `NativeModule`, `SharedObject`, `SharedRef`,
 *   `registerWebModule`, `useEvent` and `useEventListener` work for JS-implemented modules,
 *   and `new EventEmitter(nativeModule)` (the pre-SDK 52 form) listens to its native events.
 * - `fetch` (from `expo/fetch`) is the platform's streaming `fetch`.
 * - SDK 58's additions: `CodedError` / `UnavailabilityError`, `Platform` (Expo's web build:
 *   `OS` is `"web"`), `uuid` (`v4`, and a synchronous `v5`), `createSnapshotFriendlyRef`, and
 *   `useReleasingSharedObject` / `useReleasingSharedObjectWithLifecycle` (Expo's semantics: an
 *   object released on unmount or replaced when its dependencies change).
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
import type { DependencyList } from "../compat/react-types.ts";
import { useEffect, useInsertionEffect, useRef, useState } from "../runtime/hooks.ts";
import {
  CodedError,
  createPermissionHook,
  type PermissionExpiration,
  type PermissionHookOptions,
  type PermissionResponse,
  PermissionStatus,
  type Subscription,
  UnavailabilityError,
} from "./internal/common.ts";
import { type UUID, uuid } from "./internal/uuid.ts";
import * as RN from "./internal/react-native.ts";
import { nativeModule, nativeModuleName } from "../mobile/native-module.ts";
import { nativeHostComponent } from "../react-native/native-modules.ts";

export { CodedError, createPermissionHook, PermissionStatus, UnavailabilityError, uuid };
export type { PermissionExpiration, PermissionHookOptions, PermissionResponse, Subscription };
export type { UUID };
/** Expo's name for a listener subscription (`EventSubscription` in expo-modules-core). */
export type EventSubscription = Subscription;

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

/** Keys a missing module answers `undefined` for, so logging and interop checks never throw. */
const INTROSPECTION = new Set([
  "then",
  "$$typeof",
  "__esModule",
  "inspect",
  "nodeType",
  "asymmetricMatch",
  "toJSON",
]);

/**
 * A stand-in for the native module `moduleName` where there is none (a browser, SSR, a test, a
 * shell without the plugin): importing the module that asks for it works, and it throws only
 * when one of its functions is called. Its listener functions do nothing, so an event
 * subscription at import time is harmless too.
 */
function missingNativeModule(moduleName: string): unknown {
  const fail = (member: string) => () => {
    throw new Error(
      `Cannot find native module '${moduleName}' (calling ${member}): it runs only in the ` +
        "native shell with its plugin. Guard the call, or give the importing module a " +
        ".web.ts variant.",
    );
  };
  const inert = () => ({ remove() {} });
  return new Proxy({}, {
    get(_target, key) {
      if (typeof key === "symbol" || key.startsWith("@@") || INTROSPECTION.has(key)) {
        return undefined;
      }
      if (key === "toString") return () => `[missing native module ${moduleName}]`;
      if (key === "addListener" || key === "removeListeners" || key === "removeAllListeners") {
        return inert;
      }
      return fail(key);
    },
  });
}

/**
 * The native module `moduleName`: the Capacitor plugin of that name inside the iOS/Android
 * shell, or the desktop extension of that name on Deno Desktop. Its functions take Expo's
 * positional arguments and return Promises. Where neither exists (a browser, a test) it returns
 * a stand-in whose functions throw when called, so a module that asks for it at import time
 * still loads (Expo's web build throws at the `requireNativeModule` call itself).
 *
 * @param moduleName The module's name (`Name("…")` in the module definition).
 * @returns The module client, or the stand-in.
 */
export function requireNativeModule<T = unknown>(moduleName: string): T {
  const found = requireOptionalNativeModule<T>(moduleName);
  return found === null ? missingNativeModule(moduleName) as T : found;
}

/**
 * The native module `moduleName` when this runtime has it (see
 * {@linkcode requireNativeModule}), else null.
 *
 * @param moduleName The module's name.
 * @returns The module client, or null.
 */
export function requireOptionalNativeModule<T = unknown>(moduleName: string): T | null {
  if (typeof moduleName !== "string" || moduleName === "") return null;
  return nativeModule(moduleName, { calls: "positional" }) as T | null;
}

/**
 * The native view type {@linkcode requireNativeView} uses: the module name, or
 * `<moduleName>_<viewName>` for a module's other views (Expo's own view key).
 *
 * @param moduleName The view's module name.
 * @param viewName The view's name.
 * @returns The view type registered natively.
 */
function nativeViewType(moduleName: string, viewName?: string): string {
  return viewName && viewName !== moduleName ? `${moduleName}_${viewName}` : moduleName;
}

/**
 * A native view as a component: `denext/mobile`'s native view slot for the type
 * {@linkcode nativeViewType} names (the `DenextNativeViews` plugin, `denext mobile add
 * native-views`). Its JSON props go to the native factory, a native event `name` calls the
 * `on<Name>` prop with `{ nativeEvent }`, `style` styles the slot and its children are drawn
 * over the view. Where that view type is not registered natively (the web), the children render
 * instead.
 *
 * @param moduleName The view's module name.
 * @param viewName The view's name.
 * @returns The component.
 */
export function requireNativeView<P = Record<string, unknown>>(
  moduleName: string,
  viewName?: string,
): Component<P> {
  return nativeHostComponent(nativeViewType(moduleName, viewName)) as unknown as Component<P>;
}

/** A typed event emitter, as Expo modules use. */
export class EventEmitter<
  Events extends Record<string, (...args: never[]) => void> = Record<
    string,
    (...args: never[]) => void
  >,
> {
  #listeners = new Map<keyof Events, Set<(...args: never[]) => void>>();
  /** The native module whose events this emitter forwards (`new EventEmitter(module)`). */
  #native: Listenable | undefined;
  /** Native subscriptions, by event and listener. */
  #nativeSubs = new Map<keyof Events, Map<(...args: never[]) => void, { remove(): void }>>();

  /**
   * Create an emitter.
   *
   * @param nativeModule A native module (from {@linkcode requireNativeModule}) whose events
   * this emitter's listeners also receive (Expo's pre-SDK 52 `new EventEmitter(module)`).
   */
  constructor(nativeModule?: unknown) {
    if (nativeModuleName(nativeModule) !== undefined) this.#native = nativeModule as Listenable;
  }

  /** Add `listener` for `eventName`. */
  addListener<E extends keyof Events>(eventName: E, listener: Events[E]): Subscription {
    let set = this.#listeners.get(eventName);
    if (!set) this.#listeners.set(eventName, set = new Set());
    set.add(listener);
    if (this.#native) {
      let subs = this.#nativeSubs.get(eventName);
      if (!subs) this.#nativeSubs.set(eventName, subs = new Map());
      if (!subs.has(listener)) {
        subs.set(listener, this.#native.addListener(String(eventName), listener));
      }
    }
    return { remove: () => this.removeListener(eventName, listener) };
  }

  /** Remove `listener` for `eventName`. */
  removeListener<E extends keyof Events>(eventName: E, listener: Events[E]): void {
    this.#listeners.get(eventName)?.delete(listener);
    const subs = this.#nativeSubs.get(eventName);
    subs?.get(listener)?.remove();
    subs?.delete(listener);
  }

  /** Remove every listener for `eventName`. */
  removeAllListeners(eventName: keyof Events): void {
    for (const sub of this.#nativeSubs.get(eventName)?.values() ?? []) sub.remove();
    this.#nativeSubs.delete(eventName);
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

/**
 * Install Expo Modules on the worklets UI runtime (there is no UI runtime here): does
 * nothing.
 *
 * @param _uiRuntimeHolder The holder from react-native-worklets' `getUIRuntimeHolder()`
 * (ignored).
 */
export function installOnUIRuntime(_uiRuntimeHolder?: object): void {}

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

/** A platform key `Platform.select` matches (`native` never matches here). */
export type PlatformSelectOSType =
  | "ios"
  | "android"
  | "macos"
  | "windows"
  | "web"
  | "native"
  | "electron"
  | "default";

/** Expo's `Platform` (expo-modules-core): the web build's, which is what runs here. */
export interface ExpoPlatform {
  /** The platform the JS runs as: `"web"` (the Capacitor shell runs the web build too). */
  readonly OS: string;
  /** The value for `web`, else `default`. */
  select<T>(specifics: { [platform in PlatformSelectOSType]?: T }): T | undefined;
  /** Whether there is a DOM (false in SSR and tests without one). */
  readonly isDOMAvailable: boolean;
  /** Whether `window` takes event listeners. */
  readonly canUseEventListeners: boolean;
  /** Whether `window.screen` can be read. */
  readonly canUseViewport: boolean;
  /** Whether the JS runs in a remote debugger: never. */
  readonly isAsyncDebugging: boolean;
  /** Whether the app runs on a Meta Quest: never here. */
  readonly isQuest: boolean;
}

/** The page's `window`, when there is one with a document. */
function domWindow(): (Window & typeof globalThis) | undefined {
  const win = (globalThis as { window?: Window & typeof globalThis }).window;
  return typeof win?.document?.createElement === "function" ? win : undefined;
}

/**
 * Expo's `Platform`: `OS` is `"web"` and `select` picks `web`, then `default` (as Expo's web
 * build; React Native's own `Platform` from `react-native` is the one that reports the
 * Capacitor shell). The DOM facts are read when asked, so importing it is safe anywhere.
 */
export const Platform: ExpoPlatform = {
  OS: "web",
  select<T>(specifics: { [platform in PlatformSelectOSType]?: T }): T | undefined {
    if (Object.hasOwn(specifics, "web")) return specifics.web;
    return Object.hasOwn(specifics, "default") ? specifics.default : undefined;
  },
  get isDOMAvailable() {
    return domWindow() !== undefined;
  },
  get canUseEventListeners() {
    return typeof domWindow()?.addEventListener === "function";
  },
  get canUseViewport() {
    return !!domWindow()?.screen;
  },
  isAsyncDebugging: false,
  isQuest: false,
};

/**
 * A ref object (`{ current: null }`), as Expo's snapshot-friendly ref is.
 *
 * @returns The ref.
 */
export function createSnapshotFriendlyRef<T>(): { current: T | null } {
  return { current: null };
}

/** A shared object as the releasing hooks use it. */
interface Releasable {
  /** Release it. */
  release(): void;
}

/** What {@linkcode ReleasingSharedObjectLifecycle}'s callbacks receive. */
export type ReleasingSharedObjectLifecycleContext = {
  /** The dependencies the object was last committed with. */
  previousDependencies: DependencyList;
  /** The new dependencies. */
  dependencies: DependencyList;
};

/** How {@linkcode useReleasingSharedObjectWithLifecycle} creates, updates and releases. */
export type ReleasingSharedObjectLifecycle<TSharedObject> = {
  /** Create the object. */
  factory: () => TSharedObject;
  /**
   * Whether a dependency change replaces the object (the default) or keeps it (`false`: then
   * `update` is called with the change).
   */
  shouldRecreate?: (
    object: TSharedObject,
    context: ReleasingSharedObjectLifecycleContext,
  ) => boolean;
  /** Apply a dependency change to a kept object (it stays alive until this settles). */
  update?: (
    object: TSharedObject,
    context: ReleasingSharedObjectLifecycleContext,
  ) => void | Promise<void>;
  /** Release the object (default: its `release()`). */
  release?: (object: TSharedObject) => void;
};

/** A created object, retained while effects or pending updates use it. */
class SharedObjectResource<T> {
  retainCount = 0;
  disposed = false;
  release: (object: T) => void = (object) => (object as Releasable | null)?.release();

  constructor(readonly object: T) {}

  /** Retain it; the result releases this hold (the object goes once none is left). */
  retain(): () => void {
    if (this.disposed) {
      throw new Error(
        "Cannot reuse a released shared object. Remount the component to create a new one.",
      );
    }
    this.retainCount++;
    return () => {
      if (--this.retainCount > 0) return;
      // After effect replay and a consumer's synchronous cleanup have run.
      Promise.resolve().then(() => {
        if (this.retainCount === 0 && !this.disposed) {
          this.disposed = true;
          if (this.object != null) this.release(this.object);
        }
      }).catch((error) => console.error(error));
    };
  }

  /** Keep the object alive until `task` settles. */
  track(task: void | Promise<void>): void {
    if (!task) return;
    const done = this.retain();
    Promise.resolve(task).catch((error) => console.error(error)).then(done);
  }
}

/** A render's choice of object, with the dependencies it was chosen for. */
interface Snapshot<T> {
  resource: SharedObjectResource<T>;
  dependencies: DependencyList;
}

/** Whether two dependency lists are equal item by item (`Object.is`). */
function sameDependencies(a: DependencyList, b: DependencyList): boolean {
  return a.length === b.length && b.every((value, i) => Object.is(value, a[i]));
}

/** The object a render uses: the render's candidate, the committed one, or a new one. */
function selectSnapshot<T>(
  lifecycle: ReleasingSharedObjectLifecycle<T>,
  dependencies: DependencyList,
  candidate: Snapshot<T> | undefined,
  committed: Snapshot<T> | undefined,
): Snapshot<T> {
  if (
    candidate && !candidate.resource.disposed &&
    sameDependencies(candidate.dependencies, dependencies)
  ) {
    return candidate;
  }
  const previous = committed?.resource.disposed ? undefined : committed;
  if (previous && sameDependencies(previous.dependencies, dependencies)) return previous;
  if (
    previous && previous.resource.object != null &&
    lifecycle.shouldRecreate?.(previous.resource.object, {
        previousDependencies: previous.dependencies,
        dependencies,
      }) === false
  ) {
    return { resource: previous.resource, dependencies: [...dependencies] };
  }
  return {
    resource: new SharedObjectResource(lifecycle.factory()),
    dependencies: [...dependencies],
  };
}

/**
 * A shared object for the component's lifetime, made by `lifecycle.factory` and released (by
 * `lifecycle.release`, else its `release()`) on unmount or when the dependencies change.
 * With `shouldRecreate` returning false, a dependency change calls `update` on the same object
 * instead. Hiding the component in an `<Activity>` does not release it. Expo's own semantics.
 *
 * @param lifecycle How the object is created, updated and released.
 * @param dependencies When to recreate (or update) it.
 * @returns The object.
 */
export function useReleasingSharedObjectWithLifecycle<TSharedObject>(
  lifecycle: ReleasingSharedObjectLifecycle<TSharedObject>,
  dependencies: DependencyList,
): TSharedObject {
  const state = useRef<{
    candidate?: Snapshot<TSharedObject>;
    committed?: Snapshot<TSharedObject>;
  }>({});
  const selected = selectSnapshot(
    lifecycle,
    dependencies,
    state.current.candidate,
    state.current.committed,
  );
  state.current.candidate = selected;
  const resource = selected.resource;
  // An insertion effect, so an <Activity> hiding the component does not release it.
  useInsertionEffect(() => {
    resource.release = lifecycle.release ?? ((object) => (object as Releasable | null)?.release());
    return resource.retain();
  });
  // Still retained after the insertion cleanup, so a useEffect cleanup can use the object.
  useEffect(() => resource.retain(), [resource]);
  useEffect(() => {
    const previous = state.current.committed;
    state.current.committed = selected;
    if (
      previous?.resource === resource &&
      !sameDependencies(previous.dependencies, selected.dependencies)
    ) {
      resource.track(
        lifecycle.update?.(resource.object, {
          previousDependencies: previous.dependencies,
          dependencies: selected.dependencies,
        }),
      );
    }
  });
  return resource.object;
}

/**
 * A shared object for the component's lifetime: `factory`'s result, released on unmount and
 * replaced (the old one released) when `dependencies` change.
 *
 * @param factory Create the object.
 * @param dependencies When to replace it.
 * @returns The object.
 */
export function useReleasingSharedObject<TSharedObject>(
  factory: () => TSharedObject,
  dependencies: DependencyList,
): TSharedObject {
  return useReleasingSharedObjectWithLifecycle({ factory }, dependencies);
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
