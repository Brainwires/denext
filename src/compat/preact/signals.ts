/**
 * `denext/signals` — Preact Signals' API (`@preact/signals`, `@preact/signals-core` and
 * `@preact/signals/utils`) on denext: `signal`, `computed`, `effect`, `batch`, `untracked`,
 * `action`, the `Signal` class, the component hooks (`useSignal`, `useComputed`,
 * `useSignalEffect`, `useLiveSignal`) and the `Show` / `For` helpers.
 *
 * A component re-renders when a signal its render read changes, as with Preact: reading
 * `count.value` while rendering subscribes that component (on the client; a server render reads
 * the value once). A signal placed in JSX as a child (`<p>{count}</p>`) renders its value as text
 * and updates in place. A signal a Server Component passes to a `"use client"` component as a prop
 * arrives as a live signal, and two components handed the same signal share it, as islands do in
 * Fresh.
 *
 * Reactivity is per component: a change re-renders the components that read the signal (Preact
 * patches a signal child's text node directly). Effects run synchronously after the write that
 * triggered them (at the end of the outermost {@link batch}).
 *
 * @module
 */

import { REACT_ELEMENT_TYPE } from "../../runtime/react-brands.ts";
import { setSignalReviver, SIGNAL_BRAND } from "../../runtime/signal-brand.ts";
import { type Dispatcher, useEffect, useMemo, useRef } from "../../runtime/hooks.ts";
import type { VNode, VNodeChildren, VNodeType, VProps } from "../../jsx/types.ts";
import { setHostPropsTransform } from "../../jsx/jsx-runtime.ts";

// ── Tracking state ───────────────────────────────────────────────────────────

/** A computed or an effect: something that re-evaluates when a signal it read changes. */
interface Computation {
  /** The signals read during the last evaluation, with the version each had then. */
  _sources: Map<Signal<unknown>, number>;
  /** A source changed: mark stale (computed) or queue a re-run (effect). */
  _stale(): void;
}

/** The computation currently evaluating (its reads become its sources), or null. */
let evaluating: Computation | null = null;
/** Inside {@link untracked}: reads subscribe nothing, not even the rendering component. */
let untrackedDepth = 0;
/** Open {@link batch} scopes; effects and re-renders flush when the outermost closes. */
let batchDepth = 0;
/** Effects queued to re-run at the end of the batch. */
const pendingEffects = new Set<EffectImpl>();
/** Components queued to re-render at the end of the batch (token → its dispatcher). */
const pendingRenders = new Map<object, Dispatcher>();
/** Components found unmounted: their subscriptions are dropped on the next notify. */
const unmounted = new WeakSet<object>();

const DISPATCHER_KEY = Symbol.for("denext.currentDispatcher");

/** The hook dispatcher of the component rendering right now (null outside a render). */
function activeDispatcher(): Dispatcher | null {
  return (globalThis as { [DISPATCHER_KEY]?: Dispatcher | null })[DISPATCHER_KEY] ?? null;
}

/** Bound on effect re-run rounds in one flush (a cycle of effects writing each other). */
const MAX_FLUSH_ROUNDS = 100;

/** Run the queued effects and re-renders (the outermost batch closed). */
function flush(): void {
  let rounds = 0;
  while (pendingEffects.size > 0 || pendingRenders.size > 0) {
    if (++rounds > MAX_FLUSH_ROUNDS) {
      pendingEffects.clear();
      pendingRenders.clear();
      throw new Error("denext/signals: effects kept changing the signals they read (a cycle)");
    }
    const renders = [...pendingRenders];
    pendingRenders.clear();
    for (const [token, dispatcher] of renders) {
      if (!dispatcher.rerenderComponent!(token)) unmounted.add(token);
    }
    const effects = [...pendingEffects];
    pendingEffects.clear();
    batchDepth++;
    try {
      for (const e of effects) e._runIfChanged();
    } finally {
      batchDepth--;
    }
  }
}

// ── Signal ───────────────────────────────────────────────────────────────────

/**
 * A reactive value. Read `.value` to use it (subscribing the computed, effect or component that
 * reads it), assign `.value` to change it. `peek()` reads without subscribing.
 */
