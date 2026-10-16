/**
 * The Auth.js v5 types the `next-auth` shim accepts and answers with: the config
 * (`NextAuthConfig`), the session, user, account and profile shapes, the callbacks, and the
 * provider descriptors `next-auth/providers/*` return. `Session`, `User` and `JWT` are
 * interfaces, so `declare module "next-auth" { interface Session { … } }` augments them.
 *
 * @module
 */

import type { JWT } from "./jwt.ts";
import type { AuthJsAccount } from "./state.ts";
import type { AuthJsAdapter } from "./adapter.ts";
import type { CustomOAuthConfig, ProviderDescriptor } from "./providers/shared.ts";

/** A value or a promise of it. */
export type Awaitable<T> = T | PromiseLike<T>;

/** The user a provider or `authorize()` returns, and the session's `user`. */
export interface User {
  /** The user id. */
  id?: string;
  /** Display name. */
  name?: string | null;
  /** Email address. */
  email?: string | null;
  /** Avatar URL. */
  image?: string | null;
}

/** The session `auth()`, `useSession()` and `GET {basePath}/session` answer with. */
export interface Session {
  /** The signed-in user. */
  user?: User;
  /** When the session expires, as an ISO 8601 string. */
  expires: string;
}

/** The default `Session` shape (for `user: DefaultSession["user"] & { … }` augmentation). */
export interface DefaultSession {
  /** The signed-in user. */
  user?: User;
  /** When the session expires, as an ISO 8601 string. */
  expires: string;
}

/** An Auth.js `account`: the provider account behind a sign-in. */
export type Account = AuthJsAccount;

/** The raw profile an OAuth provider returned. */
export type Profile = Record<string, unknown>;

/** What `callbacks.signIn` receives. */
export interface SignInCallbackParams {
  /** The user the sign-in produced. */
  user: User;
  /** The provider account (`null` when unknown). */
  account: Account | null;
  /** The raw provider profile (OAuth). */
  profile?: Profile;
  /** The submitted credentials (Credentials). */
  credentials?: Record<string, unknown>;
  /** Set on an email sign-in. */
  email?: { verificationRequest?: boolean };
}

/** What `callbacks.jwt` receives. */
export interface JwtCallbackParams {
  /** The token so far. */
  token: JWT;
  /** The user — only on sign-in. */
  user?: User;
  /** The provider account — only on sign-in. */
  account?: Account | null;
  /** The raw provider profile — only on an OAuth sign-in. */
  profile?: Profile;
  /** Why the callback runs: a sign-in, a first sign-in, or `update()`; absent on a read. */
  trigger?: "signIn" | "signUp" | "update";
  /** Whether this sign-in created the user (with an adapter). */
  isNewUser?: boolean;
  /** The data `update(data)` was called with. */
  session?: unknown;
}

/** What `callbacks.session` receives. */
export interface SessionCallbackParams {
  /** The session being returned. */
  session: Session;
  /** The decoded token (JWT strategy). */
  token: JWT;
  /** The stored user (database strategy). */
  user: User;
  /** `"update"` when `update(data)` asked. */
  trigger?: "update";
  /** The data `update(data)` was called with. */
  newSession?: unknown;
}

/** What `callbacks.authorized` receives (middleware). */
export interface AuthorizedCallbackParams {
  /** The request being guarded. */
  request: Request & { nextUrl: URL };
  /** The session, or `null`. */
  auth: Session | null;
}

/** The Auth.js callbacks the shim runs. */
export interface CallbacksOptions {
  /** Allow (`true`) or refuse a sign-in. A returned URL refuses it (see KNOWN-DIFFERENCES). */
  signIn?: (params: SignInCallbackParams) => Awaitable<boolean | string>;
  /** Shape the token: on sign-in, on every session read, and on `update()`. */
  jwt?: (params: JwtCallbackParams) => Awaitable<JWT | null>;
  /** Shape the session every read answers with. */
  session?: (params: SessionCallbackParams) => Awaitable<Session | Record<string, unknown>>;
  /** Pick where to go after sign-in / sign-out; the result is still kept same-origin. */
  redirect?: (params: { url: string; baseUrl: string }) => Awaitable<string>;
  /** Middleware authorization: `true`, `false` (to the sign-in page) or a `Response`. */
  authorized?: (params: AuthorizedCallbackParams) => Awaitable<boolean | Response | undefined>;
}

