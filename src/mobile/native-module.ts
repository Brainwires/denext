/**
 * Your own native code from `denext/mobile`: a typed client for a native plugin by name.
 *
 * - Inside the Capacitor iOS/Android shell, {@linkcode nativeModule} reaches the Capacitor
 *   plugin registered under that name (`window.Capacitor.Plugins[name]`, which the shell seeds
 *   for every natively registered plugin, so no `registerPlugin` call is needed). `denext
 *   mobile add native-module --name <Name>` generates one (Swift + Kotlin) and registers it.
 * - In a Deno Desktop window it reaches the desktop extension of that name
 *   (`desktopExtension(name)` from `denext/desktop/client`), loaded lazily so web and mobile
 *   bundles never carry the desktop client.
 * - Elsewhere (the web, SSR, a shell without the plugin) it returns `null`.
 *
 * Every method returns a Promise: the bridge to native code is asynchronous (there is no JSI),
 * so a call site must `await` it. In a dev build, reading anything but `then` / `catch` /
 * `finally` off a call's result logs a warning that names the method.
 *
 * React Native mode routes `TurboModuleRegistry`, `NativeModules`, `NativeEventEmitter` and
 * Expo's `requireNativeModule` through the same client (with `calls: "positional"`).
 *
 * @module
 */

import { runtimePlatform, shellPlugin } from "./bridge.ts";
import { listenerDisposer, type ListenerHandle } from "./plugin.ts";

/** A native method's typed client: the same arguments, and the result as a Promise. */
export type NativeMethod<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

/** The methods of a native module spec `T`, each returning a Promise. */
export type NativeModuleMethods<T> = {
  readonly [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: NativeMethod<
    T[K]
  >;
};

/** A subscription to a native event; `remove()` ends it (calling it twice is harmless). */
export interface NativeSubscription {
  /** Stop receiving the event. */
  remove(): void;
}

/** The event half of a {@linkcode NativeModuleClient}: payloads typed per event name. */
export interface NativeModuleEvents<E extends Record<string, unknown>> {
  /**
   * Call `handler` with each `event` the native side emits (Capacitor's
   * `notifyListeners(event, data)`, or a desktop extension's `emit(event, data)`).
   *
   * @param event The event name.
   * @param handler Called with each payload.
   * @returns The subscription.
   */
  addListener<K extends keyof E & string>(
    event: K,
    handler: (data: E[K]) => void,
  ): NativeSubscription;
}

/** What {@linkcode nativeModule} returns: `T`'s methods (async) plus `addListener`. */
export type NativeModuleClient<
  T,
  E extends Record<string, unknown> = Record<string, unknown>,
> = NativeModuleMethods<T> & NativeModuleEvents<E>;

/**
 * How a call's arguments reach the native method and how its result comes back.
 *
 * - `"options"` (default): Capacitor's own convention. The first argument (an options object)
 *   is passed as is, and the resolved object is returned as is.
 * - `"positional"`: React Native's convention (`multiply(2, 3)`). The native side receives
 *   `{ args: [2, 3] }` (a single plain-object argument's own keys are also spread next to
 *   `args`, so a Capacitor `call.getString("key")` still reads them), and a result of exactly
 *   `{ value: x }` resolves to `x` (Capacitor can only resolve an object).
 */
export type NativeCallConvention = "options" | "positional";

/** Options for {@linkcode nativeModule}. */
export interface NativeModuleOptions {
  /** The argument/result convention (default `"options"`). */
  readonly calls?: NativeCallConvention;
}

/** Where a module's calls go. */
interface Backend {
  call(method: string, payload: unknown): Promise<unknown>;
  listen(event: string, handler: (data: unknown) => void): () => void;
}

/** The slice of a Capacitor plugin object the client reads. */
interface CapacitorPluginObject {
  [method: string]: unknown;
  addListener?: (
    event: string,
    handler: (data: unknown) => void,
  ) => ListenerHandle | Promise<ListenerHandle>;
}

/** Marks a client (a global symbol, so another copy of this module recognises it too). */
const CLIENT = Symbol.for("denext.nativeModule");

/** The slice of a client that {@linkcode nativeModuleName} reads. */
interface MarkedClient {
  readonly [CLIENT]?: string;
}

/**
 * The module name `value` is a {@linkcode nativeModule} client for, or undefined.
 *
 * @param value Anything.
 * @returns The name, when `value` is a client.
 */
export function nativeModuleName(value: unknown): string | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  const name = (value as MarkedClient)[CLIENT];
  return typeof name === "string" ? name : undefined;
}

