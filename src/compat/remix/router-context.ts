// React Router 7's typed context: `createContext()` makes a key, a `RouterContextProvider`
// holds a value per key, and route middleware and loaders read and write it through
// `context.get(key)` / `context.set(key, value)`. On denext the provider is the per-request
// `context` every loader, action and route middleware receives (see ./load-context.ts).
//
// Client-safe: no server imports, so `react-router` (aliased to `denext/remix`) can export it.

/** A typed context key, made by {@link createContext}. */
export interface RouterContext<T = unknown> {
  /** The value {@link RouterContextProvider.get} returns when none was set. */
  readonly defaultValue?: T;
}

/**
 * Create a typed context key — React Router's `createContext`. Set its value in a middleware
 * (or the load-context provider) with `context.set(key, value)` and read it in a later
 * middleware or a loader/action with `context.get(key)`.
 *
 * @param defaultValue The value `get` returns before one is set.
 * @returns The key.
 */
export function createContext<T>(defaultValue?: T): RouterContext<T> {
  return { defaultValue };
}

/**
 * React Router's `RouterContextProvider`: the values of {@link RouterContext} keys for one
 * request. A load-context provider may return one (`new RouterContextProvider(new Map([[key,
 * value]]))`); with no provider registered, each request starts with an empty one.
 */
export class RouterContextProvider {
  #values = new Map<RouterContext<unknown>, unknown>();

  /**
   * Create a provider, optionally holding initial values.
   *
   * @param init Initial values by key.
   */
  constructor(init?: Map<RouterContext<unknown>, unknown>) {
    if (init) { for (const [key, value] of init) this.#values.set(key, value); }
  }

  /**
   * The value set for `context`, else its default.
   *
   * @param context The key.
   * @returns The value.
   * @throws When neither a value nor a default exists.
   */
  get<T>(context: RouterContext<T>): T {
    if (this.#values.has(context)) return this.#values.get(context) as T;
    if (context.defaultValue !== undefined) return context.defaultValue;
    throw new Error("No value found for context");
  }

  /**
   * Set the value of `context` for the rest of this request.
   *
   * @param context The key.
   * @param value Its value.
   */
  set<C extends RouterContext<unknown>>(
    context: C,
    value: C extends RouterContext<infer T> ? T : never,
  ): void {
    this.#values.set(context, value);
  }
}

/** React Router ≤ 7.8's name for {@link createContext}. */
export const unstable_createContext: typeof createContext = createContext;
/** React Router ≤ 7.8's name for {@link RouterContextProvider}. */
export const unstable_RouterContextProvider: typeof RouterContextProvider = RouterContextProvider;
