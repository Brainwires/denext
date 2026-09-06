// Remix's `AppLoadContext` — the object a custom server's `getLoadContext(req, res)` handed
// every loader/action as `context`. denext replaces that server, so an app registers a
// provider with {@link defineLoadContext} (`denext migrate --from remix` writes a
// `load-context.ts` from the server's `getLoadContext`) and the runtime calls it once per
// request, passing the result as `context`.
//
// The provider lives on `globalThis`, not a module `let`: `instrumentation.ts` registers it
// through the NATIVE module graph while a compat server bundle reaches this module through
// its own — the same seam the matches bridge and the document-attrs sink use.

import { currentContext } from "../../server/request-context.ts";

/** Remix's `AppLoadContext`: whatever the app's `getLoadContext` returns. */
export type AppLoadContext = Record<string, unknown>;

/** What a {@link LoadContextProvider} receives — the request and the route's URL params. */
export interface LoadContextArgs {
  /** The incoming request (or the export/prerender placeholder outside a live request). */
  request: Request;
  /** The matched route's URL params. */
  params: Record<string, string>;
}

/** Computes the `context` a loader/action receives; called once per request. */
export type LoadContextProvider = (
  args: LoadContextArgs,
) => AppLoadContext | Promise<AppLoadContext>;

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
 * The `context` for a loader/action: the registered provider's result, memoized per request
 * (an empty object when no provider is registered).
 *
 * @param request The request the loader/action runs for.
 * @param params The route's URL params.
 * @returns The app load context.
 */
export async function loadContext(
  request: Request,
  params: Record<string, string>,
): Promise<AppLoadContext> {
  const provider = store[PROVIDER];
  if (!provider) return {};
  const memo = currentContext()?.memo;
  if (!memo) return await provider({ request, params });
  let slot = memo.get(MEMO);
  if (!slot) memo.set(MEMO, slot = new Map());
  const cached = slot.get("context") as Promise<AppLoadContext> | undefined;
  if (cached) return await cached;
  const pending = Promise.resolve(provider({ request, params }));
  slot.set("context", pending);
  return await pending;
}
