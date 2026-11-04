// React Router 7 route middleware (`export const middleware = [fn, …]`, or the older
// `unstable_middleware`): each function gets `{ request, params, context }` and a `next()` that
// runs the rest of the chain and resolves to the response. The types and the chain composition
// live here; ./server.ts runs a route's chain before its loader/action.

import type { LoaderContext } from "./load-context.ts";

/** What a route middleware receives: the request, the route's params and the request context. */
export interface MiddlewareFunctionArgs {
  /** The incoming request. */
  request: Request;
  /** The matched route's URL params. */
  params: Record<string, string>;
  /** The request's context — `context.get(key)` / `context.set(key, value)`. */
  context: LoaderContext;
}

/**
 * A React Router route middleware. Call `next()` to run the rest of the chain (and the
 * handler); return its response, another `Response` to answer instead, or nothing. Throwing a
 * `redirect()` or a `Response` stops the request the way a loader's throw does.
 */
export type MiddlewareFunction = (
  args: MiddlewareFunctionArgs,
  next: () => Promise<Response>,
) => Response | undefined | void | Promise<Response | undefined | void>;

/** One route of a middleware chain, outermost first: its id and its `middleware` export. */
export interface RouteMiddleware {
  /** The route id (each route's middleware runs once per request). */
  id: string;
  /** The route's `middleware` export, when it has one. */
  middleware?: readonly MiddlewareFunction[];
}

/**
 * Run `fns` in order around `terminal`, React Router's way: each `next()` runs the rest; a
 * middleware that returns a `Response` answers with it, one that returns nothing answers with
 * what `next()` gave (calling it when the middleware did not).
 *
 * @param fns The middleware functions, outermost first.
 * @param args What each receives.
 * @param terminal The handler the innermost `next()` runs.
 * @returns The response.
 */
export async function composeMiddleware(
  fns: readonly MiddlewareFunction[],
  args: MiddlewareFunctionArgs,
  terminal: () => Promise<Response>,
): Promise<Response> {
  const dispatch = async (i: number): Promise<Response> => {
    if (i >= fns.length) return await terminal();
    let pending: Promise<Response> | undefined;
    const next = (): Promise<Response> => {
      if (pending) throw new Error("You may only call `next()` once per middleware");
      return pending = dispatch(i + 1);
    };
    const result = await fns[i](args, next);
    if (result instanceof Response) return result;
    return await (pending ?? next());
  };
  return await dispatch(0);
}

/** Every middleware function of a chain, outermost first. */
export function chainFunctions(
  chain: readonly RouteMiddleware[] | undefined,
): MiddlewareFunction[] {
  return (chain ?? []).flatMap((route) => route.middleware ?? []);
}
