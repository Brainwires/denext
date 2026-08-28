import {
  type DependencyList,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "denext";

type ErrorCtor = abstract new (...args: never[]) => Error;
type InstanceOf<C> = C extends abstract new (...args: never[]) => infer E
  ? E
  : never;

type AsyncEffectOptions<C extends readonly ErrorCtor[]> = {
  catch: C;
  onError: (error: InstanceOf<C[number]>) => void;
};

type Effect = (signal: AbortSignal) => Promise<void>;

/**
 * Runs an async effect and re-runs it whenever dependencies change.
 *
 * If the async effect rejects with an error whose constructor matches one of the
 * configured `catch` types, the matching `onError` callback is invoked instead of
 * surfacing the error as a fatal render error.
 *
 * @param effect - Async effect to run. Receives an `AbortSignal` that is aborted
 * when the effect is cleaned up.
 * @param deps - Dependency list that controls when the effect re-runs.
 */
export function useAsyncEffect(effect: Effect, deps: DependencyList): void;
/**
 * Runs an async effect with custom error handling.
 *
 * @param effect - Async effect to run. Receives an `AbortSignal` that is aborted
 * when the effect is cleaned up.
 * @param options - Error handling configuration for matched caught errors.
 * @param deps - Dependency list that controls when the effect re-runs.
 */
export function useAsyncEffect<const C extends readonly ErrorCtor[]>(
  effect: Effect,
  options: AsyncEffectOptions<C>,
  deps: DependencyList
): void;
/**
 * @internal
 */
export function useAsyncEffect(
  effect: Effect,
  optionsOrDeps: AsyncEffectOptions<readonly ErrorCtor[]> | DependencyList,
  maybeDeps?: DependencyList
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

    effect(controller.signal).catch((err: unknown) => {
      if (controller.signal.aborted) return;

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

useAsyncEffect.run = function (signal: AbortSignal, task: () => void) {
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

useAsyncEffect.runLater = function (signal: AbortSignal, ms: number, task: () => void) {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (signal.aborted) return resolve();

        try {
          task();
          resolve();
        } catch (err) {
          reject(err);
        }
      }, ms);

      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
}
