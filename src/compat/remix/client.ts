"use client";
/**
 * `denext/remix` — the client runtime of the Remix compat layer (the surface a Remix
 * app imports from `@remix-run/react`). It maps Remix's data/navigation model onto
 * denext primitives:
 *
 *   • `useLoaderData()` / `useActionData()` read data the server wrapper threaded across
 *     the Flight boundary as client-component props (see {@link RemixRouteProvider}) and
 *     a small client action-data store updated on submit.
 *   • `<Form>` submits to the route's denext **Server Action**; `useSubmit`/`useFetcher`
 *     drive the same action programmatically.
 *   • navigation hooks (`useNavigate`/`useLocation`/`useSearchParams`/`useNavigation`)
 *     wrap denext's client router (`useRouter`/`usePathname`/`useSearchParams`).
 *   • `<Link>`/`<NavLink>`/`<Outlet>` map to denext `<Link>` + layout `children`.
 *   • `<Await>`/`useAsyncValue` resolve deferred data with Suspense + `use()`.
 *
 * @module
 */

import {
  createContext,
  Fragment,
  getNavigatingHref,
  h,
  Link as DenextLink,
  navigate,
  subscribeNavigating,
  useCallback,
  useContext,
  usePathname,
  useRouter,
  useSearchParams as denextUseSearchParams,
  useState,
  useSyncExternalStore,
} from "../../../mod.ts";
import { actionEndpoint, isServerAction } from "../../runtime/server-action.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";

// ── Route match + contexts ────────────────────────────────────────────────────

/** A single route match, as exposed by {@link useMatches}. */
export interface RemixMatch {
  /** The route id (its app-relative module path). */
  id: string;
  /** The matched pathname for this route. */
  pathname: string;
  /** The route's URL params. */
  params: Record<string, string>;
  /** The route's loader data. */
  data: unknown;
  /** The route's `handle` export (arbitrary per-route metadata). */
  handle: unknown;
}

const LoaderDataContext = createContext<unknown>(undefined);
const RouteErrorContext = createContext<unknown>(undefined);
const MatchesContext = createContext<RemixMatch[]>([]);
const OutletValueContext = createContext<unknown>(null);
const OutletChildrenContext = createContext<VNodeChildren>(null);

/** The current route's identity + its bound Server Action (for `<Form>`/`useSubmit`). */
interface RouteInfo {
  id: string;
  handle: unknown;
  params: Record<string, string>;
  /** The route's denext Server Action, if it declared an `action`. */
  formAction?: (formData: FormData) => Promise<unknown>;
}
const RouteContext = createContext<RouteInfo | null>(null);

// ── Client action-data store (updated when a Form/useSubmit runs the action) ──

const actionData = new Map<string, unknown>();
const actionListeners = new Set<() => void>();
function setActionData(routeId: string, data: unknown): void {
  actionData.set(routeId, data);
  for (const l of actionListeners) l();
}
function subscribeActionData(listener: () => void): () => void {
  actionListeners.add(listener);
  return () => actionListeners.delete(listener);
}

// ── Global navigation/submission state (for useNavigation) ────────────────────

/** Remix navigation states. */
export type NavigationState = "idle" | "loading" | "submitting";
interface NavState {
  state: NavigationState;
  formData?: FormData;
  formAction?: string;
  formMethod?: string;
}
let navState: NavState = { state: "idle" };
const navListeners = new Set<() => void>();
function setNavState(next: NavState): void {
  navState = next;
  for (const l of navListeners) l();
}
function subscribeNav(listener: () => void): () => void {
  navListeners.add(listener);
  return () => navListeners.delete(listener);
}

// ── The provider the generated server wrapper renders around each route ───────

/** Props {@link RemixRouteProvider} receives from the generated server `page.tsx`. */
export interface RemixRouteProviderProps {
  /** The route id (app-relative path). */
  id: string;
  /** Data returned by the route's `loader` (serialized across the Flight boundary). */
  loaderData: unknown;
  /** The route's URL params. */
  params: Record<string, string>;
  /** The route's `handle` export. */
  handle?: unknown;
  /** The route's denext Server Action, when it declared an `action`. */
  formAction?: (formData: FormData) => Promise<unknown>;
  /** Value passed to a child `<Outlet context={…}>`. */
  outletContext?: unknown;
  /** The route subtree. */
  children?: VNodeChildren;
}

