/**
 * `denext/result` — errors as values and exhaustive matching, opt-in.
 *
 * A {@link Result} is either {@link Ok} (`{ ok: true, value }`) or {@link Err}
 * (`{ ok: false, error }`): a failure the caller is expected to handle travels in the return
 * type instead of a throw, so the compiler sees every way a call can fail.
 *
 * ```ts
 * import { andThen, err, match, ok, type Result, tryAsync } from "denext/result";
 *
 * function parsePort(raw: string): Result<number, "not_a_number" | "out_of_range"> {
 *   const n = Number(raw);
 *   if (!Number.isInteger(n)) return err("not_a_number");
 *   return n > 0 && n < 65536 ? ok(n) : err("out_of_range");
 * }
 *
 * const res = await tryAsync(() => fetch(url).then((r) => r.json()), () => "network" as const);
 *
 * const label = match(parsePort("8080"))
 *   .with({ ok: true }, (r) => `port ${r.value}`)
 *   .with({ ok: false }, (r) => `bad port: ${r.error}`)
 *   .exhaustive(); // a missing case is a compile error
 * ```
 *
 * `defineApi` and `defineAction` (from `denext/server`) accept a returned `err(...)` as an
 * alternative to `fail()` / a thrown `ActionValidationError`.
 *
 * React's own throws stay throws: Suspense, `notFound()`, `redirect()`, `forbidden()`,
 * `unauthorized()` and error boundaries are control flow, and {@link tryAsync} /
 * {@link trySync} re-throw them rather than turning them into an `Err`.
 *
 * Everything here is a plain function over plain objects; an app that never imports this
 * module bundles none of it.
 *
 * @module
 */

import { unstable_rethrow } from "./runtime/error-boundary.ts";
import { isThenable } from "./runtime/suspense.ts";
import { RESULT_KEY } from "./runtime/result-brand.ts";

/** A success: `ok` is `true` and `value` is the result. */
export interface Ok<T> {
  /** Discriminant: always `true`. */
  readonly ok: true;
  /** The success value. */
  readonly value: T;
  /**
   * Brand set by {@link ok} (non-enumerable at runtime, so it never reaches JSON). It lets
   * `defineApi` / `defineAction` tell a returned `Result` from an ordinary `{ ok }` object.
   */
  readonly "~result": "ok";
}

/** A failure: `ok` is `false`, `error` says what went wrong, `details` optionally adds more. */
export interface Err<E, D = unknown> {
  /** Discriminant: always `false`. */
  readonly ok: false;
  /** The error — typically a string code or a tagged object. */
  readonly error: E;
  /**
   * Optional extra information. `defineApi` reads it as `{ message?, data?, fieldErrors?,
   * headers? }`; `defineAction` as `{ fieldErrors? }`.
   */
  readonly details?: D;
  /** Brand set by {@link err} (non-enumerable at runtime). See {@link Ok}. */
  readonly "~result": "err";
}

/** Either a success ({@link Ok}) or a failure ({@link Err}). Narrow on `.ok`. */
export type Result<T, E = unknown> = Ok<T> | Err<E>;

/** Attach the non-enumerable brand. */
function brand<R>(value: object, kind: "ok" | "err"): R {
  Object.defineProperty(value, RESULT_KEY, { value: kind });
  return value as R;
}

/**
 * A success with no value (`Ok<undefined>`).
 *
 * @returns `{ ok: true, value: undefined }`.
 */
export function ok(): Ok<undefined>;
/**
 * A success carrying `value`.
 *
 * @param value The success value.
 * @returns `{ ok: true, value }`.
 */
export function ok<T>(value: T): Ok<T>;
export function ok<T>(value?: T): Ok<T | undefined> {
  return brand({ ok: true, value }, "ok");
}

/**
 * A failure carrying `error` (a string literal stays a literal type: `err("not_found")` is
 * `Err<"not_found">`).
 *
 * @param error What went wrong.
 * @returns `{ ok: false, error }`.
 */
export function err<const E>(error: E): Err<E, undefined>;
/**
 * A failure carrying `error` and extra `details` (for `defineApi`: `{ message?, data?,
 * fieldErrors?, headers? }`; for `defineAction`: `{ fieldErrors? }`).
 *
 * @param error What went wrong.
 * @param details Extra information.
 * @returns `{ ok: false, error, details }`.
 */
