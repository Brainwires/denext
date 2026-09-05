// Next.js 15 hands `params` / `searchParams` to pages as Promises. denext gives the same
// code both ways to read them: the object IS the value (synchronous property access keeps
// working) and it is also awaitable (`const { slug } = await params`). The `then` lives on
// a non-enumerable property, so JSON / Flight / `Object.keys` never see it.

/** Brand for an {@linkcode asyncProps} object (so Flight serializes it as a plain object). */
const ASYNC_PROPS: unique symbol = Symbol.for("denext.asyncProps");

/** A value that is both `T` and awaitable to `T` (Next 15's `Promise<T>` page props). */
export type AsyncProps<T extends object> = T & PromiseLike<T>;

/** Next.js's `searchParams` record: repeated keys become arrays, absent keys `undefined`. */
export type SearchParams = { [key: string]: string | string[] | undefined };

/** Whether `value` is an {@linkcode asyncProps} object (a thenable that resolves to itself). */
export function isAsyncProps(value: unknown): value is AsyncProps<object> {
  return typeof value === "object" && value !== null && ASYNC_PROPS in value;
}

/**
 * Make `value` awaitable to itself without changing its enumerable shape. Idempotent.
 *
 * @example
 * const props = { params: asyncProps({ slug: "a" }) };
 * props.params.slug;            // "a"  (sync)
 * (await props.params).slug;    // "a"  (Next 15 style)
 */
export function asyncProps<T extends object>(value: T): AsyncProps<T> {
  if (isAsyncProps(value)) return value as AsyncProps<T>;
  // `await` adopts a thenable by calling its `then` and resolving with the result — so the
  // result must NOT itself be thenable, or adoption recurses forever. Resolve with a plain
  // snapshot of the value (same own properties, incl. non-enumerable ones like `raw`, minus
  // `then` and the brand).
  const then = <R1 = T, R2 = never>(
    onFulfilled?: ((v: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> => Promise.resolve(snapshot(value)).then(onFulfilled, onRejected);
  Object.defineProperty(value, "then", { value: then, enumerable: false, configurable: true });
  Object.defineProperty(value, ASYNC_PROPS, { value: true, enumerable: false });
  return value as AsyncProps<T>;
}

/** A non-thenable copy of an {@linkcode asyncProps} value (what `await` resolves to). */
function snapshot<T extends object>(value: T): T {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  delete (descriptors as Record<string, unknown>).then;
  delete (descriptors as Record<symbol, unknown>)[ASYNC_PROPS];
  return Object.defineProperties(Array.isArray(value) ? [] : {}, descriptors) as T;
}

/**
 * Next.js's `searchParams` record for a query string, with the underlying
 * `URLSearchParams` reachable as the non-enumerable `raw` property (`raw` may be a
 * read-tracking wrapper of `usp`; the record itself is built from the plain `usp`).
 *
 * @example
 * const sp = searchParamsRecord(new URLSearchParams("a=1&a=2&b=x"));
 * sp.a;      // ["1", "2"]
 * sp.b;      // "x"
 * sp.raw.get("b"); // "x"
 */
export function searchParamsRecord(
  usp: URLSearchParams,
  raw: URLSearchParams = usp,
): SearchParams & { readonly raw: URLSearchParams } {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of usp) {
    const prev = out[key];
    if (prev === undefined) out[key] = value;
    else out[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
  }
  Object.defineProperty(out, "raw", { value: raw, enumerable: false });
  return out as SearchParams & { readonly raw: URLSearchParams };
}
