/**
 * Client-side auth: a `SessionProvider` + `useSession` hook, and `signIn`/`signOut`
 * helpers that talk to the auto-mounted `/auth/*` endpoints. Mirrors the familiar
 * NextAuth surface. Import from `@denext/denext` (client entry).
 *
 * The provider keeps the session fresh three ways, all optional: an explicit
 * `session.update()`, a `refetchInterval` poll, and a refetch when the window regains
 * focus. Each one is a `GET {basePath}/session`, which is also the server's sliding-expiry
 * path — so a client that polls keeps an active user signed in (see `session.updateAge`).
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { createContext } from "../runtime/context.ts";
import {
  type Context,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "../runtime/hooks.ts";

/** The endpoint prefix denext auth mounts on unless the app configured `basePath`. */
const DEFAULT_BASE_PATH = "/auth";

/** The signed-in user exposed to the client (non-sensitive fields only). */
export interface SessionUser {
  /** Stable user id. */
  id: string;
  /** Display name, if any. */
  name?: string;
  /** Email, if any. */
  email?: string;
  /** Avatar URL, if any. */
  image?: string;
}

/** The reactive session state from {@link useSession}. */
export interface ClientSession {
  /** The signed-in user, or `null`. */
  user: SessionUser | null;
  /**
   * `"loading"` until resolved, then `"authenticated"` / `"unauthenticated"`, or
   * `"mfa-required"` while the user still owes a second factor.
   */
  status: "loading" | "authenticated" | "unauthenticated" | "mfa-required";
  /** `"required"` while the user still owes a second factor. */
  mfa?: "required";
  /**
   * Refetch `{basePath}/session` now and update every consumer — call it after an action
   * that changes the session server-side (a profile edit, finishing a second factor).
   *
   * @returns The freshly fetched session.
   */
  update(): Promise<ClientSession>;
}

/** The session facts the provider tracks — a {@link ClientSession} before `update`. */
type SessionState = Omit<ClientSession, "update">;

/** The JSON `GET {basePath}/session` answers with. */
interface SessionResponse {
  /** The signed-in user, or `null`. */
  user?: SessionUser | null;
  /** Expiry in epoch seconds, or `null`. */
  expires?: number | null;
  /** `"required"` when the session still owes a second factor. */
  mfa?: "required";
}

/** The state before anything has been fetched. */
const LOADING: SessionState = { user: null, status: "loading" };

/** Outside a {@link SessionProvider} there is nothing to refetch. */
function noSession(): Promise<ClientSession> {
  return Promise.resolve({ ...LOADING, update: noSession });
}

const SessionContext: Context<ClientSession> = createContext<ClientSession>({
  ...LOADING,
  update: noSession,
});

/** The state a `{basePath}/session` payload describes. */
function stateFrom(data: SessionResponse | null): SessionState {
  if (data?.mfa === "required") return { user: null, status: "mfa-required", mfa: "required" };
  const user = data?.user ?? null;
  return { user, status: user ? "authenticated" : "unauthenticated" };
}

const SIGNED_OUT: SessionState = { user: null, status: "unauthenticated" };

/** How long to hold ambient refetches after a `429` that names no `Retry-After`. */
const DEFAULT_RETRY_AFTER_MS = 60_000;

/**
 * What one `{basePath}/session` fetch established: the session, or nothing at all — a
 * `429`, a server error, a network failure or a non-JSON body says nothing about who is
 * signed in — plus how long to hold off ambient refetches.
 */
type SessionFetch = { state: SessionState } | { state: null; holdMs: number };

/**
 * Fetch the session endpoint without ever throwing into the tree. A `4xx` other than
 * `429` (no auth mounted at `basePath`) reads as signed out.
 */
