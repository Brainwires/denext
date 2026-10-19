"use client";
/**
 * `next-auth/react` on denext: `SessionProvider`, `useSession`, `signIn`, `signOut`,
 * `getSession`, `getCsrfToken` and `getProviders`, talking to the `NextAuth()` handlers at
 * `/api/auth` (or `basePath`). Every POST carries the CSRF token from `{basePath}/csrf`, and
 * every `callbackUrl` is kept to the page's own origin before it is sent or followed.
 *
 * ```tsx
 * "use client";
 * import { signIn, useSession } from "next-auth/react";
 * export function Account() {
 *   const { data, status } = useSession();
 *   if (status === "loading") return <p>…</p>;
 *   return data ? <p>{data.user?.name}</p> : <button onClick={() => signIn("github")}>Sign in</button>;
 * }
 * ```
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import {
  clientState,
  currentHref,
  DEFAULT_BASE_PATH,
  navigate,
  refetchers,
  refreshProviders,
  sameOrigin,
} from "./client-state.ts";
import { getApiDispatcher } from "../../runtime/api-dispatch.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";
import { createContext } from "../../runtime/context.ts";
import {
  type Context,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "../../runtime/hooks.ts";

/** The session the server answers with (`{ user, expires }` plus what `callbacks.session` adds). */
export interface Session extends Record<string, unknown> {
  /** The signed-in user. */
  user?: { id?: string; name?: string | null; email?: string | null; image?: string | null };
  /** When the session expires, ISO 8601. */
  expires: string;
}

/** What {@linkcode useSession} returns. */
export type SessionContextValue =
  | { data: Session; status: "authenticated"; update: UpdateSession }
  | { data: null; status: "unauthenticated" | "loading"; update: UpdateSession };

/** `update(data?)`: refetch the session, or send `data` to the `jwt` callback (`trigger: "update"`). */
export type UpdateSession = (data?: unknown) => Promise<Session | null>;

/** A provider as `getProviders()` lists it. */
export interface ClientSafeProvider {
  /** The provider id. */
  id: string;
  /** Its display name. */
  name: string;
  /** Its kind. */
  type: string;
  /** Where its sign-in starts. */
  signinUrl: string;
  /** Its callback URL. */
  callbackUrl: string;
}

/** What `signIn(…, { redirect: false })` resolves to. */
export interface SignInResponse {
  /** The Auth.js error code (`"CredentialsSignin"`, …), or `undefined` on success. */
  error: string | undefined;
  /** `"credentials"` for a refused Credentials sign-in. */
  code: string | undefined;
  /** The HTTP status. */
  status: number;
  /** Whether the sign-in went through. */
  ok: boolean;
  /** Where the sign-in would have navigated. */
  url: string | null;
}

/** Options for {@linkcode signIn}. */
export interface SignInOptions extends Record<string, unknown> {
  /** Where to land afterwards (default: this page). Kept same-origin. */
  callbackUrl?: string;
  /** The same as `callbackUrl` (Auth.js v5's name). */
  redirectTo?: string;
  /** `false` resolves with the result instead of navigating. */
  redirect?: boolean;
}

/** Options for {@linkcode signOut}. */
export interface SignOutParams {
  /** Where to land afterwards (default: this page). Kept same-origin. */
  callbackUrl?: string;
  /** The same as `callbackUrl` (Auth.js v5's name). */
  redirectTo?: string;
  /** `false` resolves with `{ url }` instead of navigating. */
  redirect?: boolean;
}

/** Props for {@linkcode SessionProvider}. */
export interface SessionProviderProps {
  /** The tree that reads the session. */
  children?: VNodeChildren;
  /** A session from the server (`await auth()`), so the first render has it. */
  session?: Session | null;
  /** The handlers' prefix (default `/api/auth`). */
  basePath?: string;
  /** Accepted for compatibility (NextAuth.js v4): the handlers are always on the page's origin. */
  baseUrl?: string;
  /** Refetch every N seconds (`0`, the default, never polls). */
  refetchInterval?: number;
  /** Refetch when the window regains focus (default `true`). */
  refetchOnWindowFocus?: boolean;
  /** Accepted for compatibility. */
  refetchWhenOffline?: boolean;
}

