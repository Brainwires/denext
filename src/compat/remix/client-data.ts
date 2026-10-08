"use client";
/**
 * The browser half of a route module's data APIs — React Router v7 framework mode's (and
 * Remix ≥ 2.4's) `clientLoader`, `clientAction` and `HydrateFallback`. The generated route
 * boundary (`remix-codegen.ts`, `@denext/react-router`) calls {@link useClientRouteData} and
 * {@link useClientRouteAction}; an app never imports them.
 *
 *   • `clientLoader` runs in the browser and its result is the route's loader data. On the
 *     document's first load it runs only when it hydrates — `clientLoader.hydrate === true`,
 *     or the route has no server `loader` — and the route renders its `HydrateFallback` on
 *     the server and until it settles. A route a navigation mounts, and every revalidation
 *     (new server data or params), runs it. `serverLoader()` resolves the server loader's
 *     data, which denext's navigation already fetched with the route's server render.
 *   • `clientAction` runs in the browser for the route's `<Form>` / `useSubmit` / same-route
 *     fetcher submissions; `serverAction()` runs the server `action`. Its result is the
 *     action data, and the route revalidates after it, as after a server action.
 *
 * @module
 */

import {
  navigate,
  subscribeNavigating,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "../../../mod.ts";
import { DataWithResponseInit } from "./responses.ts";

/** The argument of a route's `clientLoader`. */
export interface ClientLoaderFunctionArgs {
  /** A `GET` request for the current URL (aborted when the route moves on). */
  request: Request;
  /** The route's URL params. */
  params: Record<string, string>;
  /** The server `loader`'s data (rejects when the route has no server loader). */
  serverLoader: <T = unknown>() => Promise<T>;
}

/** The argument of a route's `clientAction`. */
export interface ClientActionFunctionArgs {
  /** A `POST` request for the current URL carrying the submitted form. */
  request: Request;
  /** The route's URL params. */
  params: Record<string, string>;
  /** Run the route's server `action` with the same form (rejects when it has none). */
  serverAction: <T = unknown>() => Promise<T>;
}

/** A route's `clientLoader`; `hydrate: true` also runs it when the document first loads. */
export type ClientLoaderFunction = ((args: ClientLoaderFunctionArgs) => unknown) & {
  hydrate?: boolean;
};

/** A route's `clientAction`. */
export type ClientActionFunction = (args: ClientActionFunctionArgs) => unknown;

/** What the generated boundary passes {@link useClientRouteData}. */
export interface ClientRouteDataOptions {
  /** The route id. */
  id: string;
  /** The server `loader`'s data, threaded across the Flight boundary. */
  loaderData: unknown;
  /** The route's URL params. */
  params: Record<string, string>;
  /** The route's `clientLoader` export, if any. */
  clientLoader?: ClientLoaderFunction;
  /** Whether the route has a server `loader`. */
  hasServerLoader: boolean;
  /** Whether the route exports a `HydrateFallback`. */
  hasHydrateFallback: boolean;
  /**
   * React Router's SPA mode (`ssr: false`): the route's component never renders on the
   * server — its `HydrateFallback` does — and loads in the browser.
   */
  spa?: boolean;
}

/** What the boundary renders: the route's loader data, or its `HydrateFallback`. */
export interface ClientRouteData {
  /** The loader data the route component sees. */
  data: unknown;
  /** Render the `HydrateFallback` (or nothing) instead of the route component. */
  fallback: boolean;
}

// Whether a soft navigation has started since the document loaded: a route that mounts
// after one was brought in by a navigation, not by the document's own hydration.
let navigatedSinceLoad = false;
subscribeNavigating(() => {
  navigatedSinceLoad = true;
});

/** Forget the navigation history (tests; the next mount counts as the first load). @internal */
export function resetClientRouteNavigation(): void {
  navigatedSinceLoad = false;
}

/** The current URL (a placeholder outside the browser, where no loader runs). */
function currentUrl(): string {
  return typeof location !== "undefined" ? location.href : "http://localhost/";
}

/** A redirect `Response`'s target, or null. */
function redirectTarget(res: Response): string | null {
  const to = res.headers.get("location");
  return to && res.status >= 300 && res.status < 400 ? to : null;
}

/** A `Response`'s body as JSON when it says so, else text. */
async function responseBody(res: Response): Promise<unknown> {
  const type = res.headers.get("content-type") ?? "";
  return type.includes("json") ? await res.json() : await res.text();
}

/**
 * A client loader/action result as route data: a `data()` wrapper unwraps, a redirect
 * `Response` navigates (the data is `undefined`), any other `Response` yields its body.
 */
async function settleResult(value: unknown): Promise<unknown> {
  if (value instanceof DataWithResponseInit) return value.data;
  if (!(value instanceof Response)) return value;
  const to = redirectTarget(value);
  if (to === null) return await responseBody(value);
  navigate(to);
  return undefined;
}

/**
 * A thrown client loader error as the route error: a thrown `Response` becomes the error
 * response `isRouteErrorResponse` recognizes; a thrown redirect navigates instead (null).
 */
async function settleError(error: unknown): Promise<{ value: unknown } | null> {
  if (!(error instanceof Response)) return { value: error };
  const to = redirectTarget(error);
  if (to !== null) {
    navigate(to);
    return null;
  }
  const value = {
    status: error.status,
    statusText: error.statusText,
    data: await responseBody(error),
    __remixErrorResponse: true,
  };
  return { value };
}

/** The `serverLoader` / `serverAction` of a route without one: RR's error. */
function missingServer(kind: "loader" | "action", id: string): Promise<never> {
  const fn = kind === "loader" ? "serverLoader" : "serverAction";
  return Promise.reject(
    new Error(
      `You are trying to call ${fn}() on a route that does not have a server ${kind} ` +
        `(routeId: "${id}")`,
    ),
  );
}

/** Whether the route loads in the browser on the document's first load. */
function hydrates(o: ClientRouteDataOptions): boolean {
  if (o.spa) return true;
  return !!o.clientLoader && (o.clientLoader.hydrate === true || !o.hasServerLoader);
}

/** One state of a client-loaded route. */
interface LoadState {
  data: unknown;
  fallback: boolean;
  /** A client loader failure, rethrown during render to reach the route's ErrorBoundary. */
  error?: { value: unknown };
}

/**
 * Run a route's `clientLoader` (React Router v7 / Remix): see the module docs for when.
 * The first render — on the server, on hydration, and on a navigation's mount alike — is
 * the server data, or, when the route hydrates, its `HydrateFallback` (nothing without one)
 * unless it has server data and no fallback to show — so the hydrated markup always matches
 * the server's. In SPA mode the component never renders on the server.
 *
 * @param o The route's loader data, params and client exports.
 * @returns The data the route renders with, and whether it renders its fallback.
 * @internal Generated route code calls it.
 */
export function useClientRouteData(o: ClientRouteDataOptions): ClientRouteData {
  const hydrate = hydrates(o);
  const [state, setState] = useState<LoadState>(() => ({
    data: o.loaderData,
    fallback: hydrate && (o.hasHydrateFallback || !o.hasServerLoader || !!o.spa),
  }));
  const firstRun = useRef(true);
  const mountedByNavigation = useRef(navigatedSinceLoad);
  const paramsKey = JSON.stringify(o.params);
  useEffect(() => {
    const initial = firstRun.current;
    firstRun.current = false;
    if (initial && !mountedByNavigation.current && !hydrate) return;
    let live = true;
    const controller = new AbortController();
    loadOnce(o, controller.signal).then(
      (data) => live && setState({ data, fallback: false }),
      async (thrown) => {
        const error = await settleError(thrown);
        if (live && error) setState({ data: undefined, fallback: false, error });
      },
    );
    return () => {
      live = false;
      controller.abort();
    };
  }, [o.loaderData, paramsKey]);
  if (state.error) throw state.error.value;
  return { data: o.clientLoader ? state.data : o.loaderData, fallback: state.fallback };
}

/** One client load: the route's `clientLoader`, or (SPA mode without one) its server data. */
async function loadOnce(o: ClientRouteDataOptions, signal: AbortSignal): Promise<unknown> {
  if (!o.clientLoader) return o.loaderData;
  const serverLoader = <T>() =>
    o.hasServerLoader ? Promise.resolve(o.loaderData as T) : missingServer("loader", o.id);
  const request = new Request(currentUrl(), { signal });
  return await settleResult(await o.clientLoader({ request, params: o.params, serverLoader }));
}

/**
 * Route submissions through a route's `clientAction` (React Router v7 / Remix): the returned
 * function stands in for the route's server action, so `<Form>`, `useSubmit` and a
 * same-route fetcher run the client action, whose `serverAction()` runs the server one.
 *
 * @param id The route id.
 * @param serverAction The route's denext Server Action, when it declared an `action`.
 * @param params The route's URL params.
 * @param clientAction The route's `clientAction` export.
 * @returns The submission handler the route's provider exposes.
 * @internal Generated route code calls it.
 */
export function useClientRouteAction(
  id: string,
  serverAction: ((formData: FormData) => Promise<unknown>) | undefined,
  params: Record<string, string>,
  clientAction: ClientActionFunction,
): (formData: FormData) => Promise<unknown> {
  const paramsKey = JSON.stringify(params);
  return useCallback(async (formData: FormData) => {
    const request = new Request(currentUrl(), { method: "POST", body: formData });
    const runServer = <T>() =>
      serverAction ? serverAction(formData) as Promise<T> : missingServer("action", id);
    return await settleResult(await clientAction({ request, params, serverAction: runServer }));
  }, [id, serverAction, paramsKey, clientAction]);
}