/**
 * Wraps a migrated Remix route so its component tree sees Remix's contexts. Rendered by
 * the generated server `page.tsx`/`layout.tsx`; `loaderData` crosses the Flight boundary
 * here (client-component prop), giving `useLoaderData()` its value on SSR **and** hydrate.
 */
export function RemixRouteProvider(props: RemixRouteProviderProps): VNode {
  const parent = useContext(MatchesContext);
  const pathname = usePathname();
  const match: RemixMatch = {
    id: props.id,
    pathname,
    params: props.params,
    data: props.loaderData,
    handle: props.handle ?? undefined,
  };
  const matches = [...parent, match];
  const routeInfo: RouteInfo = {
    id: props.id,
    handle: props.handle,
    params: props.params,
    formAction: props.formAction,
  };
  return h(
    MatchesContext.Provider,
    { value: matches },
    h(
      LoaderDataContext.Provider,
      { value: props.loaderData },
      h(
        RouteContext.Provider,
        { value: routeInfo },
        h(
          OutletValueContext.Provider,
          { value: props.outletContext ?? null },
          props.children,
        ),
      ),
    ),
  );
}

/**
 * Provides a layout's nested-route subtree to a descendant `<Outlet/>`. The generated
 * layout wrapper renders `<OutletProvider outlet={children}>` around the user layout
 * component so its `<Outlet/>` resolves.
 */
export function OutletProvider(props: { outlet?: VNodeChildren; children?: VNodeChildren }): VNode {
  return h(OutletChildrenContext.Provider, { value: props.outlet ?? null }, props.children);
}

// ── Provides the route error to an ErrorBoundary (from the generated error.tsx) ──

/** Props the generated `error.tsx` passes so `useRouteError()` resolves. */
export interface RemixErrorProviderProps {
  error: unknown;
  children?: VNodeChildren;
}

/** Exposes a caught error to a Remix `ErrorBoundary` via {@link useRouteError}. */
export function RemixErrorProvider(props: RemixErrorProviderProps): VNode {
  return h(RouteErrorContext.Provider, { value: props.error }, props.children);
}

// ── Data hooks ────────────────────────────────────────────────────────────────

/** The current route's loader data (Remix `useLoaderData`). */
export function useLoaderData<T = unknown>(): T {
  return useContext(LoaderDataContext) as T;
}

/** The nearest route's action data, or `undefined` before a submission (Remix `useActionData`). */
export function useActionData<T = unknown>(): T | undefined {
  const route = useContext(RouteContext);
  const id = route?.id ?? "";
  return useSyncExternalStore(
    subscribeActionData,
    () => actionData.get(id) as T | undefined,
    () => undefined,
  );
}

/** A specific ancestor route's loader data by id (Remix `useRouteLoaderData`). */
export function useRouteLoaderData<T = unknown>(routeId: string): T | undefined {
  const matches = useContext(MatchesContext);
  return matches.find((m) => m.id === routeId)?.data as T | undefined;
}

/** All active route matches, outermost first (Remix `useMatches`). */
export function useMatches(): RemixMatch[] {
  return useContext(MatchesContext);
}

/** The current route's URL params (Remix `useParams`). */
export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  const route = useContext(RouteContext);
  return (route?.params ?? {}) as T;
}

// ── Navigation hooks ──────────────────────────────────────────────────────────

/** The current location (Remix `useLocation`). */
export interface RemixLocation {
  pathname: string;
  search: string;
  hash: string;
  state: unknown;
  key: string;
}

/** The current location object (Remix `useLocation`). */
export function useLocation(): RemixLocation {
  const pathname = usePathname();
  const sp = denextUseSearchParams();
  const search = sp.toString();
  const hash = typeof location !== "undefined" ? location.hash : "";
  return {
    pathname,
    search: search ? `?${search}` : "",
    hash,
    state: (typeof history !== "undefined" ? history.state?.usr : undefined) ?? null,
    key: "default",
  };
}

/** Options accepted by the {@link useNavigate} function and `<Form>`. */
export interface RemixNavigateOptions {
  replace?: boolean;
  state?: unknown;
  preventScrollReset?: boolean;
}

