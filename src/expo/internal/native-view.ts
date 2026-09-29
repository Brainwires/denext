/**
 * Load-safe stand-ins for native-only Expo views (`@expo/ui`'s SwiftUI / Jetpack Compose
 * components, `expo-maps`): components that render their children (or a labelled
 * placeholder) instead of a native view, and modifier factories that return inert configs.
 * Importing a stub never throws; each warns once, when it first renders. Internal: not a
 * `denext/expo/*` entrypoint. Nothing here runs at import time.
 *
 * @module
 */

import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { useRef } from "../../runtime/hooks.ts";
import { hostView, viewStyle } from "./common.ts";

/** How a stub component lays out what it renders. */
export type StubLayout =
  /** Children in a column (VStack, Column, List, Form, …). */
  | "column"
  /** Children in a row (HStack, Row, …). */
  | "row"
  /** Children as text (Text, Label). */
  | "text"
  /** A `<button>` that calls `onPress` / `onClick` (Button and its variants). */
  | "button"
  /** Children as they are, or nothing (everything else). */
  | "children";

/** The (package, name) pairs that have warned already. */
const warned = new Set<string>();

/**
 * Warn once that `pkg`'s `name` is a native view with no web equivalent.
 *
 * @param pkg The package (`"@expo/ui/swift-ui"`).
 * @param name The view (`"Chart"`).
 * @param detail What renders instead.
 */
export function warnNativeView(pkg: string, name: string, detail: string): void {
  const key = `${pkg}#${name}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`denext/expo: ${pkg}'s ${name} is a native view; ${detail}`);
}

/** Forget which views warned (for tests). */
export function resetNativeViewWarningsForTesting(): void {
  warned.clear();
}

/** The error a native-only call on a stub throws. */
export function nativeViewError(pkg: string, name: string, hint: string): Error {
  return new Error(
    `denext/expo: ${pkg}'s ${name} needs the native view, which a web view does not have. ${hint}`,
  );
}

/** A stub component's props (whatever the native view takes). */
export type StubProps = Record<string, unknown> & { children?: unknown; style?: unknown };

/** The label a button-like view shows: `label`, `title`, `text`, or its children. */
function buttonLabel(props: StubProps): unknown {
  return props.label ?? props.title ?? props.text ?? props.children;
}

/**
 * A stand-in for a native view: renders by `layout` and warns once on first render.
 *
 * @param pkg The package, for the warning.
 * @param name The view's export name.
 * @param layout How it renders.
 * @returns The component.
 */
export function stubView(
  pkg: string,
  name: string,
  layout: StubLayout,
): (props: StubProps) => VNode {
  const Stub = (props: StubProps): VNode => {
    warnNativeView(pkg, name, "denext renders its children with web layout instead.");
    const children = props.children as never;
    if (layout === "text") return h("span", { style: props.style as never }, children);
    if (layout === "button") {
      const onPress = (props.onPress ?? props.onClick) as (() => void) | undefined;
      return h("button", {
        type: "button",
        disabled: props.disabled === true,
        onClick: () => onPress?.(),
      }, buttonLabel(props) as never);
    }
    if (layout === "column" || layout === "row") {
      const base = {
        flexDirection: layout,
        gap: typeof props.spacing === "number" ? props.spacing : 0,
      };
      return h(hostView(), { style: viewStyle(props.style, base) }, children);
    }
    return children === undefined ? (null as unknown as VNode) : h(Fragment, null, children);
  };
  Object.defineProperty(Stub, "name", { value: name });
  return Stub;
}

/** An inert modifier config: what a native modifier factory returns, never applied here. */
export interface StubModifier {
  /** The modifier's name. */
  readonly $type: string;
  /** Its arguments. */
  readonly $args: readonly unknown[];
}

/**
 * A modifier factory that records its name and arguments in an inert config.
 *
 * @param name The modifier's name.
 * @returns The factory.
 */
export function stubModifier(name: string): (...args: unknown[]) => StubModifier {
  return (...args: unknown[]) => ({ $type: name, $args: args });
}

/**
 * Whether `value` is a config from {@linkcode stubModifier}.
 *
 * @param value Anything.
 */
export function isStubModifier(value: unknown): value is StubModifier {
  return typeof value === "object" && value !== null &&
    typeof (value as StubModifier).$type === "string";
}

/**
 * An object whose every listed key is a {@linkcode stubModifier} (`Shape.Circle`,
 * `EnterTransition.fadeIn`, …).
 *
 * @param prefix The object's name, prefixed to each config's type.
 * @param keys The keys.
 */
export function stubModifierGroup<K extends string>(
  prefix: string,
  keys: readonly K[],
): Readonly<Record<K, (...args: unknown[]) => StubModifier>> {
  return Object.fromEntries(keys.map((k) => [k, stubModifier(`${prefix}.${k}`)])) as Record<
    K,
    (...args: unknown[]) => StubModifier
  >;
}

/** A value shared with native views: here a plain holder (writes do not re-render). */
export interface ObservableState<T> {
  /** The current value. */
  value: T;
  /** Read the value. */
  get(): T;
  /** Write the value. */
  set(value: T): void;
}

/**
 * Stand-in for `useNativeState`: a value holder kept across renders. There are no native
 * views to observe it, so a write does not re-render anything.
 *
 * @param initialValue The first value.
 * @returns The holder.
 */
export function useNativeState<T>(initialValue: T): ObservableState<T> {
  const ref = useRef<ObservableState<T> | null>(null);
  if (ref.current === null) {
    const state: ObservableState<T> = {
      value: initialValue,
      get: () => state.value,
      set: (value: T) => void (state.value = value),
    };
    ref.current = state;
  }
  return ref.current;
}

/**
 * A modifier config of `type` (inert here).
 *
 * @param type The modifier's native type.
 * @param params Its parameters.
 */
export function createModifier(type: string, params?: Record<string, unknown>): StubModifier {
  return { $type: type, $args: params === undefined ? [] : [params] };
}

/**
 * A modifier config of `type` with an event listener (never called here).
 *
 * @param type The modifier's native type.
 * @param eventListener The listener (never called).
 * @param params Its parameters.
 */
export function createModifierWithEventListener(
  type: string,
  eventListener: (args: unknown) => void,
  params?: Record<string, unknown>,
): StubModifier {
  return { $type: type, $args: params === undefined ? [eventListener] : [eventListener, params] };
}
