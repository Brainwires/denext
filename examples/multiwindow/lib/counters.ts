// The per-window counters, as plain logic over `createOwnedResources`: each window starts one
// counter, which ticks once a second in the app's process and sends its ticks to that window only;
// closing the window DETACHES the counter (it keeps ticking, its ticks kept for the replay), a
// window reopened with the same key finds it and takes it back with what it missed, and the app's
// quit stops them all. No Deno or denext imports (the store is `createOwnedResources` from
// `denext/desktop`, handed in by desktop/counters.ts), so the tests drive it with a fake host and
// a fake clock.

/** One tick, as the page receives it (`{ id, data: Tick }`) and the replay keeps it. */
export interface Tick {
  readonly n: number;
  readonly at: number;
}

/** A counter: its interval and where it is. */
export interface Counter {
  readonly id: string;
  n: number;
  stop: () => void;
}

/** What `attach` hands the page: the ticks it missed. */
export interface Attachment {
  readonly id: string;
  readonly replay: readonly Tick[];
}

/** The clock and timer the counters run on (the real ones in the app, fakes in the tests). */
export interface CounterClock {
  now(): number;
  every(ms: number, fn: () => void): () => void;
}

/** The most ticks' bytes one counter keeps for a reattaching window. */
const REPLAY_BYTES = 4096;

/**
 * What `createOwnedResources` is built with for the counters: a closed window's counter lives on
 * for the window that reopens with its key, its ticks kept for the replay, and a dispose stops it.
 */
export const counterStoreOptions = {
  onOwnerClosed: "detach" as const,
  replay: { maxBytes: REPLAY_BYTES, events: ["tick"] },
  dispose: (counter: Counter) => counter.stop(),
};

/** The slice of `OwnedResources<Counter>` (`denext/desktop`) the counters use. */
export interface CounterStore {
  connect(host: unknown): () => void;
  add(id: string, counter: Counter, options: { owner: string }): void;
  emit(id: string, event: string, data: unknown): boolean;
  attach(id: string, windowId: string): { replay: readonly { readonly data: unknown }[] };
  ownedBy(windowIdOrKey: string): string[];
  remove(id: string): Promise<boolean>;
  disposeAll(): Promise<void>;
}

/** The counters service: what the extension's methods and `setup` call. */
export interface Counters {
  /** Connect to the extension's host (`setup(host)`); the unsubscribe. */
  connect(host: unknown): () => void;
  /** Start a counter for `windowId`, ticking every `intervalMs`; its id. */
  start(windowId: string, intervalMs?: number): string;
  /** The counters `windowIdOrKey` owns, plus the detached ones its key last owned. */
  mine(windowIdOrKey: string): string[];
  /** Give counter `id` to `windowId`; the ticks it missed. */
  attach(id: string, windowId: string): Attachment;
  /** Stop and forget counter `id`. */
  stop(id: string): Promise<boolean>;
  /** Stop them all (the app's quit does). */
  stopAll(): Promise<void>;
}

/**
 * Create the counters service.
 *
 * @param clock The clock and timer.
 * @param counters The store: `createOwnedResources<Counter>(counterStoreOptions)`.
 * @returns The service.
 */
export function createCounters(clock: CounterClock, counters: CounterStore): Counters {
  let next = 1;
  return {
    connect: (host) => counters.connect(host),
    start: (windowId, intervalMs = 1000) => {
      const id = `counter-${next++}`;
      const counter: Counter = { id, n: 0, stop: () => {} };
      counter.stop = clock.every(intervalMs, () => {
        counter.n++;
        // To the owner window only; kept for a window that attaches later.
        counters.emit(id, "tick", { n: counter.n, at: clock.now() } satisfies Tick);
      });
      counters.add(id, counter, { owner: windowId });
      return id;
    },
    mine: (windowIdOrKey) => counters.ownedBy(windowIdOrKey),
    attach: (id, windowId) => ({
      id,
      replay: counters.attach(id, windowId).replay.map((e) => e.data as Tick),
    }),
    stop: (id) => counters.remove(id),
    stopAll: () => counters.disposeAll(),
  };
}

/** The count a window shows: its latest tick's, or 0 before the first. */
export function latestCount(ticks: readonly Tick[]): number {
  return ticks.length === 0 ? 0 : ticks[ticks.length - 1].n;
}

/** The note under the count once ticks were replayed, or `null`. */
export function replayNote(replayed: number): string | null {
  return replayed > 0 ? `${replayed} tick(s) replayed from before the close.` : null;
}

/** A window's name on its page: its key, else its id. */
export function windowLabel(w: { readonly id: string; readonly key?: string }): string {
  return w.key ?? w.id;
}
