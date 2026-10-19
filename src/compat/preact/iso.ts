/**
 * `denext/preact-iso` — preact-iso's API on denext, for a Preact SPA `denext migrate` moved:
 * `LocationProvider`, `useLocation`, `Router`, `Route`, `useRoute`, `exec`, `lazy`,
 * `ErrorBoundary`, `hydrate`, `prerender` and `locationStub`. preact-iso drives Preact's internal
 * render hooks, so it cannot run on denext's renderer as it is; this module implements the same
 * contract on denext's hooks and `<Suspense>`.
 *
 * Differences: while a `lazy()` route loads, `<Router>` renders nothing in its place (preact-iso
 * keeps the previous route on screen), and `onLoadStart` is not called.
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";
import { createContext } from "../../runtime/context.ts";
import {
  type Context,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
} from "../../runtime/hooks.ts";
import { Suspense } from "../../runtime/suspense.ts";
import { ErrorBoundary as DenextErrorBoundary } from "../../runtime/error-boundary.ts";
import { lazy as denextLazy } from "../../runtime/dynamic.ts";
import { Children, cloneElement } from "../../runtime/react-core.ts";
import { render as domRender } from "../react-dom.ts";
import { renderToString } from "../../jsx/render-to-string.ts";

/** What {@link useLocation} returns. */
export interface LocationHook {
  /** The current URL (path and query). */
  url: string;
  /** The path, without a trailing slash. */
  path: string;
  /** The query parameters. */
  query: Record<string, string>;
  /** Navigate to `url` (replacing the history entry with `replace`). */
  route: (url: string, replace?: boolean) => void;
  /** Go back in history. */
  back: () => void;
  /** Go forward in history. */
  forward: () => void;
}

/** What {@link useRoute} returns: the matched route's path, query and parameters. */
export interface RouteHook {
  /** The path matched. */
  path: string;
  /** The query parameters. */
  query: Record<string, string>;
  /** The route parameters. */
  params: Record<string, string>;
}

/** Match props {@link exec} fills: the parameters, plus `rest` for a `/*` route. */
export interface MatchProps {
  /** The route parameters. */
  params: Record<string, string>;
  /** What a trailing `*` matched. */
  rest?: string;
  /** Anything else (each parameter also appears as its own prop). */
  [prop: string]: unknown;
}

/** One navigation action. */
type NavAction = { url: string; replace?: boolean } | Event;

/** The current location as `path?query`. */
function currentUrl(): string {
  return typeof location === "undefined" ? "/" : location.pathname + location.search;
}

/** Restrict the links {@link LocationProvider} intercepts (its `scope` prop). */
let scope: string | RegExp | undefined;

/** Whether `href` is inside the provider's `scope`. */
function inScope(href: string): boolean {
  return !scope || (typeof scope === "string" ? href.startsWith(scope) : scope.test(href));
}

/** A click the browser handles itself: modified, not the main button, or already handled. */
function browserClick(e: MouseEvent): boolean {
  return e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey ||
    e.button !== 0;
}

/** Whether a link navigates within the app: same origin, not a hash, a download or a new tab. */
function appLink(link: HTMLAnchorElement): boolean {
  const href = link.getAttribute("href") ?? "";
  if (link.origin !== location.origin || href.startsWith("#")) return false;
  return /^(_?self)?$/i.test(link.target) && !link.download && inScope(href);
}

/** The same-origin `<a>` a click should navigate to on the client, or null. */
function clickedLink(e: MouseEvent): HTMLAnchorElement | null {
  if (browserClick(e)) return null;
  const link = e.composedPath().find((el) =>
    (el as Element).nodeName === "A" && (el as HTMLAnchorElement).href
  ) as HTMLAnchorElement | undefined;
  return link && appLink(link) ? link : null;
}

/** The location reducer: a link click, history navigation, or `route()`. */
function navigate(state: string, action: NavAction): string {
  if (action instanceof Event) {
    if (action.type !== "click") return currentUrl();
    const link = clickedLink(action as MouseEvent);
    if (!link) return state;
    action.preventDefault();
    const url = link.href.replace(location.origin, "");
    history.pushState(null, "", url);
    return url;
  }
  if (action.replace) history.replaceState(null, "", action.url);
  else history.pushState(null, "", action.url);
  return action.url;
}

const LocationContext: Context<LocationHook> = createContext<LocationHook>(
  null as unknown as LocationHook,
);
const RouteContext: Context<Partial<RouteHook> & { rest?: string }> = createContext({});

/** Props of {@link LocationProvider}. */
export interface LocationProviderProps {
  /** Only intercept links whose `href` starts with (or matches) this. */
  scope?: string | RegExp;
  /** The app. */
  children?: VNodeChildren;
}

