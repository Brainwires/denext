// A first-party, browser-compatible `AsyncContext` — denext's own implementation
// of the TC39 proposal (https://github.com/tc39/proposal-async-context), which no
// browser has shipped yet. A `Variable` holds a value that is visible to everything
// that runs synchronously inside its `run(value, fn)` scope; a `Snapshot` captures
// the whole set of currently-bound variables so a later callback can re-enter that
// context.
//
//   const theme = new AsyncContext.Variable();
//   theme.run("dark", () => { theme.get(); /* "dark" */ });
//   theme.get(); // undefined — the scope has exited
//
// SYNCHRONOUS scoping always works, on the server and the client, with zero setup.
// Propagation across an `await` is the hard part: a native `await` gives no runtime
// hook (verified: it never calls a patched `Promise.prototype.then`), so a value set
// before an `await` is NOT visible after it unless the module was instrumented by
// denext's build-time transform (`experimental.asyncContext`, see
// src/build/async-context-transform.ts). Without that flag this behaves as a
// synchronous-only context — documented so it can't surprise.
//
// This module is isomorphic (no server-only deps — never pulls `node:async_hooks`)
// and deliberately tiny: it lives in the shared client runtime chunk, which has a
// hard byte budget (see tests/integration/build-smoke.test.ts).

// The current binding set: variable → value. Treated as IMMUTABLE — `run` swaps in a
// fresh Map rather than mutating this one, so a captured Snapshot keeps seeing the
// bindings that were live when it was taken. Starts empty; `null` is never stored.
let current = new Map<Variable<unknown>, unknown>();

/**
 * A value scoped to an async control flow. Set it for the duration of a callback
 * with {@linkcode run}, read the innermost enclosing value with {@linkcode get}.
 */
export class Variable<T> {
  #name: string;
  #hasDefault: boolean;
  #default: T | undefined;

  /**
   * Create a context variable, optionally with a diagnostic `name` and a `defaultValue`
   * returned by {@link Variable.get} when the variable is not currently bound.
   */
  constructor(options?: { name?: string; defaultValue?: T }) {
    this.#name = options?.name ?? "";
    this.#hasDefault = options != null && "defaultValue" in options;
    this.#default = options?.defaultValue;
  }

  /** The optional name given at construction (`""` if none) — for diagnostics. */
  get name(): string {
    return this.#name;
  }

  /**
   * Run `fn(...args)` with this variable bound to `value`; restore the previous
   * binding when it returns or throws. Returns `fn`'s result.
   */
  run<R, A extends unknown[]>(value: T, fn: (...args: A) => R, ...args: A): R {
    const prev = current;
    // Copy-on-write: a fresh Map so any Snapshot of `prev` is unaffected.
    const next = new Map(prev);
    next.set(this as Variable<unknown>, value);
    current = next;
    try {
      return fn(...args);
    } finally {
      current = prev;
    }
  }

  /**
   * The current value of this variable — the one from the innermost enclosing
   * {@linkcode run}, or the `defaultValue` given at construction, else `undefined`.
   */
  get(): T | undefined {
    if (current.has(this as Variable<unknown>)) return current.get(this as Variable<unknown>) as T;
    return this.#hasDefault ? this.#default : undefined;
  }
}

/**
 * A frozen capture of every variable's current value. {@linkcode run} re-enters the
 * captured context for the duration of a callback; {@linkcode wrap} binds a function
 * to the context that was current when it was wrapped.
 */
export class Snapshot {
  #captured: Map<Variable<unknown>, unknown>;

  constructor() {
    this.#captured = current;
  }

  /** Run `fn(...args)` with the captured context restored, then restore the prior one. */
  run<R, A extends unknown[]>(fn: (...args: A) => R, ...args: A): R {
    const prev = current;
    current = this.#captured;
    try {
      return fn(...args);
    } finally {
      current = prev;
    }
  }

  /**
   * Return a function that runs `fn` with the context current *now* (at wrap time)
   * restored — regardless of the context in effect when it is later called.
   */
  static wrap<F extends (...args: never[]) => unknown>(fn: F): F {
    const snapshot = new Snapshot();
    const wrapped = function (this: unknown, ...args: never[]): unknown {
      const prev = current;
      current = snapshot.#captured;
      try {
        return fn.apply(this, args);
      } finally {
        current = prev;
      }
    };
    return wrapped as F;
  }
}

/** The TC39-shaped namespace object: `AsyncContext.Variable` / `AsyncContext.Snapshot`. */
export const AsyncContext: { Variable: typeof Variable; Snapshot: typeof Snapshot } = {
  Variable,
  Snapshot,
};