/** Fetch JSON from the handlers; `null` on any failure. */
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${clientState.basePath}/${path}`, {
      credentials: "same-origin",
      ...init,
      headers: { accept: "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

/**
 * The request a server-side caller passes (NextAuth.js v4's `getSession({ req })` in
 * `getServerSideProps` or an API route): a `Request`, or a Node-style one with a header bag.
 */
export interface ServerRequestLike {
  /** Its headers (the session cookie). */
  headers: Headers | Record<string, string | string[] | undefined>;
}

/** NextAuth.js v4's `{ req }` / `{ ctx }` argument, for a call on the server. */
export interface CtxOrReq {
  /** The incoming request. */
  req?: ServerRequestLike;
  /** A `getServerSideProps` / `getInitialProps` context carrying it. */
  ctx?: { req?: ServerRequestLike };
}

/** What Auth.js's `getSession()` takes; on the server, v4's `{ req }` reads that request's session. */
export interface GetSessionParams extends CtxOrReq {
  /** Why the session is read (Auth.js's broadcast reason). */
  event?: "storage" | "timer" | "hidden" | string;
  /** Whether to notify other tabs. */
  triggerEvent?: boolean;
  /** Whether to broadcast the result. */
  broadcast?: boolean;
}

/** The server-side request a v4 call names, or `undefined` (a browser call). */
function serverRequest(params: CtxOrReq | undefined): ServerRequestLike | undefined {
  return params?.req ?? params?.ctx?.req;
}

/** One header of a server-side request. */
function headerOf(req: ServerRequestLike, name: string): string | undefined {
  if (req.headers instanceof Headers) return req.headers.get(name) ?? undefined;
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

/** An environment variable on the server (`undefined` in a browser). */
function serverEnv(name: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(n: string): string | undefined } } }).Deno?.env
      .get(name);
  } catch {
    return undefined;
  }
}

/**
 * The handlers' URL for an HTTP call from the server: `NEXTAUTH_URL_INTERNAL` / `NEXTAUTH_URL` /
 * `AUTH_URL`, else `http://localhost:$PORT` (3000) — never the request's `Host`, which the
 * client chooses (as NextAuth.js v4 does).
 */
function serverAuthUrl(): URL {
  const configured = serverEnv("NEXTAUTH_URL_INTERNAL") ?? serverEnv("NEXTAUTH_URL") ??
    serverEnv("AUTH_URL");
  const url = new URL(configured ?? `http://localhost:${serverEnv("PORT") ?? "3000"}`);
  if (url.pathname === "/" || url.pathname === "") url.pathname = DEFAULT_BASE_PATH;
  return url;
}

/**
 * Where the server half of the shim answers `next-auth/react`'s server-side calls in-process
 * (installed by the handlers module; absent in a browser).
 */
const SERVER_HANDLERS = Symbol.for("denext.next-auth.server-handlers");

/** The handlers' in-process answer for the current request, or `null` where there is none. */
type ServerHandlers = (path: string) => Promise<Response | null>;

/**
 * The handlers' answer in-process, for the current request: the active `NextAuth()` instance's
 * own handlers, else the app's pipeline (a `[...nextauth]` route not loaded yet). `null` when
 * neither answers (outside a request, or the endpoints live where the pipeline can't reach).
 */
async function answerInProcess(pathname: string, path: string): Promise<Response | null> {
  const own = (globalThis as Record<symbol, unknown>)[SERVER_HANDLERS] as
    | ServerHandlers
    | undefined;
  const handled = await own?.(path);
  if (handled) return handled;
  const headers = new Headers({ accept: "application/json" });
  const signal = new AbortController().signal;
  const dispatched = await getApiDispatcher()?.(pathname, { method: "GET", headers, signal });
  if (dispatched?.ok) return dispatched;
  await dispatched?.body?.cancel();
  return null;
}

/**
 * Fetch JSON from the handlers on behalf of a server-side request: in-process (the current
 * request's cookies; a cookie the endpoint sets reaches its response), or — outside a request —
 * over HTTP with `req`'s cookie, as v4 does. `null` on any failure.
 */