function LocationProviderComponent(props: LocationProviderProps): VNode {
  const [url, dispatch] = useReducer(navigate, undefined, currentUrl);
  if (props.scope) scope = props.scope;
  const value = useMemo<LocationHook>(() => {
    const u = new URL(url, "http://localhost");
    return {
      url,
      path: u.pathname.replace(/\/+$/, "") || "/",
      query: Object.fromEntries(u.searchParams),
      route: (to, replace) => dispatch({ url: to, replace }),
      back: () => history.back(),
      forward: () => history.forward(),
    };
  }, [url]);
  useLayoutEffect(() => {
    addEventListener("click", dispatch);
    addEventListener("popstate", dispatch);
    return () => {
      removeEventListener("click", dispatch);
      removeEventListener("popstate", dispatch);
    };
  }, []);
  return h(LocationContext as never, { value }, props.children);
}

/**
 * Track the URL: same-origin link clicks and back / forward navigate on the client. Its `ctx` is
 * the location context (preact-iso's `LocationProvider.ctx`).
 */
export const LocationProvider:
  & ((props: LocationProviderProps) => VNode)
  & { ctx: Context<LocationHook> } = Object.assign(LocationProviderComponent, {
    ctx: LocationContext,
  });

/**
 * The current location.
 *
 * @returns The URL, path, query and navigation functions.
 */
export function useLocation(): LocationHook {
  return useContext(LocationContext);
}

/**
 * The matched route.
 *
 * @returns Its path, query and parameters.
 */
export function useRoute(): RouteHook {
  const r = useContext(RouteContext);
  return { path: r.path ?? "", query: r.query ?? {}, params: r.params ?? {} };
}

/** One segment pattern: `:name` with a `?` / `+` / `*` flag, or a literal. */
function segment(part: string): { param: boolean; name: string; flag: string } {
  const m = /^(:?)(.*?)([+*?]?)$/.exec(part)!;
  return { param: m[1] === ":", name: m[2], flag: m[3] };
}

/**
 * Match a URL path against a route pattern (`/user/:id`, `/files/*`, `/:a?`, `/:rest+`).
 *
 * @param url The URL path.
 * @param route The pattern.
 * @param matches The props to fill.
 * @returns The props with the parameters, or undefined when it does not match.
 */
export function exec(
  url: string,
  route: string,
  matches: MatchProps = { params: {} },
): MatchProps | undefined {
  const parts = url.split("/").filter(Boolean);
  const pattern = (route || "").split("/").filter(Boolean);
  matches.params ??= {};
  for (let i = 0; i < Math.max(parts.length, pattern.length); i++) {
    const step = matchSegment(parts, i, segment(pattern[i] ?? ""), matches);
    if (step === "fail") return undefined;
    if (step === "done") break;
  }
  return matches;
}

/** A literal pattern segment: equal, a trailing `*` (the rest of the URL), or no match. */
function literalSegment(
  parts: string[],
  i: number,
  seg: { name: string; flag: string },
  matches: MatchProps,
): "next" | "done" | "fail" {
  const val = parts[i];
  if (seg.name === val) return "next";
  if (!val || seg.flag !== "*") return "fail";
  matches.rest = "/" + parts.slice(i).join("/");
  return "done";
}

/** Match URL segment `i` against one pattern segment, recording what it captured. */
function matchSegment(
  parts: string[],
  i: number,
  seg: { param: boolean; name: string; flag: string },
  matches: MatchProps,
): "next" | "done" | "fail" {
  const val = parts[i];
  if (!seg.param) return literalSegment(parts, i, seg, matches);
  if (!val && seg.flag !== "?" && seg.flag !== "*") return "fail";
  const rest = seg.flag === "+" || seg.flag === "*";
  const value = rest
    ? parts.slice(i).map(decodeURIComponent).join("/") || undefined
    : val && decodeURIComponent(val);
  matches.params[seg.name] = value as string;
  if (!(seg.name in matches)) matches[seg.name] = value;
  return rest ? "done" : "next";
}

/** Props of {@link Router}. */
export interface RouterProps {
  /** Called with the URL after a route renders. */
  onRouteChange?: (url: string) => void;
  /** Called with the URL once a route has rendered. */
  onLoadEnd?: (url: string) => void;
  /** Not called on denext. */
  onLoadStart?: (url: string) => void;
  /** `<Route>`s or components with a `path` / `default` prop. */
  children?: VNodeChildren;
}

/**
 * Render the first child whose `path` matches the URL (else the `default` one), with the match
 * as props (`params`, `path`, `query`, `rest`, and each parameter).
 *
 * @param props The routes.
 * @returns The matched route.
 */
