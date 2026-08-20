// Signals — opt-in reactive state whose values are serializable, so they can be
// transported from server to client and ADOPTED on resume rather than recomputed
// by re-running the component (the substrate for resumability, stage 3).
//
// Built on the existing hook machinery (useRef + a force-update), so it works in
// every dispatcher with no reconciler change and stays orthogonal to React-parity
// hooks — code that does not opt in keeps useState exactly as before. Reactivity
// is component-scoped (a write re-renders the owning component), matching React's
// model; fine-grained per-subscriber updates are a later optimization.

import { useRef, useState } from "./hooks.ts";

/** A reactive box holding a single serializable value. */
export interface Signal<T> {
  /** The current value; reading it in render subscribes, assigning it re-renders. */
  value: T;
  /** Read the value WITHOUT subscribing (no re-render is scheduled on later writes). */
  peek(): T;
}

class SignalImpl<T> implements Signal<T> {
  private _value: T;
  private readonly _notify: () => void;
  constructor(value: T, notify: () => void) {
    this._value = value;
    this._notify = notify;
  }
  get value(): T {
    return this._value;
  }
  set value(next: T) {
    if (Object.is(next, this._value)) return;
    this._value = next;
    this._notify();
  }
  peek(): T {
    return this._value;
  }
}

/**
 * A component-local reactive value. Read `signal.value` to use it, assign
 * `signal.value = next` to update it (re-rendering the owning component). Unlike
 * `useState`, the same `Signal` object is stable across renders — pass it to a
 * child without re-subscribing the parent.
 *
 * @param initial The initial value (used only on first render / when not resumed).
 */
export function useSignal<T>(initial: T): Signal<T> {
  const [, force] = useState(0);
  const ref = useRef<Signal<T> | null>(null);
  if (ref.current === null) {
    ref.current = new SignalImpl<T>(initial, () => force((n) => n + 1));
  }
  return ref.current;
}

/**
 * A component-local reactive object. Assigning a top-level property re-renders the
 * owning component; reading is transparent. Shallow — nested-object mutations do
 * not notify (assign a new nested object instead).
 *
 * @param initial The initial object (used only on first render / when not resumed).
 */
export function useStore<T extends object>(initial: T): T {
  const [, force] = useState(0);
  const ref = useRef<T | null>(null);
  if (ref.current === null) {
    ref.current = new Proxy(initial, {
      set(target, key, value) {
        const prev = (target as Record<PropertyKey, unknown>)[key];
        if (Object.is(prev, value)) return true;
        (target as Record<PropertyKey, unknown>)[key] = value;
        force((n) => n + 1);
        return true;
      },
    });
  }
  return ref.current;
}
