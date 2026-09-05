/// <reference path="../globals.d.ts" />
/**
 * React-compatible entrypoint for denext.
 *
 * Alias `react` to this module in your project's import map so code (and
 * libraries) that `import ... from "react"` run on denext's runtime:
 *
 * ```jsonc
 * // deno.json
 * "imports": {
 *   "react": "jsr:@denext/denext/react",
 *   "react/jsx-runtime": "jsr:@denext/denext/react/jsx-runtime"
 * }
 * ```
 *
 * It re-exports denext's hooks and helpers under their React names
 * (`createElement`, `Fragment`, all the `use*` hooks, `memo`, `createContext`,
 * `Suspense`, `lazy` = `dynamic`, `Profiler`, `act`), plus small compat shims for
 * `forwardRef`, `createRef`, `Children`, `cloneElement`, and `isValidElement`. Class
 * components (`Component`/`PureComponent`) are supported when enabled via
 * `classComponents` in the next-compat build (they throw a guided error when off).
 *
 * @module
 */

import { Activity, cache, ViewTransition } from "../runtime/react-extras.ts";
import { REACT_COMPAT_VERSION } from "./react-version.ts";
import {
  createContext,
  Fragment,
  h,
  memo,
  Profiler,
  startTransition,
  Suspense,
  SuspenseList,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useFormState,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "../../mod.ts";
import { act } from "../client/mod.ts";
import { lazy as lazyImpl } from "../runtime/dynamic.ts";
import { StrictMode } from "../runtime/strict-mode.ts";
import {
  Children,
  type ChildrenApi,
  cloneElement,
  createRef,
  forwardRef,
  isValidElement,
} from "../runtime/react-core.ts";
export { Children, type ChildrenApi, cloneElement, createRef, forwardRef, isValidElement };
import {
  experimental_taintObjectReference,
  experimental_taintUniqueValue,
} from "../runtime/taint.ts";
// Side-effect: install the un-bundled `globalThis` default so the bare
// `__DENEXT_CLASS_COMPONENTS__` reads below resolve in dev/test (folds out of builds).
import "../runtime/class-flag.ts";

import {
  Component as RealComponent,
  PureComponent as RealPureComponent,
} from "./class-component.ts";

// The runtime class bases behind the `Component` / `PureComponent` value exports
// (see below). Re-exported under explicit aliases so those consts' `typeof`
// annotations reference a public symbol. Type-only; no runtime change. Names are
// chosen to avoid colliding with react-types.ts's `ComponentClass` interface.
export type {
  Component as ClassComponent,
  PureComponent as PureClassComponent,
} from "./class-component.ts";

export {
  act,
  createContext,
  Fragment,
  memo,
  Profiler,
  startTransition,
  Suspense,
  SuspenseList,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useFormState,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
};

/** `React.createElement` — denext's hyperscript. */
export const createElement: typeof h = h;
/** `React.lazy` — suspends to the nearest `<Suspense>` while its module loads. */
export const lazy: typeof lazyImpl = lazyImpl;
/** The React version denext reports for compatibility (matches the surface it tracks,
 * incl. the now-stable `useEffectEvent` from React 19.2). */
export const version: string = REACT_COMPAT_VERSION;
/** `React.StrictMode` — dev double-invoke of renders/effects; a Fragment otherwise. */
export { StrictMode };

/**
 * `React.experimental_taintObjectReference` / `experimental_taintUniqueValue` — mark a
 * value that must never be serialized to a client component. denext's Flight serializer
 * throws if a tainted object reference or secret string/bigint would cross the
 * server→client boundary. Defense-in-depth (a guardrail against *accidentally* leaking a
 * secret to the client), not a substitute for not passing secrets in the first place.
 */
export { experimental_taintObjectReference, experimental_taintUniqueValue };

/** `React.cache`, `React.Activity`, `React.ViewTransition` — see `src/runtime/react-extras.ts`. */
export { Activity, cache, ViewTransition };

/**
 * `React.cacheSignal` — the `AbortSignal` that aborts when the current cache scope is
 * torn down. denext has no client-side cache scope, so this returns `null` (React's
 * documented value outside a cache scope).
 *
 * @returns `null` (no active cache scope).
 */
export function cacheSignal(): AbortSignal | null {
  return null;
}

/**
 * `React.captureOwnerStack` (dev-only) — the component owner stack at the call site, for
 * building richer dev warnings. denext surfaces owner stacks through its DevTools rather
 * than this API, so it returns `null`.
 *
 * @returns `null`.
 */
export function captureOwnerStack(): string | null {
  return null;
}

/**
 * `React.addTransitionType` — tag the in-flight transition with a named type (a hint for
 * view transitions / instrumentation). denext has no transition-type registry, so this is
 * a no-op that accepts the type for signature parity.
 *
 * @param type The transition type name.
 */
export function addTransitionType(_type: string): void {
  // no-op — denext does not track transition types.
}

/**
 * `React.optimisticKey` — the sentinel key React uses to correlate optimistic updates.
 * Exposed as a stable symbol so code that references it resolves; denext's
 * {@linkcode useOptimistic} does not key by it.
 */
export const optimisticKey: symbol = Symbol.for("react.optimistic_key");

// The React-compatible TYPE surface (HTMLAttributes families, forwardRef generics,
// ComponentProps, ElementRef, ReactNode, events, …) so `import type { … } from
// "react"` resolves through the app's react→denext alias.
export type * from "./react-types.ts";
/** The `JSX` namespace (`JSX.Element`, `JSX.IntrinsicElements`) — `React.JSX` in React 18+. */
export type { JSX } from "../jsx/types.ts";
// The `Component` value export below (React's class base) shadows the same-named
// instance interface that `export type *` surfaces, which would leave that interface
// unreachable in the public type graph. Re-export the interface symbol under an
// explicit alias so it stays public and `ComponentClass`'s construct signature can
// reference it. Type-only; no runtime or semantic change.
export type { Component as ComponentInstance } from "./react-types.ts";

// Class components are gated by `classComponents` (denext.config.ts). When enabled,
// `Component`/`PureComponent` are the real class runtime (from class-component.ts);
// when off, they're a stub whose constructor throws a guided error — and because the
// real classes are referenced only inside the bare `__DENEXT_CLASS_COMPONENTS__`
// branch, the off build folds the ternary and drops class-component.ts entirely
// (zero cost). The stub is branded `isReactComponent` so the always-present detector
// (class-detect.ts) still recognizes user subclasses off, routing them to the guided
// error at render rather than an opaque native "cannot invoke class" failure.

/** Stub used when `classComponents` is off — construction throws a guided error. */
class DisabledComponent {
  constructor() {
    throw new Error(
      "denext: class components are disabled. Set `classComponents: true` in " +
        "denext.config.ts to enable them (adds the class runtime to the client bundle).",
    );
  }
}
(DisabledComponent.prototype as { isReactComponent?: unknown }).isReactComponent = true;

/** `React.Component` — real base class when `classComponents` is on, else a guard. */
export const Component: typeof RealComponent = __DENEXT_CLASS_COMPONENTS__
  ? RealComponent
  : (DisabledComponent as unknown as typeof RealComponent);
/** `React.PureComponent` — real when `classComponents` is on, else a guard. */
export const PureComponent: typeof RealPureComponent = __DENEXT_CLASS_COMPONENTS__
  ? RealPureComponent
  : (DisabledComponent as unknown as typeof RealPureComponent);

/** The default `React` namespace object (`import React from "react"`). */
export default {
  createElement,
  Fragment,
  lazy,
  version,
  StrictMode,
  ViewTransition,
  Activity,
  experimental_taintObjectReference,
  experimental_taintUniqueValue,
  cacheSignal,
  captureOwnerStack,
  addTransitionType,
  optimisticKey,
  forwardRef,
  createRef,
  cache,
  isValidElement,
  cloneElement,
  Children,
  Component,
  PureComponent,
  memo,
  Profiler,
  createContext,
  Suspense,
  SuspenseList,
  use,
  act,
  startTransition,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useFormState,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
};