export function err<const E, D>(error: E, details: D): Err<E, D>;
export function err<E, D>(error: E, details?: D): Err<E, D | undefined> {
  return brand(details === undefined ? { ok: false, error } : { ok: false, error, details }, "err");
}

/**
 * Is `result` a success? Reads `.ok`, so it also works on a `Result` that crossed a
 * serialization boundary (a Server Component prop, a Server Action's return).
 *
 * @param result The result to test.
 * @returns `true` for an {@link Ok}.
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok === true;
}

/**
 * Is `result` a failure? Reads `.ok` (see {@link isOk}).
 *
 * @param result The result to test.
 * @returns `true` for an {@link Err}.
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.ok === false;
}

/**
 * Transform the success value; a failure passes through unchanged.
 *
 * @param result The result.
 * @param fn Maps the success value.
 * @returns `ok(fn(value))`, or the same `Err`.
 */
export function map<T, E, U>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/**
 * Transform the error; a success passes through unchanged. The failure's `details` are kept.
 *
 * @param result The result.
 * @param fn Maps the error.
 * @returns `err(fn(error))`, or the same `Ok`.
 */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  if (result.ok) return result;
  const mapped = fn(result.error);
  return result.details === undefined ? err(mapped) : err(mapped, result.details);
}

/**
 * Chain a step that can itself fail: run `fn` on the success value; a failure short-circuits.
 *
 * @param result The result.
 * @param fn The next step.
 * @returns `fn(value)`, or the same `Err`.
 */
export function andThen<T, E, U, F>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, F>,
): Result<U, E | F> {
  return result.ok ? fn(result.value) : result;
}

/**
 * The success value, or `fallback` for a failure.
 *
 * @param result The result.
 * @param fallback The value to use when `result` is an `Err`.
 * @returns The value or the fallback.
 */
export function unwrapOr<T, E, U>(result: Result<T, E>, fallback: U): T | U {
  return result.ok ? result.value : fallback;
}

/**
 * Re-throw what must stay a throw: Suspense's thenables and denext's control-flow signals
 * (`notFound()`, `redirect()`, `forbidden()`, `unauthorized()`, a PPR postpone).
 */
function rethrowControl(thrown: unknown): void {
  if (isThenable(thrown)) throw thrown;
  unstable_rethrow(thrown);
}

/**
 * Run a throwing synchronous call and capture the outcome as a {@link Result}.
 *
 * Suspense's thrown promises and denext's control-flow signals (`notFound()`, `redirect()`,
 * …) are re-thrown, never captured.
 *
 * @param fn The call.
 * @param mapError Maps whatever was thrown to the error type (default: the thrown value).
 * @returns `ok(fn())`, or `err(mapError(thrown))`.
 */
export function trySync<T, E = unknown>(
  fn: () => T,
  mapError?: (thrown: unknown) => E,
): Result<T, E> {
  try {
    return ok(fn());
  } catch (thrown) {
    rethrowControl(thrown);
    return err((mapError ? mapError(thrown) : thrown) as E);
  }
}

/**
 * Run a throwing (or rejecting) async call and capture the outcome as a {@link Result}.
 *
 * Suspense's thrown promises and denext's control-flow signals (`notFound()`, `redirect()`,
 * …) are re-thrown, never captured.
 *
 * @param fn The call.
 * @param mapError Maps whatever was thrown to the error type (default: the thrown value).
 * @returns A promise of `ok(await fn())`, or `err(mapError(thrown))`.
 */
export async function tryAsync<T, E = unknown>(
  fn: () => T | PromiseLike<T>,
  mapError?: (thrown: unknown) => E,
): Promise<Result<Awaited<T>, E>> {
  try {
    return ok(await fn());
  } catch (thrown) {
    rethrowControl(thrown);
    return err((mapError ? mapError(thrown) : thrown) as E);
  }
}

