/**
 * The process state the `next-auth` shim shares across its modules: the active `NextAuth()`
 * instance (its Auth.js config and the denext config built from it), and the per-request
 * sign-in record — what a provider round-trip or an `authorize()` learned that the Auth.js
 * callbacks are handed later in the same request (`account`, `profile`, `credentials`, the raw
 * `user`, `isNewUser`).
 *
 * @module
 */

import { currentContext } from "@denext/denext/auth-kit";
import type { AuthConfig } from "../src/types.ts";
import type { NextAuthConfig } from "./types.ts";
import type { ProviderDescriptor } from "./providers/shared.ts";

/** One `NextAuth()` instance, as the shim's modules need it. */
export interface ActiveNextAuth {
  /** The app's Auth.js config. */
  config: NextAuthConfig;
  /** The denext auth config translated from it. */
  denext: AuthConfig;
  /** The endpoint prefix (`/api/auth` by default), without a trailing slash. */
  basePath: string;
  /** `"jwt"` or `"database"`. */
  strategy: "jwt" | "database";
  /** The secret (or rotation list) tokens are sealed under. */
  secret: string | string[];
  /** The session lifetime in seconds. */
  maxAge: number;
  /** The providers, as `next-auth/providers/*` described them. */
  providers: ProviderDescriptor[];
}

let active: ActiveNextAuth | null = null;

/** The request-context memo key of the instance a lazy config built for one request. */
const REQUEST_INSTANCE = Symbol.for("denext.next-auth.request-instance");

/**
 * Make `instance` the one `getToken()`, `next-auth/react`'s server half and the handlers read.
 *
 * @param instance The instance `NextAuth()` built.
 */
export function setActiveNextAuth(instance: ActiveNextAuth): void {
  active = instance;
}

/**
 * Make `instance` the one this request reads (a lazy `NextAuth((req) => config)` builds one per
 * request), whatever another request made active meanwhile. Outside a request it does nothing.
 *
 * @param instance The instance built for this request.
 */
export function bindActiveNextAuth(instance: ActiveNextAuth): void {
  currentContext()?.memo.set(REQUEST_INSTANCE, new Map([["instance", instance]]));
}

/**
 * The active instance — the one bound to this request, else the last `NextAuth()` built — or
 * `null` before `NextAuth()` ran.
 *
 * @returns The instance, or `null`.
 */
export function activeNextAuth(): ActiveNextAuth | null {
  const bound = currentContext()?.memo.get(REQUEST_INSTANCE)?.get("instance");
  return (bound as ActiveNextAuth | undefined) ?? active;
}

/** An Auth.js `account` — the provider account behind a sign-in. */
export interface AuthJsAccount extends Record<string, unknown> {
  /** The provider id. */
  provider: string;
  /** `"oauth"`, `"oidc"`, `"email"` or `"credentials"`. */
  type: string;
  /** The account's id at the provider. */
  providerAccountId: string;
  /** The provider access token (OAuth). */
  access_token?: string;
  /** The provider refresh token (OAuth). */
  refresh_token?: string;
  /** When the access token expires, epoch seconds (OAuth). */
  expires_at?: number;
  /** The token type (OAuth). */
  token_type?: string;
  /** The granted scope (OAuth). */
  scope?: string;
  /** The OIDC id_token. */
  id_token?: string;
}

/** What one request's sign-in learned for the Auth.js callbacks. */
export interface SignInRecord {
  /** The provider account. */
  account?: AuthJsAccount;
  /** The raw provider profile (OAuth). */
  profile?: Record<string, unknown>;
  /** The submitted credentials (Credentials). */
  credentials?: Record<string, string>;
  /** The user exactly as `authorize()` / the profile callback returned it. */
  user?: Record<string, unknown>;
  /** Whether the adapter created the user during this sign-in. */
  isNewUser?: boolean;
}

/** Records per request context; a sign-in never outlives its request. */
const records = new WeakMap<object, SignInRecord>();

/**
 * This request's sign-in record (created empty on first use); outside a request, a throwaway.
 *
 * @returns The record.
 */
export function signInRecord(): SignInRecord {
  const ctx = currentContext();
  if (!ctx) return {};
  let record = records.get(ctx);
  if (!record) records.set(ctx, record = {});
  return record;
}
