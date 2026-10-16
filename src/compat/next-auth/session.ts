/**
 * The Auth.js session on top of a denext session: the `jwt` callback at sign-in (its token
 * sealed into the session payload), the `jwt` + `session` callbacks on every read, `update()`,
 * and the Auth.js `Session` shape (`{ user, expires }`, `expires` an ISO string).
 *
 * @module
 */

import { auth as denextSession, updateAuthSession } from "../../server/auth/mod.ts";
import { clearAuthSession, replaceAuthSession } from "../../server/auth/session.ts";
import type { AuthSession, AuthUser } from "../../server/auth/types.ts";
import { decode, encode, type JWT } from "./jwt.ts";
import { type ActiveNextAuth, type AuthJsAccount, signInRecord } from "./state.ts";
import type { Session, User } from "./types.ts";

/** A denext session payload carrying the sealed Auth.js token. */
type SealedSession = AuthSession & { authjs?: string };

/** The salt the session token is sealed with (Auth.js's cookie name). */
const TOKEN_SALT = "authjs.session-token";

/**
 * The Auth.js user a denext session user is.
 *
 * @param user The denext user.
 * @returns `{ id, name, email, image }` with the absent fields left out.
 */
export function authJsUser(user: AuthUser): User {
  const out: User = { id: user.id };
  if (user.name !== undefined) out.name = user.name;
  if (user.email !== undefined) out.email = user.email;
  if (user.image !== undefined) out.image = user.image;
  return out;
}

/** The token Auth.js starts from: the user's name, email, picture and id. */
function defaultToken(user: AuthUser): JWT {
  const token: JWT = { sub: user.id };
  if (user.name !== undefined) token.name = user.name;
  if (user.email !== undefined) token.email = user.email;
  if (user.image !== undefined) token.picture = user.image;
  return token;
}

/**
 * The provider account behind a sign-in, as the callbacks receive it: what the round-trip
 * recorded, else the provider and the user id.
 *
 * @param provider The provider id.
 * @param userId The signed-in user's id.
 * @returns The account.
 */
export function signInAccount(provider: string, userId: string): AuthJsAccount {
  return signInRecord().account ?? { provider, type: "oauth", providerAccountId: userId };
}

/** The user `jwt` / `signIn` receive: the raw `authorize()` / profile result over the session's. */
export function signInUser(user: AuthUser): User {
  const raw = signInRecord().user ?? {};
  return { ...raw, ...authJsUser(user) };
}

/** Seal `token` for the session payload. */
function seal(active: ActiveNextAuth, token: JWT): Promise<string> {
  return encode({ token, secret: active.secret, salt: TOKEN_SALT, maxAge: active.maxAge });
}

/**
 * denext's `callbacks.session` for a `NextAuth()` config: on a JWT-strategy sign-in, run the
 * app's `jwt` callback (`trigger: "signIn"`, or `"signUp"` when the adapter created the user)
 * and seal its token into the payload.
 *
 * @param active The instance.
 * @param payload The payload denext minted.
 * @returns The payload carrying the sealed token.
 */
export async function sealSignInToken(
  active: ActiveNextAuth,
  payload: AuthSession,
): Promise<AuthSession> {
  if (active.strategy !== "jwt") return payload;
  const record = signInRecord();
  let token = defaultToken(payload.user);
  const jwt = active.config.callbacks?.jwt;
  if (jwt) {
    const isNewUser = record.isNewUser === true;
    token = (await jwt({
      token,
      user: signInUser(payload.user),
      account: signInAccount(payload.provider, payload.user.id),
      profile: record.profile,
      trigger: isNewUser ? "signUp" : "signIn",
      isNewUser,
    })) ?? {};
  }
  return { ...payload, authjs: await seal(active, token) } as SealedSession;
}

/** Whether two tokens differ in anything but their timestamps. */
function tokenChanged(a: JWT, b: JWT): boolean {
  const strip = ({ iat: _i, exp: _e, ...rest }: JWT) => JSON.stringify(rest);
  return strip(a) !== strip(b);
}

/** How a read runs the callbacks. */
export interface ReadOptions {
  /** Write a changed token (or a sign-out) back to the cookie — only where the response is ours. */
  persist: boolean;
  /** `update(data)`: run `jwt` with `trigger: "update"` and `session: data`. */
  update?: { data: unknown };
}

