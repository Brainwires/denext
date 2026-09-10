/**
 * `useEventListener` / `useClickOutside` — declarative DOM event subscription
 * with correct cleanup and no stale closures (the latest handler is always
 * called via a ref). Both are client-only and no-ops during SSR.
 *
 * @module
 */

import { useEffect, useRef } from "../runtime/hooks.ts";
import type { RefObject } from "../compat/react-types.ts";

/** Options for {@linkcode useEventListener}. */
export interface UseEventListenerOptions {
  /**
   * The target to attach to: an `EventTarget`, a ref to one, or `null`.
   * Defaults to the global object (`window`). A ref is resolved on each
   * (re)subscribe, so it may start `null`.
   */
  target?: EventTarget | RefObject<EventTarget | null> | null;
  /** Listen during the capture phase. */
  capture?: boolean;
  /** Register a passive listener (cannot call `preventDefault`). */
  passive?: boolean;
  /** Remove the listener automatically after it fires once. */
  once?: boolean;
}

/** Resolve the configured target to a concrete `EventTarget`, or `null`. */
function resolveTarget(
  target: EventTarget | RefObject<EventTarget | null> | null | undefined,
): EventTarget | null {
  if (target === undefined) {
    return typeof globalThis.addEventListener === "function" ? globalThis : null;
  }
  if (target === null) return null;
  if ("current" in (target as RefObject<EventTarget | null>)) {
    return (target as RefObject<EventTarget | null>).current;
  }
  return target as EventTarget;
}

/**
 * Attach a DOM event listener for the lifetime of the component. The handler is
 * held in a ref, so passing a fresh closure each render never re-subscribes and
 * never goes stale.
 *
 * @param type The event name (typed against `WindowEventMap`, e.g. `"resize"`,
 * `"keydown"`).
 * @param handler Called with the event; always the latest closure.
 * @param options {@linkcode UseEventListenerOptions} — `target` (default
 * `window`), `capture`, `passive`, `once`.
 * @example
 * ```tsx
 * "use client";
 * import { useEventListener } from "denext";
 * useEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
 * ```
 */
export function useEventListener<K extends keyof WindowEventMap>(
  type: K,
  handler: (event: WindowEventMap[K]) => void,
  options: UseEventListenerOptions = {},
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const { target, capture, passive, once } = options;

  useEffect(() => {
    const el = resolveTarget(target);
    if (!el || typeof el.addEventListener !== "function") return;
    const listener = (event: Event) => handlerRef.current(event as WindowEventMap[K]);
    const listenerOptions = { capture, passive, once };
    el.addEventListener(type, listener, listenerOptions);
    return () => el.removeEventListener(type, listener, listenerOptions);
  }, [type, target, capture, passive, once]);
}

/**
 * Call `handler` when a pointer/touch event lands outside the referenced
 * element — the "click away to dismiss" pattern for menus, popovers, and
 * dialogs. Listens in the capture phase so it runs before inner handlers.
 * No-op during SSR.
 *
 * @param ref A ref to the element whose inside is "safe".
 * @param handler Called with the originating event when the interaction is
 * outside `ref.current`.
 * @param events The event names that count as an outside interaction (default
 * `["mousedown", "touchstart"]`).
 * @example
 * ```tsx
 * "use client";
 * import { useClickOutside } from "denext";
 * const ref = useRef<HTMLDivElement>(null);
 * useClickOutside(ref, () => setOpen(false));
 * ```
 */
export function useClickOutside<T extends { contains(node: Node | null): boolean }>(
  ref: RefObject<T | null>,
  handler: (event: Event) => void,
  events: readonly string[] = ["mousedown", "touchstart"],
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const eventsKey = events.join(",");

  useEffect(() => {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    const names = eventsKey.split(",");
    const listener = (event: Event) => {
      const el = ref.current;
      const node = event.target as Node | null;
      if (el && node && !el.contains(node)) handlerRef.current(event);
    };
    for (const name of names) document.addEventListener(name, listener, true);
    return () => {
      for (const name of names) document.removeEventListener(name, listener, true);
    };
  }, [ref, eventsKey]);
}
