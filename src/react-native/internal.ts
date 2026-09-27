/**
 * Helpers the React Native overlay modules share: React Native's subscription shape, a small
 * listener fan-out, and a `matchMedia` query reader. Internal to the overlay; nothing here runs
 * at import time.
 *
 * @module
 */

/** What React Native's `addEventListener` / `addListener` return. */
export interface EmitterSubscription {
  /** Stop listening (idempotent). */
  remove(): void;
}

/**
 * A subscription whose `remove()` calls `stop` once.
 *
 * @param stop The unsubscribe work.
 * @returns The subscription.
 */
export function subscription(stop: () => void): EmitterSubscription {
  let removed = false;
  return {
    remove() {
      if (removed) return;
      removed = true;
      stop();
    },
  };
}

/** Subscriptions tracked per handler, for React Native's deprecated `removeEventListener`. */
export interface HandlerSubscriptions {
  /** A subscription for `handler` whose `remove()` runs `stop` and forgets it. */
  track(handler: unknown, stop: () => void): EmitterSubscription;
  /** Remove every subscription `handler` holds. */
  removeAll(handler: unknown): void;
}

/**
 * Per-handler subscription bookkeeping, so `removeEventListener(type, handler)` can undo what
 * `addEventListener(type, handler)` did.
 *
 * @returns The tracker.
 */
export function handlerSubscriptions(): HandlerSubscriptions {
  const map = new Map<unknown, EmitterSubscription[]>();
  return {
    track(handler, stop) {
      const sub = subscription(() => {
        stop();
        const subs = map.get(handler) ?? [];
        const at = subs.indexOf(sub);
        if (at >= 0) subs.splice(at, 1);
        if (subs.length === 0) map.delete(handler);
      });
      map.set(handler, [...(map.get(handler) ?? []), sub]);
      return sub;
    },
    removeAll(handler) {
      for (const sub of [...(map.get(handler) ?? [])]) sub.remove();
    },
  };
}

/** Listeners keyed by event name, each called in subscription order. */
export interface Listeners<E extends string, T> {
  /** Add `fn` for `event`; returns its subscription. */
  add(event: E, fn: (value: T) => void): EmitterSubscription;
  /** Call every listener of `event` with `value`. */
  emit(event: E, value: T): void;
  /** Remove every listener of `event`, or of every event. */
  clear(event?: E): void;
  /** Remove `fn` from `event` (React Native's deprecated `removeListener`). */
  remove(event: E, fn: (value: T) => void): void;
  /** How many listeners are registered, over all events. */
  size(): number;
}

/**
 * A listener fan-out. `onChange` runs after each add or removal with the new total, so a
 * source can start on the first listener and stop after the last.
 *
 * @param onChange Called with the listener count after each change.
 * @returns The fan-out.
 */
export function listeners<E extends string, T>(
  onChange: (count: number) => void = () => {},
): Listeners<E, T> {
  const byEvent = new Map<E, Array<{ fn: (value: T) => void }>>();
  let count = 0;
  const drop = (event: E, entry: { fn: (value: T) => void }) => {
    const list = byEvent.get(event);
    const at = list?.indexOf(entry) ?? -1;
    if (!list || at < 0) return;
    list.splice(at, 1);
    count--;
    onChange(count);
  };
  return {
    add(event, fn) {
      const entry = { fn };
      const list = byEvent.get(event) ?? [];
      byEvent.set(event, list);
      list.push(entry);
      count++;
      onChange(count);
      return subscription(() => drop(event, entry));
    },
    emit(event, value) {
      for (const entry of [...(byEvent.get(event) ?? [])]) entry.fn(value);
    },
    clear(event) {
      const events = event === undefined ? [...byEvent.keys()] : [event];
      for (const e of events) {
        for (const entry of [...(byEvent.get(e) ?? [])]) drop(e, entry);
      }
    },
    remove(event, fn) {
      const entry = byEvent.get(event)?.find((e) => e.fn === fn);
      if (entry) drop(event, entry);
    },
    size: () => count,
  };
}

/** The slice of a `MediaQueryList` the overlay reads. */
interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener?(type: "change", fn: (e: { matches: boolean }) => void): void;
  removeEventListener?(type: "change", fn: (e: { matches: boolean }) => void): void;
  addListener?(fn: (e: { matches: boolean }) => void): void;
  removeListener?(fn: (e: { matches: boolean }) => void): void;
}

/**
 * `matchMedia(query)`, or undefined during SSR and where the browser lacks it.
 *
 * @param query The media query.
 */
function mediaQuery(query: string): MediaQueryLike | undefined {
  const match = (globalThis as { matchMedia?: (q: string) => MediaQueryLike }).matchMedia;
  return typeof match === "function" ? match(query) : undefined;
}

/**
 * Whether `query` matches now (`false` when it cannot be evaluated).
 *
 * @param query The media query.
 */
export function mediaMatches(query: string): boolean {
  return mediaQuery(query)?.matches === true;
}

/**
 * Call `fn` with `query`'s match state each time it changes; returns the stop function.
 *
 * @param query The media query.
 * @param fn Called with the new state.
 */
export function watchMedia(query: string, fn: (matches: boolean) => void): () => void {
  const media = mediaQuery(query);
  if (!media) return () => {};
  const listener = (e: { matches: boolean }) => fn(e.matches === true);
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", listener);
    return () => media.removeEventListener?.("change", listener);
  }
  media.addListener?.(listener);
  return () => media.removeListener?.(listener);
}
