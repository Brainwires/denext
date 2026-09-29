/**
 * React Native mode's native modules: `TurboModuleRegistry.get` / `getEnforcing`,
 * `NativeModules` and `NativeEventEmitter` reach the app's own native code through
 * `denext/mobile`'s {@linkcode nativeModule} client — the Capacitor plugin of the module's name
 * inside the iOS/Android shell, the desktop extension of that name in a Deno Desktop window.
 * Calls use React Native's positional convention (`{ args }` in, `{ value }` unwrapped out)
 * and always return a Promise: the bridge is asynchronous, and there is no JSI, so a
 * synchronous native method cannot be served. Where neither native side exists (the web), a
 * module is absent, exactly as react-native-web answers.
 *
 * @module
 */

import { nativeModule, nativeModuleName } from "../mobile/native-module.ts";
import { nativeViewComponent, nativeViewSlotCommand } from "../mobile/native-view.ts";
import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";

/** A module client as React Native code sees it: any member is a method. */
type TurboModuleClient = Record<string, unknown>;

/** Clients already built, by name (one per module, so identity is stable). */
let clients: Map<string, TurboModuleClient | null> | undefined;

/**
 * The native module `name` for React Native code, or null when this runtime has none: the
 * Capacitor plugin `name` in the shell, the desktop extension `name` on Deno Desktop.
 * `TurboModuleRegistry.get` returns it as is; `getEnforcing` falls back to a stand-in that
 * throws on first use.
 *
 * @param name The module name (the TurboModule spec's `getEnforcing('<name>')`).
 * @returns The client, or null.
 */
export function turboModule(name: string): TurboModuleClient | null {
  if (typeof name !== "string" || name === "") return null;
  clients ??= new Map();
  if (clients.has(name)) return clients.get(name)!;
  const client = nativeModule(name, { calls: "positional" }) as TurboModuleClient | null;
  // Only a found module is remembered: a plugin may register after the first lookup.
  if (client) clients.set(name, client);
  return client;
}

/**
 * React Native's `NativeModules`, over react-native-web's (which holds only `UIManager`): a
 * name react-native-web has keeps its value; any other name is {@linkcode turboModule}'s
 * client, or undefined when there is no native side.
 *
 * @param UIManager react-native-web's `UIManager`.
 * @returns The `NativeModules` object.
 */
export function createNativeModules(UIManager: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = { UIManager };
  return new Proxy(base, {
    get(target, key) {
      if (typeof key !== "string" || Object.hasOwn(target, key)) return Reflect.get(target, key);
      if (key === "then" || key === "__esModule" || key === "$$typeof") return undefined;
      return turboModule(key) ?? undefined;
    },
    has(target, key) {
      if (typeof key !== "string" || Object.hasOwn(target, key)) return Reflect.has(target, key);
      return turboModule(key) !== null;
    },
  });
}

/** A subscription as React Native's emitters return it. */
interface EmitterSubscription {
  remove(): void;
}

/** The slice of react-native-web's `NativeEventEmitter` class this extends. */
interface EventEmitterBase {
  addListener(
    eventType: string,
    listener: (...args: unknown[]) => unknown,
    context?: unknown,
  ): EmitterSubscription;
  removeAllListeners(eventType: string): void;
  listenerCount(eventType: string): number;
}

/** The slice of a {@linkcode turboModule} client an emitter subscribes through. */
interface ListenableModule {
  addListener(event: string, handler: (data: unknown) => void): EmitterSubscription;
}

/** A constructor of {@linkcode EventEmitterBase}. */
type EventEmitterClass = new (nativeModule?: unknown) => EventEmitterBase;

/**
 * React Native's `NativeEventEmitter` over react-native-web's: constructed with a native
 * module this bridge serves ({@linkcode turboModule}'s client), `addListener` subscribes to
 * that plugin's events (Capacitor's `notifyListeners`, a desktop extension's `emit`), and
 * `emit()` still reaches the same listeners. Any other module (or none) keeps
 * react-native-web's behaviour.
 *
 * @param Base react-native-web's `NativeEventEmitter` class.
 * @returns The class.
 */
