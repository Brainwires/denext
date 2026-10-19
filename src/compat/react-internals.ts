/**
 * React's shared internals, for renderers built on `react-reconciler`.
 *
 * A custom React renderer (`react-reconciler`: React Native Skia's `<Canvas>`, react-three-fiber,
 * react-konva, ink, react-pdf) brings its own fiber tree. It reads React's
 * `__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE` object when it loads, and while
 * it renders a component it puts its hooks dispatcher in `H`, so the `useState` / `useEffect` /
 * `useContext` the component imported from `react` run against ITS fiber. denext's `react` exports
 * the same object, and its hooks hand the call to `H` whenever denext itself is not rendering
 * (after its first render a renderer leaves a dispatcher in `H` that throws on any hook call).
 *
 * Fields (React 19): `H` the hooks dispatcher, `A` the async dispatcher (`cache`), `T` the current
 * transition, `S` the start-transition callback a renderer chains onto. denext's own renderer uses
 * none of them.
 *
 * @module
 */

import { rendering } from "../runtime/hooks.ts";

/** A hooks dispatcher a foreign renderer installs (`useState`, `useEffect`, …). */
// deno-lint-ignore no-explicit-any
export type ReactDispatcher = Record<string, (...args: any[]) => any>;

/** The shared-internals object a `react-reconciler` build reads from `react`. */
export interface ReactSharedInternals {
  /** The hooks dispatcher while a foreign renderer renders a component, else null. */
  H: ReactDispatcher | null;
  /** The async dispatcher (`getCacheForType`, `getOwner`), set by a foreign renderer. */
  A: unknown;
  /** The current transition, set by a foreign renderer's `startTransition`. */
  T: unknown;
  /** The start-transition callback a renderer chains onto. */
  S: ((transition: unknown, returnValue: unknown) => void) | null;
}

/** The one shared-internals object (React keeps one per `react` instance). */
export const sharedInternals: ReactSharedInternals = { H: null, A: null, T: null, S: null };

/**
 * Wrap one of denext's hooks so that, while a foreign renderer's dispatcher is installed, the call
 * goes to that dispatcher's hook of the same name (as React's own `useState` does).
 *
 * @param name The hook's name on React's dispatcher.
 * @param own denext's hook.
 * @returns The hook React code imports.
 */
// deno-lint-ignore no-explicit-any
export function dispatched<F extends (...args: any[]) => any>(name: string, own: F): F {
  const hook = function (this: unknown, ...args: Parameters<F>): ReturnType<F> {
    // React leaves its "context only" dispatcher in `H` between renders (a hook called there
    // throws), so `H` alone does not say a foreign renderer is rendering: denext's own render
    // (its dispatcher installed) always takes denext's hooks.
    const foreign = rendering() ? undefined : sharedInternals.H?.[name];
    return foreign ? foreign(...args) : own.apply(this, args);
  };
  Object.defineProperty(hook, "name", { value: own.name || name });
  return hook as unknown as F;
}