async function fetchSession(basePath: string): Promise<SessionFetch> {
  try {
    const res = await fetch(`${basePath}/session`, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    if (res.status === 429) return { state: null, holdMs: retryAfterMs(res) };
    if (res.status >= 500) return { state: null, holdMs: 0 };
    if (!res.ok) return { state: SIGNED_OUT };
    return { state: stateFrom(await res.json() as SessionResponse) };
  } catch {
    return { state: null, holdMs: 0 };
  }
}

/** A `429`'s `Retry-After` (delta-seconds) in milliseconds, or the one-minute default. */
function retryAfterMs(res: Response): number {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
}

/** Props for {@link SessionProvider}. */
export interface SessionProviderProps {
  /** The subtree that reads the session via {@link useSession}. */
  children?: VNodeChildren;
  /**
   * Seed the session from the server (SSR) to avoid a loading flash. Pass the user
   * (or `null`); omit to fetch `{basePath}/session` on mount instead.
   */
  session?: SessionUser | null;
  /** The auth endpoint prefix, when the app configured `denextAuth({ basePath })`. Default `"/auth"`. */
  basePath?: string;
  /**
   * Poll `{basePath}/session` every N milliseconds. `0` (the default) never polls.
   * With `session.updateAge` set server-side, polling is also what slides an active
   * user's expiry forward.
   */
  refetchInterval?: number;
  /** Refetch when the window regains focus (default `true`), so a stale tab catches up. */
  refetchOnWindowFocus?: boolean;
}

/**
 * Provide session state to the tree. Seed it with `session` from the server for no
 * loading flash, or omit it to fetch `{basePath}/session` on mount.
 *
 * @param props {@link SessionProviderProps}.
 * @returns The provider element wrapping `children`.
 */
export function SessionProvider(props: SessionProviderProps): VNode {
  const basePath = props.basePath ?? DEFAULT_BASE_PATH;
  const seeded = props.session !== undefined;
  const { state, update, ambientUpdate } = useSessionState(
    basePath,
    seeded
      ? { user: props.session ?? null, status: props.session ? "authenticated" : "unauthenticated" }
      : LOADING,
  );

  useEffect(() => {
    if (seeded || typeof fetch === "undefined") return;
    void update();
  }, [update]);

  useRefetchTriggers(
    ambientUpdate,
    props.refetchInterval ?? 0,
    props.refetchOnWindowFocus !== false,
  );

  const value = useMemo<ClientSession>(() => ({ ...state, update }), [state, update]);
  return h(SessionContext, { value }, props.children);
}

/**
 * The provider's session state, `update()` (an explicit refetch) and the entry point the
 * focus/interval triggers use. A fetch that learns nothing keeps what was known — only a
 * first load with nothing known degrades to the logged-out view — and a `429` holds the
 * ambient refetches for its `Retry-After`; an explicit `update()` always asks.
 */
function useSessionState(basePath: string, initial: SessionState): {
  state: SessionState;
  update: () => Promise<ClientSession>;
  ambientUpdate: () => void;
} {
  const [state, setState] = useState<SessionState>(initial);
  // Guards every setState: a refetch in flight when the provider unmounts must not write.
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);
  const latest = useRef(state);
  latest.current = state;
  const holdUntil = useRef(0);

  const update: () => Promise<ClientSession> = useCallback(async () => {
    const fetched = await fetchSession(basePath);
    let next: SessionState;
    if (fetched.state === null) {
      holdUntil.current = Date.now() + fetched.holdMs;
      next = latest.current.status === "loading" ? SIGNED_OUT : latest.current;
    } else {
      next = fetched.state;
    }
    if (mounted.current) setState(next);
    return { ...next, update };
  }, [basePath]);
  const ambientUpdate = useCallback(() => {
    if (Date.now() >= holdUntil.current) void update();
  }, [update]);
  return { state, update, ambientUpdate };
}

/**
 * The two ambient refetch triggers — an interval poll and the window regaining focus.
 * Both are browser-only and unsubscribe on unmount or when their setting changes.
 */
function useRefetchTriggers(
  update: () => void,
  interval: number,
  onFocus: boolean,
): void {
  useEffect(() => {
    if (!(interval > 0)) return;
    const id = setInterval(update, interval);
    return () => clearInterval(id);
  }, [update, interval]);

  useEffect(() => {
    if (!onFocus || typeof addEventListener === "undefined") return;
    const listener = () => update();
    addEventListener("focus", listener);
    return () => removeEventListener("focus", listener);
  }, [update, onFocus]);
}

/**
 * Read the current {@link ClientSession}. Must be under a {@link SessionProvider}.
 *
 * @returns The session state plus `update()`.
 */
export function useSession(): ClientSession {
  return useContext(SessionContext);
}

/** The current path + query, or `"/"` when there is no `location` (SSR, tests). */
function currentUrl(): string {
  return typeof location === "undefined" ? "/" : location.pathname + location.search;
}

/**
 * Coerce a caller-supplied `callbackUrl` to a **same-origin path**, because these helpers
 * navigate to it: `signOut({ callbackUrl })` assigns it to `location.href`, and `signIn`
 * hands it to the server which reflects it back as a `Location`. A `callbackUrl` is
 * routinely read straight out of the current URL's query, so it is attacker-influenced —
 * `javascript:…` would execute, `//evil.test/x` is protocol-relative and `https://evil.test`
 * absolute, and all three are open redirects (the `javascript:` one an XSS).
 *
 * An absolute URL on the page's OWN origin keeps only its path + query + hash; anything
 * else falls back. The server coerces again (`sameOriginRedirect`) — this is the half that
 * protects the purely client-side navigation, which never reaches the server at all.
 *
 * @param requested The caller's `callbackUrl`, if any.
 * @param fallback Where to go when `requested` is absent or foreign.
 * @returns A same-origin path, always starting with a single `/`.
 */