export function createNativeEventEmitter(Base: EventEmitterClass): EventEmitterClass {
  return class NativeEventEmitter extends Base {
    #module: ListenableModule | undefined;
    #native = new Map<string, Set<EmitterSubscription>>();

    constructor(nativeModule?: unknown) {
      const ours = nativeModuleName(nativeModule) !== undefined;
      // react-native-web's own constructor would call the module's `addListener(eventType)`
      // bookkeeping; a module served here gets real subscriptions instead.
      super(ours ? undefined : nativeModule);
      if (ours) this.#module = nativeModule as ListenableModule;
    }

    override addListener(
      eventType: string,
      listener: (...args: unknown[]) => unknown,
      context?: unknown,
    ): EmitterSubscription {
      const local = super.addListener(eventType, listener, context);
      if (!this.#module) return local;
      const nativeSub = this.#module.addListener(
        eventType,
        (data) => listener.call(context, data),
      );
      let set = this.#native.get(eventType);
      if (!set) this.#native.set(eventType, set = new Set());
      const subs = set;
      const sub: EmitterSubscription = {
        remove: () => {
          if (!subs.delete(sub)) return;
          nativeSub.remove();
          local.remove();
        },
      };
      subs.add(sub);
      return sub;
    }

    override removeAllListeners(eventType: string): void {
      for (const sub of [...this.#native.get(eventType) ?? []]) sub.remove();
      super.removeAllListeners(eventType);
    }
  };
}

/** A React Native style prop: an object, or a (nested) array of them with falsy holes. */
type StyleProp = unknown;

/** `style` flattened into one object (later entries win), or undefined when empty. */
function flattenStyle(style: StyleProp): Record<string, unknown> | undefined {
  if (!Array.isArray(style)) {
    return typeof style === "object" && style !== null
      ? style as Record<string, unknown>
      : undefined;
  }
  let out: Record<string, unknown> | undefined;
  for (const entry of style) {
    const flat = flattenStyle(entry);
    if (flat) out = { ...out, ...flat };
  }
  return out;
}

/** Host components already built, by view type (one per type, so identity is stable). */
let hostComponents: Map<string, (props: Readonly<Record<string, unknown>>) => unknown> | undefined;

/**
 * The component React Native mode returns from `requireNativeComponent(type)`,
 * `codegenNativeComponent(type)` and `NativeComponentRegistry.get(type)`, and Expo's
 * `requireNativeView`: `denext/mobile`'s native view slot for view type `type` (the
 * `DenextNativeViews` plugin, `denext mobile add native-views`). Its JSON props go to the native
 * factory, a native event `name` calls the `on<Name>` prop with `{ nativeEvent }`, `style` (an
 * array is flattened) styles the slot, and its children are drawn over the view. Where the view
 * type is not registered natively (the web), the children render instead.
 *
 * @param type The native view type.
 * @returns The component.
 */
export function nativeHostComponent(
  type: string,
): (props: Readonly<Record<string, unknown>>) => unknown {
  hostComponents ??= new Map();
  let component = hostComponents.get(type);
  if (!component) {
    const View = nativeViewComponent(type);
    const Host = (props: Readonly<Record<string, unknown>>) => {
      const { children, ...rest }: Record<string, unknown> = props;
      if (rest.style !== undefined) rest.style = flattenStyle(rest.style);
      // Children as h()'s own argument: h() sets `children` from its rest arguments.
      return h(View as (p: Record<string, unknown>) => VNode, rest, children as VNode);
    };
    Object.defineProperty(Host, "displayName", { value: type });
    hostComponents.set(type, component = Host);
  }
  return component;
}

/** A view manager's config as React Native code reads it: only its `Commands`. */
export interface ViewManagerConfig {
  /** Every command name maps to itself (a native view slot's commands are called by name). */
  readonly Commands: Readonly<Record<string, string>>;
}

/** `Commands` of every config: any name is its own command id. */
const COMMANDS: Readonly<Record<string, string>> = new Proxy({}, {
  get: (_target, key) => typeof key === "string" && key !== "then" ? key : undefined,
});

/**
 * React Native's `UIManager.getViewManagerConfig(name)`: a config for a native component this
 * app built with `requireNativeComponent` / `codegenNativeComponent` (a native view slot of that
 * type, {@linkcode nativeHostComponent}), null for any other name — so a library that
 * feature-detects its view falls back instead of mounting a view nothing draws.
 *
 * @param name The view manager (native component) name.
 * @returns The config, or null.
 */
export function getViewManagerConfig(name: string): ViewManagerConfig | null {
  return typeof name === "string" && hostComponents?.has(name) ? { Commands: COMMANDS } : null;
}

/** Whether the dev warning for a command with no native view has been shown. */
let warnedCommand = false;

/** Warn once (not in a production build) that a view command reached no native view. */
function warnCommandOnce(command: unknown, why: string): void {
  if (warnedCommand || (globalThis as { __DEV__?: boolean }).__DEV__ === false) return;
  warnedCommand = true;
  console.warn(
    `denext reactNative: UIManager.dispatchViewManagerCommand("${String(command)}") ${why}; ` +
      "it does nothing (further commands are not reported).",
  );
}

/**
 * React Native's `UIManager.dispatchViewManagerCommand(tag, command, args)`: when `tag` is a
 * native view slot's element (what a ref to a native component holds; react-native-web's
 * `findNodeHandle` throws, so a numeric tag cannot name one) and that view is native, runs
 * the command on it (`{ args }`, React Native's positional arguments). Anything else does
 * nothing, with one warning in dev.
 *
 * @param tag The view: its element, or a ref object holding it.
 * @param command The command name (a `Commands` entry of {@linkcode getViewManagerConfig}).
 * @param args The command's arguments.
 */
export function dispatchViewManagerCommand(tag: unknown, command: unknown, args?: unknown): void {
  const run = nativeViewSlotCommand(tag);
  if (!run) return warnCommandOnce(command, "names no native view");
  run(String(command), { args: Array.isArray(args) ? args : [] }).catch((err: unknown) =>
    warnCommandOnce(command, `failed (${err instanceof Error ? err.message : String(err)})`)
  );
}

/**
 * react-native-web's `UIManager` with the view manager API it lacks, added in place (a member it
 * already has is kept): {@linkcode getViewManagerConfig}, `hasViewManagerConfig` and
 * {@linkcode dispatchViewManagerCommand}.
 *
 * @param UIManager react-native-web's `UIManager`.
 * @returns The same object.
 */
export function withViewManagerCommands<T extends object>(UIManager: T): T {
  const u = UIManager as Record<string, unknown>;
  u.getViewManagerConfig ??= getViewManagerConfig;
  u.hasViewManagerConfig ??= (name: string) => getViewManagerConfig(name) !== null;
  u.dispatchViewManagerCommand ??= dispatchViewManagerCommand;
  return UIManager;
}