export class Signal<T = unknown> {
  /** @internal The current value. */
  _value: T;
  /** @internal Bumped on every change (a computation compares it to decide whether to re-run). */
  _version: number = 0;
  /** @internal The computations that read this signal. */
  _targets: Set<Computation> = new Set();
  /** @internal The components whose render read this signal (token → dispatcher). */
  _renders: Map<object, Dispatcher> | undefined = undefined;
  /** The Preact Signals brand (`Symbol.for("preact-signals")`). */
  declare readonly brand: symbol;
  // A signal is element-shaped (see below), so it type-checks as a JSX child.
  /** @internal Element shape: the React element brand. */
  declare readonly $$typeof: symbol;
  /** @internal Element shape: the component rendering the value. */
  declare readonly type: VNodeType;
  /** @internal Element shape: the props it renders with. */
  declare readonly props: VProps;
  /** @internal Element shape: no key. */
  declare readonly key: null;

  /**
   * Create a signal.
   *
   * @param value The initial value.
   */
  constructor(value?: T) {
    this._value = value as T;
  }

  /** The value; reading subscribes, assigning notifies. */
  get value(): T {
    this._track();
    return this._value;
  }

  set value(next: T) {
    if (Object.is(next, this._value)) return;
    if (evaluating instanceof ComputedImpl) {
      throw new Error("denext/signals: a computed must not write to a signal");
    }
    this._value = next;
    this._version++;
    batch(() => this._notify());
  }

  /** The value, read without subscribing. */
  peek(): T {
    return this._value;
  }

  /**
   * Call `fn` with the value now and after every change; returns the unsubscribe function.
   *
   * @param fn The listener.
   */
  subscribe(fn: (value: T) => void): () => void {
    return effect(() => {
      const value = this.value;
      untracked(() => fn(value));
    });
  }

  /** The value as a string (reading subscribes). */
  toString(): string {
    return String(this.value);
  }

  /** The value itself, for `JSON.stringify`. */
  toJSON(): T {
    return this.value;
  }

  /** The value itself, for arithmetic and comparisons. */
  valueOf(): T {
    return this.value;
  }

  /** @internal Subscribe whoever is reading: a computation, else a rendering component. */
  _track(): void {
    if (untrackedDepth > 0) return;
    if (evaluating !== null) {
      evaluating._sources.set(this as Signal<unknown>, this._version);
      this._targets.add(evaluating);
      return;
    }
    const dispatcher = activeDispatcher();
    const token = dispatcher?.renderingComponent?.();
    if (!token) return;
    (this._renders ??= new Map()).set(token, dispatcher!);
  }

  /** @internal Tell every reader the value changed. */
  _notify(): void {
    for (const target of [...this._targets]) target._stale();
    const renders = this._renders;
    if (!renders) return;
    for (const [token, dispatcher] of renders) {
      if (unmounted.has(token)) renders.delete(token);
      else pendingRenders.set(token, dispatcher);
    }
  }
}

/** A child rendered for a signal placed in JSX: the signal's current value. */
function SignalValue(props: { s: Signal<unknown> }): unknown {
  const value = props.s.value;
  if (value === null || value === undefined || typeof value === "boolean") return null;
  return typeof value === "object" || typeof value === "function" ? value : String(value);
}

// A signal is element-shaped, as in Preact Signals: `{count}` in JSX renders `<SignalValue s />`.
Object.defineProperties(Signal.prototype, {
  brand: { value: SIGNAL_BRAND, configurable: true },
  $$typeof: { value: REACT_ELEMENT_TYPE, configurable: true },
  type: { value: SignalValue, configurable: true },
  key: { value: null, configurable: true },
  props: {
    get(this: Signal<unknown>) {
      return { s: this };
    },
    configurable: true,
  },
});

/** A signal that can be read but not written. */
export interface ReadonlySignal<T = unknown> {
  /** The value; reading subscribes. */
  readonly value: T;
  /** The value, read without subscribing. */
  peek(): T;
  /** Call `fn` with the value now and after every change; returns the unsubscribe function. */
  subscribe(fn: (value: T) => void): () => void;
  /** The value itself. */
  valueOf(): T;
  /** The value as a string. */
  toString(): string;
  /** The value itself, for `JSON.stringify`. */
  toJSON(): T;
  /** The Preact Signals brand. */
  readonly brand: symbol;
}

/**
 * Create a signal.
 *
 * @param value The initial value.
 * @returns The signal.
 */
export function signal<T>(value: T): Signal<T>;
/**
 * Create a signal holding `undefined`.
 *
 * @returns The signal.
 */
export function signal<T = undefined>(): Signal<T | undefined>;
export function signal<T>(value?: T): Signal<T> {
  return new Signal<T>(value);
}

