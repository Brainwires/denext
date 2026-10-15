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

/** The endpoint prefix `NextAuth()`'s handlers are mounted on unless `basePath` says otherwise. */
const DEFAULT_BASE_PATH = "/api/auth";

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
  /** Refetch every N seconds (`0`, the default, never polls). */
  refetchInterval?: number;
  /** Refetch when the window regains focus (default `true`). */
  refetchOnWindowFocus?: boolean;
  /** Accepted for compatibility. */
  refetchWhenOffline?: boolean;
}

/** The prefix the most recently mounted provider uses (what the standalone functions call). */
let activeBasePath = DEFAULT_BASE_PATH;

/** Fetch JSON from the handlers; `null` on any failure. */
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${activeBasePath}/${path}`, {
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
 * The current session, fetched from `{basePath}/session`.
 *
 * @returns The session, or `null`.
 */
export async function getSession(): Promise<Session | null> {
  const data = await fetchJson<Session | null>("session");
  return data && typeof data === "object" && data.expires ? data : null;
}

/**
 * This browser's CSRF token (setting its cookie on first use).
 *
 * @returns The token, or `undefined` when the handlers can't be reached.
 */
export async function getCsrfToken(): Promise<string | undefined> {
  return (await fetchJson<{ csrfToken?: string }>("csrf"))?.csrfToken;
}

/**
 * The configured providers.
 *
 * @returns Them, by id, or `null` when the handlers can't be reached.
 */
export function getProviders(): Promise<Record<string, ClientSafeProvider> | null> {
  return fetchJson<Record<string, ClientSafeProvider>>("providers");
}

/** The current page (`/` outside a browser). */
function currentHref(): string {
  return typeof location === "undefined" ? "/" : location.href;
}

/**
 * `requested` as a URL on this page's origin, else this page — a `callbackUrl` read out of the
 * address bar is attacker-influenced, and this function navigates to it.
 */
function sameOrigin(requested: unknown): string {
  const here = new URL(currentHref(), "http://localhost");
  if (typeof requested !== "string" || !requested) return here.href;
  try {
    const url = new URL(requested, here);
    const web = url.protocol === "http:" || url.protocol === "https:";
    return url.origin === here.origin && web ? url.href : here.href;
  } catch {
    return here.href;
  }
}

/** Follow `url` (reloading when only the hash changes). */
function navigate(url: string): void {
  if (typeof location === "undefined") return;
  location.href = url;
  if (url.includes("#")) location.reload();
}

/** POST a form to the handlers, asking for `{ url }` back. */
async function postForm(
  path: string,
  fields: Record<string, string>,
): Promise<{ status: number; url: string | null }> {
  const res = await fetch(`${activeBasePath}/${path}`, {
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
 * Sign in. With no provider, open the sign-in page. Otherwise POST to the handlers (with the
 * CSRF token): an OAuth provider navigates to the provider, an email provider to "check your
 * email", Credentials (pass the fields in `options`) signs in and navigates to `callbackUrl` —
 * or, with `redirect: false`, resolves with the result instead.
 *
 * @param provider The provider id.
 * @param options `callbackUrl` / `redirectTo`, `redirect`, and the provider's fields.
 * @param _authorizationParams Accepted for compatibility (see KNOWN-DIFFERENCES).
 * @returns The result with `redirect: false`; otherwise it navigates.
 */
export async function signIn(
  provider?: string,
  options: SignInOptions = {},
  _authorizationParams?: Record<string, string> | string,
): Promise<SignInResponse | undefined> {
  const callbackUrl = sameOrigin(options.redirectTo ?? options.callbackUrl);
  if (!provider) {
    navigate(`${activeBasePath}/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
    return undefined;
  }
  const providers = await getProviders();
  const type = providers?.[provider]?.type;
  const action = type === "credentials" ? "callback" : "signin";
  const csrfToken = (await getCsrfToken()) ?? "";
  const { status, url } = await postForm(`${action}/${encodeURIComponent(provider)}`, {
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

/** Every mounted provider's refetch, so a sign-in / sign-out updates them all. */
const refetchers = new Set<() => void>();

/** Refetch in every mounted provider. */
function refreshProviders(): Promise<void> {
  for (const refetch of refetchers) refetch();
  return Promise.resolve();
}

/** Where the session state lives. */
const SessionContext: Context<SessionContextValue | undefined> = /* @__PURE__ */ createContext<
  SessionContextValue | undefined
>(undefined);

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
  if (props.basePath) activeBasePath = props.basePath.replace(/\/+$/, "");
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
    navigate(`${activeBasePath}/signin?error=SessionRequired&callbackUrl=${callbackUrl}`);
  }, [unauthenticated, onUnauthenticated]);
  return unauthenticated ? { data: null, status: "loading", update: value.update } : value;
}
