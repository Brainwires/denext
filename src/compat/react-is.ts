/**
 * `react-is`-compatible entrypoint for denext.
 *
 * Alias `react-is` to this module in your import map so libraries (Radix UI,
 * react-hook-form, emotion, …) that classify elements/components resolve to
 * denext:
 *
 * ```jsonc
 * "imports": { "react-is": "jsr:@denext/denext/react-is" }
 * ```
 *
 * It classifies denext's own shapes: VNodes (elements), `Fragment`/`Suspense`/
 * portal markers, and `memo`/`forwardRef`/`lazy` components (recognized by the
 * `$$typeof` brand denext stamps on them). Context provider/consumer, profiler,
 * and strict-mode classifiers recognize denext's markers (a Fragment carrying a
 * `__dnxStrict`/`__dnxProfiler` prop, the branded `.Consumer`, the metadata-
 * carrying provider) rather than React's distinct element objects.
 *
 * @module
 */

import { FRAGMENT, PORTAL, type VNode } from "../jsx/types.ts";
import { SUSPENSE } from "../runtime/suspense.ts";
import { CONSUMER_BRAND } from "../runtime/context.ts";
import { STRICT_MODE_PROP, StrictMode as StrictModeComponent } from "../runtime/strict-mode.ts";
import { Profiler as ProfilerComponent, PROFILER_PROP } from "../runtime/profiler.ts";
import {
  brandOf,
  REACT_ELEMENT_TYPE,
  REACT_FORWARD_REF_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_LAZY_TYPE,
  REACT_LEGACY_ELEMENT_TYPE,
  REACT_MEMO_TYPE,
  REACT_PORTAL_TYPE,
  REACT_STRICT_MODE_TYPE,
  REACT_SUSPENSE_TYPE,
} from "../runtime/react-brands.ts";

// ---- Exported type-of symbols (react-is surface) ---------------------------

/** `$$typeof` brand of a React element. */
export const Element: symbol = REACT_ELEMENT_TYPE;
/** Type marker for a `Fragment`. */
export const Fragment: symbol = REACT_FRAGMENT_TYPE;
/** Brand for a `forwardRef` component. */
export const ForwardRef: symbol = REACT_FORWARD_REF_TYPE;
/** Brand for a `memo` component. */
export const Memo: symbol = REACT_MEMO_TYPE;
/** Brand for a `lazy` component. */
export const Lazy: symbol = REACT_LAZY_TYPE;
/** Type marker for a portal. */
export const Portal: symbol = REACT_PORTAL_TYPE;
/** Type marker for `Suspense`. */
export const Suspense: symbol = REACT_SUSPENSE_TYPE;
/** Type marker for `StrictMode`. */
export const StrictMode: symbol = REACT_STRICT_MODE_TYPE;
/** Type marker for `Profiler` (denext models it as a marked Fragment). */
export const Profiler: symbol = Symbol.for("react.profiler");
/** Type marker for a context provider (returned by {@link typeOf} for denext providers). */
export const ContextProvider: symbol = Symbol.for("react.context"); // React 19: the Context IS the Provider
/** Type marker for a context consumer (returned by {@link typeOf} for `.Consumer`). */
export const ContextConsumer: symbol = Symbol.for("react.consumer");

// ---- Helpers ---------------------------------------------------------------

/**
 * Whether `value` carries the React element `$$typeof` brand — matching React's own
 * `react-is.isElement` (and denext's {@link isValidElement} in `react.ts`). denext stamps
 * `$$typeof` on every VNode (`jsx-runtime`), so its own elements pass; a plain
 * `{ type, props }` object WITHOUT the brand is rejected, so config/data objects that
 * merely share that shape aren't misclassified as elements by libraries that route on
 * `react-is` (Radix, react-hook-form, emotion). (Previously this also accepted the bare
 * structural shape, which diverged from React and from `React.isValidElement`.)
 *
 * @param value Any value.
 * @returns Whether it is a renderable element.
 */
export function isElement(value: unknown): value is VNode {
  const b = brandOf(value);
  return b === REACT_ELEMENT_TYPE || b === REACT_LEGACY_ELEMENT_TYPE;
}

/** Alias of {@link isElement} (react-is also exports `isValidElementType`-style checks). */
export const isValidElement: (value: unknown) => value is VNode = isElement;

/**
 * The `type` a VNode-shaped value wraps, or the value itself otherwise. Unwraps
 * STRUCTURALLY (any `{ type }` object), independent of the strict `$$typeof` brand that
 * public {@link isElement} requires — the internal classifiers below (`isPortal`,
 * `isFragment`, `typeOf`, …) key on unique symbol markers on `.type`, which a plain data
 * object cannot forge, and some denext-internal shapes (e.g. a portal marker) carry the
 * structural shape without the element brand.
 */
function markerOf(value: unknown): unknown {
  return typeof value === "object" && value !== null && "type" in value
    ? (value as VNode).type
    : value;
}

/** Does `value` (element or bare type) carry the brand `b`? */
function hasBrand(value: unknown, b: symbol): boolean {
  return brandOf(value) === b || brandOf(markerOf(value)) === b;
}

// ---- Classifiers -----------------------------------------------------------

/**
 * The react-is "type of" symbol for `value` (element or type), or `undefined`.
 *
 * @param value An element or component type.
 * @returns The classifying symbol, or `undefined` when unrecognized.
 */