/** An error for a call the backend cannot make. */
function callError(name: string, method: string, why: string): Error {
  return new Error(`denext nativeModule: ${name}.${method}() ${why}`);
}

/** The Capacitor plugin `plugin`, as a backend. */
function capacitorBackend(name: string, plugin: CapacitorPluginObject): Backend {
  return {
    call(method, payload) {
      const fn = plugin[method];
      if (typeof fn !== "function") {
        return Promise.reject(callError(name, method, "is not a method of the native plugin"));
      }
      try {
        return Promise.resolve(fn.call(plugin, payload));
      } catch (err) {
        return Promise.reject(err);
      }
    },
    listen(event, handler) {
      if (typeof plugin.addListener !== "function") return () => {};
      try {
        return listenerDisposer(plugin.addListener(event, handler));
      } catch {
        return () => {};
      }
    },
  };
}

/** The desktop extension `name`, as a backend (the desktop client loads on first use). */
function desktopBackend(name: string): Backend {
  const client = () => import("../desktop/client.ts");
  return {
    async call(method, payload) {
      const ext = (await client()).desktopExtension(name) as Record<
        string,
        (args?: unknown) => Promise<unknown>
      >;
      return await ext[method](payload);
    },
    listen(event, handler) {
      let disposed = false;
      let stop: (() => void) | undefined;
      client().then(
        (c) => {
          if (!disposed) stop = c.onDesktopEvent(name, event, handler);
        },
        () => {},
      );
      return () => {
        disposed = true;
        stop?.();
        stop = undefined;
      };
    },
  };
}

/** The backend for `name` in this runtime, or undefined when there is none. */
function backendFor(name: string): Backend | undefined {
  const plugin = shellPlugin(name);
  if (typeof plugin === "object" && plugin !== null) {
    return capacitorBackend(name, plugin as CapacitorPluginObject);
  }
  return runtimePlatform() === "desktop" ? desktopBackend(name) : undefined;
}

/** Whether `value` is a plain object (not an array, a class instance or null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The payload a `"positional"` call sends: `{ args }`, with a lone plain-object argument's own
 * keys spread beside it.
 *
 * @param args The call's arguments.
 * @returns The payload.
 */
export function positionalPayload(args: readonly unknown[]): Record<string, unknown> {
  const only = args.length === 1 && isPlainObject(args[0]) ? args[0] : undefined;
  return { ...only, args: [...args] };
}

/**
 * A `"positional"` call's result: `{ value: x }` (and nothing else) unwraps to `x`.
 *
 * @param result What the native side resolved.
 * @returns The value the caller sees.
 */
export function positionalResult(result: unknown): unknown {
  if (!isPlainObject(result)) return result;
  const keys = Object.keys(result);
  return keys.length === 1 && keys[0] === "value" ? result.value : result;
}

/** Whether this is a denext dev build. */
function isDev(): boolean {
  return (globalThis as { __denextDev?: boolean }).__denextDev === true;
}

/** The Promise members a caller may read without being told to await. */
const PROMISE_MEMBERS: ReadonlySet<PropertyKey> = new Set([
  "then",
  "catch",
  "finally",
  "constructor",
  Symbol.toStringTag,
]);

/** Method labels already warned about (once per label). */
let warnedSync: Set<string> | undefined;

/**
 * `promise`, wrapped in dev so that reading a value off it (the caller used the result as if
 * the call were synchronous) warns once, naming the method.
 *
 * @param promise The call's result.
 * @param label `Name.method`.
 * @returns The promise, or its dev proxy.
 */
