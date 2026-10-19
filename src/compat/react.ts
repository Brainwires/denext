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
import { dispatched, type ReactSharedInternals, sharedInternals } from "./react-internals.ts";
export type { ReactDispatcher, ReactSharedInternals } from "./react-internals.ts";
import {
  createContext,
  Fragment,
  h,
  memo,
  Profiler,
  startTransition,
  Suspense,
  SuspenseList,
  use as ownUse,
  useActionState as ownUseActionState,
  useCallback as ownUseCallback,
  useContext as ownUseContext,
  useDebugValue as ownUseDebugValue,
  useDeferredValue as ownUseDeferredValue,
  useEffect as ownUseEffect,
  useEffectEvent as ownUseEffectEvent,
  useFormState as ownUseFormState,
  useId as ownUseId,
  useImperativeHandle as ownUseImperativeHandle,
  useInsertionEffect as ownUseInsertionEffect,
  useLayoutEffect as ownUseLayoutEffect,
  useMemo as ownUseMemo,
  useOptimistic as ownUseOptimistic,
  useReducer as ownUseReducer,
  useRef as ownUseRef,
  useState as ownUseState,
  useSyncExternalStore as ownUseSyncExternalStore,
  useTransition as ownUseTransition,
} from "../../mod.ts";
import { act } from "../client/mod.ts";
import { currentOwnerStack } from "../runtime/hooks.ts";
import { addTransitionType as addTransitionTypeImpl } from "../client/fiber/view-transition-support.ts";
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

import { Component as RealComponent, PureComponent as RealPureComponent } from "./class-base.ts";

// The runtime class bases behind the `Component` / `PureComponent` value exports
// (see below). Re-exported under explicit aliases so those consts' `typeof`
// annotations reference a public symbol. Type-only; no runtime change. Names are
// chosen to avoid colliding with react-types.ts's `ComponentClass` interface.
export type {
  Component as ClassComponent,
  PureComponent as PureClassComponent,
} from "./class-base.ts";

export { act, createContext, Fragment, memo, Profiler, startTransition, Suspense, SuspenseList };

/**
 * React's shared internals: a `react-reconciler` renderer (React Native Skia, react-three-fiber,
 * react-konva) reads it when it loads and installs its hooks dispatcher in it while it renders.
 */
export const __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: ReactSharedInternals =
  sharedInternals;

/** React's `use`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const use: typeof ownUse = dispatched("use", ownUse);
/** React's `useActionState`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useActionState: typeof ownUseActionState = dispatched(
  "useActionState",
  ownUseActionState,
);
/** React's `useCallback`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useCallback: typeof ownUseCallback = dispatched("useCallback", ownUseCallback);
/** React's `useContext`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useContext: typeof ownUseContext = dispatched("useContext", ownUseContext);
/** React's `useDebugValue`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useDebugValue: typeof ownUseDebugValue = dispatched("useDebugValue", ownUseDebugValue);
/** React's `useDeferredValue`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useDeferredValue: typeof ownUseDeferredValue = dispatched(
  "useDeferredValue",
  ownUseDeferredValue,
);
/** React's `useEffect`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useEffect: typeof ownUseEffect = dispatched("useEffect", ownUseEffect);
/** React's `useEffectEvent`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useEffectEvent: typeof ownUseEffectEvent = dispatched(
  "useEffectEvent",
  ownUseEffectEvent,
);
/** React's `useFormState`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useFormState: typeof ownUseFormState = dispatched("useFormState", ownUseFormState);
/** React's `useId`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useId: typeof ownUseId = dispatched("useId", ownUseId);
/** React's `useImperativeHandle`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useImperativeHandle: typeof ownUseImperativeHandle = dispatched(
  "useImperativeHandle",
  ownUseImperativeHandle,
);
/** React's `useInsertionEffect`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useInsertionEffect: typeof ownUseInsertionEffect = dispatched(
  "useInsertionEffect",
  ownUseInsertionEffect,
);
/** React's `useLayoutEffect`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useLayoutEffect: typeof ownUseLayoutEffect = dispatched(
  "useLayoutEffect",
  ownUseLayoutEffect,
);
/** React's `useMemo`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useMemo: typeof ownUseMemo = dispatched("useMemo", ownUseMemo);
/** React's `useOptimistic`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useOptimistic: typeof ownUseOptimistic = dispatched("useOptimistic", ownUseOptimistic);
/** React's `useReducer`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useReducer: typeof ownUseReducer = dispatched("useReducer", ownUseReducer);
/** React's `useRef`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useRef: typeof ownUseRef = dispatched("useRef", ownUseRef);
/** React's `useState`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useState: typeof ownUseState = dispatched("useState", ownUseState);
/** React's `useSyncExternalStore`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useSyncExternalStore: typeof ownUseSyncExternalStore = dispatched(
  "useSyncExternalStore",
  ownUseSyncExternalStore,
);
/** React's `useTransition`: denext's, or a foreign renderer's while one renders (see react-internals.ts). */
export const useTransition: typeof ownUseTransition = dispatched("useTransition", ownUseTransition);

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
/** `React.FragmentInstance` — what `<Fragment ref>` receives (React 19.3). */
export type { FragmentInstance } from "../runtime/react-extras.ts";

/**
 * `React.cacheSignal` — during a server render, an `AbortSignal` that aborts when the render's
 * cache scope ends: the render finished (its last streamed byte included), failed, or was
 * aborted (the client disconnected, the request timed out). Thread it into a `fetch()` or other
 * cancellable work started from a `cache()`d function or a Server Component, so work the render
 * no longer needs is cancelled.
 *
 * It returns `null` on the client, outside a request (a script, a job, module init) and inside a
 * `"use cache"` scope, whose fill readers share, so one request ending never aborts it — as
 * React returns `null` outside a render.
 *
 * @returns The render's signal, or `null` with no server render in progress.
 */
export function cacheSignal(): AbortSignal | null {
  return (globalThis as { __denextCacheSignal?: () => AbortSignal | null })
    .__denextCacheSignal?.() ?? null;
}

/**
 * `React.captureOwnerStack` (development only) — the owner stack at the call site, for richer
 * dev warnings: called while a component renders, the components above it, nearest first,
 * formatted as React 19 formats it (`"\n    at Parent (file:line:column)\n    at App (…)"`, the
 * caller itself not included). It is the chain denext's DevTools panel shows; the location is
 * where each component was declared, and a component the dev build didn't register prints as
 * `"\n    at Name"`.
 *
 * It returns `null` in production (as React's does), outside a client render (an event handler,
 * an effect) and during a server render.
 *
 * @returns The owner stack, or `null`.
 */
export function captureOwnerStack(): string | null {
  return currentOwnerStack();
}

/**
 * `React.addTransitionType` — tag the in-flight transition with a named type. denext buffers
 * the types (see `view-transition-support.ts`); the navigation runtime drains them into
 * `document.startViewTransition({ types })` and `<ViewTransition>`'s `enter`/`exit`/`update`/
 * `share` type→class maps resolve against them, so `:active-view-transition-type(name)` and a
 * per-type class both work. Off the client (SSR) the buffer is simply never consumed.
 *
 * @param type The transition type name.
 */
export function addTransitionType(type: string): void {
  addTransitionTypeImpl(type);
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
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
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