export function typeOf(value: unknown): symbol | undefined {
  // StrictMode/Profiler are modeled as marked Fragments, so classify them before the
  // bare-Fragment check below (a plain Fragment carries neither marker).
  if (isStrictMode(value)) return REACT_STRICT_MODE_TYPE;
  if (isProfiler(value)) return Profiler;
  const m = markerOf(value);
  if (m === FRAGMENT) return REACT_FRAGMENT_TYPE;
  if (m === PORTAL) return REACT_PORTAL_TYPE;
  if ((m as unknown) === SUSPENSE) return REACT_SUSPENSE_TYPE;
  const b = brandOf(m);
  if (
    b === REACT_MEMO_TYPE || b === REACT_FORWARD_REF_TYPE || b === REACT_LAZY_TYPE ||
    b === REACT_SUSPENSE_TYPE
  ) return b;
  // A denext context provider (the createContext result) / consumer (`.Consumer`) —
  // functions carrying context metadata, not distinct element objects.
  if (isContextProvider(value)) return ContextProvider;
  if (isContextConsumer(value)) return ContextConsumer;
  // Any other element (`<div/>`, `<MyComponent/>`) is a plain element, as in React.
  if (isElement(value)) return Element;
  return undefined;
}

/** Whether `value` is (or wraps) a `Fragment`. */
export function isFragment(value: unknown): boolean {
  return markerOf(value) === FRAGMENT;
}
/** Whether `value` is (or wraps) a portal. */
export function isPortal(value: unknown): boolean {
  return markerOf(value) === PORTAL;
}
/** Whether `value` is (or wraps) a `Suspense` boundary. */
export function isSuspense(value: unknown): boolean {
  return (markerOf(value) as unknown) === SUSPENSE || hasBrand(value, REACT_SUSPENSE_TYPE);
}
/** Whether `value` is (or wraps) a `forwardRef` component. */
export function isForwardRef(value: unknown): boolean {
  return hasBrand(value, REACT_FORWARD_REF_TYPE);
}
/** Whether `value` is (or wraps) a `memo` component. */
export function isMemo(value: unknown): boolean {
  return hasBrand(value, REACT_MEMO_TYPE);
}
/** Whether `value` is (or wraps) a `lazy` component. */
export function isLazy(value: unknown): boolean {
  return hasBrand(value, REACT_LAZY_TYPE);
}
/**
 * Whether `value` is (or wraps) `StrictMode`. denext models `<StrictMode>` as a
 * Fragment carrying the `STRICT_MODE_PROP` marker, so recognize both the bare
 * `StrictMode` component and a rendered element carrying that marker prop.
 */
export function isStrictMode(value: unknown): boolean {
  if (markerOf(value) === StrictModeComponent) return true;
  return isElement(value) &&
    (value as VNode).props?.[STRICT_MODE_PROP as keyof VNode["props"]] === true;
}
/**
 * Whether `value` is (or wraps) `Profiler`. denext models `<Profiler>` as a
 * Fragment carrying the `PROFILER_PROP` marker, so recognize both the bare
 * `Profiler` component and a rendered element carrying that marker prop.
 */
export function isProfiler(value: unknown): boolean {
  if (markerOf(value) === ProfilerComponent) return true;
  return isElement(value) &&
    (value as VNode).props?.[PROFILER_PROP as keyof VNode["props"]] != null;
}
/**
 * Whether `value` is (or wraps) a denext context provider. denext's `createContext`
 * result IS the provider (usable as `<Ctx value>` / `<Ctx.Provider value>`), so a
 * provider is a function carrying context metadata (`_id` + a `Provider`).
 */
export function isContextProvider(value: unknown): boolean {
  const t = markerOf(value);
  return typeof t === "function" && "_id" in (t as object) && "Provider" in (t as object);
}
/**
 * Whether `value` is (or wraps) a context consumer. denext's `createContext`
 * exposes a render-prop `.Consumer` branded with `CONSUMER_BRAND`; recognize that
 * brand (and React's `_context` back-reference libraries also set).
 */
export function isContextConsumer(value: unknown): boolean {
  const t = markerOf(value);
  return typeof t === "function" &&
    ((t as unknown as Record<symbol, unknown>)[CONSUMER_BRAND] === true ||
      "_context" in (t as object));
}

/**
 * Whether `value` is a valid element *type* (a string tag, a function component,
 * or a recognized marker/branded component).
 *
 * @param value Any value.
 * @returns Whether it can be used as an element type.
 */
export function isValidElementType(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "function") return true;
  if (value === FRAGMENT || value === PORTAL || (value as unknown) === SUSPENSE) return true;
  const b = brandOf(value);
  return b === REACT_MEMO_TYPE || b === REACT_FORWARD_REF_TYPE || b === REACT_LAZY_TYPE;
}

/** The default `react-is` namespace object. */
export default {
  Element,
  Fragment,
  ForwardRef,
  Memo,
  Lazy,
  Portal,
  Suspense,
  StrictMode,
  Profiler,
  ContextProvider,
  ContextConsumer,
  typeOf,
  isElement,
  isValidElement,
  isValidElementType,
  isFragment,
  isPortal,
  isSuspense,
  isForwardRef,
  isMemo,
  isLazy,
  isStrictMode,
  isProfiler,
  isContextProvider,
  isContextConsumer,
};
