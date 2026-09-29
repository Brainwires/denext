/**
 * Small React Native core exports react-native-web lacks, for React Native mode: `DevSettings`,
 * `RootTagContext` and the `useAnimatedValue` / `useAnimatedValueXY` / `useAnimatedColor`
 * hooks (built over react-native-web's own `Animated` by {@linkcode createAnimatedHook}).
 * Without them an import of any of these names was a build error.
 *
 * @module
 */

import { createContext } from "../runtime/context.ts";
import { type Context, useRef } from "../runtime/hooks.ts";
import { type EmitterSubscription, type Listeners, listeners } from "./internal.ts";

/** React Native's `DevSettings` module. */
export interface DevSettingsStatic {
  /** Add an item to the developer menu (accepted; a web view has no developer menu). */
  addMenuItem(title: string, handler: () => unknown): void;
  /** Reload the app: the page reloads. */
  reload(reason?: string): void;
  /** Called by React Native's Fast Refresh (does nothing here). */
  onFastRefresh(): void;
  /** Listen for a `DevSettings` event (its event-emitter face; nothing here emits one). */
  addListener(event: string, listener: (...args: unknown[]) => unknown): EmitterSubscription;
  /** Call `event`'s listeners with `args`. */
  emit(event: string, ...args: unknown[]): void;
  /** How many listeners `event` has. */
  listenerCount(event: string): number;
  /** Remove `event`'s listeners, or every listener. */
  removeAllListeners(event?: string): void;
}

/** The `DevSettings` listeners, created on first use. */
let devListeners: Listeners<string, unknown[]> | undefined;

/** The `DevSettings` listener fan-out. */
function devSettingsListeners(): Listeners<string, unknown[]> {
  return devListeners ??= listeners<string, unknown[]>();
}

/**
 * React Native's `DevSettings`: `reload()` reloads the page (the shell's web view reloads the
 * app's bundle, which is what `DevSettings.reload()` does in React Native);
 * `addMenuItem()` and `onFastRefresh()` are accepted and do nothing, since a web view has no
 * React Native developer menu (use the browser's or Safari's Web Inspector). Its event-emitter
 * face (`addListener`, `emit`, `listenerCount`, `removeAllListeners`) works, though nothing in
 * React Native mode emits a `DevSettings` event.
 *
 * @example
 * ```ts
 * import { DevSettings } from "react-native";
 *
 * DevSettings.reload("settings changed");
 * ```
 */
export const DevSettings: DevSettingsStatic = {
  addMenuItem() {},
  reload() {
    const location = (globalThis as { location?: { reload?: () => void } }).location;
    location?.reload?.();
  },
  onFastRefresh() {},
  addListener(event, listener) {
    return devSettingsListeners().add(event, (args) => void listener(...args));
  },
  emit(event, ...args) {
    devListeners?.emit(event, args);
  },
  listenerCount(event) {
    return devListeners?.count(event) ?? 0;
  },
  removeAllListeners(event) {
    devListeners?.clear(event);
  },
};

/**
 * React Native's `RootTagContext`: the tag of the React Native root a component renders in.
 * A React Native mode app has one root, so every component reads `1` (the tag React Native
 * gives its first root) unless a provider says otherwise; nothing in React Native mode reads it
 * back, so libraries that pass it to native modules get a stable value.
 *
 * @example
 * ```ts
 * import { useContext } from "react";
 * import { RootTagContext } from "react-native";
 *
 * const rootTag = useContext(RootTagContext); // 1
 * ```
 */
export const RootTagContext: Context<number> = /* @__PURE__ */ createContext<number>(1);

/** The `Animated` node classes the hooks construct. */
export type AnimatedNodeKind = "Value" | "ValueXY" | "Color";

/** The slice of react-native-web's `Animated` the hooks use. */
export type AnimatedNodes = {
  readonly [K in AnimatedNodeKind]?: new (value?: unknown, config?: unknown) => unknown;
};

/**
 * A hook that creates an `Animated.<kind>` once per component and returns the same node on
 * every render: React Native's `useAnimatedValue(initialValue, config?)` (`"Value"`),
 * `useAnimatedValueXY(initialValue, config?)` (`"ValueXY"`) and
 * `useAnimatedColor(initialValue?, config?)` (`"Color"`), each
 * `useRef(new Animated.<kind>(…)).current` with the node built only on the first render.
 * React Native mode adds them to the `react-native` entry, built over react-native-web's own
 * `Animated` (which it passes in), so the nodes are the ones react-native-web animates.
 *
 * @param Animated react-native-web's `Animated`.
 * @param kind The node class.
 * @returns The hook.
 * @example
 * ```ts
 * import { Animated, useAnimatedValue } from "react-native";
 *
 * function Fade() {
 *   const opacity = useAnimatedValue(0);
 *   // …Animated.timing(opacity, { toValue: 1, useNativeDriver: false }).start()
 * }
 * ```
 */
export function createAnimatedHook(
  Animated: AnimatedNodes,
  kind: AnimatedNodeKind,
): (initialValue?: unknown, config?: unknown) => unknown {
  function useAnimatedNode(initialValue?: unknown, config?: unknown): unknown {
    const ref = useRef<unknown>(null);
    if (ref.current === null) {
      const Node = Animated?.[kind];
      if (typeof Node !== "function") {
        throw new Error(`denext reactNative: Animated.${kind} is not available`);
      }
      ref.current = new Node(initialValue, config);
    }
    return ref.current;
  }
  return useAnimatedNode;
}
