/**
 * The account-recovery endpoints — email verification and password reset:
 *
 * - `GET {basePath}/verify?token=…&email=…` — the link in a verification email. Verifies
 *   the address and redirects (`pages.verifyRequest`, else `pages.afterSignIn`) with
 *   `?verified=1`, or to `pages.error` (same fallbacks) with `?error=invalid_token`.
 *   `POST {basePath}/verify` takes the same two fields from a form or JSON body.
 * - `POST {basePath}/reset` — `{ email }`: request a reset link. The answer is the same
 *   for every address (a generic `200`, or a `303` to the "check your email" page) — only
 *   a spent send budget changes it, to a `429` that is equally blind to existence.
 * - `POST {basePath}/reset/confirm` — `{ email, token, password }`: set the new password
 *   (every server-side session of the user is revoked), then `200` / `303` to the sign-in
 *   page with `?reset=1`.
 *
 * Every POST is same-origin gated, reads its body through the shared size/stall cap, and
 * accepts JSON or a plain form post — so the flows work with JavaScript disabled (a form
 * gets a `303`, an `Accept: application/json` client a JSON body). The `Authorization`
 * header is never read. Without an adapter that can run a flow its endpoints don't exist:
 * the handler answers `null` and the dispatcher falls through to a plain 404.
 *
 * @module
 */

import { bufferedRequest, readCappedBody, STALLED, TOO_LARGE } from "../body.ts";
import { emailFlowAdapter, resetPassword, startEmailFlow, verifyEmail } from "./email.ts";
import {
  type AuthRoute,
  type AuthRouteContext,
  isSameOrigin,
  json,
  redirect,
  sameOriginRedirect,
  wantsJson,
} from "./routes-shared.ts";
import type { AuthConfig } from "./types.ts";
import { normalizeEmailIdentifier } from "./verification.ts";

/** The most an account-flow body may carry (an address, a token and a password). */
const MAX_BODY_BYTES = 8 * 1024;

/** The string-valued fields of a parsed body; anything else (nested JSON, files) is dropped. */
function stringEntries(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string"));
}

/**
 * The body's string fields — JSON, `application/x-www-form-urlencoded` (a plain HTML form)
 * or multipart — read through the shared cap. An unusable body is `{}`, which every flow
 * then refuses like any other bad input, never a `500`.
 */
async function readFields(ctx: AuthRouteContext): Promise<Record<string, string>> {
  const type = ctx.request.headers.get("content-type") ?? "";
  try {
    const bytes = await readCappedBody(ctx.request, MAX_BODY_BYTES);
    if (bytes === TOO_LARGE || bytes === STALLED) return {};
    if (type.includes("multipart/form-data")) {
      return stringEntries(
        Object.fromEntries(await bufferedRequest(ctx.request, bytes).formData()),
      );
    }
    const text = new TextDecoder().decode(bytes);
    return type.includes("application/json")
      ? stringEntries(JSON.parse(text))
      : Object.fromEntries(new URLSearchParams(text));
  } catch (error) {
    ctx.options.logger.debug("denextAuth: could not parse an account-flow body", {
      error: String(error),
    });
    return {};
  }
}

/** `page` with `query` merged into its search string, as a path (the origin is dropped). */
function withQuery(page: string, query: Record<string, string>): string {
  const url = new URL(page, "http://denext.invalid");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.pathname + url.search + url.hash;
}

/**
 * Answer a flow's outcome: a JSON body for an API client, otherwise a `303` to `page` (a
 * configured, same-origin-coerced path) carrying `query` — what a JS-disabled form needs.
 */
function answer(
  ctx: AuthRouteContext,
  status: number,
  body: Record<string, unknown>,
  page: string,
  query: Record<string, string>,
): Response {
  if (wantsJson(ctx.request)) return json(body, status);
  return redirect(sameOriginRedirect(ctx.config, null, withQuery(page, query)));
}

/** Where a successful verification (or a "check your email" notice) lands. */
function noticePage(config: AuthConfig): string {
  return config.pages?.verifyRequest ?? config.pages?.afterSignIn ?? "/";
}