export function Router(props: RouterProps): VNode {
  const { url, path, query } = useLocation();
  const parent = useContext(RouteContext);
  const rest = parent.rest || path;
  let matched: VNode | undefined;
  let fallback: VNode | undefined;
  let matchProps: MatchProps = { params: {} };
  for (const child of Children.toArray(props.children) as VNode[]) {
    const childProps = child.props as Record<string, unknown>;
    const candidate: MatchProps = {
      ...childProps,
      path: rest,
      query,
      params: { ...parent.params },
      rest: "",
    };
    if (exec(rest, childProps.path as string, candidate)) {
      matched = cloneElement(child, candidate as never);
      matchProps = candidate;
      break;
    }
    if (childProps.default && !fallback) {
      fallback = cloneElement(child, candidate as never);
      matchProps = candidate;
    }
  }
  useEffect(() => {
    props.onRouteChange?.(url);
    props.onLoadEnd?.(url);
  }, [url]);
  const route = matched ?? fallback ?? null;
  return h(
    RouteContext as never,
    { value: matchProps },
    h(Suspense, { fallback: null }, route as VNodeChildren),
  );
}

/** Props of {@link Route}. */
export interface RouteProps {
  /** The pattern. */
  path?: string;
  /** Render when no other route matches. */
  default?: boolean;
  /** The component to render. */
  component: (props: never) => unknown;
  /** Props passed on. */
  [prop: string]: unknown;
}

/**
 * A route: renders `component` with the match props.
 *
 * @param props The pattern, the component and its props.
 * @returns The component.
 */
export function Route(props: RouteProps): VNode {
  const { component, ...rest } = props;
  return h(component as never, rest);
}

/** A component {@link lazy} returns: it suspends until loaded, and can be preloaded. */
export type LazyComponent<P> = ((props: P) => VNode) & { preload(): Promise<unknown> };

/**
 * A component loaded on first render (`lazy(() => import("./Page.jsx"))`; the module's default
 * export, or the value the loader resolves to).
 *
 * @param load Loads the module or the component.
 * @returns The component.
 */
export function lazy<P = Record<string, unknown>>(
  load: () => Promise<unknown>,
): LazyComponent<P> {
  let pending: Promise<{ default: (props: P) => VNode }> | undefined;
  const loadModule = () =>
    pending ??= load().then((m) => {
      const c = (m as { default?: unknown })?.default ?? m;
      return { default: c as (props: P) => VNode };
    });
  const Component = denextLazy(loadModule as never) as unknown as LazyComponent<P>;
  Component.preload = loadModule;
  return Component;
}

/** Props of {@link ErrorBoundary}. */
export interface ErrorBoundaryProps {
  /** Called with an error a child threw. */
  onError?: (error: unknown) => void;
  /** The content. */
  children?: VNodeChildren;
}

/**
 * Catch a render error below (calling `onError`); the content renders nothing in its place.
 *
 * @param props The handler and the content.
 * @returns The boundary.
 */
export function ErrorBoundary(props: ErrorBoundaryProps): VNode {
  const Fallback = (fallback: { error: unknown }) => {
    useEffect(() => props.onError?.(fallback.error), [fallback.error]);
    return null as unknown as VNode;
  };
  return h(DenextErrorBoundary, { fallback: Fallback, children: props.children });
}

/**
 * Render the app into `parent` (default: the body). denext renders a SPA on the client, so
 * there is no server markup to hydrate.
 *
 * @param jsx The app.
 * @param parent Where to render it.
 */
export function hydrate(jsx: VNode, parent?: Element | null): void {
  if (typeof document === "undefined") return;
  domRender(jsx, parent ?? document.body);
}

/**
 * Render the app to HTML (preact-iso's `prerender`), with the same-site links it holds.
 *
 * @param vnode The app (or a component).
 * @param options Props to render it with.
 * @returns The HTML and the links.
 */
export async function prerender(
  vnode: VNode | ((props: Record<string, unknown>) => VNode),
  options: { props?: Record<string, unknown> } = {},
): Promise<{ html: string; links: Set<string> }> {
  const node = typeof vnode === "function"
    ? h(vnode as never, options.props ?? {})
    : options.props
    ? cloneElement(vnode, options.props as never)
    : vnode;
  const html = await renderToString(node);
  const links = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*?href="([^"]+)"[^>]*>/g)) {
    if (!/\starget="(?!_self")/.test(m[0])) links.add(m[1]);
  }
  return { html: html + `<script type="isodata"></script>`, links };
}

/**
 * Point `globalThis.location` at `path`, for code that reads it while prerendering.
 *
 * @param path The URL path.
 */
export function locationStub(path: string): void {
  const u = new URL(path, "http://localhost");
  const stub: Record<string, unknown> = {};
  for (
    const key of [
      "href",
      "origin",
      "protocol",
      "host",
      "hostname",
      "port",
      "pathname",
      "search",
      "hash",
    ]
  ) {
    stub[key] = u[key as keyof URL];
  }
  (globalThis as { location?: unknown }).location = stub;
}