function devChecked<T>(promise: Promise<T>, label: string): Promise<T> {
  if (!isDev()) return promise;
  return new Proxy(promise, {
    get(target, key) {
      if (!PROMISE_MEMBERS.has(key) && !(warnedSync ??= new Set()).has(label)) {
        warnedSync.add(label);
        console.warn(
          `denext: ${label}() returns a Promise (calls into native code are asynchronous in ` +
            `denext), but \`${String(key)}\` was read off it as if it were the result. Await ` +
            "the call: `const value = await " + label + "(…)`.",
        );
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A subscription whose `remove()` runs `dispose` once. */
function subscription(dispose: () => void): NativeSubscription {
  let done = false;
  return {
    remove() {
      if (done) return;
      done = true;
      dispose();
    },
  };
}

/** Members a client answers itself instead of treating as native method names. */
const NOT_METHODS: ReadonlySet<string> = new Set([
  "then",
  "$$typeof",
  "__esModule",
  "toJSON",
  "nodeType",
  "asymmetricMatch",
]);

/** React Native's emitter bookkeeping methods, which do nothing on this bridge. */
const RN_EMITTER_METHODS: ReadonlySet<string> = new Set(["removeListeners"]);

/** Build the client proxy over `backend`. */
function createClient(
  name: string,
  backend: Backend,
  calls: NativeCallConvention,
): Record<string, unknown> {
  const methods = new Map<string, unknown>();
  const positional = calls === "positional";
  const addListener = (event: string, handler?: (data: unknown) => void): NativeSubscription =>
    // React Native's spec `addListener(eventName)` (one argument) only tells native code a
    // listener exists: nothing to subscribe.
    subscription(typeof handler === "function" ? backend.listen(event, handler) : () => {});
  const method = (key: string) => {
    if (positional && RN_EMITTER_METHODS.has(key)) return () => {};
    const label = `${name}.${key}`;
    return (...args: unknown[]) => {
      const payload = positional ? positionalPayload(args) : args[0];
      const result = backend.call(key, payload);
      return devChecked(positional ? result.then(positionalResult) : result, label);
    };
  };
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, key) {
      if (key === CLIENT) return name;
      if (typeof key !== "string" || NOT_METHODS.has(key) || key.startsWith("@@")) {
        return undefined;
      }
      if (key === "toString") return () => `[native module ${name}]`;
      if (key === "addListener") return addListener;
      let fn = methods.get(key);
      if (!fn) methods.set(key, fn = method(key));
      return fn;
    },
    has: (_target, key) => typeof key === "string" && !NOT_METHODS.has(key),
    ownKeys: () => [],
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}

/**
 * A typed client for your own native plugin `name`: the Capacitor plugin of that name inside
 * the iOS/Android shell, the desktop extension of that name in a Deno Desktop window, else
 * `null` (on the web, during SSR, or when the shell has no such plugin).
 *
 * Each method of `T` becomes an async function; `addListener(event, handler)` subscribes to
 * the plugin's events (`notifyListeners` natively, `emit` from a desktop extension). The
 * bridge is asynchronous, so always `await` a call. Calls pass one options object and resolve
 * with the plugin's result object (Capacitor's convention); pass `{ calls: "positional" }` for
 * React Native's positional arguments and `{ value }` unwrapping ({@linkcode NativeCallConvention}).
 *
 * A method the native plugin lacks rejects; a desktop call rejects with the desktop bridge's
 * error (`unavailable` when the extension is not enabled).
 *
 * @param name The plugin's JS name (Capacitor's `@CapacitorPlugin(name = …)` /
 * `jsName`, or the desktop extension's name).
 * @param options The call convention.
 * @returns The client, or `null` when there is no native side here.
 * @example
 * ```ts
 * import { nativeModule } from "denext/mobile";
 *
 * interface Scanner {
 *   scan(options: { timeoutMs: number }): { codes: string[] };
 * }
 * type ScannerEvents = { progress: { percent: number } };
 *
 * const scanner = nativeModule<Scanner, ScannerEvents>("Scanner");
 * if (scanner) {
 *   const sub = scanner.addListener("progress", ({ percent }) => console.log(percent));
 *   const { codes } = await scanner.scan({ timeoutMs: 5000 });
 *   sub.remove();
 * }
 * ```
 */
export function nativeModule<
  T extends object = Record<string, (...args: never[]) => unknown>,
  E extends Record<string, unknown> = Record<string, unknown>,
>(name: string, options: NativeModuleOptions = {}): NativeModuleClient<T, E> | null {
  if (typeof name !== "string" || name === "") {
    throw new TypeError("nativeModule: the name must be a non-empty string");
  }
  const backend = backendFor(name);
  if (!backend) return null;
  return createClient(name, backend, options.calls ?? "options") as NativeModuleClient<T, E>;
}

/**
 * Call `handler` with each `event` the native plugin `name` emits. Does nothing (and returns a
 * no-op) where {@linkcode nativeModule} would return `null`.
 *
 * @param name The plugin's JS name.
 * @param event The event name.
 * @param handler Called with each payload.
 * @returns A function that unsubscribes.
 * @example
 * ```ts
 * import { onNativeEvent } from "denext/mobile";
 *
 * const stop = onNativeEvent<{ percent: number }>("Scanner", "progress", ({ percent }) => {
 *   progressBar.value = percent;
 * });
 * ```
 */
export function onNativeEvent<D = unknown>(
  name: string,
  event: string,
  handler: (data: D) => void,
): () => void {
  const sub = nativeModule(name)?.addListener(event, handler as (data: unknown) => void);
  return () => sub?.remove();
}
