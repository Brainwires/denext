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

/**
 * Fetch the session endpoint. A network failure, a non-JSON body or an error status all
 * read as "signed out" rather than throwing into the tree — the UI degrades to the
 * logged-out view instead of unmounting behind an error boundary.
 */
async function fetchSession(basePath: string): Promise<SessionState> {
  try {
    const res = await fetch(`${basePath}/session`, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    if (!res.ok) return { user: null, status: "unauthenticated" };
    return stateFrom(await res.json() as SessionResponse);
  } catch {
    return { user: null, status: "unauthenticated" };
  }
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
  const [state, setState] = useState<SessionState>(
    seeded
      ? { user: props.session ?? null, status: props.session ? "authenticated" : "unauthenticated" }
      : LOADING,
  );
  // Guards every setState: a refetch in flight when the provider unmounts must not write.
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const update: () => Promise<ClientSession> = useCallback(async () => {
    const next = await fetchSession(basePath);
    if (mounted.current) setState(next);
    return { ...next, update };
  }, [basePath]);

  useEffect(() => {
    if (seeded || typeof fetch === "undefined") return;
    void update();
  }, [update]);

  useRefetchTriggers(update, props.refetchInterval ?? 0, props.refetchOnWindowFocus !== false);

  const value = useMemo<ClientSession>(() => ({ ...state, update }), [state, update]);
  return h(SessionContext, { value }, props.children);
}

/**
 * The two ambient refetch triggers — an interval poll and the window regaining focus.
 * Both are browser-only and unsubscribe on unmount or when their setting changes.
 */
function useRefetchTriggers(
  update: () => Promise<ClientSession>,
  interval: number,
  onFocus: boolean,
): void {
  useEffect(() => {
    if (!(interval > 0)) return;
    const id = setInterval(() => void update(), interval);
    return () => clearInterval(id);
  }, [update, interval]);

  useEffect(() => {
    if (!onFocus || typeof addEventListener === "undefined") return;
    const listener = () => void update();
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

/** Options for {@link signIn}. */
export interface SignInOptions {
  /** Where to return after signing in (defaults to the current URL). */
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
export function signIn(provider: string, options: SignInOptions = {}): Promise<unknown> {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const callbackUrl = options.callbackUrl ?? currentUrl();
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
): Promise<unknown> {
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
  return data;
}

/** Options for {@link signOut}. */
export interface SignOutOptions {
  /** Where to go after signing out (defaults to `/`). */
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
  const callbackUrl = options.callbackUrl ?? "/";
  return fetch(`${basePath}/signout?callbackUrl=${encodeURIComponent(callbackUrl)}`, {
    method: "POST",
    headers: { accept: "application/json", "x-denext-auth": "1" },
    credentials: "same-origin",
  }).then(() => {
    location.href = callbackUrl;
  });
}
