/**
 * An Auth.js v5 config (`NextAuthConfig`) as a denext auth config. The mapping:
 *
 * - `secret` → `secret` (default `AUTH_SECRET`, then `NEXTAUTH_SECRET`);
 * - `AUTH_URL` (or `NEXTAUTH_URL`) → `canonicalOrigin`, its path → `basePath` (default
 *   `/api/auth`);
 * - `providers` → denext providers (env defaults applied); the email providers' sender →
 *   `sendVerificationRequest`;
 * - `session.strategy` `"jwt"` → denext's signed cookie with the token sealed inside,
 *   `"database"` → `session.strategy: "database"` over the adapter's sessions; `maxAge`,
 *   `updateAge` (default 24 hours) as they are;
 * - `adapter` → {@link fromAuthJsAdapter};
 * - `callbacks.signIn` → `callbacks.signIn`; `callbacks.jwt` → run at sign-in from denext's
 *   `callbacks.session` hook and on every read; `callbacks.session` / `redirect` /
 *   `authorized` → run by the shim;
 * - `events.signIn` / `signOut` / `createUser` / `linkAccount` → the denext events;
 *   `events.updateUser` from the adapter bridge, `events.session` on every session read;
 * - several email providers → one `sendVerificationRequest` dispatching on the issuing
 *   provider;
 * - `pages` → `pages` (the built-in pages under the base path otherwise);
 * - `logger` / `debug` → `logger`.
 *
 * @module
 */

import { type AuthJsAdapterUser, fromAuthJsAdapter } from "./adapter.ts";
import { decode } from "./jwt.ts";
import {
  buildProvider,
  customDescriptor,
  type EnvReader,
  isDescriptor,
  type ProviderDescriptor,
  readEnv,
} from "./providers/shared.ts";
import { authJsUser, sealSignInToken, signInAccount, signInUser } from "./session.ts";
import { type ActiveNextAuth, signInRecord } from "./state.ts";
import type { NextAuthConfig, Provider, User } from "./types.ts";
import type { AdapterUser } from "../../server/auth/adapter.ts";
import type { RateLimitOptions } from "../../server/auth/rate-limit.ts";
import type {
  AuthConfig,
  AuthEvents,
  AuthLogger,
  AuthProvider,
  AuthSession,
  SendVerificationRequest,
} from "../../server/auth/types.ts";

/** Auth.js's default session lifetime: 30 days. */
const DEFAULT_MAX_AGE = 30 * 24 * 60 * 60;
/** Auth.js's default `updateAge`: 24 hours. */
const DEFAULT_UPDATE_AGE = 24 * 60 * 60;
/** The endpoint prefix a Next app mounts the handlers on. */
const DEFAULT_BASE_PATH = "/api/auth";

/** A provider entry as a descriptor: a factory passed uncalled is called, an object described. */
function describe(entry: Provider): ProviderDescriptor {
  if (typeof entry === "function") return entry();
  if (isDescriptor(entry)) return entry;
  return customDescriptor(entry);
}

/** `AUTH_URL`'s origin and path, when it is set. */
function authUrl(env: EnvReader): { origin?: string; path?: string } {
  const raw = env("AUTH_URL") ?? env("NEXTAUTH_URL");
  if (!raw) return {};
  const url = new URL(raw);
  const path = url.pathname.replace(/\/+$/, "");
  return { origin: url.origin, path: path || undefined };
}

/** The Auth.js logger as denext's, quiet at `debug` unless `debug: true`. */
function logger(config: NextAuthConfig): AuthLogger {
  const custom = config.logger;
  return {
    error: (message, error) => {
      const err = error instanceof Error ? error : new Error(message);
      if (custom?.error) custom.error(err);
      else console.error(`[next-auth] ${message}`, error ?? "");
    },
    warn: (message) => custom?.warn ? custom.warn(message) : console.warn(`[next-auth] ${message}`),
    debug: (message, meta) => {
      if (config.debug) custom?.debug ? custom.debug(message, meta) : console.debug(message, meta);
    },
  };
}

/** An adapter user as the Auth.js events see it. */
function storedUser(user: AdapterUser): User {
  return authJsUser({ id: user.id, name: user.name, email: user.email, image: user.image });
}

/** The app's Auth.js events on denext's. */
function events(active: () => ActiveNextAuth): AuthEvents {
  const app = () => active().config.events;
  return {
    signIn: async ({ user, provider, isNewUser, ip }) => {
      const record = signInRecord();
      await app()?.signIn?.({
        user: signInUser(user),
        account: signInAccount(provider, user.id),
        profile: record.profile,
        isNewUser,
        ip,
      });
    },
    signOut: async ({ session, ip }) => {
      const sealed = (session as AuthSession & { authjs?: string } | null)?.authjs;
      const token = sealed
        ? await decode({ token: sealed, secret: active().secret, salt: "authjs.session-token" })
        : null;
      await app()?.signOut?.(active().strategy === "jwt" ? { token, ip } : { session, ip });
    },
    createUser: async ({ user, ip }) => {
      signInRecord().isNewUser = true;
      await app()?.createUser?.({ user: storedUser(user), ip });
    },
    linkAccount: async ({ user, account, ip }) => {
      await app()?.linkAccount?.({
        user: storedUser(user),
        account,
        profile: signInRecord().profile,
        ip,
      });
    },
  };
}