// ── Computations ─────────────────────────────────────────────────────────────

/** Evaluate `fn` with `computation` collecting its reads as the new source set. */
function evaluate<R>(computation: Computation, fn: () => R): R {
  for (const source of computation._sources.keys()) source._targets.delete(computation);
  computation._sources.clear();
  const prev = evaluating;
  evaluating = computation;
  try {
    return fn();
  } finally {
    evaluating = prev;
  }
}

/** Whether any source changed since `computation` last evaluated (refreshing stale computeds). */
function sourcesChanged(computation: Computation): boolean {
  for (const [source, version] of computation._sources) {
    if (source instanceof ComputedImpl) source._refresh();
    if (source._version !== version) return true;
  }
  return false;
}

/** A computed signal's implementation: re-derived lazily when read after a source changed. */
class ComputedImpl<T> extends Signal<T> implements Computation {
  _sources = new Map<Signal<unknown>, number>();
  _fn: () => T;
  _dirty = true;
  _initialized = false;

  constructor(fn: () => T) {
    super(undefined);
    this._fn = fn;
  }

  override get value(): T {
    this._refresh();
    this._track();
    return this._value;
  }

  override set value(_next: T) {
    throw new Error("denext/signals: a computed signal is read-only");
  }

  override peek(): T {
    this._refresh();
    return this._value;
  }

  _refresh(): void {
    if (!this._dirty) return;
    this._dirty = false;
    if (this._initialized && !sourcesChanged(this)) return;
    const next = evaluate(this, this._fn);
    if (!this._initialized || !Object.is(next, this._value)) {
      this._value = next;
      this._version++;
    }
    this._initialized = true;
  }

  _stale(): void {
    if (this._dirty) return;
    this._dirty = true;
    this._notify();
  }
}

/**
 * A signal derived from other signals: `fn` re-runs (lazily, when read) after one it read
 * changed.
 *
 * @param fn Computes the value.
 * @returns A read-only signal.
 */
export function computed<T>(fn: () => T): ReadonlySignal<T> {
  return new ComputedImpl(fn) as unknown as ReadonlySignal<T>;
}

/** An effect's implementation: re-runs after a signal it read changed. */
class EffectImpl implements Computation {
  _sources = new Map<Signal<unknown>, number>();
  _fn: () => unknown;
  _cleanup: (() => void) | undefined = undefined;
  _disposed = false;

  constructor(fn: () => unknown) {
    this._fn = fn;
  }

  _run(): void {
    this._runCleanup();
    const result = evaluate(this, this._fn);
    if (typeof result === "function") this._cleanup = result as () => void;
  }

  _runIfChanged(): void {
    if (!this._disposed && sourcesChanged(this)) this._run();
  }

  _runCleanup(): void {
    const cleanup = this._cleanup;
    this._cleanup = undefined;
    if (cleanup) untracked(cleanup);
  }

  _stale(): void {
    if (!this._disposed) pendingEffects.add(this);
  }

  _dispose(): void {
    this._disposed = true;
    pendingEffects.delete(this);
    for (const source of this._sources.keys()) source._targets.delete(this);
    this._sources.clear();
    this._runCleanup();
  }
}

/** The function {@link effect} returns: disposes the effect (also `using`-disposable). */
export type EffectDispose = (() => void) & { [Symbol.dispose](): void };

/**
 * Run `fn` now and again after any signal it read changes. `fn` may return a cleanup, run
 * before the next run and on dispose.
 *
 * @param fn The effect.
 * @returns Its dispose function.
 */
export function effect(fn: () => unknown): EffectDispose {
  const e = new EffectImpl(fn);
  batch(() => e._run());
  const dispose = (() => e._dispose()) as EffectDispose;
  dispose[Symbol.dispose] = dispose;
  return dispose;
}

/**
 * Apply several writes as one change: effects and re-renders run once, when the outermost batch
 * ends.
 *
 * @param fn The writes.
 * @returns What `fn` returned.
 */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    if (--batchDepth === 0) flush();
  }
}

/**
 * Run `fn` without subscribing to the signals it reads.
 *
 * @param fn The reads.
 * @returns What `fn` returned.
 */
export function untracked<T>(fn: () => T): T {
  const prev = evaluating;
  evaluating = null;
  untrackedDepth++;
  try {
    return fn();
  } finally {
    untrackedDepth--;
    evaluating = prev;
  }
}