/** Programmatic navigation (Remix `useNavigate`) — a path (with options) or a history delta. */
export function useNavigate(): (to: string | number, options?: RemixNavigateOptions) => void {
  const router = useRouter();
  return useCallback((to: string | number, options?: RemixNavigateOptions) => {
    if (typeof to === "number") {
      if (typeof history !== "undefined") history.go(to);
      return;
    }
    if (options?.replace) router.replace(to);
    else router.push(to);
  }, [router]);
}

/** Remix `useSearchParams` — the tuple form `[params, setSearchParams]`. */
export function useSearchParams(): [
  URLSearchParams,
  (
    next: URLSearchParams | Record<string, string> | ((prev: URLSearchParams) => URLSearchParams),
    options?: RemixNavigateOptions,
  ) => void,
] {
  const params = denextUseSearchParams();
  const setParams = useCallback(
    (
      next:
        | URLSearchParams
        | Record<string, string>
        | ((prev: URLSearchParams) => URLSearchParams),
      options?: RemixNavigateOptions,
    ) => {
      const resolved = typeof next === "function"
        ? next(new URLSearchParams(params.toString()))
        : next instanceof URLSearchParams
        ? next
        : new URLSearchParams(next);
      const qs = resolved.toString();
      const path = typeof location !== "undefined" ? location.pathname : "";
      navigate(qs ? `${path}?${qs}` : path, { replace: options?.replace });
    },
    [params],
  );
  return [params, setParams];
}

/** The current navigation/submission (Remix `useNavigation`). */
export interface Navigation {
  state: NavigationState;
  formData?: FormData;
  formAction?: string;
  formMethod?: string;
  location?: RemixLocation;
}

/** Parse an href (relative or absolute) into a Remix `location`. */
function hrefToLocation(href: string): RemixLocation {
  let pathname = href;
  let search = "";
  let hash = "";
  try {
    const base = typeof location !== "undefined" ? location.href : "http://localhost/";
    const u = new URL(href, base);
    pathname = u.pathname;
    search = u.search;
    hash = u.hash;
  } catch { /* non-URL href — keep it as the pathname */ }
  return { pathname, search, hash, state: null, key: "default" };
}

/** Reduce a (possibly absolute) same-origin URL to a path+search+hash for a soft nav. */
function sameOriginPath(href: string): string {
  try {
    const base = typeof location !== "undefined" ? location.href : "http://localhost/";
    const u = new URL(href, base);
    return u.pathname + u.search + u.hash;
  } catch {
    return href;
  }
}

/**
 * Remix `useNavigation` — the app's pending navigation/submission. A submission driven
 * through this layer (`<Form>`/`useSubmit`/`useFetcher`) reports `submitting`; a plain
 * `<Link>`/`useNavigate`/history navigation reports `loading` with the target `location`
 * (backed by denext's global soft-navigation signal). Idle otherwise.
 */
export function useNavigation(): Navigation {
  const submission = useSyncExternalStore(subscribeNav, () => navState, () => navState);
  const navHref = useSyncExternalStore(subscribeNavigating, getNavigatingHref, () => null);
  // A submission takes precedence and stays "submitting" through its own revalidation.
  if (submission.state !== "idle") return submission;
  if (navHref) return { state: "loading", location: hrefToLocation(navHref) };
  return { state: "idle" };
}

/** Revalidate loader data (Remix `useRevalidator`). */
export function useRevalidator(): { revalidate: () => void; state: "idle" | "loading" } {
  const router = useRouter();
  return { revalidate: () => router.refresh(), state: "idle" };
}

/** Resolve a form's action URL (Remix `useFormAction`) — defaults to the current path. */
export function useFormAction(action?: string): string {
  const pathname = usePathname();
  return action ?? pathname;
}

/** Resolve an href (Remix `useHref`) — best-effort passthrough. */
export function useHref(to: string): string {
  return to;
}

/** Resolve a path relative to the current route (Remix `useResolvedPath`). */
export function useResolvedPath(to: string): { pathname: string; search: string; hash: string } {
  const [path, rest = ""] = to.split("?");
  const [search, hash = ""] = rest.split("#");
  return { pathname: path, search: search ? `?${search}` : "", hash: hash ? `#${hash}` : "" };
}

