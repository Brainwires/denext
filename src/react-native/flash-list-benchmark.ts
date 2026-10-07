/**
 * FlashList v2's benchmark utilities for React Native mode, with the package's behaviour: an
 * app's benchmark screen (`useBenchmark(ref, report)`, `useFlatListBenchmark`,
 * `useDataMultiplier`) runs as it does on a device — it scrolls the list to its end and back
 * at a fling's speed while {@linkcode JSFPSMonitor} counts animation frames, then reports the
 * frame rate and FlashList's suggestions. Re-exported by `denext/react-native/flash-list`; not
 * a public entrypoint. For a profile of a route (CPU by function, heap, leaks), use
 * `denext profile`.
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState } from "../runtime/hooks.ts";

/** FlashList's error when `startTracking()` runs twice on one monitor. */
const FPS_MONITOR_RUNNING = "This FPS Monitor has already been run, please create a new instance";
/** FlashList's error when a benchmark starts on an empty list. */
const DATA_EMPTY = "Data is empty, cannot run benchmark";

/** `requestAnimationFrame`, or a 16 ms timer where there is none (a worker, tests). */
function nextFrame(cb: () => void): number {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
    .requestAnimationFrame;
  return raf ? raf(cb) : setTimeout(cb, 16) as unknown as number;
}

/** Cancel a {@linkcode nextFrame}. */
function cancelFrame(id: number): void {
  const caf = (globalThis as { cancelAnimationFrame?: (id: number) => void })
    .cancelAnimationFrame;
  if (caf) caf(id);
  else clearTimeout(id);
}

/** Round to `places` decimals. */
function round(value: number, places: number): number {
  const m = 10 ** places;
  return Math.round(value * m) / m;
}

/** A cancellation flag for {@linkcode autoScroll}. */
export class Cancellable {
  /** Whether {@linkcode Cancellable.cancel} ran. */
  public _isCancelled = false;

  /** Cancel: the scroll stops at its next frame and resolves `false`. */
  public cancel(): void {
    this._isCancelled = true;
  }

  /**
   * Whether it was cancelled.
   *
   * @returns `true` after {@linkcode Cancellable.cancel}.
   */
  public isCancelled(): boolean {
    return this._isCancelled;
  }
}

/**
 * Scroll from `(fromX, fromY)` to `(toX, toY)` frame by frame at a fast fling's speed (7 px per
 * ms, times `speedMultiplier`), calling `scroll(x, y, false)` each frame.
 *
 * @param scroll Moves the scrollable (e.g. `ref.scrollToOffset({ offset, animated: false })`).
 * @param fromX The x offset to start from.
 * @param fromY The y offset to start from.
 * @param toX The x offset to end at.
 * @param toY The y offset to end at.
 * @param speedMultiplier Scales the speed. Default 1.
 * @param cancellable Stops the scroll when cancelled.
 * @returns `true` when the end was reached, `false` when cancelled.
 */
export function autoScroll(
  scroll: (x: number, y: number, animated: boolean) => void,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  speedMultiplier = 1,
  cancellable: Cancellable = new Cancellable(),
): Promise<boolean> {
  return new Promise((resolve) => {
    scroll(fromX, fromY, false);
    const perMs = 7 * speedMultiplier;
    const dirX = toX > fromX ? 1 : -1;
    const dirY = toY > fromY ? 1 : -1;
    const clampX = toX > fromX ? Math.min : Math.max;
    const clampY = toY > fromY ? Math.min : Math.max;
    let last = Date.now();
    let x = fromX;
    let y = fromY;
    const step = (): void => {
      nextFrame(() => {
        if (cancellable.isCancelled()) return resolve(false);
        const now = Date.now();
        const distance = perMs * (now - last);
        x += distance * dirX;
        y += distance * dirY;
        scroll(clampX(toX, x), clampY(toY, y), false);
        last = now;
        if (clampX(toX, x) !== toX || clampY(toY, y) !== toY) return step();
        resolve(true);
      });
    };
    step();
  });
}

/** What {@linkcode JSFPSMonitor.stopAndGetData} returns (frames per second, one decimal). */
export interface JSFPSResult {
  /** The lowest one-second window's rate. */
  minFPS: number;
  /** The highest one-second window's rate. */
  maxFPS: number;
  /** The rate over the whole run. */
  averageFPS: number;
}

/** Measures the JavaScript thread's frame rate by counting animation frames. */
export class JSFPSMonitor {
  #startTime = 0;
  #frames = 0;
  #window = { frames: 0, startTime: 0 };
  #min = Number.MAX_SAFE_INTEGER;
  #max = 0;
  #average = 0;
  #frame = 0;

