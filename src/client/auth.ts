/**
 * Client-side auth: a `SessionProvider` + `useSession` hook, and `signIn`/`signOut`
 * helpers that talk to the auto-mounted `/auth/*` endpoints. Mirrors the familiar
 * NextAuth surface. Import from `@denext/denext` (client entry).
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { createContext } from "../runtime/context.ts";
import { type Context, useContext, useEffect, useState } from "../runtime/hooks.ts";

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
  /** `"loading"` until resolved, then `"authenticated"` / `"unauthenticated"`. */
  status: "loading" | "authenticated" | "unauthenticated";
}

const SessionContext: Context<ClientSession> = createContext<ClientSession>({
  user: null,
  status: "loading",
});

/** Props for {@link SessionProvider}. */
export interface SessionProviderProps {
  /** The subtree that reads the session via {@link useSession}. */
  children?: VNodeChildren;
  /**
   * Seed the session from the server (SSR) to avoid a loading flash. Pass the user
   * (or `null`); omit to fetch `/auth/session` on mount instead.
   */
  session?: SessionUser | null;
}

/**
 * Provide session state to the tree. Seed it with `session` from the server for no
 * loading flash, or omit it to fetch `/auth/session` on mount.
 *
 * @param props {@link SessionProviderProps}.
 */
export function SessionProvider(props: SessionProviderProps): VNode {
  const seeded = props.session !== undefined;
  const [state, setState] = useState<ClientSession>(
    seeded
      ? { user: props.session ?? null, status: props.session ? "authenticated" : "unauthenticated" }
      : { user: null, status: "loading" },
  );

  useEffect(() => {
    if (seeded || typeof fetch === "undefined") return;
    let cancelled = false;
    fetch("/auth/session", { headers: { accept: "application/json" }, credentials: "same-origin" })
      .then((r) => r.json())
      .then((d: { user: SessionUser | null }) => {
        if (!cancelled) {
          setState({ user: d.user ?? null, status: d.user ? "authenticated" : "unauthenticated" });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ user: null, status: "unauthenticated" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return h(SessionContext, { value: state }, props.children);
}

/** Read the current {@link ClientSession}. Must be under a {@link SessionProvider}. */
export function useSession(): ClientSession {
  return useContext(SessionContext);
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
}

/**
 * Start sign-in. For an OAuth/OIDC provider this navigates to the provider; for a
 * Credentials provider (pass `credentials`) it POSTs and resolves with the result.
 *
 * @param provider The provider id (e.g. `"google"`, `"credentials"`).
 * @param options {@link SignInOptions}.
 */
export function signIn(provider: string, options: SignInOptions = {}): Promise<unknown> {
  const callbackUrl = options.callbackUrl ?? location.pathname + location.search;
  if (options.credentials) {
    return fetch(`/auth/callback/${encodeURIComponent(provider)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        "x-denext-auth": "1",
      },
      credentials: "same-origin",
      body: JSON.stringify({ ...options.credentials, callbackUrl }),
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data as { error?: string }).error ?? "sign in failed");
      return data;
    });
  }
  location.href = `/auth/signin/${encodeURIComponent(provider)}?callbackUrl=${
    encodeURIComponent(callbackUrl)
  }`;
  return Promise.resolve();
}

/** Options for {@link signOut}. */
export interface SignOutOptions {
  /** Where to go after signing out (defaults to `/`). */
  callbackUrl?: string;
}

/**
 * Sign out (same-origin POST to `/auth/signout`), then navigate to `callbackUrl`.
 *
 * @param options {@link SignOutOptions}.
 */
export function signOut(options: SignOutOptions = {}): Promise<void> {
  const callbackUrl = options.callbackUrl ?? "/";
  return fetch(`/auth/signout?callbackUrl=${encodeURIComponent(callbackUrl)}`, {
    method: "POST",
    headers: { accept: "application/json", "x-denext-auth": "1" },
    credentials: "same-origin",
  }).then(() => {
    location.href = callbackUrl;
  });
}