/** The token a session carries: its sealed one, else the user's defaults. */
async function storedToken(active: ActiveNextAuth, session: SealedSession): Promise<JWT> {
  const stored = session.authjs
    ? await decode({ token: session.authjs, secret: active.secret, salt: TOKEN_SALT })
    : null;
  return stored ?? defaultToken(session.user);
}

/** Write a read's outcome back: a sign-out when `jwt` returned nothing, else a changed token. */
async function persistToken(
  active: ActiveNextAuth,
  session: SealedSession,
  before: JWT,
  after: JWT | null,
): Promise<void> {
  if (!after) {
    await clearAuthSession(active.denext);
    return;
  }
  if (!tokenChanged(after, before)) return;
  const resealed = { ...session, authjs: await seal(active, after) } as SealedSession;
  await replaceAuthSession(active.denext, resealed);
}

/** The token on a read: decoded, through `jwt`, persisted when it changed. `null`: signed out. */
async function readToken(
  active: ActiveNextAuth,
  session: SealedSession,
  options: ReadOptions,
): Promise<JWT | null> {
  const token = await storedToken(active, session);
  const jwt = active.config.callbacks?.jwt;
  if (!jwt) return token;
  // A copy: a callback that edits `token` in place and returns it is still a change.
  const draft = structuredClone(token);
  const update = options.update;
  const next = await jwt(
    update ? { token: draft, trigger: "update", session: update.data } : { token: draft },
  );
  if (options.persist) await persistToken(active, session, token, next);
  return next ?? null;
}

/** The session `callbacks.session` starts from on a JWT-strategy read. */
function tokenSession(token: JWT, expires: string): Session {
  const user: User = {};
  if (token.sub !== undefined) user.id = token.sub;
  if (token.name !== undefined) user.name = token.name;
  if (token.email !== undefined) user.email = token.email;
  if (token.picture !== undefined) user.image = token.picture;
  return { user, expires };
}

/**
 * The Auth.js session a denext session reads as — through the app's `jwt` and `session`
 * callbacks — or `null` when `jwt` signed it out.
 *
 * @param active The instance.
 * @param session The live denext session.
 * @param options Whether a changed token may be written back, and an `update()`'s data.
 * @returns The Auth.js session, or `null`.
 */
async function toAuthJsSession(
  active: ActiveNextAuth,
  session: AuthSession,
  options: ReadOptions,
): Promise<Session | null> {
  const expires = new Date(session.expiresAt * 1000).toISOString();
  const callback = active.config.callbacks?.session;
  const update = options.update
    ? { trigger: "update" as const, newSession: options.update.data }
    : {};
  if (active.strategy === "jwt") {
    const token = await readToken(active, session as SealedSession, options);
    if (!token) return null;
    const base = tokenSession(token, expires);
    const shaped = callback
      ? await callback({ session: base, token, user: base.user ?? {}, ...update }) as Session
      : base;
    await sessionEvent(active, { session: shaped, token });
    return shaped;
  }
  const user = authJsUser(session.user);
  const base: Session = { user, expires };
  const shaped = callback
    ? await callback({ session: base, user, token: {}, ...update }) as Session
    : base;
  await sessionEvent(active, { session: shaped });
  return shaped;
}

/** Fire `events.session` for a read; a throwing listener is logged, never fails the read. */
async function sessionEvent(
  active: ActiveNextAuth,
  message: { session: Session; token?: JWT },
): Promise<void> {
  const listener = active.config.events?.session;
  if (!listener) return;
  try {
    await listener(message);
  } catch (error) {
    active.denext.logger?.error?.("next-auth: events.session threw", error);
  }
}

/**
 * The current request's Auth.js session, or `null`. With `persist` (a route handler, middleware,
 * a Server Action) the session's expiry slides and a token the `jwt` callback changed is written
 * back; a Server Component reads without writing.
 *
 * @param active The instance.
 * @param options Whether to write back, and an `update()`'s data.
 * @returns The session, or `null`.
 */
export async function currentAuthJsSession(
  active: ActiveNextAuth,
  options: ReadOptions,
): Promise<Session | null> {
  const session = options.persist ? await updateAuthSession() : await denextSession();
  return session ? await toAuthJsSession(active, session, options) : null;
}