/** Where a failed verification or reset lands. */
function errorPage(config: AuthConfig): string {
  return config.pages?.error ?? noticePage(config);
}

/** The generic cross-origin refusal every account POST shares. */
function forbidden(): Response {
  return json({ error: "forbidden" }, 403);
}

/**
 * `GET {basePath}/verify` (the emailed link) and `POST {basePath}/verify` (a form or JSON
 * body): redeem the token, mark the address verified, and redirect or answer JSON.
 */
async function handleVerifyEmail(ctx: AuthRouteContext): Promise<Response | null> {
  if (!emailFlowAdapter(ctx.config, "email")) return null;
  let fields: Record<string, string>;
  if (ctx.method === "POST") {
    if (!isSameOrigin(ctx.request, ctx.config)) return forbidden();
    fields = await readFields(ctx);
  } else {
    fields = Object.fromEntries(ctx.url.searchParams);
  }
  const user = await verifyEmail(ctx.config, {
    email: fields.email ?? "",
    token: fields.token ?? "",
  });
  return user
    ? answer(ctx, 200, { ok: true }, noticePage(ctx.config), { verified: "1" })
    : answer(ctx, 400, { error: "invalid_token" }, errorPage(ctx.config), {
      error: "invalid_token",
    });
}

/**
 * `POST {basePath}/reset` — request a reset link. The same answer for every address
 * (known, unknown, malformed); with no mailer configured the answer is unchanged and the
 * misconfiguration goes to `logger.error`. Only a spent send budget answers differently,
 * with a `429` that a known and an unknown address earn alike.
 */
async function handleResetRequest(ctx: AuthRouteContext): Promise<Response | null> {
  const adapter = emailFlowAdapter(ctx.config, "reset");
  if (!adapter) return null;
  if (!isSameOrigin(ctx.request, ctx.config)) return forbidden();
  const identifier = normalizeEmailIdentifier((await readFields(ctx)).email);
  const send = ctx.config.sendVerificationRequest;
  if (!send) {
    ctx.options.logger.error(
      "denextAuth: POST /reset needs `sendVerificationRequest` — no reset email was sent.",
    );
  } else if (identifier) {
    const result = await startEmailFlow(ctx.config, {
      flow: "reset",
      identifier,
      request: ctx.request,
      adapter,
      send,
    });
    if (result.throttled) {
      return json({ error: "too many attempts" }, 429, {
        "retry-after": String(result.retryAfter),
      });
    }
  }
  return answer(ctx, 200, { ok: true }, noticePage(ctx.config), { sent: "1" });
}

/**
 * `POST {basePath}/reset/confirm` — redeem the reset token and set the new password. A
 * refused password sends a form back to the reset page with its link intact (the token
 * was not spent); a bad token lands on the error page.
 */
async function handleResetConfirm(ctx: AuthRouteContext): Promise<Response | null> {
  if (!emailFlowAdapter(ctx.config, "reset")) return null;
  if (!isSameOrigin(ctx.request, ctx.config)) return forbidden();
  const { email = "", token = "", password = "" } = await readFields(ctx);
  const result = await resetPassword(ctx.config, { email, token, password });
  if (result.ok) {
    return answer(ctx, 200, { ok: true }, ctx.config.pages?.signIn ?? "/", { reset: "1" });
  }
  const retry = result.error === "invalid_password";
  return answer(
    ctx,
    400,
    { error: result.error },
    retry ? ctx.options.email.resetPath : errorPage(ctx.config),
    retry ? { email, token, error: result.error } : { error: result.error },
  );
}

/**
 * The account-recovery rows, relative to `basePath`. The link click is a GET that anyone
 * can make, so it carries the per-IP `"session-read"` budget; the POSTs are same-origin
 * gated and `/reset` spends the per-address verification budget itself.
 */
export const accountRoutes: AuthRoute[] = [
  { method: "GET", pattern: "/verify", handler: handleVerifyEmail, limit: "session-read" },
  { method: "POST", pattern: "/verify", handler: handleVerifyEmail },
  { method: "POST", pattern: "/reset", handler: handleResetRequest },
  { method: "POST", pattern: "/reset/confirm", handler: handleResetConfirm },
];