/**
 * Fail at compile time when a value that should be impossible is still possible: put it in
 * the `default` of a `switch` over a union (`default: return assertNever(shape)`), and a
 * missing `case` becomes a type error. Reached at runtime (data that broke the types), it
 * throws a `TypeError`.
 *
 * @param value The value the type system says cannot exist.
 * @param message Optional message for the thrown error.
 * @returns Never returns.
 */
export function assertNever(value: never, message?: string): never {
  throw new TypeError(message ?? `Unexpected value: ${describe(value)}`);
}

// ── match ────────────────────────────────────────────────────────────────────

/**
 * What `.with()` accepts for a value of type `T`: a literal (for a literal union), or an
 * object whose listed keys must equal the given literals (for a discriminated union —
 * `{ type: "circle" }`). Matching is shallow and uses `===` (with `NaN` equal to itself).
 */
export type Pattern<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : {
    readonly [K in keyof T]?: Extract<
      T[K],
      string | number | boolean | bigint | symbol | null | undefined
    >;
  };

/** The members of `T` that pattern `P` can match, narrowed by it. */
export type Narrowed<T, P> = T extends unknown ? (T extends P ? T : T & P) : never;

/**
 * The type of `.exhaustive` when cases remain: not callable, and its one property names
 * what is still unhandled, so the compile error says which case is missing.
 */
export interface NonExhaustiveMatch<Remaining> {
  /** The members of the union no `.with()` has handled yet. */
  readonly "denext: match is not exhaustive; unhandled cases": Remaining;
}

/**
 * A pattern match in progress (see {@link match}). `Remaining` is what no `.with()` has
 * handled yet; `Out` is the union of the handlers' results.
 */
export interface Match<Remaining, Out> {
  /**
   * Handle the values matching `pattern`. The handler receives the value narrowed to the
   * matched members; once a pattern matches, later ones are skipped.
   */
  with<const P extends Pattern<Remaining>, R>(
    pattern: P,
    handler: (value: Narrowed<Remaining, P>) => R,
  ): Match<Exclude<Remaining, P>, Out | R>;
  /** Handle everything not matched yet, and return the result. */
  otherwise<R>(handler: (value: Remaining) => R): Out | R;
  /**
   * Return the matched handler's result. Callable only once every member is handled — a
   * missing case is a compile error naming it. Throws a `TypeError` if a value outside the
   * declared type reaches it at runtime.
   */
  readonly exhaustive: [Remaining] extends [never] ? () => Out : NonExhaustiveMatch<Remaining>;
}

/** `===`, except that `NaN` matches `NaN`. */
function same(a: unknown, b: unknown): boolean {
  return a === b || (a !== a && b !== b);
}

/** Does `value` match `pattern` (a literal, or a shallow object of literals)? */
function matches(value: unknown, pattern: unknown): boolean {
  if (pattern === null || typeof pattern !== "object") return same(value, pattern);
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const want = pattern as Record<string, unknown>;
  return Object.keys(want).every((key) => same(record[key], want[key]));
}

/** A short, safe description of a value for an error message. */
function describe(value: unknown): string {
  try {
    return typeof value === "string" ? JSON.stringify(value) : String(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

/**
 * Start an exhaustive match over a literal union or a discriminated union:
 *
 * ```ts
 * type Shape = { kind: "circle"; r: number } | { kind: "square"; side: number };
 * const area = match(shape)
 *   .with({ kind: "circle" }, (s) => Math.PI * s.r ** 2)
 *   .with({ kind: "square" }, (s) => s.side ** 2)
 *   .exhaustive(); // drop a case and this line stops compiling
 * ```
 *
 * Use `.otherwise(fn)` instead of `.exhaustive()` for a deliberate catch-all.
 *
 * @param value The value to match.
 * @returns The match builder.
 */
export function match<T>(value: T): Match<T, never> {
  let done = false;
  let out: unknown;
  const builder = {
    with(pattern: unknown, handler: (value: T) => unknown) {
      if (!done && matches(value, pattern)) {
        done = true;
        out = handler(value);
      }
      return builder;
    },
    otherwise(handler: (value: T) => unknown) {
      return done ? out : handler(value);
    },
    exhaustive() {
      if (!done) throw new TypeError(`match: no pattern matched ${describe(value)}`);
      return out;
    },
  };
  return builder as unknown as Match<T, never>;
}
