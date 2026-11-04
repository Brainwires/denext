// The public `useEffectEvent`, beside `useInsertionEffect` (its commit-time swap), so a bundle
// carries either only when the app calls them.

import { activeDispatcher, rendering, useMemo, useRef } from "../hooks.ts";
import { useInsertionEffect } from "./use-insertion-effect.ts";

/** React 19.2's error for calling an Effect Event while a component renders. */
const EFFECT_EVENT_IN_RENDER =
  "A function wrapped in useEffectEvent can't be called during rendering.";

/**
 * Return a callback that always sees the latest committed props/state — React 19.2's
 * `useEffectEvent`. Use it for the "event" part of an Effect that should not itself be a
 * dependency (so the Effect doesn't re-run when the handler's closure changes).
 *
 * As in React, the handler it forwards to is swapped in when the render commits (before any
 * layout or passive effect runs), not while rendering, so a render that never commits leaves
 * the previous one in place; and calling it during a render throws. Its identity is stable
 * (React's is not guaranteed to be — don't list it as an Effect dependency either way).
 *
 * @param handler The event handler; its latest committed version is invoked.
 * @returns A function forwarding to the latest committed `handler`.
 */
export function useEffectEvent<A extends unknown[], R>(
  handler: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(handler);
  useInsertionEffect(() => {
    ref.current = handler; // commit-time swap (React updates Effect Events before effects)
  });
  const renderer = activeDispatcher();
  return useMemo(() => (...args: A) => {
    // The renderer's dispatcher is installed only while one of its components renders.
    if (rendering() && activeDispatcher() === renderer) throw new Error(EFFECT_EVENT_IN_RENDER);
    return ref.current(...args);
  }, []);
}