// ── Submission (Form / useSubmit / useFetcher) ────────────────────────────────

/** Run a route's Server Action with a FormData payload, then revalidate. */
async function runRouteAction(
  route: RouteInfo | null,
  formData: FormData,
  router: { refresh: () => void },
): Promise<unknown> {
  if (!route?.formAction) return undefined;
  setNavState({ state: "submitting", formData, formAction: route.id, formMethod: "post" });
  try {
    const result = await route.formAction(formData);
    setActionData(route.id, result);
    router.refresh();
    return result;
  } finally {
    setNavState({ state: "idle" });
  }
}

/** Programmatic form submission (Remix `useSubmit`). */
export function useSubmit(): (
  target: HTMLFormElement | FormData | Record<string, string> | null,
  options?: { method?: string; replace?: boolean },
) => void {
  const route = useContext(RouteContext);
  const router = useRouter();
  return useCallback((target) => {
    const fd = toFormData(target);
    void runRouteAction(route, fd, router);
  }, [route, router]);
}

/** Coerce a submit target into FormData. */
function toFormData(
  target: HTMLFormElement | FormData | Record<string, string> | null,
): FormData {
  if (target instanceof FormData) return target;
  if (target && typeof (target as HTMLFormElement).elements !== "undefined") {
    return new FormData(target as HTMLFormElement);
  }
  const fd = new FormData();
  if (target && typeof target === "object") {
    for (const [k, v] of Object.entries(target)) fd.append(k, String(v));
  }
  return fd;
}

/**
 * Find the first client-boundary `loaderData` in a denext Flight payload. A migrated
 * Remix route serializes as `{ $: "c", p: { loaderData, … } }`; this pulls the target
 * route's loader data out of the payload so `fetcher.load(href)` gets it without
 * navigating.
 *
 * @internal Exported for testing.
 */
export function findLoaderData(node: unknown): unknown {
  if (Array.isArray(node)) return firstLoaderData(node);
  if (!node || typeof node !== "object") return undefined;
  const o = node as Record<string, unknown>;
  if (o.$ === "c" && o.p && typeof o.p === "object" && "loaderData" in o.p) {
    return (o.p as Record<string, unknown>).loaderData;
  }
  return firstLoaderData(Object.values(o));
}

