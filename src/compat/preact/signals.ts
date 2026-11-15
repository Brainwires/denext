/**
 * `denext/signals` — Preact Signals' API (`@preact/signals`, `@preact/signals-core` and
 * `@preact/signals/utils`) on denext: `signal`, `computed`, `effect`, `batch`, `untracked`,
 * `action`, `createModel`, the `Signal` class, the component hooks (`useSignal`, `useComputed`,
 * `useSignalEffect`, `useLiveSignal`, `useSignalRef`, `useModel`) and the `Show` / `For` helpers.
 * `signal` / `computed` / `useSignal` / `useComputed` take Preact's `SignalOptions` (`name`, and
 * the `watched` / `unwatched` callbacks run when the signal gains its first subscriber and loses
 * its last), `effect` / `useSignalEffect` its `EffectOptions` (`name`).
 *
 * A component re-renders when a signal its render read changes, as with Preact: reading
 * `count.value` while rendering subscribes that component (on the client; a server render reads
 * the value once). A signal placed in JSX as a child (`<p>{count}</p>`) renders its value as text
 * and updates in place. A signal passed as a DOM prop (`<input value={text} />`) is bound in code
 * compiled with Preact's JSX runtime (`jsxImportSource: "preact"`, which `denext migrate` maps to
 * `denext/preact/jsx-runtime`). A signal a Server Component passes to a `"use client"` component as a prop
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
import { useEffect, useMemo, useRef } from "../../runtime/hooks.ts";
import type { VNode, VNodeChildren, VNodeType, VProps } from "../../jsx/types.ts";
// The client reconciler's rendering fiber and its update scheduler: a component whose render read a
// signal re-renders when it changes. (`denext`'s own entry already loads these modules.)
import { currentFiber } from "../../client/fiber/hooks-dispatcher.ts";
import { scheduleUpdate } from "../../client/fiber/scheduler.ts";
import { type Fiber, hasBit, UnmountedBit } from "../../client/fiber/fiber.ts";

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
/** Components queued to re-render at the end of the batch. */
const pendingRenders = new Set<Fiber>();
/** The effects a {@link createModel} factory creates while it runs (the model disposes them). */
let capturedEffects: EffectImpl[] | undefined;

/** Re-render a component whose render read a changed signal (a forced render: no hook changed). */
function rerender(fiber: Fiber): void {
  if (!hasBit(fiber, UnmountedBit)) scheduleUpdate(fiber, false);
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
    for (const fiber of renders) rerender(fiber);
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
  /** @internal The components whose render read this signal. */
  _renders: Set<Fiber> | undefined = undefined;
  /** @internal Called when the signal gains its first subscriber. */
  _watched: ((this: Signal<T>) => void) | undefined;
  /** @internal Called when the signal loses its last subscriber. */
  _unwatched: ((this: Signal<T>) => void) | undefined;
  /** The signal's name (`SignalOptions.name`), for debugging tools. */
  name: string | undefined;
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
   * @param options Its name and its `watched` / `unwatched` callbacks.
   */
  constructor(value?: T, options?: SignalOptions<T>) {
    this._value = value as T;
    this._watched = options?.watched;
    this._unwatched = options?.unwatched;
    this.name = options?.name;
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
      if (!this._targets.has(evaluating)) {
        const first = !this._watchedNow();
        this._targets.add(evaluating);
        if (first) this._fireWatch(this._watched);
      }
      return;
    }
    const fiber = currentFiber;
    if (fiber === null) return;
    const renders = this._renders ??= new Set();
    if (renders.has(fiber)) return;
    const first = !this._watchedNow();
    renders.add(fiber);
    if (first) this._fireWatch(this._watched);
  }

  /** @internal Whether anything subscribes to the signal. */
  _watchedNow(): boolean {
    return this._targets.size > 0 || (this._renders?.size ?? 0) > 0;
  }

  /** @internal Run a `watched` / `unwatched` callback, reading nothing reactively. */
  _fireWatch(fn: ((this: Signal<T>) => void) | undefined): void {
    if (fn) untracked(() => fn.call(this));
  }

  /** @internal Drop a computation's subscription (`unwatched` once nothing is left). */
  _untarget(target: Computation): void {
    if (!this._targets.delete(target)) return;
    if (!this._watchedNow()) this._fireWatch(this._unwatched);
  }

  /** @internal Tell every reader the value changed. */
  _notify(): void {
    for (const target of [...this._targets]) target._stale();
    const renders = this._renders;
    if (!renders) return;
    for (const fiber of renders) {
      if (hasBit(fiber, UnmountedBit)) renders.delete(fiber);
      else pendingRenders.add(fiber);
    }
    if (!this._watchedNow()) this._fireWatch(this._unwatched);
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

/** The options of {@link signal}, {@link computed}, {@link useSignal} and {@link useComputed}. */
export interface SignalOptions<T = unknown> {
  /** Called (untracked) when the signal gains its first subscriber. */
  watched?: (this: Signal<T>) => void;
  /** Called (untracked) when the signal loses its last subscriber. */
  unwatched?: (this: Signal<T>) => void;
  /** A name for debugging tools. */
  name?: string;
}

/** The options of {@link effect} and {@link useSignalEffect}. */
export interface EffectOptions {
  /** A name for debugging tools. */
  name?: string;
}

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
  /** The signal's name (`SignalOptions.name`). */
  readonly name?: string;
}

