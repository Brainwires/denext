/**
 * The process state the `next-auth` shim shares across its modules: the active `NextAuth()`
 * instance (its Auth.js config and the denext config built from it), and the per-request
 * sign-in record — what a provider round-trip or an `authorize()` learned that the Auth.js
 * callbacks are handed later in the same request (`account`, `profile`, `credentials`, the raw
 * `user`, `isNewUser`).
 *
 * @module
 */

import { currentContext } from "../../server/request-context.ts";
import type { AuthConfig } from "../../server/auth/types.ts";
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
  /** Whether the cookies carry the `__Host-` prefix (https), as Auth.js decides `__Secure-`. */
  hostPrefix: boolean;
}

let active: ActiveNextAuth | null = null;

/**
 * Make `instance` the one `getToken()`, `next-auth/react`'s server half and the handlers read.
 *
 * @param instance The instance `NextAuth()` built.
 */
export function setActiveNextAuth(instance: ActiveNextAuth): void {
  active = instance;
}

/**
 * The active instance, or `null` before `NextAuth()` ran.
 *
 * @returns The instance, or `null`.
 */
export function activeNextAuth(): ActiveNextAuth | null {
  return active;
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