/** The first defined `loaderData` found among `items` (depth-first). */
function firstLoaderData(items: Iterable<unknown>): unknown {
  for (const item of items) {
    const found = findLoaderData(item);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Load a route's data without navigating (`fetcher.load`). Fetches `href`: a resource
 * route answers with JSON (returned as-is); a page route answers with a Flight payload,
 * from which the target route's `loaderData` is extracted. Returns `undefined` on error.
 */
async function fetchRouteData(href: string): Promise<unknown> {
  try {
    const res = await fetch(href, {
      headers: { "x-denext-nav": "1", "accept": "application/json" },
      credentials: "same-origin",
    });
    if (res.headers.get("x-denext-flight") === "1") return findLoaderData(await res.json());
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("application/json")) return await res.json();
    return undefined;
  } catch {
    return undefined;
  }
}

/** A Remix fetcher (Remix `useFetcher`) — same-route action + cross-route load/submit. */
export interface Fetcher<T = unknown> {
  state: NavigationState;
  data: T | undefined;
  formData?: FormData;
  submit: (
    target: HTMLFormElement | FormData | Record<string, string>,
    options?: { method?: string; action?: string },
  ) => void;
  load: (href: string) => void;
  Form: (props: FormProps) => VNode;
}

/**
 * Remix `useFetcher` — non-navigation loads/mutations that don't drive the global
 * navigation. `submit` with no `action` runs the current route's Server Action;
 * `submit` with an `action` URL POSTs the FormData there — a resource route (`route.ts`)
 * OR another **page** route's `action` (the migration emits a `route.ts` POST handler
 * beside a page that has an action, so a POST to the page URL runs it) — reading back
 * its JSON, or following a redirecting action. `load(href)` fetches the target route's
 * loader data (page route via its Flight payload, resource route via its JSON) without
 * navigating. Each settles into `fetcher.data` and revalidates the current route.
 */
export function useFetcher<T = unknown>(): Fetcher<T> {
  const route = useContext(RouteContext);
  const router = useRouter();
  const [state, setState] = useState<NavigationState>("idle");
  const [data, setData] = useState<T | undefined>(undefined);
  const submit = useCallback(
    (
      target: HTMLFormElement | FormData | Record<string, string>,
      options?: { method?: string; action?: string },
    ) => {
      const fd = toFormData(target);
      setState("submitting");
      const settle = (r: unknown) => {
        setData(r as T | undefined);
        setState("idle");
        router.refresh();
      };
      if (options?.action) {
        // Cross-route: POST the payload to the target URL. A resource route (`route.ts`)
        // answers directly; a page route runs its `action` (denext dispatches a POST to a
        // page URL to the `route.ts` the migration emits beside it). A redirecting action
        // (the login pattern) is followed by `fetch`, so honor it with a soft navigation.
        fetch(options.action, {
          method: options.method ?? "post",
          body: fd,
          credentials: "same-origin",
        })
          .then(async (r) => {
            if (r.redirected) {
              navigate(sameOriginPath(r.url));
              return undefined;
            }
            return r.headers.get("content-type")?.includes("json")
              ? await r.json()
              : await r.text();
          })
          .then(settle)
          .catch(() => settle(undefined));
      } else {
        // Same-route: run this route's bound Server Action.
        Promise.resolve(route?.formAction?.(fd)).then(settle).catch(() => settle(undefined));
      }
    },
    [route, router],
  );
  const load = useCallback((href: string) => {
    setState("loading");
    fetchRouteData(href).then((d) => {
      setData(d as T | undefined);
      setState("idle");
    });
  }, []);
  const FetcherForm = useCallback(
    (props: FormProps) => h(Form, { ...props, __fetcherSubmit: submit } as FormProps),
    [submit],
  );
  return { state, data, submit, load, Form: FetcherForm };
}

// ── Components ────────────────────────────────────────────────────────────────

/** Props for the Remix-compatible {@link Link}. */
export interface LinkProps {
  /** Remix destination (mapped to denext's `href`). */
  to?: string;
  /** denext-native destination (also accepted). */
  href?: string;
  replace?: boolean;
  prefetch?: "none" | "intent" | "render" | "viewport" | boolean;
  reloadDocument?: boolean;
  state?: unknown;
  children?: VNodeChildren;
  [key: string]: unknown;
}

/** Remix `<Link>` → denext `<Link>` (`to` mapped to `href`; `reloadDocument` → plain `<a>`). */
export function Link(props: LinkProps): VNode {
  const { to, href, prefetch, reloadDocument, state: _state, ...rest } = props;
  const dest = String(href ?? to ?? "");
  if (reloadDocument) return h("a", { ...rest, href: dest });
  const pf = prefetch === "none" || prefetch === false ? false : undefined;
  return h(DenextLink, { href: dest, prefetch: pf, ...rest });
}

/** Props for the Remix-compatible {@link NavLink}. */
export interface NavLinkProps extends Omit<LinkProps, "children" | "className" | "style"> {
  end?: boolean;
  caseSensitive?: boolean;
  className?: string | ((s: { isActive: boolean; isPending: boolean }) => string);
  style?:
    | Record<string, string | number>
    | ((s: { isActive: boolean; isPending: boolean }) => Record<string, string | number>);
  children?: VNodeChildren | ((s: { isActive: boolean; isPending: boolean }) => VNodeChildren);
}

/** Remix `<NavLink>` → denext `<Link>` with an `isActive` computed from the pathname. */
export function NavLink(props: NavLinkProps): VNode {
  const { to, href, end, caseSensitive, className, style, children, ...rest } = props;
  const dest = String(href ?? to ?? "");
  const pathname = usePathname();
  const a = caseSensitive ? pathname : pathname.toLowerCase();
  const b = caseSensitive ? dest : dest.toLowerCase();
  const isActive = end ? a === b : a === b || a.startsWith(b.endsWith("/") ? b : b + "/");
  const s = { isActive, isPending: false };
  const resolvedClass = typeof className === "function" ? className(s) : className;
  const resolvedStyle = typeof style === "function" ? style(s) : style;
  const resolvedChildren = typeof children === "function" ? children(s) : children;
  return h(DenextLink, {
    href: dest,
    className: resolvedClass,
    style: resolvedStyle,
    "aria-current": isActive ? "page" : undefined,
    ...rest,
  }, resolvedChildren);
}

/** Props for the Remix-compatible {@link Form}. */
export interface FormProps {
  method?: "get" | "post" | "put" | "patch" | "delete" | "GET" | "POST" | string;
  action?: string;
  replace?: boolean;
  reloadDocument?: boolean;
  encType?: string;
  onSubmit?: (event: Event) => void;
  children?: VNodeChildren;
  /** @internal wires a fetcher's submit handler (with the form's action/method). */
  __fetcherSubmit?: (
    target: HTMLFormElement,
    options?: { action?: string; method?: string },
  ) => void;
  [key: string]: unknown;
}

/**
 * Compute a `<Form>`'s DOM `action` attribute. For a mutating method bound to the
 * route's Server Action it returns the action's **endpoint URL string** (so the
 * no-JS path still posts to the right place); otherwise it passes the caller's
 * `action` through.
 *
 * Crucially it NEVER returns the Server-Action ref (a function) itself: denext's
 * reconciler treats a function-valued `action`/`formAction` as a React-19 form
 * action and wires its OWN submit handler (dispatch + refresh directives), which
 * would run the action outside Remix's submit lifecycle — bypassing
 * `useActionData`/`useNavigation`/revalidation. Remix drives the submit through
 * `<Form>`'s own `onSubmit` (`runRouteAction`) instead, so the DOM `action` is only
 * the progressive-enhancement fallback URL.
 *
 * @internal Exported for regression testing (guards against handing denext a
 * function-valued action again).
 */
export function formActionAttr(
  routeAction: ((formData: FormData) => Promise<unknown>) | undefined,
  userAction: string | undefined,
  isGet: boolean,
): string | undefined {
  // An explicit `action` (a cross-route resource/action URL, or a GET search target)
  // is honored as-is; only a mutating form with NO explicit action binds to the
  // current route's Server Action endpoint.
  if (isGet || userAction) return userAction;
  return routeAction && isServerAction(routeAction)
    ? actionEndpoint(routeAction.denextActionId)
    : undefined;
}

/**
 * Remix `<Form>` → a `<form>` bound to the route's denext Server Action. `method="get"`
 * is a soft search-navigation (progressive-enhancement, like Next's `<Form>`); a mutating
 * method posts to the route action. Without JS the native form still submits.
 */
export function Form(props: FormProps): VNode {
  const {
    method = "get",
    action,
    replace,
    reloadDocument,
    onSubmit,
    children,
    __fetcherSubmit,
    ...rest
  } = props;
  const route = useContext(RouteContext);
  const router = useRouter();
  const isGet = method.toLowerCase() === "get";

  const handleSubmit = (event: Event) => {
    onSubmit?.(event);
    if (event.defaultPrevented || reloadDocument) return;
    const form = event.target as HTMLFormElement;
    if (isGet) {
      event.preventDefault();
      const qs = new URLSearchParams(new FormData(form) as unknown as Record<string, string>)
        .toString();
      const path = action ?? (typeof location !== "undefined" ? location.pathname : "");
      navigate(qs ? `${path}?${qs}` : path, { replace });
      return;
    }
    event.preventDefault();
    const fd = new FormData(form);
    // A fetcher form routes through the fetcher (which handles a cross-route `action`
    // URL); a plain form with no explicit action runs the current route's Server Action.
    if (__fetcherSubmit) __fetcherSubmit(form, { action, method });
    else void runRouteAction(route, fd, router);
  };

  return h("form", {
    method: isGet ? "get" : "post",
    action: formActionAttr(route?.formAction, action, isGet),
    onSubmit: handleSubmit,
    ...rest,
  }, children);
}

/** Remix `<Outlet>` → the layout's child subtree (denext passes it as `children`). */
export function Outlet(props: { context?: unknown }): VNode {
  const children = useContext(OutletChildrenContext);
  return h(OutletValueContext.Provider, { value: props.context ?? null }, children);
}

/** The value passed to a parent `<Outlet context={…}>` (Remix `useOutletContext`). */
export function useOutletContext<T = unknown>(): T {
  return useContext(OutletValueContext) as T;
}

// ── Deferred data (defer + <Await>) ───────────────────────────────────────────

const AsyncValueContext = createContext<unknown>(undefined);
const AsyncErrorContext = createContext<unknown>(undefined);

/** Props for {@link Await}. */
export interface AwaitProps {
  resolve: Promise<unknown> | unknown;
  errorElement?: VNodeChildren;
  children: VNodeChildren | ((value: unknown) => VNodeChildren);
}

/** Remix `<Await>` — resolves a deferred value (via `use()`), then renders `children`. */
export function Await(props: AwaitProps): VNode {
  const value = isPromiseLike(props.resolve) ? readPromise(props.resolve) : props.resolve;
  const rendered = typeof props.children === "function"
    ? (props.children as (v: unknown) => VNodeChildren)(value)
    : props.children;
  return h(AsyncValueContext.Provider, { value }, rendered);
}

/** The resolved value inside an `<Await>` (Remix `useAsyncValue`). */
export function useAsyncValue<T = unknown>(): T {
  return useContext(AsyncValueContext) as T;
}

/** The rejection inside an `<Await errorElement>` (Remix `useAsyncError`). */
export function useAsyncError(): unknown {
  return useContext(AsyncErrorContext);
}

function isPromiseLike(v: unknown): v is Promise<unknown> {
  return !!v && typeof (v as Promise<unknown>).then === "function";
}

// Minimal Suspense-less promise unwrap: block render until resolved on the client by
// throwing the promise (denext Suspense catches it). Values are cached per-promise.
const promiseCache = new WeakMap<
  Promise<unknown>,
  { status: string; value?: unknown; error?: unknown }
>();
function readPromise(promise: Promise<unknown>): unknown {
  let entry = promiseCache.get(promise);
  if (!entry) {
    entry = { status: "pending" };
    promiseCache.set(promise, entry);
    promise.then(
      (value) => {
        entry!.status = "fulfilled";
        entry!.value = value;
      },
      (error) => {
        entry!.status = "rejected";
        entry!.error = error;
      },
    );
  }
  if (entry.status === "fulfilled") return entry.value;
  if (entry.status === "rejected") throw entry.error;
  throw promise;
}

// ── Errors (useRouteError / isRouteErrorResponse) ─────────────────────────────

/** A Remix route error-response (`isRouteErrorResponse` recognizes this shape). */
export interface ErrorResponse {
  status: number;
  statusText: string;
  data: unknown;
  /** @internal brand */
  __remixErrorResponse: true;
}

/** The error caught by the nearest `ErrorBoundary` (Remix `useRouteError`). */
export function useRouteError(): unknown {
  return useContext(RouteErrorContext);
}

/** Whether an error is a Remix route-error-response (from a thrown `json`/`Response`). */
export function isRouteErrorResponse(error: unknown): error is ErrorResponse {
  return !!error && typeof error === "object" &&
    (error as ErrorResponse).__remixErrorResponse === true;
}

// ── Document components (denext manages the document; these are inert) ─────────

/** Inert in denext (the framework injects metadata) — Remix `<Meta>`. */
export function Meta(): VNode | null {
  return null;
}
/** Inert in denext (the framework injects `<link>`s) — Remix `<Links>`. */
export function Links(): VNode | null {
  return null;
}
/** Inert in denext (the framework injects scripts) — Remix `<Scripts>`. */
export function Scripts(): VNode | null {
  return null;
}
/** Inert in denext — Remix `<ScrollRestoration>` (denext restores scroll itself). */
export function ScrollRestoration(): VNode | null {
  return null;
}
/** Inert in denext — Remix `<LiveReload>` (denext has its own dev HMR). */
export function LiveReload(): VNode | null {
  return null;
}
/** Inert in denext — Remix `<PrefetchPageLinks>` (`<Link>` prefetches on intent). */
export function PrefetchPageLinks(): VNode | null {
  return null;
}
/** Inert fallback — Remix `<RemixBrowser>` entry (denext owns hydration). */
export function RemixBrowser(props: { children?: VNodeChildren }): VNode {
  return h(Fragment, null, props.children);
}
/** Inert fallback — Remix `<RemixServer>` entry (denext owns SSR). */
export function RemixServer(props: { children?: VNodeChildren }): VNode {
  return h(Fragment, null, props.children);
}
