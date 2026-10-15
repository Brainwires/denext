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
 * - `pages` → `pages` (the built-in pages under the base path otherwise);
 * - `logger` / `debug` → `logger`.
 *
 * @module
 */

import { fromAuthJsAdapter } from "./adapter.ts";
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
import type {
  AuthConfig,
  AuthEvents,
  AuthLogger,
  AuthProvider,
  AuthSession,
  AuthUser,
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

/** The one sender the email providers share (denext has one per config). */
function emailSender(
  built: { provider: AuthProvider; send?: SendVerificationRequest }[],
  warn: (message: string) => void,
): SendVerificationRequest | undefined {
  const senders = built.filter((b) => b.send);
  if (senders.length > 1) {
    warn(
      `more than one email provider is configured; every sign-in link is sent by ` +
        `"${senders[0].provider.id}"'s sender`,
    );
  }
  return senders[0]?.send;
}

/** `user` with what the provider's `profile()` override returned (never its id or email). */
async function withProfileOverride(user: AuthUser): Promise<AuthUser> {
  const record = signInRecord();
  if (!record.applyProfile) return user;
  const mine = await record.applyProfile();
  record.user = { ...mine, id: user.id };
  const next: AuthUser = { ...user };
  if (typeof mine.name === "string") next.name = mine.name;
  if (typeof mine.image === "string") next.image = mine.image;
  return next;
}

/**
 * denext's `callbacks.signIn`: apply a provider's `profile()` override, then the app's
 * `signIn`, which refuses on anything but `true` (a returned URL included).
 */
function signInCallback(
  active: () => ActiveNextAuth,
): NonNullable<AuthConfig["callbacks"]>["signIn"] {
  return async (user, provider) => {
    const current = await withProfileOverride(user);
    const callback = active().config.callbacks?.signIn;
    if (callback) {
      const record = signInRecord();
      const verdict = await callback({
        user: signInUser(current),
        account: signInAccount(provider, current.id),
        profile: record.profile,
        credentials: record.credentials,
      });
      if (verdict !== true) return false;
    }
    return current;
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
  warn: (message: string) => void,
): AuthConfig["adapter"] {
  if (!config.adapter) return undefined;
  const credentialsProviders = new Set(
    descriptors.filter((d) => d.type === "credentials").map((d) => d.id),
  );
  return fromAuthJsAdapter(config.adapter, { credentialsProviders, warn });
}

/**
 * Translate `config` and describe the instance it makes.
 *
 * @param config The app's Auth.js config.
 * @param env The environment reader (injectable for tests).
 * @returns The instance: the config, the denext config, the base path, strategy and secret.
 */
export function translateConfig(config: NextAuthConfig, env: EnvReader = readEnv): ActiveNextAuth {
  const url = authUrl(env);
  const basePath = (config.basePath ?? url.path ?? DEFAULT_BASE_PATH).replace(/\/+$/, "");
  const secret = config.secret ?? env("AUTH_SECRET") ?? env("NEXTAUTH_SECRET") ?? "";
  const descriptors = config.providers.map(describe);
  const built = descriptors.map((d) => buildProvider(d, env));
  const { strategy, session } = sessionSettings(config);
  const log = logger(config);
  const warn = (message: string) => log.warn?.(message);
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
  const adapter = bridgedAdapter(config, descriptors, warn);
  if (adapter) denext.adapter = adapter;
  const send = emailSender(built, warn);
  if (send) denext.sendVerificationRequest = send;
  const maxAge = session.maxAge!;
  ref.current = { config, denext, basePath, strategy, secret, maxAge, providers: descriptors };
  return ref.current;
}
