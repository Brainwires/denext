/**
 * LegendList's render controls on denext's `VirtualList` (internal to `legend-list.ts`):
 *
 * - `waitForInitialLayout`: the list stays invisible (`opacity: 0`, no pointer events) until its
 *   first items are measured, so it never paints at estimated positions.
 * - `itemsAreEqual`: an item whose key is unchanged and which the callback calls equal to the one
 *   it rendered keeps its rendered element (and its old item, as LegendList's container does),
 *   so neither `renderItem` nor the item's components run again.
 * - `experimental_adaptiveRender`: the list-level `"normal"` / `"light"` mode LegendList derives
 *   from the scroll velocity (its web build's thresholds), read by `useAdaptiveRender` and
 *   `useAdaptiveRenderChange` inside the items.
 *
 * @module
 */

import type { VNodeChild } from "../../jsx/types.ts";
import { createContext } from "../../runtime/context.ts";
import {
  type Context,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "../../runtime/hooks.ts";
import { useSyncExternalStore } from "../../runtime/hooks/use-sync-external-store.ts";
import type { VirtualListScrollEvent } from "../../client/virtual/types.ts";

// ---- waitForInitialLayout --------------------------------------------------------------------

/** The style that hides a list until its first layout. */
const HIDDEN = { opacity: 0, pointerEvents: "none" } as const;

/**
 * Hook: whether the list has had its first measured layout (any item measured, or no items),
 * and `measured`, the engine's measurement report that flips it.
 *
 * @param count The number of items.
 * @returns `ready`, and `measured` to call on every item measurement.
 */
export function useInitialLayout(count: number): { ready: boolean; measured: () => void } {
  const [ready, setReady] = useState(false);
  const done = useRef(false);
  const measured = useCallback(() => {
    if (done.current) return;
    done.current = true;
    setReady(true);
  }, []);
  // An empty list has nothing to measure: it is laid out once it commits.
  useLayoutEffect(() => {
    if (count === 0) measured();
  }, [count === 0]);
  return { ready, measured };
}

/**
 * The list's style while `waitForInitialLayout` holds it back: hidden until `ready`.
 *
 * @param style The app's style.
 * @param wait `waitForInitialLayout`.
 * @param ready Whether the first layout happened.
 * @returns The style to pass on.
 */
export function initialLayoutStyle(style: unknown, wait: boolean | undefined, ready: boolean) {
  return wait === true && !ready ? [style, HIDDEN] : style;
}

// ---- itemsAreEqual ---------------------------------------------------------------------------

/** What an item rendered last time. */
interface RenderedItem {
  readonly item: unknown;
  readonly index: number;
  readonly node: VNodeChild;
}

/** The comparison LegendList's `itemsAreEqual` makes. */
export type ItemsAreEqual = (
  a: unknown,
  b: unknown,
  index: number,
  data: readonly unknown[],
) => boolean;

/**
 * Hook: `render` that skips an item `itemsAreEqual` calls equal to the one it rendered at the
 * same index under the same key (LegendList compares only with a `keyExtractor`): the previous
 * element is returned, so the item's components bail out. A change of `extraData` (or
 * `dataVersion` / `dataKey`, folded into `epoch`) renders every item again. The memory holds
 * the items rendered since the list's last commit.
 *
 * @param render The item renderer.
 * @param opts `itemsAreEqual`, whether the app gave a `keyExtractor`, the key of an item, the
 *   data, and `epoch` (changes when everything must render).
 * @returns The renderer to use.
 */
export function useItemsAreEqual(
  render: (item: unknown, index: number) => VNodeChild,
  opts: {
    equal: ItemsAreEqual | undefined;
    keyed: boolean;
    keyOf: (item: unknown, i: number) => string;
    data: readonly unknown[];
    epoch: unknown;
  },
): (item: unknown, index: number) => VNodeChild {
  const memo = useRef<{ epoch: unknown; items: Map<string, RenderedItem>; seen: Set<string> }>({
    epoch: opts.epoch,
    items: new Map(),
    seen: new Set(),
  });
  const m = memo.current;
  if (m.epoch !== opts.epoch || !opts.equal || !opts.keyed) {
    m.epoch = opts.epoch;
    m.items.clear();
  }
  // Forget the items no render since the last commit asked for (scrolled away or removed).
  useLayoutEffect(() => {
    for (const key of m.items.keys()) if (!m.seen.has(key)) m.items.delete(key);
    m.seen.clear();
  });
  const { equal, keyed, keyOf, data } = opts;
  return useMemo(() => {
    if (!equal || !keyed) return render;
    return (item: unknown, index: number): VNodeChild => {
      const key = keyOf(item, index);
      m.seen.add(key);
      const prev = m.items.get(key);
      if (
        prev && prev.index === index && (prev.item === item || equal(prev.item, item, index, data))
      ) {
        return prev.node;
      }
      const node = render(item, index);
      m.items.set(key, { item, index, node });
      return node;
    };
  }, [render, equal, keyed, keyOf, data, m]);
}

// ---- experimental_adaptiveRender -------------------------------------------------------------

/** LegendList's adaptive render mode. */
export type AdaptiveRender = "normal" | "light";

/** Why the mode changed. */
export type AdaptiveRenderChangeReason = "initial" | "ready" | "scroll";

/** LegendList's `experimental_adaptiveRender`. */
export interface AdaptiveRenderConfig {
  /** Mode before the list is ready (default `"normal"`). */
  initialMode?: AdaptiveRender;
  /** Px per ms above which items switch to light mode (default 6, LegendList's web value). */
  enterVelocity?: number;
  /** Px per ms below which items can return to normal mode (default 3). */
  exitVelocity?: number;
  /** Ms without a velocity above `exitVelocity` before returning to normal (default 250). */
  exitDelay?: number;
  /** Called when the list-level mode changes. */
  onChange?: (mode: AdaptiveRender, reason: AdaptiveRenderChangeReason) => void;
}

// LegendList's web defaults and velocity window.
const ENTER_VELOCITY = 6;
const EXIT_VELOCITY = 3;
const EXIT_DELAY = 250;
const VELOCITY_WINDOW_MS = 1000;
const VELOCITY_HALF_LIFE_MS = 200;
const HISTORY = 5;

/** The list's mode, its subscribers and the scroll history the velocity comes from. */
export interface AdaptiveStore {
  mode: AdaptiveRender;
  readonly listeners: Set<() => void>;
  readonly history: { scroll: number; time: number }[];
  exit: ReturnType<typeof setTimeout> | undefined;
  config: AdaptiveRenderConfig | undefined;
  ready: boolean;
  last: number | undefined;
}

/** A store in `mode`. */
function adaptiveStore(mode: AdaptiveRender): AdaptiveStore {
  return {
    mode,
    listeners: new Set(),
    history: [],
    exit: undefined,
    config: undefined,
    ready: false,
    last: undefined,
  };
}

/** Set the mode, telling the items and `onChange`. */
function setMode(s: AdaptiveStore, mode: AdaptiveRender, reason: AdaptiveRenderChangeReason) {
  if (s.mode === mode) return;
  s.mode = mode;
  for (const l of s.listeners) l();
  s.config?.onChange?.(mode, reason);
}

/** Cancel a pending return to normal. */
function cancelExit(s: AdaptiveStore): void {
  if (s.exit !== undefined) clearTimeout(s.exit);
  s.exit = undefined;
}

/** Return to normal after `delay` ms (at once for 0). */
function scheduleExit(s: AdaptiveStore, delay: number): void {
  cancelExit(s);
  if (delay <= 0) setMode(s, "normal", "scroll");
  else {
    s.exit = setTimeout(() => {
      s.exit = undefined;
      setMode(s, "normal", "scroll");
    }, delay);
  }
}

/**
 * The scroll velocity in px per ms: the recent samples moving one way, newest weighted most
 * (LegendList's `getScrollVelocity`).
 *
 * @param history The recent `{ scroll, time }` samples, oldest first.
 * @param now The current time (ms).
 * @returns The velocity, 0 when idle.
 */
export function scrollVelocity(
  history: readonly { scroll: number; time: number }[],
  now: number,
): number {
  const n = history.length - 1;
  if (n < 1) return 0;
  const newest = history[n];
  if (now - newest.time > VELOCITY_WINDOW_MS) return 0;
  let direction = 0;
  let weighted = 0;
  let total = 0;
  for (let i = n; i > 0; i--) {
    const cur = history[i];
    const prev = history[i - 1];
    const diff = cur.scroll - prev.scroll;
    const dt = cur.time - prev.time;
    const sign = Math.sign(diff);
    if (sign !== 0) {
      if (direction === 0) direction = sign;
      else if (sign !== direction) break;
    }
    if (newest.time - prev.time > VELOCITY_WINDOW_MS) break;
    if (diff === 0 || dt <= 0) continue;
    const weight = Math.exp(-(newest.time - cur.time) / VELOCITY_HALF_LIFE_MS);
    weighted += diff / dt * weight;
    total += weight;
  }
  return total > 0 ? weighted / total : 0;
}

/**
 * One scroll frame: record it and move between the modes on the velocity (a user jump of more
 * than a viewport goes light at once), as LegendList's `updateAdaptiveRender` does.
 *
 * @param s The store.
 * @param e The scroll event.
 * @param horizontal Whether the list scrolls horizontally.
 */
export function adaptiveFrame(s: AdaptiveStore, e: VirtualListScrollEvent, horizontal: boolean) {
  const jump = recordFrame(s, e, horizontal);
  const config = s.config;
  if (!s.ready || !config) return;
  const velocity = scrollVelocity(s.history, e.timeStamp);
  const threshold = s.mode === "light"
    ? config.exitVelocity ?? EXIT_VELOCITY
    : config.enterVelocity ?? ENTER_VELOCITY;
  moveTo(s, jump || Math.abs(velocity) > threshold ? "light" : "normal", config);
}

/**
 * Record a scroll frame's offset (the list's own scrolls — a `scrollTo*`, an anchor correction —
 * are not motion samples).
 *
 * @returns Whether the user jumped more than a viewport since the last frame.
 */
function recordFrame(s: AdaptiveStore, e: VirtualListScrollEvent, horizontal: boolean): boolean {
  const ne = e.nativeEvent;
  const scroll = horizontal ? ne.contentOffset.x : ne.contentOffset.y;
  const viewport = horizontal ? ne.layoutMeasurement.width : ne.layoutMeasurement.height;
  const prev = s.last ?? 0;
  s.last = scroll;
  if (e.programmatic) return false;
  s.history.push({ scroll, time: e.timeStamp });
  if (s.history.length > HISTORY) s.history.shift();
  return viewport > 0 && Math.abs(scroll - prev) > viewport;
}

/** Enter light mode at once (leaving after the exit delay), or leave it after the delay. */
function moveTo(s: AdaptiveStore, next: AdaptiveRender, config: AdaptiveRenderConfig): void {
  const before = s.exit !== undefined ? "normal" : s.mode;
  if (next === before) return;
  const delay = config.exitDelay ?? EXIT_DELAY;
  if (next === "light") {
    setMode(s, "light", "scroll");
    scheduleExit(s, delay);
  } else if (s.mode === "light") scheduleExit(s, delay);
}

let adaptiveContext: Context<AdaptiveStore | null> | undefined;

/** The list's adaptive store context (created on first use). */
export function adaptiveCtx(): Context<AdaptiveStore | null> {
  return adaptiveContext ??= createContext<AdaptiveStore | null>(null);
}

/**
 * Hook: the list's adaptive store, following `config` and the list's readiness (`"normal"`
 * with reason `"ready"` once it is laid out; before that `initialMode`).
 *
 * @param config `experimental_adaptiveRender`.
 * @param ready Whether the list has had its first layout.
 * @returns The store.
 */
export function useAdaptiveStore(
  config: AdaptiveRenderConfig | undefined,
  ready: boolean,
): AdaptiveStore {
  const store = useMemo(() => adaptiveStore(config?.initialMode ?? "normal"), []);
  store.config = config;
  useLayoutEffect(() => {
    if (!ready || store.ready) return;
    store.ready = true;
    cancelExit(store);
    setMode(store, "normal", "ready");
  }, [ready]);
  useLayoutEffect(() => {
    if (config) return;
    // Without the config the mode rests at normal (LegendList's reset).
    cancelExit(store);
    setMode(store, "normal", "initial");
  }, [!config]);
  useEffect(() => () => cancelExit(store), []);
  return store;
}

const NO_SUBSCRIBE = () => () => {};

/**
 * Hook: the mode of the list this item is in (`"normal"` outside one).
 *
 * @returns The mode.
 */
export function useAdaptiveMode(): AdaptiveRender {
  const store = useContext(adaptiveCtx());
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!store) return NO_SUBSCRIBE();
      store.listeners.add(cb);
      return () => store.listeners.delete(cb);
    },
    [store],
  );
  return useSyncExternalStore(subscribe, () => store?.mode ?? "normal", () => "normal");
}

/**
 * Hook: call `callback` with each new mode of the list this item is in.
 *
 * @param callback Receives the new mode.
 */
export function useAdaptiveModeChange(callback: (mode: AdaptiveRender) => void): void {
  const store = useContext(adaptiveCtx());
  const latest = useRef(callback);
  latest.current = callback;
  useLayoutEffect(() => {
    if (!store) return;
    let mode = store.mode;
    const cb = () => {
      if (store.mode === mode) return;
      mode = store.mode;
      latest.current(mode);
    };
    store.listeners.add(cb);
    return () => {
      store.listeners.delete(cb);
    };
  }, [store]);
}