async function fetchServerJson<T>(req: ServerRequestLike, path: string): Promise<T | null> {
  const base = serverAuthUrl();
  const pathname = `${base.pathname.replace(/\/+$/, "")}/${path}`;
  try {
    let res = await answerInProcess(pathname, path);
    if (!res) {
      const headers = new Headers({ accept: "application/json" });
      const cookie = headerOf(req, "cookie");
      if (cookie) headers.set("cookie", cookie);
      res = await fetch(new URL(pathname, base), { headers });
    }
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

/** A session answer, or `null` for anything else. */
function sessionOrNull(data: Session | null): Session | null {
  return data && typeof data === "object" && data.expires ? data : null;
}

/**
 * The current session, fetched from `{basePath}/session`. On the server, pass the request
 * (`getSession({ req })`, v4's form) to read its session.
 *
 * @param params `{ req }` / `{ ctx }` on the server; the rest is accepted for compatibility.
 * @returns The session, or `null`.
 */
export async function getSession(params?: GetSessionParams): Promise<Session | null> {
  const req = serverRequest(params);
  if (req) return sessionOrNull(await fetchServerJson<Session | null>(req, "session"));
  return sessionOrNull(await fetchJson<Session | null>("session"));
}

/**
 * This browser's CSRF token (setting its cookie on first use). On the server, pass the request
 * (`getCsrfToken({ req })`); a token minted then is set on the current response.
 *
 * @param params `{ req }` / `{ ctx }` on the server.
 * @returns The token, or `undefined` when the handlers can't be reached.
 */
export async function getCsrfToken(params?: CtxOrReq): Promise<string | undefined> {
  const req = serverRequest(params);
  const data = req
    ? await fetchServerJson<{ csrfToken?: string }>(req, "csrf")
    : await fetchJson<{ csrfToken?: string }>("csrf");
  return data?.csrfToken;
}

/**
 * The configured providers.
 *
 * @param params `{ req }` / `{ ctx }` to list them on the server.
 * @returns Them, by id, or `null` when the handlers can't be reached.
 */
export function getProviders(
  params?: CtxOrReq,
): Promise<Record<string, ClientSafeProvider> | null> {
  const req = serverRequest(params);
  return req
    ? fetchServerJson<Record<string, ClientSafeProvider>>(req, "providers")
    : fetchJson<Record<string, ClientSafeProvider>>("providers");
}

/** POST a form to the handlers, asking for `{ url }` back. */
async function postForm(
  path: string,
  fields: Record<string, string>,
): Promise<{ status: number; url: string | null }> {
  const res = await fetch(`${clientState.basePath}/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-auth-return-redirect": "1",
    },
    body: new URLSearchParams(fields),
  });
  const data = await res.json().catch(() => ({})) as { url?: string };
  return { status: res.status, url: typeof data.url === "string" ? data.url : null };
}

/** The string fields of `signIn`'s options (the credentials, `email`). */
function formFields(options: SignInOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === "callbackUrl" || key === "redirectTo" || key === "redirect") continue;
    if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

/**
 * The type of the provider `signIn()` names, or `undefined` after navigating instead: to the
 * sign-in page with no provider or one the server doesn't list, to the error page when the
 * providers can't be read (as Auth.js does).
 */
async function providerType(
  provider: string | undefined,
  callbackUrl: string,
): Promise<string | undefined> {
  const signInPage = `${clientState.basePath}/signin?${new URLSearchParams({ callbackUrl })}`;
  if (!provider) {
    navigate(signInPage);
    return undefined;
  }
  const providers = await getProviders();
  if (!providers) {
    navigate(`${clientState.basePath}/error`);
    return undefined;
  }
  if (Object.hasOwn(providers, provider)) return providers[provider].type;
  navigate(signInPage);
  return undefined;
}

/**
 * Sign in. With no provider, open the sign-in page. Otherwise POST to the handlers (with the
 * CSRF token): an OAuth provider navigates to the provider, an email provider to "check your
 * email", Credentials (pass the fields in `options`) signs in and navigates to `callbackUrl` —
 * or, with `redirect: false`, resolves with the result instead.
 *
 * @param provider The provider id.
 * @param options `callbackUrl` / `redirectTo`, `redirect`, and the provider's fields.
 * @param authorizationParams Extra authorization-request parameters for an OAuth / OIDC
 *   provider (`{ prompt: "login" }`), sent as the POST URL's query as Auth.js does; the server
 *   drops the ones the flow owns (`state`, PKCE, `redirect_uri`, …).
 * @returns The result with `redirect: false`; otherwise it navigates.
 */
export async function signIn(
  provider?: string,
  options: SignInOptions = {},
  authorizationParams?: Record<string, string> | string | URLSearchParams | string[][],
): Promise<SignInResponse | undefined> {
  const callbackUrl = sameOrigin(options.redirectTo ?? options.callbackUrl);
  const type = await providerType(provider, callbackUrl);
  if (!type) return undefined;
  const action = type === "credentials" ? "callback" : "signin";
  const csrfToken = (await getCsrfToken()) ?? "";
  const query = new URLSearchParams(authorizationParams ?? {}).toString();
  const path = `${action}/${encodeURIComponent(provider!)}${query ? `?${query}` : ""}`;
  const { status, url } = await postForm(path, {
    ...formFields(options),
    csrfToken,
    callbackUrl,
  });
  if (options.redirect !== false) {
    if (url) navigate(url);
    return undefined;
  }
  const error = url
    ? new URL(url, "http://localhost").searchParams.get("error") ?? undefined
    : "Default";
  if (!error) await refreshProviders();
  return {
    error,
    code: error === "CredentialsSignin" ? "credentials" : undefined,
    status,
    ok: !error && status < 400,
    url: error ? null : url,
  };
}

/**
 * Sign out (a POST carrying the CSRF token), then navigate to `callbackUrl` — or, with
 * `redirect: false`, resolve with `{ url }`.
 *
 * @param options `callbackUrl` / `redirectTo` and `redirect`.
 * @returns `{ url }` with `redirect: false`.
 */
export async function signOut(options: SignOutParams = {}): Promise<{ url: string } | undefined> {
  const callbackUrl = sameOrigin(options.redirectTo ?? options.callbackUrl);
  const csrfToken = (await getCsrfToken()) ?? "";
  const { url } = await postForm("signout", { csrfToken, callbackUrl });
  const target = url ?? callbackUrl;
  await refreshProviders();
  if (options.redirect === false) return { url: target };
  navigate(target);
  return undefined;
}

/**
 * Where the session state lives — what {@linkcode useSession} reads; `undefined` outside a
 * {@linkcode SessionProvider}.
 */
export const SessionContext: Context<SessionContextValue | undefined> = /* @__PURE__ */
  createContext<SessionContextValue | undefined>(undefined);

/** The context value for a fetched session. */
function valueOf(session: Session | null | undefined, update: UpdateSession): SessionContextValue {
  if (session === undefined) return { data: null, status: "loading", update };
  return session
    ? { data: session, status: "authenticated", update }
    : { data: null, status: "unauthenticated", update };
}

/** POST `data` to `{basePath}/session` (the `jwt` callback's `update` trigger). */
async function sendUpdate(data: unknown): Promise<Session | null> {
  const csrfToken = (await getCsrfToken()) ?? "";
  return await fetchJson<Session | null>("session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csrfToken, data: JSON.stringify(data ?? null) }),
  });
}

/** The ambient refetch triggers: an interval and the window regaining focus. */
function useRefetch(refetch: () => void, intervalSeconds: number, onFocus: boolean): void {
  useEffect(() => {
    if (!(intervalSeconds > 0)) return;
    const id = setInterval(refetch, intervalSeconds * 1000);
    return () => clearInterval(id);
  }, [refetch, intervalSeconds]);
  useEffect(() => {
    if (!onFocus || typeof addEventListener === "undefined") return;
    addEventListener("focus", refetch);
    return () => removeEventListener("focus", refetch);
  }, [refetch, onFocus]);
}

/**
 * Provide the session to the tree. Pass `session` from the server for a first render without a
 * loading state; otherwise it is fetched on mount.
 *
 * @param props {@linkcode SessionProviderProps}.
 * @returns The provider element.
 */
export function SessionProvider(props: SessionProviderProps): VNode {
  if (props.basePath) clientState.basePath = props.basePath.replace(/\/+$/, "");
  const [session, setSession] = useState<Session | null | undefined>(props.session);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);
  const refetch = useCallback(() => {
    void getSession().then((next) => {
      if (mounted.current) setSession(next);
    });
  }, []);
  useEffect(() => {
    refetchers.add(refetch);
    if (props.session === undefined) refetch();
    return () => void refetchers.delete(refetch);
  }, [refetch]);
  useRefetch(refetch, props.refetchInterval ?? 0, props.refetchOnWindowFocus !== false);
  const update: UpdateSession = useCallback(async (data?: unknown) => {
    const next = data === undefined ? await getSession() : await sendUpdate(data);
    if (mounted.current) setSession(next);
    return next;
  }, []);
  const value = useMemo(() => valueOf(session, update), [session, update]);
  return h(SessionContext, { value }, props.children);
}

/** Options for {@linkcode useSession}. */
export interface UseSessionOptions {
  /** Send an unauthenticated visitor to the sign-in page (or call `onUnauthenticated`). */
  required?: boolean;
  /** What to do instead of the redirect `required` makes. */
  onUnauthenticated?: () => void;
}

/**
 * The session: `{ data, status, update }`. Must be under a {@linkcode SessionProvider}.
 *
 * @param options `required` / `onUnauthenticated`.
 * @returns The session state.
 */
export function useSession(options: UseSessionOptions = {}): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("[next-auth]: `useSession` must be wrapped in a <SessionProvider />");
  }
  const { required, onUnauthenticated } = options;
  const unauthenticated = required && value.status === "unauthenticated";
  useEffect(() => {
    if (!unauthenticated) return;
    if (onUnauthenticated) return onUnauthenticated();
    const callbackUrl = encodeURIComponent(currentHref());
    navigate(`${clientState.basePath}/signin?error=SessionRequired&callbackUrl=${callbackUrl}`);
  }, [unauthenticated, onUnauthenticated]);
  return unauthenticated ? { data: null, status: "loading", update: value.update } : value;
}