/**
 * denext's one `sendVerificationRequest` over the email providers' own senders: a link or code
 * goes out through the provider that issued it (its `provider` id), anything else (a provider
 * denext doesn't name) through the first.
 */
function emailSender(
  built: { provider: AuthProvider; send?: SendVerificationRequest }[],
): SendVerificationRequest | undefined {
  const senders = new Map<string, SendVerificationRequest>();
  for (const { provider, send } of built) if (send) senders.set(provider.id, send);
  const first = senders.values().next().value;
  if (!first) return undefined;
  return (params) => ((params.provider && senders.get(params.provider)) || first)(params);
}

/** denext's `callbacks.signIn`: the app's `signIn`, refusing on anything but `true` (a URL too). */
function signInCallback(
  active: () => ActiveNextAuth,
): NonNullable<AuthConfig["callbacks"]>["signIn"] {
  return async (user, provider) => {
    const callback = active().config.callbacks?.signIn;
    if (!callback) return true;
    const record = signInRecord();
    const verdict = await callback({
      user: signInUser(user),
      account: signInAccount(provider, user.id),
      profile: record.profile,
      credentials: record.credentials,
    });
    return verdict === true;
  };
}

/** The session settings: Auth.js's strategy and lifetimes as denext's. */
function sessionSettings(config: NextAuthConfig): {
  strategy: "jwt" | "database";
  session: NonNullable<AuthConfig["session"]>;
} {
  const strategy = config.session?.strategy ?? (config.adapter ? "database" : "jwt");
  return {
    strategy,
    session: {
      strategy: strategy === "jwt" ? "cookie" : "database",
      maxAge: config.session?.maxAge ?? DEFAULT_MAX_AGE,
      updateAge: config.session?.updateAge ?? DEFAULT_UPDATE_AGE,
    },
  };
}

/** The pages: the app's, else the built-in ones under the base path. */
function pages(config: NextAuthConfig, basePath: string): NonNullable<AuthConfig["pages"]> {
  const own = config.pages ?? {};
  return {
    signIn: own.signIn ?? `${basePath}/signin`,
    error: own.error ?? `${basePath}/error`,
    verifyRequest: own.verifyRequest ?? `${basePath}/verify-request`,
  };
}

/** The Auth.js adapter behind denext's port, when the app has one. */
function bridgedAdapter(
  config: NextAuthConfig,
  descriptors: ProviderDescriptor[],
  log: AuthLogger,
): AuthConfig["adapter"] {
  if (!config.adapter) return undefined;
  const credentialsProviders = new Set(
    descriptors.filter((d) => d.type === "credentials").map((d) => d.id),
  );
  const warn = (message: string) => log.warn?.(message);
  // Auth.js's `updateUser` event; a throwing listener is logged, never fails the write.
  const onUpdateUser = async (row: AuthJsAdapterUser) => {
    try {
      await config.events?.updateUser?.({ user: authJsRow(row) });
    } catch (error) {
      log.error?.("next-auth: events.updateUser threw", error);
    }
  };
  return fromAuthJsAdapter(config.adapter, { credentialsProviders, warn, onUpdateUser });
}

/** An Auth.js adapter row as the events see a user. */
function authJsRow(row: AuthJsAdapterUser): User {
  const user: User = { id: String(row.id) };
  if (row.name) user.name = row.name;
  if (row.email) user.email = row.email;
  if (row.image) user.image = row.image;
  return user;
}

/**
 * Translate `config` and describe the instance it makes.
 *
 * @param config The app's Auth.js config.
 * @param env The environment reader (injectable for tests).
 * @param rateLimit The rate limits, when several translations must share one budget (a lazy
 *   config builds a config per request; the limiters are per config object otherwise).
 * @returns The instance: the config, the denext config, the base path, strategy and secret.
 */
export function translateConfig(
  config: NextAuthConfig,
  env: EnvReader = readEnv,
  rateLimit?: RateLimitOptions,
): ActiveNextAuth {
  const url = authUrl(env);
  const basePath = (config.basePath ?? url.path ?? DEFAULT_BASE_PATH).replace(/\/+$/, "");
  const secret = config.secret ?? env("AUTH_SECRET") ?? env("NEXTAUTH_SECRET") ?? "";
  const descriptors = config.providers.map(describe);
  const built = descriptors.map((d) => buildProvider(d, env));
  const { strategy, session } = sessionSettings(config);
  const log = logger(config);
  // Filled in below; the callbacks read it lazily, once `NextAuth()` has returned.
  const ref: { current?: ActiveNextAuth } = {};
  const active = () => ref.current!;
  const denext: AuthConfig = {
    secret,
    providers: built.map((b) => b.provider),
    basePath,
    session,
    callbacks: {
      signIn: signInCallback(active),
      session: (payload) => sealSignInToken(active(), payload),
    },
    events: events(active),
    logger: log,
    pages: pages(config, basePath),
  };
  if (url.origin) denext.canonicalOrigin = url.origin;
  if (rateLimit) denext.rateLimit = rateLimit;
  const adapter = bridgedAdapter(config, descriptors, log);
  if (adapter) denext.adapter = adapter;
  const send = emailSender(built);
  if (send) denext.sendVerificationRequest = send;
  const maxAge = session.maxAge!;
  ref.current = {
    config,
    denext,
    basePath,
    strategy,
    secret,
    maxAge,
    providers: descriptors,
  };
  return ref.current;
}
