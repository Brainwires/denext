/**
 * The one sign-in tail every first-factor route ends in (credentials, OAuth/OIDC, email):
 * decide whether a second factor is owed, mint the session accordingly, fire `signIn`
 * only when the sign-in is complete, and answer with JSON or a redirect.
 *
 * A session that still owes a factor is minted **pending** (`auth()` reads `null` for
 * it); the caller is sent to `pages.mfa` (or the sign-in page) instead of `afterSignIn`,
 * and `signIn` fires later, when the step-up completes.
 *
 * @module
 */

import { emitAuthEvent } from "./events.ts";
import { mfaPendingFor } from "./mfa.ts";
import {
  afterSignIn,
  type AuthRouteContext,
  json,
  redirect,
  sameOriginRedirect,
  wantsJson,
} from "./routes-shared.ts";
import { issueAuthSession } from "./session.ts";
import type { AuthUser } from "./types.ts";

/**
 * How long a pending (second-factor-owed) session lives: 15 minutes, never more than the
 * configured `maxAge`. Long enough to open an authenticator app — or, under
 * `mfa.required: "always"`, to enrol one — and short enough that a first factor alone
 * doesn't hold a door open for days.
 */
const PENDING_MFA_LIFETIME = 15 * 60;

/** How a first-factor route finishes its sign-in. */
export interface FinishSignInOptions {
  /** Whether the adapter created the user during this sign-in (for the `signIn` event). */
  isNewUser?: boolean;
  /** The requested `callbackUrl`, kept same-origin. */
  returnTo?: string;
  /** The authentication method the first factor proved (`pwd`, `ext`, `email`, `otp`). */
  amr: string[];
  /** Answer JSON instead of redirecting; defaults to what the request asks for. */
  json?: boolean;
}

/**
 * Finish a first-factor sign-in: step-up decision, session, event, response.
 *
 * @param ctx The route context.
 * @param user The approved user (after `callbacks.signIn`).
 * @param provider The provider id the first factor came from.
 * @param options Event data, the return target and the proven method.
 * @returns The response that ends the sign-in route.
 */
export async function finishSignIn(
  ctx: AuthRouteContext,
  user: AuthUser,
  provider: string,
  options: FinishSignInOptions,
): Promise<Response> {
  const asJson = options.json ?? wantsJson(ctx.request);
  const pending = await mfaPendingFor(ctx.options, user);
  await issueAuthSession(ctx.config, user, provider, {
    mfaPending: pending,
    amr: options.amr,
    lifetime: pending ? PENDING_MFA_LIFETIME : undefined,
  });
  if (pending) {
    return asJson
      ? json({ ok: true, mfa: "required" })
      : redirect(mfaStepLocation(ctx, options.returnTo));
  }
  await emitAuthEvent(ctx.options, "signIn", {
    user,
    provider,
    isNewUser: options.isNewUser ?? false,
  });
  return asJson ? json({ ok: true, user }) : redirect(afterSignIn(ctx.config, options.returnTo));
}

/**
 * Where a pending sign-in goes: `pages.mfa` (else the sign-in page), carrying the
 * eventual `afterSignIn` target as `callbackUrl` — and, when a step-up attempt was
 * refused, an `error` code for the page to render.
 *
 * @param ctx The route context.
 * @param returnTo The requested `callbackUrl`, kept same-origin.
 * @param error An `?error=` code to add (e.g. `"CredentialsSignin"`), if any.
 * @returns A same-origin `Location` value.
 */
export function mfaStepLocation(
  ctx: AuthRouteContext,
  returnTo: string | undefined,
  error?: string,
): string {
  const pages = ctx.config.pages;
  const step = new URL(sameOriginRedirect(ctx.config, pages?.mfa || pages?.signIn, "/"), ctx.url);
  if (error) step.searchParams.set("error", error);
  step.searchParams.set("callbackUrl", afterSignIn(ctx.config, returnTo));
  return step.origin === ctx.url.origin ? step.pathname + step.search : step.href;
}
