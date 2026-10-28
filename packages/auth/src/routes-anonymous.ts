/**
 * **Anonymous sign-in** on denext's own endpoints (`anonymous: true`) — the native half of
 * Supabase's `signInAnonymously()`:
 *
 * - `POST {basePath}/anonymous` — same-origin gated; with `captcha` configured it needs a solved
 *   captcha token; it spends the per-IP sign-in-start budget; then it creates a user with no
 *   identifier (`{ isAnonymous: true }`, firing `createUser`), runs `callbacks.signIn`, and signs
 *   it in (`amr: ["anonymous"]`, provider `"anonymous"`, `isNewUser: true`). The session user
 *   carries `isAnonymous: true`. Without `anonymous: true` the endpoint does not exist (a plain
 *   404).
 * - **Conversion** ({@linkcode convertAnonymousUser}): when a request carrying a COMPLETE
 *   anonymous session redeems an email link / code or a phone code for an identifier no account
 *   has, the proof is attached to that anonymous user — it keeps its id, gains the verified
 *   identifier and loses `isAnonymous` (`userConverted` fires) — instead of a new user being
 *   created. `allowSignUp: false` does not block it (the user exists already). An identifier
 *   that already has an account signs in as that account; the anonymous user is left as it is
 *   (no merge). A pending (second-factor-owed) session never converts.
 *
 * @module
 */

import type { AdapterUser, AuthAdapter } from "./adapter.ts";
import { type ResolvedSignIn, toAuthUser } from "./adapter-link.ts";
import { captchaRefusal } from "./captcha.ts";
import { emitAuthEvent } from "./events.ts";
import {
  authTrustsProxy,
  proxiedWithoutTrust,
  signinStartKey,
  signinStartLimiter,
} from "./rate-limit.ts";
import {
  emitSignInFailure,
  finishProvenSignIn,
  readSignInForm,
  resolveContained,
  tooManyAttempts,
} from "./routes-passwordless.ts";
import {
  type AuthRoute,
  type AuthRouteContext,
  isSameOrigin,
  json,
  wantsJson,
} from "./routes-shared.ts";
import { readAuthSession } from "./session.ts";
import type { AuthConfig, AuthSession } from "./types.ts";

/** The provider id an anonymous session records (it is not a configured provider). */
const ANONYMOUS_PROVIDER = "anonymous";

/** The adapter methods a conversion needs. */
type ConvertingAdapter = Pick<AuthAdapter, "updateUser"> & Partial<Pick<AuthAdapter, "getUser">>;

/**
 * Whether the request carries a complete (not second-factor-owed) session of an anonymous
 * user — one a proof could convert. A send to an identifier with no account goes out for such a
 * request even under `allowSignUp: false`, since the conversion creates no user.
 *
 * @param ctx The route context.
 * @returns `true` for a complete anonymous session.
 */
export async function hasConvertibleSession(ctx: AuthRouteContext): Promise<boolean> {
  return (await convertibleSession(ctx)) !== null;
}

/** The request's complete anonymous session, or `null`. */
async function convertibleSession(ctx: AuthRouteContext): Promise<AuthSession | null> {
  const session = await readAuthSession(ctx.config);
  return session && !session.mfaPending && session.user.isAnonymous === true ? session : null;
}

/**
 * Attach a just-proven identifier to the signed-in anonymous user, if there is one: the
 * request's session must be complete (not owing a second factor) and its user still anonymous
 * in the adapter. The user keeps its id; `proof` (`{ email, emailVerified }` or
 * `{ phone, phoneVerified }`) is written with `isAnonymous: false`, and `userConverted` fires.
 * Call it only for an identifier that has NO account.
 *
 * @param ctx The route context.
 * @param adapter The configured adapter.
 * @param proof The proven identifier and its verification time.
 * @param provider The provider whose proof converts the user.
 * @returns The converted user, or `null` when the request has no complete anonymous session.
 */
async function convertAnonymousUser(
  ctx: AuthRouteContext,
  adapter: ConvertingAdapter,
  proof: Partial<Pick<AdapterUser, "email" | "emailVerified" | "phone" | "phoneVerified">>,
  provider: string,
): Promise<AdapterUser | null> {
  const session = await convertibleSession(ctx);
  if (!session) return null;
  const stored = await adapter.getUser?.(session.user.id);
  if (stored?.isAnonymous !== true) return null;
  const user = await adapter.updateUser({ id: stored.id, ...proof, isAnonymous: false });
  await emitAuthEvent(ctx.options, "userConverted", { user, provider });
  return user;
}

