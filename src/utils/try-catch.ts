/**
 * Converts the outcome of a synchronous or asynchronous operation into a
 * discriminated tuple.
 *
 * The callback is invoked synchronously by `Promise.try()`. A returned value or
 * fulfilled promise produces `[true, data]`; a synchronous throw or rejected
 * promise produces `[false, error]`.
 *
 * @example
 * ```ts
 * const result = await tryCatch(() => fetchUser(id));
 *
 * if (!result[0]) {
 *   console.error(result[1]);
 *   return;
 * }
 *
 * const user = result[1];
 * ```
 *
 * @typeParam T - The operation's returned or resolved value.
 * @typeParam E - The expected thrown or rejected value. Defaults to `unknown`.
 */

/** A successful operation result. */
export type SuccessResult<T> = readonly [ok: true, data: T];

/** A failed operation result. */
export type ErrorResult<E = unknown> = readonly [ok: false, error: E];

/** The result of a synchronous or asynchronous operation. */
export type TryCatchResult<T, E = unknown> = SuccessResult<T> | ErrorResult<E>;

interface PromiseConstructorWithTry {
  try<T>(operation: () => T | PromiseLike<T>): Promise<T>;
}

/**
 * Runs an operation and captures its return value, thrown value, or rejection.
 */
export function tryCatch<T, E = unknown>(
  operation: () => T | PromiseLike<T>,
): Promise<TryCatchResult<T, E>> {
  // Keep this utility usable with TypeScript library definitions that predate
  // ES2025, where the runtime method exists but `PromiseConstructor.try` does not.
  const promise = Promise as unknown as PromiseConstructorWithTry;

  return promise.try(operation).then(
    (data) => [true, data] as const,
    (error) => [false, error as E] as const,
  );
}
