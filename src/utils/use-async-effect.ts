import { useEffect, useLayoutEffect, useRef, useState } from "../runtime/hooks.ts";
import type { DependencyList } from "../compat/react-types.ts";

type ErrorCtor = abstract new (...args: never[]) => Error;
type InstanceOf<C> = C extends abstract new (...args: never[]) => infer E ? E
  : never;

type AsyncEffectOptions<C extends readonly ErrorCtor[]> = {
  catch: C;
  onError: (error: InstanceOf<C[number]>) => void;
};

type Effect = (args: {
  signal: AbortSignal;
  sleep: (ms: number) => Promise<void>;
  setTimeout: (ms: number, task: () => void) => Promise<void>;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}) => Promise<void>;

/**
 * Runs an async effect and re-runs it whenever dependencies change.
 *
 * If the async effect rejects with an error whose constructor matches one of the
 * configured `catch` types, the matching `onError` callback is invoked instead of
 * surfacing the error as a fatal render error.
 *
 * @param effect - Async effect to run. Receives `{ signal, sleep, setTimeout, fetch }`:
 * a `signal` (`AbortSignal`) that is aborted when the effect is cleaned up, plus
 * abort-aware `sleep`, `setTimeout`, and `fetch` helpers that reject on abort so the
 * effect body stops at the next `await` (the rejection is swallowed by the hook).
 * @param deps - Dependency list that controls when the effect re-runs.
 */
export function useAsyncEffect(effect: Effect, deps: DependencyList): void;
/**
 * Runs an async effect with custom error handling.
 *
 * @param effect - Async effect to run. Receives `{ signal, sleep, setTimeout, fetch }`:
 * a `signal` (`AbortSignal`) that is aborted when the effect is cleaned up, plus
 * abort-aware `sleep`, `setTimeout`, and `fetch` helpers that reject on abort so the
 * effect body stops at the next `await` (the rejection is swallowed by the hook).
 * @param options - Error handling configuration for matched caught errors.
 * @param deps - Dependency list that controls when the effect re-runs.
 */
export function useAsyncEffect<const C extends readonly ErrorCtor[]>(
  effect: Effect,
  options: AsyncEffectOptions<C>,
  deps: DependencyList,
): void;
/**
 * @internal
 */
export function useAsyncEffect(
  effect: Effect,
  optionsOrDeps: AsyncEffectOptions<readonly ErrorCtor[]> | DependencyList,
  maybeDeps?: DependencyList,
): void {
  const isDepsOnly = Array.isArray(optionsOrDeps);
  const deps = (isDepsOnly ? optionsOrDeps : maybeDeps) as DependencyList;
  const options = isDepsOnly
    ? undefined
    : (optionsOrDeps as AsyncEffectOptions<readonly ErrorCtor[]>);

  const [fatal, setFatal] = useState<unknown>(null);

  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    const controller = new AbortController();

    effect({
      signal: controller.signal,
      setTimeout: (ms, task) => internalSetTimeout(controller.signal, ms, task),
      sleep: (ms) => internalSetTimeout(controller.signal, ms),
      fetch: (input, init) => internalFetch(controller.signal, input, init),
    })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // An abort from any source (e.g. a caller-supplied `init.signal`) is a
        // cancellation, not a fatal render error.
        if (err instanceof DOMException && err.name === "AbortError") return;

        const opts = optionsRef.current;
        if (opts?.catch.some((Ctor: ErrorCtor) => err instanceof Ctor)) {
          opts.onError(err as never);
          return;
        }
        setFatal(err);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  if (fatal) throw fatal;
}

/**
 * Run a synchronous `task` as a promise that is skipped when `signal` is already aborted.
 * A helper for composing an aborted-aware step inside a {@link useAsyncEffect} effect:
 * resolves after `task()` runs, rejects if it throws, and resolves immediately (without
 * running `task`) when `signal.aborted` is already true.
 *
 * @param signal The effect's `AbortSignal`.
 * @param task The synchronous work to run when not aborted.
 * @returns A promise that settles once the task has run (or been skipped).
 */
useAsyncEffect.wrap = function (signal: AbortSignal, task: () => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return resolve();

    try {
      task();
      resolve();
    } catch (err) {
      reject(err);
    }
  });
};

function internalFetch(
  signal: AbortSignal,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // If the caller passed their own signal too, honor both.
  const merged = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
  return fetch(input, { ...init, signal: merged });
}

function internalSetTimeout(
  signal: AbortSignal,
  ms: number,
  task: () => void = () => {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => settle(() => reject(signal.reason));

    const timeout = setTimeout(() => {
      settle(() => {
        try {
          task();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