/**
 * The user a proven identifier with NO account signs in as: the request's anonymous user,
 * converted ({@linkcode convertAnonymousUser}) — even when the provider allows no sign-up, since
 * the user exists already; else a new user carrying the proof when the provider allows sign-up
 * (firing `createUser`); else `null`.
 *
 * @param ctx The route context.
 * @param adapter The configured adapter.
 * @param proof The proven identifier and its verification time.
 * @param provider The provider's id and sign-up policy.
 * @returns The resolved sign-in, or `null`.
 */
export async function convertOrCreateUser(
  ctx: AuthRouteContext,
  adapter: ConvertingAdapter & Pick<AuthAdapter, "createUser">,
  proof: Partial<Pick<AdapterUser, "email" | "emailVerified" | "phone" | "phoneVerified">>,
  provider: { id: string; allowSignUp: boolean },
): Promise<ResolvedSignIn | null> {
  const converted = await convertAnonymousUser(ctx, adapter, proof, provider.id);
  if (converted) return { user: toAuthUser(converted), isNewUser: false };
  if (!provider.allowSignUp) return null;
  const created = await adapter.createUser(proof);
  await emitAuthEvent(ctx.options, "createUser", { user: created });
  return { user: toAuthUser(created), isNewUser: true };
}

/**
 * The per-IP sign-in-start budget, spent by hand so it comes after the captcha check (the
 * dispatch-level gate would spend it first). Skipped behind an undeclared proxy, like the gate.
 */
async function spendSigninStart(ctx: AuthRouteContext): Promise<Response | null> {
  const limiter = signinStartLimiter(ctx.config);
  if (!limiter || proxiedWithoutTrust(ctx.request, ctx.config)) return null;
  const key = signinStartKey(ctx.request, { trustForwardedHeaders: authTrustsProxy(ctx.config) });
  const retryAfter = await limiter.hit(key);
  if (retryAfter === null) return null;
  await emitSignInFailure(ctx, ANONYMOUS_PROVIDER, "rate_limited");
  return tooManyAttempts(retryAfter);
}

/** The adapter when anonymous sign-in is on and can run, else `null` (→ no such endpoint). */
function anonymousAdapter(ctx: AuthRouteContext): AuthAdapter | null {
  if (ctx.config.anonymous !== true) return null;
  const adapter = ctx.options.adapter;
  return typeof adapter?.createUser === "function" ? adapter : null;
}

/**
 * `POST {basePath}/anonymous` — create an anonymous user and sign it in.
 *
 * @param ctx The route context.
 * @returns `null` without `anonymous: true` (a plain 404); else a cross-origin `403`, a captcha
 * refusal, a `429`, a `403` / `?error=AccessDenied` veto, or the sign-in answer.
 */
async function handleAnonymous(ctx: AuthRouteContext): Promise<Response | null> {
  const adapter = anonymousAdapter(ctx);
  if (!adapter) return null;
  if (!isSameOrigin(ctx.request, ctx.config)) return json({ error: "forbidden" }, 403);
  const fields = await readSignInForm(ctx);
  const refused = await captchaRefusal(ctx, fields, ANONYMOUS_PROVIDER) ??
    await spendSigninStart(ctx);
  if (refused) return refused;
  const resolved = await resolveContained(ctx, ANONYMOUS_PROVIDER, async () => {
    const created = await adapter.createUser({ isAnonymous: true });
    await emitAuthEvent(ctx.options, "createUser", { user: created });
    return { user: toAuthUser(created), isNewUser: true };
  });
  return await finishProvenSignIn(ctx, ANONYMOUS_PROVIDER, resolved, {
    callbackUrl: fields.callbackUrl,
    asJson: wantsJson(ctx.request),
    amr: ["anonymous"],
  });
}

/**
 * Refuse, at config time, `anonymous: true` with no adapter able to create users.
 *
 * @param config The app's auth config.
 * @throws {Error} Naming what is missing.
 */
export function assertAnonymousConfig(config: AuthConfig): void {
  if (config.anonymous !== true) return;
  if (typeof config.adapter?.createUser === "function") return;
  throw new Error(
    "denextAuth: `anonymous: true` needs an `adapter` implementing createUser (and getUser / " +
      "updateUser to convert an anonymous user) — pass e.g. `adapter: sqliteAuthAdapter({ " +
      "path })`, or `inMemoryAuthAdapter()` in tests.",
  );
}

/** The anonymous sign-in row, relative to `basePath`. */
export const anonymousRoutes: AuthRoute[] = [
  { method: "POST", pattern: "/anonymous", handler: handleAnonymous },
];