  #loop(): void {
    this.#frame = nextFrame(this.#tick);
  }

  readonly #tick = (): void => {
    this.#frames++;
    const elapsed = (Date.now() - this.#startTime) / 1000;
    this.#average = elapsed > 0 ? this.#frames / elapsed : 0;
    this.#window.frames++;
    const windowElapsed = (Date.now() - this.#window.startTime) / 1000;
    if (windowElapsed >= 1) {
      const rate = this.#window.frames / windowElapsed;
      this.#min = Math.min(this.#min, rate);
      this.#max = Math.max(this.#max, rate);
      this.#window = { frames: 0, startTime: Date.now() };
    }
    this.#loop();
  };

  /** Start counting frames. Throws when this monitor already ran (create a new one). */
  public startTracking(): void {
    if (this.#startTime !== 0) throw new Error(FPS_MONITOR_RUNNING);
    this.#startTime = Date.now();
    this.#window.startTime = Date.now();
    this.#loop();
  }

  /**
   * Stop counting and report. A run shorter than one second reports its average as the
   * minimum and maximum too.
   *
   * @returns The rates.
   */
  public stopAndGetData(): JSFPSResult {
    cancelFrame(this.#frame);
    if (this.#min === Number.MAX_SAFE_INTEGER) {
      this.#min = this.#average;
      this.#max = this.#average;
    }
    return {
      minFPS: round(this.#min, 1),
      maxFPS: round(this.#max, 1),
      averageFPS: round(this.#average, 1),
    };
  }
}

/** Options of {@linkcode useBenchmark}. */
export interface BenchmarkParams {
  /** Wait this long before starting. Default 3000 ms. */
  startDelayInMs?: number;
  /** Scales the scroll speed. Default 1. */
  speedMultiplier?: number;
  /** How many times to scroll to the end and back. Default 1. */
  repeatCount?: number;
  /** Accepted (FlashList v2 reports no blank area either). */
  sumNegativeBlankAreaValues?: boolean;
  /** Do not start on mount; call the returned `startBenchmark()`. */
  startManually?: boolean;
}

/** What a benchmark reports. */
export interface BenchmarkResult {
  /** The JavaScript frame rate during the run. */
  js?: JSFPSResult;
  /** Whether it was cancelled (the list unmounted). */
  interrupted: boolean;
  /** FlashList's suggestions. */
  suggestions: string[];
  /** The result as text, for the console or an alert (absent when interrupted). */
  formattedString?: string;
}

/** Options of {@linkcode useFlatListBenchmark}. */
export interface FlatListBenchmarkParams extends BenchmarkParams {
  /** The offset to scroll to (and back from). */
  targetOffset: number;
}

/** The slice of a FlashList ref a benchmark drives. */
interface BenchmarkedFlashList {
  readonly props: { readonly data?: ArrayLike<unknown> | null; readonly horizontal?: unknown };
  getWindowSize(): { width: number; height: number };
  getChildContainerDimensions(): { width: number; height: number };
  scrollToOffset(params: { offset: number; animated?: boolean }): void;
}

/** The slice of a FlatList ref a benchmark drives (`props` when the list exposes them). */
interface BenchmarkedFlatList {
  readonly props?: { readonly data?: ArrayLike<unknown> | null; readonly horizontal?: unknown };
  scrollToOffset(params: { offset: number; animated?: boolean }): void;
}

/** The result as text (FlashList's format). */
function getFormattedString(res: BenchmarkResult): string {
  const tips = res.suggestions.length > 0
    ? `Suggestions:\n\n${res.suggestions.map((v, i) => `${i + 1}. ${v}`).join("\n")}`
    : "";
  return `Results:\n\nJS FPS: Avg: ${res.js?.averageFPS} | Min: ${res.js?.minFPS} | Max: ${res.js?.maxFPS}\n\n${tips}`;
}

/** Throw FlashList's error when a list with props has no data. */
function requireData(props: { readonly data?: ArrayLike<unknown> | null } | undefined): void {
  if (props && !(Number(props.data?.length) > 0)) throw new Error(DATA_EMPTY);
}

/** Scroll to `(toX, toY)` and back with `scrollToOffset`. */
async function scrollThereAndBack(
  scrollTo: (offset: number) => void,
  horizontal: boolean,
  toX: number,
  toY: number,
  speed: number,
  cancellable: Cancellable,
): Promise<void> {
  const move = (x: number, y: number): void => scrollTo(horizontal ? x : y);
  await autoScroll(move, 0, 0, toX, toY, speed, cancellable);
  await autoScroll(move, toX, toY, 0, 0, speed, cancellable);
}

/** The benchmark run shared by both hooks; returns the result. */
async function runBenchmark(
  pass: () => Promise<void>,
  repeat: number,
  suggest: (fps: JSFPSResult) => string[],
  cancellable: Cancellable,
): Promise<BenchmarkResult> {
  const monitor = new JSFPSMonitor();
  monitor.startTracking();
  for (let i = 0; i < repeat; i++) await pass();
  const js = monitor.stopAndGetData();
  const result: BenchmarkResult = {
    js,
    suggestions: suggest(js),
    interrupted: cancellable.isCancelled(),
  };
  if (!cancellable.isCancelled()) result.formattedString = getFormattedString(result);
  return result;
}

/** Hook state shared by both benchmark hooks: running flag, cancellation, the auto start. */
function useBenchmarkRunner(
  params: BenchmarkParams,
  run: (cancellable: Cancellable) => Promise<BenchmarkResult>,
  validate: () => void,
  callback: (result: BenchmarkResult) => void,
  deps: readonly unknown[],
): { startBenchmark: () => void; isBenchmarkRunning: boolean } {
  const [isBenchmarkRunning, setRunning] = useState(false);
  const cancellableRef = useRef<Cancellable | null>(null);
  const startBenchmark = useCallback(() => {
    if (isBenchmarkRunning) return;
    const cancellable = new Cancellable();
    cancellableRef.current = cancellable;
    validate();
    setRunning(true);
    run(cancellable).then((result) => {
      callback(result);
      setRunning(false);
    });
  }, [callback, isBenchmarkRunning, ...deps]);
  useEffect(() => {
    if (params.startManually) return;
    const timer = setTimeout(() => startBenchmark(), params.startDelayInMs || 3000);
    return () => {
      clearTimeout(timer);
      cancellableRef.current?.cancel();
    };
  }, []);
  return { startBenchmark, isBenchmarkRunning };
}

/**
 * Benchmark a FlashList: after `startDelayInMs` (or `startBenchmark()`), scroll it to its end
 * and back `repeatCount` times at a fling's speed, then call `callback` with the JavaScript
 * frame rate and FlashList's suggestions (a low average rate; fewer than 200 items).
 *
 * @param flashListRef The list's ref.
 * @param callback Receives the result.
 * @param params Options.
 * @returns `startBenchmark` and whether a run is in progress.
 */
export function useBenchmark(
  flashListRef: { readonly current: BenchmarkedFlashList | null | undefined },
  callback: (benchmarkResult: BenchmarkResult) => void,
  params: BenchmarkParams = {},
): { readonly startBenchmark: () => void; readonly isBenchmarkRunning: boolean } {
  const speed = params.speedMultiplier || 1;
  const pass = (cancellable: Cancellable) => async (): Promise<void> => {
    const list = flashListRef.current;
    if (!list) return;
    const size = list.getWindowSize();
    const content = list.getChildContainerDimensions();
    await scrollThereAndBack(
      (offset) => flashListRef.current?.scrollToOffset({ offset, animated: false }),
      !!list.props.horizontal,
      content.width - size.width,
      content.height - size.height,
      speed,
      cancellable,
    );
  };
  const suggest = (fps: JSFPSResult): string[] => {
    const out: string[] = [];
    if (fps.averageFPS < 35) {
      out.push(
        "Your average JS FPS is low. This can indicate that your components are doing too much work. Try to optimize your components and reduce re-renders if any",
      );
    }
    const data = flashListRef.current?.props.data;
    if (data && data.length < 200) {
      out.push(
        "Data count is low. Try to increase it to a large number (e.g 200) using the 'useDataMultiplier' hook.",
      );
    }
    return out;
  };
  return useBenchmarkRunner(
    params,
    (cancellable) => runBenchmark(pass(cancellable), params.repeatCount || 1, suggest, cancellable),
    () => requireData(flashListRef.current?.props),
    callback,
    [flashListRef, params.repeatCount, params.speedMultiplier],
  );
}

/**
 * Benchmark a FlatList the same way: scroll to `targetOffset` and back.
 *
 * @param flatListRef The list's ref.
 * @param callback Receives the result.
 * @param params Options, with the target offset.
 * @returns `startBenchmark` and whether a run is in progress.
 */
export function useFlatListBenchmark(
  flatListRef: { readonly current: BenchmarkedFlatList | null | undefined },
  callback: (benchmarkResult: BenchmarkResult) => void,
  params: FlatListBenchmarkParams,
): { readonly startBenchmark: () => void; readonly isBenchmarkRunning: boolean } {
  const pass = (cancellable: Cancellable) => async (): Promise<void> => {
    const list = flatListRef.current;
    if (!list) return;
    const horizontal = Boolean(list.props?.horizontal);
    await scrollThereAndBack(
      (offset) => flatListRef.current?.scrollToOffset({ offset, animated: false }),
      horizontal,
      horizontal ? params.targetOffset : 0,
      horizontal ? 0 : params.targetOffset,
      params.speedMultiplier || 1,
      cancellable,
    );
  };
  return useBenchmarkRunner(
    params,
    (cancellable) =>
      runBenchmark(pass(cancellable), params.repeatCount || 1, () => [], cancellable),
    () => requireData(flatListRef.current?.props),
    callback,
    [flatListRef, params.repeatCount, params.speedMultiplier, params.targetOffset],
  );
}

/**
 * Grow `data` to `count` items by repeating it (objects are shallow-copied), for a benchmark.
 * With a FlatList, drop `keyExtractor` (repeated ids collide).
 *
 * @param data The items.
 * @param count The length to return.
 * @returns `[items]`.
 */
export function useDataMultiplier<T>(data: readonly T[], count: number): [T[]] {
  const len = data.length;
  const out = new Array<T>(count);
  const objects = typeof data[0] === "object";
  for (let i = 0; i < count; i++) {
    out[i] = objects ? { ...data[i % len] } : data[i % len];
  }
  return [out];
}