/**
 * Wrap `fn` so each call is batched and reads nothing reactively (`@preact/signals-core`'s
 * `action`).
 *
 * @param fn The action.
 * @returns The wrapped action.
 */
export function action<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args: A) => batch(() => untracked(() => fn(...args)));
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/**
 * A signal owned by the component (created once, kept across renders).
 *
 * @param value The initial value.
 * @returns The component's signal.
 */
export function useSignal<T>(value: T): Signal<T>;
/**
 * A component-owned signal holding `undefined`.
 *
 * @returns The component's signal.
 */
export function useSignal<T = undefined>(): Signal<T | undefined>;
export function useSignal<T>(value?: T): Signal<T> {
  return useMemo(() => new Signal<T>(value), []);
}

/**
 * A computed signal owned by the component; `fn` is always the latest render's.
 *
 * @param fn Computes the value.
 * @returns The component's computed signal.
 */
export function useComputed<T>(fn: () => T): ReadonlySignal<T> {
  const latest = useRef(fn);
  latest.current = fn;
  return useMemo(() => computed(() => latest.current()), []);
}

/**
 * An {@link effect} owned by the component: started after mount, disposed on unmount; `fn` is
 * always the latest render's.
 *
 * @param fn The effect.
 */
export function useSignalEffect(fn: () => unknown): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => effect(() => latest.current()), []);
}

/**
 * A signal that follows `value` (a prop): updated whenever the component renders with a new one.
 *
 * @param value The value to follow.
 * @returns The signal.
 */
export function useLiveSignal<T>(value: T): ReadonlySignal<T> {
  const s = useSignal(value);
  if (!Object.is(s.peek(), value)) untracked(() => (s.value = value));
  return s;
}

// ── @preact/signals/utils ────────────────────────────────────────────────────

/** Props of {@link Show}. */
export interface ShowProps<T = boolean> {
  /** The condition (a signal or a value). */
  when: Signal<T> | ReadonlySignal<T> | T;
  /** Rendered while `when` is falsy. */
  fallback?: VNodeChildren;
  /** Rendered while `when` is truthy; a function receives its value. */
  children?: VNodeChildren | ((value: T) => VNodeChildren);
}

/**
 * Render `children` while `when` is truthy, else `fallback` (`@preact/signals/utils`).
 *
 * @param props The condition and the two branches.
 * @returns The branch.
 */
export function Show<T = boolean>(props: ShowProps<T>): VNode {
  const value = props.when instanceof Signal ? props.when.value : props.when as T;
  const children = props.children;
  const out = !value ? props.fallback : typeof children === "function" ? children(value) : children;
  return (out ?? null) as unknown as VNode;
}

/** Props of {@link For}. */
export interface ForProps<T> {
  /** The items (a signal or an array). */
  each: Signal<T[]> | ReadonlySignal<T[]> | T[];
  /** Rendered when there are no items. */
  fallback?: VNodeChildren;
  /** Renders one item. */
  children: (item: T, index: number) => VNodeChildren;
}

/**
 * Render `children` for each item of `each`, or `fallback` when it is empty
 * (`@preact/signals/utils`).
 *
 * @param props The items and the item renderer.
 * @returns The rendered items.
 */
export function For<T>(props: ForProps<T>): VNode {
  const items = props.each instanceof Signal ? props.each.value : props.each as T[];
  const out = !items || items.length === 0
    ? props.fallback
    : items.map((item, i) => props.children(item, i));
  return (out ?? null) as unknown as VNode;
}

// ── Signals as DOM props ──────────────────────────────────────────────────────

// `<input value={text} />`: an intrinsic element's signal-valued prop becomes the signal's value,
// read while the owning component renders, so that component follows the signal. A signal child
// stays a signal (it renders through `SignalValue`).
setHostPropsTransform((props: VProps) => {
  for (const name in props) {
    if (name === "children") continue;
    const value = (props as Record<string, unknown>)[name];
    if (value instanceof Signal) (props as Record<string, unknown>)[name] = value.value;
  }
});

// ── Server → client hand-off ─────────────────────────────────────────────────

/** The client signals revived from the page's Flight payloads, by wire id. */
const revived = new Map<number, Signal<unknown>>();

setSignalReviver((value, id) => {
  if (id === undefined) return new Signal(value);
  const existing = revived.get(id);
  if (existing) return existing;
  const s = new Signal(value);
  revived.set(id, s);
  return s;
});