/** The Auth.js events the shim fires. */
export interface EventCallbacks {
  /** A sign-in completed. */
  signIn?: (message: {
    user: User;
    account: Account | null;
    profile?: Profile;
    isNewUser?: boolean;
    ip?: string;
  }) => Awaitable<void>;
  /** A session ended through sign-out. */
  signOut?: (message: { session?: unknown; token?: JWT | null; ip?: string }) => Awaitable<void>;
  /** The adapter created a user. */
  createUser?: (message: { user: User; ip?: string }) => Awaitable<void>;
  /** A provider account was linked to a user. */
  linkAccount?: (
    message: { user: User; account: Partial<Account>; profile?: Profile; ip?: string },
  ) => Awaitable<void>;
  /** The adapter updated a user (an email sign-in verifying its address, a profile change). */
  updateUser?: (message: { user: User }) => Awaitable<void>;
  /**
   * A session was read (the `session` endpoint, `auth()`, `useSession`): with the token on the
   * JWT strategy, without it on the database strategy.
   */
  session?: (message: { session: Session; token?: JWT }) => Awaitable<void>;
}

/** The Auth.js logger shape. */
export interface LoggerInstance {
  /** A swallowed failure. */
  error?: (error: Error) => void;
  /** A recoverable misconfiguration. */
  warn?: (code: string) => void;
  /** Verbose tracing. */
  debug?: (message: string, metadata?: unknown) => void;
}

/**
 * A provider entry: a descriptor, a provider factory passed uncalled (`providers: [GitHub]`), or a
 * custom OAuth / OIDC provider object.
 */
export type Provider =
  | ProviderDescriptor
  | ((options?: never) => ProviderDescriptor)
  | CustomOAuthConfig;

/** The Auth.js v5 config `NextAuth()` takes. */
export interface NextAuthConfig {
  /** The sign-in providers. */
  providers: Provider[];
  /** The signing secret (default `AUTH_SECRET`, then `NEXTAUTH_SECRET`). */
  secret?: string | string[];
  /** Session strategy and lifetimes. */
  session?: {
    /** `"jwt"` (default without an adapter) or `"database"` (default with one). */
    strategy?: "jwt" | "database";
    /** Session lifetime in seconds (default 30 days). */
    maxAge?: number;
    /** How often an active session is extended, in seconds (default 24 hours). */
    updateAge?: number;
  };
  /** Token lifetime (the sealed token follows the session's otherwise). */
  jwt?: { maxAge?: number };
  /** The callbacks. */
  callbacks?: CallbacksOptions;
  /** The events. */
  events?: EventCallbacks;
  /** Custom pages. */
  pages?: {
    /** The sign-in page (default: the built-in `{basePath}/signin`). */
    signIn?: string;
    /** The sign-out page. */
    signOut?: string;
    /** The error page. */
    error?: string;
    /** The "check your email" page. */
    verifyRequest?: string;
    /** Where a first sign-in lands. */
    newUser?: string;
  };
  /** An Auth.js database adapter (`@auth/prisma-adapter`, `@auth/drizzle-adapter`, …). */
  adapter?: AuthJsAdapter;
  /** The endpoint prefix (default `/api/auth`, or `AUTH_URL`'s path). */
  basePath?: string;
  /** Accepted; denext trusts only `AUTH_URL` (its `canonicalOrigin`) for its own origin. */
  trustHost?: boolean;
  /** Turns on `logger.debug` output. */
  debug?: boolean;
  /** Where the shim logs. */
  logger?: LoggerInstance;
  /** Accepted and ignored: denext's cookies are fixed (see KNOWN-DIFFERENCES). */
  cookies?: Record<string, unknown>;
  /** Accepted and ignored. */
  useSecureCookies?: boolean;
  /** Accepted and ignored (the built-in pages are unstyled). */
  theme?: Record<string, unknown>;
  /** Accepted and ignored. */
  experimental?: Record<string, unknown>;
  /** Accepted and ignored. */
  redirectProxyUrl?: string;
}