function sameOriginPath(requested: string | undefined, fallback: string): string {
  if (!requested) return fallback;
  const origin = typeof location === "undefined" ? undefined : location.origin;
  if (/^[a-z][a-z0-9+.-]*:/i.test(requested)) {
    // Absolute (or scheme-like: `javascript:`, `data:`) — admitted only on our own origin.
    try {
      const url = new URL(requested);
      if (origin && url.origin === origin) return url.pathname + url.search + url.hash;
    } catch { /* not a URL at all */ }
    return fallback;
  }
  // Protocol-relative (`//evil.test/x`) is a foreign origin dressed as a path; a value
  // that is not rooted at all is not a path we are willing to guess at either.
  if (!requested.startsWith("/") || requested.startsWith("//")) return fallback;
  return requested;
}

/** What a `credentials` sign-in resolves; a refused sign-in rejects instead. */
export interface CredentialsSignInResult {
  /** Always `true`. */
  ok: true;
  /** The signed-in user, when the sign-in completed. */
  user?: SessionUser;
  /** `"required"` when the user still owes a second factor (the session is pending). */
  mfa?: "required";
}

/** Options for {@link signIn}. */
export interface SignInOptions {
  /**
   * Where to return after signing in (defaults to the current URL). Coerced to a
   * same-origin path: an absolute URL on another origin, a protocol-relative `//host/…`
   * or a `javascript:` value falls back to the default.
   */
  callbackUrl?: string;
  /**
   * For a Credentials provider, the fields to submit. When present, `signIn` POSTs
   * them to the credentials callback instead of redirecting to an OAuth provider.
   */
  credentials?: Record<string, string>;
  /**
   * Navigate to the provider (default `true`). Pass `false` to get the sign-in URL back
   * instead — for a popup, a custom transition, or a test. Ignored for a `credentials`
   * sign-in, which never navigates.
   */
  redirect?: boolean;
  /** The auth endpoint prefix, when the app configured `denextAuth({ basePath })`. Default `"/auth"`. */
  basePath?: string;
}

/**
 * Start sign-in. For an OAuth/OIDC provider this navigates to the provider (or, with
 * `redirect: false`, resolves with the URL it would have gone to); for a Credentials
 * provider (pass `credentials`) it POSTs and resolves with the result.
 *
 * @param provider The provider id (e.g. `"google"`, `"credentials"`).
 * @param options {@link SignInOptions}.
 * @returns The credentials result, or the sign-in URL for the redirect flow.
 */
export function signIn(
  provider: string,
  options: SignInOptions & { credentials: Record<string, string> },
): Promise<CredentialsSignInResult>;
/**
 * Start a redirect sign-in with an OAuth/OIDC provider: navigate to it (unless
 * `redirect: false`) and resolve the sign-in URL.
 *
 * @param provider The provider id.
 * @param options Where to return afterwards, `redirect: false`, a custom `basePath`.
 * @returns The `{basePath}/signin/:provider` URL.
 */
export function signIn(provider: string, options?: SignInOptions): Promise<string>;
export function signIn(
  provider: string,
  options: SignInOptions = {},
): Promise<CredentialsSignInResult | string> {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const callbackUrl = sameOriginPath(options.callbackUrl, currentUrl());
  if (options.credentials) {
    return submitCredentials(basePath, provider, options.credentials, callbackUrl);
  }
  const url = `${basePath}/signin/${encodeURIComponent(provider)}?callbackUrl=${
    encodeURIComponent(callbackUrl)
  }`;
  if (options.redirect !== false) location.href = url;
  return Promise.resolve(url);
}

/** POST the Credentials form to the callback endpoint and unwrap its JSON. */
async function submitCredentials(
  basePath: string,
  provider: string,
  credentials: Record<string, string>,
  callbackUrl: string,
): Promise<CredentialsSignInResult> {
  const res = await fetch(`${basePath}/callback/${encodeURIComponent(provider)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      "x-denext-auth": "1",
    },
    credentials: "same-origin",
    body: JSON.stringify({ ...credentials, callbackUrl }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "sign in failed");
  return data as CredentialsSignInResult;
}

/** Options for {@link signOut}. */
export interface SignOutOptions {
  /**
   * Where to go after signing out (defaults to `/`). Coerced to a same-origin path — this
   * one is assigned to `location.href`, so a foreign or `javascript:` value is refused.
   */
  callbackUrl?: string;
  /** The auth endpoint prefix, when the app configured `denextAuth({ basePath })`. Default `"/auth"`. */
  basePath?: string;
}

/**
 * Sign out (same-origin POST to `{basePath}/signout`), then navigate to `callbackUrl`.
 *
 * @param options {@link SignOutOptions}.
 * @returns A promise that settles once the navigation has been started.
 */
export function signOut(options: SignOutOptions = {}): Promise<void> {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const callbackUrl = sameOriginPath(options.callbackUrl, "/");
  return fetch(`${basePath}/signout?callbackUrl=${encodeURIComponent(callbackUrl)}`, {
    method: "POST",
    headers: { accept: "application/json", "x-denext-auth": "1" },
    credentials: "same-origin",
  }).then(() => {
    location.href = callbackUrl;
  });
}