// ---- Transform hooks -------------------------------------------------------
// The build-time transform (src/build/async-context-transform.ts) instruments each
// async function so a frame's context survives `await`. The model, per async
// function body:
//
//   const $ = __asyncScope();          // at entry: capture the frame's context
//   try { …                            // each `await X` → `await __asyncAwait($, X)`
//   } finally { __asyncScopeEnd($); }  // restore the ambient context on completion
//
// A `Bindings` map is treated immutably (copy-on-write in Variable.run), so a scope
// can hold a reference to one and trust it not to mutate underneath it. The scope
// cell tracks two contexts: `frame` (this async function's own, restored every time
// it resumes) and `ambient` (whatever was current when it last gained control, put
// back whenever it yields — so the global never leaks a frame's context to unrelated
// code that runs between its suspensions or after it settles).

/** A frame's variable bindings: each {@linkcode Variable} to its current value. */
export type Bindings = Map<Variable<unknown>, unknown>;

/** Per-async-function bookkeeping created at entry by {@linkcode __asyncScope}. */
export interface AsyncScope {
  /** This frame's own context — restored each time the frame resumes. */
  readonly frame: Bindings;
  /** The context found at the frame's last resume — put back whenever it yields. */
  ambient: Bindings;
}

/** Open an async scope at function entry: the frame's context is whatever is current. */
export function __asyncScope(): AsyncScope {
  return { frame: current, ambient: current };
}

/** Close an async scope (in a `finally`): restore the ambient context the frame found. */
export function __asyncScopeEnd(scope: AsyncScope): void {
  current = scope.ambient;
}

/**
 * Bracket one `await`. Called synchronously while the frame's context is current:
 * leave the ambient context behind before yielding, and — via a `.then` reaction
 * that runs as the awaited value settles — re-establish the frame's context the
 * instant before the frame resumes. Returns the promise the instrumented `await`
 * actually awaits.
 */
export function __asyncAwait<T>(scope: AsyncScope, value: T | PromiseLike<T>): Promise<T> {
  current = scope.ambient; // put back what we found, before control leaves the frame
  return Promise.resolve(value).then(
    (v) => {
      scope.ambient = current; // remember the ambient we resume into
      current = scope.frame; // ...and restore the frame's context for the resumed code
      return v;
    },
    (e) => {
      scope.ambient = current;
      current = scope.frame;
      throw e;
    },
  );
}

/**
 * Bracket a generator `yield`: called synchronously the instant before the frame
 * suspends, it leaves behind the ambient context (so the caller resumes into its
 * own context, not the frame's) and returns the value to be yielded unchanged. Its
 * counterpart {@linkcode __asyncResume} restores the frame's context on resume.
 *
 * Async generators capture their frame at the first `.next()` (when the body first
 * runs), consistent with how {@link __asyncScope} treats an async function's entry;
 * the TC39 proposal has not settled creation-time vs. resume-time capture, and
 * `yield*` delegation is left uninstrumented (see the build transform).
 */
export function __asyncYield<T>(scope: AsyncScope, value?: T): T | undefined {
  current = scope.ambient; // hand the caller back its own context while suspended
  return value;
}

/**
 * Bracket a generator resume after a `yield`: called synchronously the instant the
 * frame regains control (`.next(sent)`), it remembers the ambient it resumed into
 * and restores the frame's own context, returning the sent value unchanged.
 */
export function __asyncResume<T>(scope: AsyncScope, sent: T): T {
  scope.ambient = current; // the context the caller was in at this resume
  current = scope.frame; // ...and put the frame's own context back for the body
  return sent;
}

/**
 * Bracket a `for await (… of iterable)`: wrap the iterable so each `next`/`return`/
 * `throw` step restores the frame's context on resume, exactly as {@linkcode
 * __asyncAwait} does for a single `await`. Accepts a sync- or async-iterable.
 */
export function __asyncIter<T>(
  scope: AsyncScope,
  iterable: AsyncIterable<T> | Iterable<T | PromiseLike<T>>,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const inner: AsyncIterator<T> | Iterator<T | PromiseLike<T>> =
        (iterable as AsyncIterable<T>)[Symbol.asyncIterator]?.() ??
          (iterable as Iterable<T | PromiseLike<T>>)[Symbol.iterator]();
      const step = (
        method: "next" | "return" | "throw",
        arg?: unknown,
      ): Promise<IteratorResult<T>> => {
        const fn = inner[method] as
          | ((a?: unknown) => IteratorResult<T | PromiseLike<T>> | Promise<IteratorResult<T>>)
          | undefined;
        if (!fn) {
          return method === "next"
            ? Promise.resolve({ value: undefined, done: true } as IteratorResult<T>)
            : Promise.resolve({ value: arg, done: true } as IteratorResult<T>);
        }
        current = scope.ambient;
        return Promise.resolve(fn.call(inner, arg)).then(
          async (r) => {
            scope.ambient = current;
            current = scope.frame;
            return { value: (await r.value) as T, done: r.done } as IteratorResult<T>;
          },
          (e) => {
            scope.ambient = current;
            current = scope.frame;
            throw e;
          },
        );
      };
      return {
        next: (a?: unknown) => step("next", a),
        return: (v?: unknown) => step("return", v),
        throw: (e?: unknown) => step("throw", e),
      };
    },
  };
}