/**
 * Create a signal.
 *
 * @param value The initial value.
 * @param options Its name and its `watched` / `unwatched` callbacks.
 * @returns The signal.
 */
export function signal<T>(value: T, options?: SignalOptions<T>): Signal<T>;
/**
 * Create a signal holding `undefined`.
 *
 * @returns The signal.
 */
export function signal<T = undefined>(): Signal<T | undefined>;
export function signal<T>(value?: T, options?: SignalOptions<T>): Signal<T> {
  return new Signal<T>(value, options);
}

// ── Computations ─────────────────────────────────────────────────────────────

/** Evaluate `fn` with `computation` collecting its reads as the new source set. */
function evaluate<R>(computation: Computation, fn: () => R): R {
  const previous = [...computation._sources.keys()];
  computation._sources.clear();
  const prev = evaluating;
  const prevUntracked = untrackedDepth;
  evaluating = computation;
  // A computation tracks its own reads even when it runs inside `untracked()` (as in Preact).
  untrackedDepth = 0;
  try {
    return fn();
  } finally {
    evaluating = prev;
    untrackedDepth = prevUntracked;
    // A source this run no longer read drops the computation (its `unwatched` may fire).
    for (const source of previous) {
      if (!computation._sources.has(source)) source._untarget(computation);
    }
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

  constructor(fn: () => T, options?: SignalOptions<T>) {
    super(undefined, options);
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
 * @param options Its name and its `watched` / `unwatched` callbacks.
 * @returns A read-only signal.
 */
export function computed<T>(fn: () => T, options?: SignalOptions<T>): ReadonlySignal<T> {
  return new ComputedImpl(fn, options) as unknown as ReadonlySignal<T>;
}

/** An effect's implementation: re-runs after a signal it read changed. */
class EffectImpl implements Computation {
  _sources = new Map<Signal<unknown>, number>();
  _fn: () => unknown;
  _cleanup: (() => void) | undefined = undefined;
  _disposed = false;
  name: string | undefined;

  constructor(fn: () => unknown, options?: EffectOptions) {
    this._fn = fn;
    this.name = options?.name;
    capturedEffects?.push(this);
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
    for (const source of this._sources.keys()) source._untarget(this);
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
 * @param options Its name.
 * @returns Its dispose function.
 */
export function effect(fn: () => unknown, options?: EffectOptions): EffectDispose {
  const e = new EffectImpl(fn, options);
  try {
    batch(() => e._run());
  } catch (err) {
    e._dispose();
    throw err;
  }
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
  const prevCaptured = capturedEffects;
  evaluating = null;
  // Inside a model factory, an untracked callback's effects are not the model's (Preact's rule).
  capturedEffects = undefined;
  untrackedDepth++;
  try {
    return fn();
  } finally {
    untrackedDepth--;
    evaluating = prev;
    capturedEffects = prevCaptured;
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
  return function actionWrapper(this: unknown, ...args: A) {
    return batch(() => untracked(() => fn.apply(this, args)));
  };
}

// ── createModel ──────────────────────────────────────────────────────────────

/** Something `using` / `[Symbol.dispose]()` disposes. */
export interface DisposableLike {
  /** Dispose it. */
  [Symbol.dispose](): void;
}

/** A model: signals, actions and nested objects of them, with `[Symbol.dispose]`. */
export type Model<TModel> = TModel & DisposableLike;

/** The factory {@link createModel} takes. */
export type ModelFactory<TModel, TFactoryArgs extends unknown[] = []> = (
  ...args: TFactoryArgs
) => TModel;

/** What {@link createModel} returns: `new` it (or call it) to build a model. */
export type ModelConstructor<TModel, TFactoryArgs extends unknown[] = []> = new (
  ...args: TFactoryArgs
) => Model<TModel>;

/** Whether a model property is a plain nested object to walk (not a signal, not seen yet). */
function nestedModel(val: unknown, visited: object[]): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !("brand" in val) && !visited.includes(val);
}

/** Wrap the functions one prototype level of `value` defines (`obj`) in {@link action}. */
function wrapLevel(
  value: Record<string, unknown>,
  obj: object,
  seen: Record<string, boolean>,
  visited: object[],
): void {
  const descs = Object.getOwnPropertyDescriptors(obj);
  for (const key in descs) {
    if (seen[key]) continue;
    seen[key] = true;
    const val = descs[key].value;
    if (typeof val === "function") {
      if (key !== "constructor") value[key] = action(val as (...args: unknown[]) => unknown);
    } else if (obj === value && nestedModel(val, visited)) wrapInAction(val, visited);
  }
}

/** Wrap a model's functions (and its nested plain objects' functions) in {@link action}. */
function wrapInAction(value: Record<string, unknown>, visited: object[]): void {
  visited.push(value);
  // Built-ins (a Map, a Date, an array) keep their prototypes' methods as they are.
  const walkPrototypes = Object.prototype.toString.call(value) === "[object Object]";
  const seen: Record<string, boolean> = Object.create(null);
  let obj: object | null = value;
  while (obj && obj !== Object.prototype) {
    wrapLevel(value, obj, seen, visited);
    obj = walkPrototypes ? Object.getPrototypeOf(obj) : null;
  }
}

/**
 * A model constructor (`@preact/signals-core`'s `createModel`): each `new Model(...args)` (or
 * call) runs `factory`, wraps its functions in {@link action}, and owns the effects the factory
 * created (outside an {@link untracked} callback); `model[Symbol.dispose]()` disposes them.
 *
 * @param factory Builds the model's signals and actions.
 * @returns The constructor.
 */
export function createModel<TModel, TFactoryArgs extends unknown[] = []>(
  factory: ModelFactory<TModel, TFactoryArgs>,
): ModelConstructor<TModel, TFactoryArgs> {
  return function SignalModel(...args: TFactoryArgs): Model<TModel> {
    const parent = capturedEffects;
    capturedEffects = [];
    let owned: EffectImpl[] | undefined;
    let model: Model<TModel>;
    try {
      model = factory(...args) as Model<TModel>;
    } catch (err) {
      const effects = capturedEffects;
      capturedEffects = parent;
      batch(() => {
        for (const e of effects ?? []) e._dispose();
      });
      throw err;
    }
    owned = capturedEffects;
    // A nested model's effects are its parent model's too.
    capturedEffects = parent && owned ? parent.concat(owned) : parent;
    wrapInAction(model as unknown as Record<string, unknown>, []);
    (model as DisposableLike)[Symbol.dispose] = action(function disposeModel() {
      for (const e of owned ?? []) e._dispose();
      owned = undefined;
    });
    return model;
  } as unknown as ModelConstructor<TModel, TFactoryArgs>;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/**
 * A signal owned by the component (created once, kept across renders).
 *
 * @param value The initial value.
 * @param options Its name and its `watched` / `unwatched` callbacks.
 * @returns The component's signal.
 */
export function useSignal<T>(value: T, options?: SignalOptions<T>): Signal<T>;
/**
 * A component-owned signal holding `undefined`.
 *
 * @returns The component's signal.
 */
export function useSignal<T = undefined>(): Signal<T | undefined>;
export function useSignal<T>(value?: T, options?: SignalOptions<T>): Signal<T> {
  return useMemo(() => new Signal<T>(value, options), []);
}

/**
 * A computed signal owned by the component; `fn` is always the latest render's.
 *
 * @param fn Computes the value.
 * @param options Its name and its `watched` / `unwatched` callbacks.
 * @returns The component's computed signal.
 */
export function useComputed<T>(fn: () => T, options?: SignalOptions<T>): ReadonlySignal<T> {
  const latest = useRef(fn);
  latest.current = fn;
  return useMemo(() => computed(() => latest.current(), options), []);
}

/**
 * An {@link effect} owned by the component: started after mount, disposed on unmount; `fn` is
 * always the latest render's.
 *
 * @param fn The effect.
 * @param options Its name.
 */
export function useSignalEffect(fn: () => unknown, options?: EffectOptions): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => effect(() => latest.current(), options), []);
}

/**
 * A component-owned signal that is also a ref (`@preact/signals/utils`'s `useSignalRef`):
 * `ref.current` reads and writes `ref.value`, so `<div ref={ref} />` sets the signal and a
 * component that read `ref.value` re-renders.
 *
 * @param value The initial value.
 * @returns The signal, with `current`.
 */
export function useSignalRef<T>(value: T): Signal<T> & { current: T } {
  const ref = useSignal(value) as Signal<T> & { current: T };
  if (!("current" in ref)) Object.defineProperty(ref, "current", SIGNAL_REF);
  return ref;
}

/** `current` on a {@link useSignalRef} signal: its value. */
const SIGNAL_REF: PropertyDescriptor = {
  configurable: true,
  get(this: Signal<unknown>) {
    return this.value;
  },
  set(this: Signal<unknown>, v: unknown) {
    this.value = v;
  },
};

/**
 * A model owned by the component (`@preact/signals`' `useModel`): built once from a
 * {@link createModel} constructor (or a function returning a model), disposed on unmount.
 *
 * @param factory The model constructor, or a function returning a model.
 * @returns The component's model.
 */
export function useModel<TModel>(
  factory: ModelConstructor<TModel, []> | (() => Model<TModel>),
): Model<TModel> {
  const inst = useMemo(() => (factory as () => Model<TModel>)(), []);
  useEffect(() => () => inst[Symbol.dispose](), [inst]);
  return inst;
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
