// Remix's `AppLoadContext` — the object a custom server's `getLoadContext(req, res)` handed
// every loader/action as `context`. denext replaces that server, so an app registers a
// provider with {@link defineLoadContext} (`denext migrate --from remix` writes a
// `load-context.ts` from the server's `getLoadContext`) and the runtime calls it once per
// request, passing the result as `context`.
//
// The provider lives on `globalThis`, not a module `let`: `instrumentation.ts` registers it
// through the NATIVE module graph while a compat server bundle reaches this module through
// its own — the same seam the matches bridge and the document-attrs sink use.
//
// The context is always a React Router `RouterContextProvider`, so route middleware and
// loaders can `context.get(key)` / `context.set(key, value)`: a provider's plain object has its
// properties carried onto one (the Remix `context.db` reads keep working), a provider that
// returns a `RouterContextProvider` (React Router 7's middleware mode) is used as is, and with
// no provider each request starts with an empty one.

import { currentContext } from "../../server/request-context.ts";
import { RouterContextProvider } from "./router-context.ts";

/** Remix's `AppLoadContext`: whatever the app's `getLoadContext` returns. */
export type AppLoadContext = Record<string, unknown>;

/**
 * The `context` a loader, action or route middleware receives: the provider's values as
 * properties (Remix) and a {@link RouterContextProvider} (React Router 7's typed
 * `context.get(key)`).
 */
export type LoaderContext = AppLoadContext & RouterContextProvider;

/** What a {@link LoadContextProvider} receives — the request and the route's URL params. */
export interface LoadContextArgs {
  /** The incoming request (or the export/prerender placeholder outside a live request). */
  request: Request;
  /** The matched route's URL params. */
  params: Record<string, string>;
}

/**
 * Computes the `context` a loader/action receives; called once per request. Return a plain
 * object (Remix's `getLoadContext`) or a {@link RouterContextProvider} (React Router 7 with
 * middleware).
 */
export type LoadContextProvider = (
  args: LoadContextArgs,
) =>
  | AppLoadContext
  | RouterContextProvider
  | Promise<AppLoadContext | RouterContextProvider>;

const PROVIDER = Symbol.for("denext.remix.loadContext");
/** Per-request memo key: the context is computed once per request, like `getLoadContext`. */
const MEMO = Symbol.for("denext.remix.loadContextMemo");

type Store = { [PROVIDER]?: LoadContextProvider };
const store = globalThis as unknown as Store;

/**
 * Register the app's load-context provider — Remix's `getLoadContext` on denext. Every
 * loader/action then receives its result as `context` (computed once per request). Call it
 * at module scope from a module the server loads at boot (`instrumentation.ts` imports the
 * generated `load-context.ts`). Returns the provider so the module can `export default` it.
 *
 * @param provider Computes the context for a request.
 * @returns `provider`, unchanged.
 */
export function defineLoadContext(provider: LoadContextProvider): LoadContextProvider {
  store[PROVIDER] = provider;
  return provider;
}

/** Drop the registered provider (tests). */
export function clearLoadContext(): void {
  delete store[PROVIDER];
}

/**
 * The provider's result as the request's {@link LoaderContext}: a `RouterContextProvider` as
 * is; a plain object's own properties (getters included, unevaluated) carried onto a fresh
 * provider; anything else (a class instance) as is, since copying would drop its methods.
 */
function toLoaderContext(value: unknown): LoaderContext {
  if (value instanceof RouterContextProvider) return value as LoaderContext;
  const provider = new RouterContextProvider();
  if (value === null || value === undefined) return provider as LoaderContext;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value as LoaderContext;
  Object.defineProperties(provider, Object.getOwnPropertyDescriptors(value));
  return provider as LoaderContext;
}

/** Run the provider (an empty context without one). */
async function computeContext(
  request: Request,
  params: Record<string, string>,
): Promise<LoaderContext> {
  const provider = store[PROVIDER];
  return toLoaderContext(provider ? await provider({ request, params }) : null);
}

/**
 * The `context` for a loader/action/middleware: the registered provider's result, memoized
 * per request (an empty {@link RouterContextProvider} when no provider is registered), so a
 * value a middleware sets is what the loaders of that request read.
 *
 * @param request The request the loader/action runs for.
 * @param params The route's URL params.
 * @returns The app load context.
 */
export async function loadContext(
  request: Request,
  params: Record<string, string>,
): Promise<LoaderContext> {
  const memo = currentContext()?.memo;
  if (!memo) return await computeContext(request, params);
  let slot = memo.get(MEMO);
  if (!slot) memo.set(MEMO, slot = new Map());
  const cached = slot.get("context") as Promise<LoaderContext> | undefined;
  if (cached) return await cached;
  const pending = computeContext(request, params);
  slot.set("context", pending);
  return await pending;
}
