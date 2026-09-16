/**
 * `requireBearer()` — the API-token counterpart of `requireSession()`: middleware for
 * `createApi().use(...)` that authenticates a caller from an
 * `Authorization: Bearer tok_…` header instead of a session cookie.
 *
 * It is the first-party replacement for the bearer middleware every API used to
 * hand-roll, and it does three things at once:
 * 1. **Enforces** the token — verified against the adapter, with scope and role checks;
 * 2. **Documents** itself — it is tagged with `documentsSecurity(…, [{ bearerAuth: [] }])`,
 *    so every endpoint built with it is marked secured in the `@denext/openapi` document
 *    with no `security` written on the definition;
 * 3. **Extends the context** with `{ token, user, session }`, where `session` has the same
 *    shape `requireSession()` provides — so a handler written against `ctx.session.user.id`
 *    works under either credential.
 *
 * What it deliberately does NOT do: set a cookie. A bearer request carries its own
 * credential on every call, so nothing is ever written back to the client — no session is
 * issued, no expiry slides, and a token can't be escalated into a browser session.
 *
 * @module
 */

import { ApiError } from "../api-error.ts";
import { type ApiMiddleware, documentsSecurity } from "../define-api.ts";
import type { AdapterUser, ApiTokenRecord } from "./adapter.ts";
import { isVerified } from "./adapter-link.ts";
import { requireApiTokenAdapter, verifyApiToken } from "./api-token.ts";
import { activeAuthConfig, hasRole, peekActiveAuthConfig } from "./mod.ts";
import { resolveAuthOptions } from "./options.ts";
import type { AuthConfig, AuthSession } from "./types.ts";

/** The `provider` a bearer-authenticated {@link AuthSession} carries. */
const BEARER_PROVIDER = "api-token";
/** The one 401 message every refusal shares (see {@link RequireBearerOptions.message}). */
const UNAUTHORIZED = "Missing or invalid bearer token";
/** The 403 message a valid token that lacks the scope or role gets. */
const FORBIDDEN = "Forbidden";

/** What {@link requireBearer} adds to the handler's `ctx`. */
export interface BearerContext {
  /** The verified token row — its id, name, scopes, expiry and `lastUsedAt`. */
  token: ApiTokenRecord;
  /** The adapter user the token acts as. */
  user: AdapterUser;
  /**
   * A session shaped exactly like `requireSession()`'s, synthesized from the token and
   * its user (`provider: "api-token"`, `amr: ["bearer"]`). It exists only for this
   * request: nothing is signed, stored or sent to the client.
   */
  session: AuthSession;
}

/** Options for {@link requireBearer}. */
export interface RequireBearerOptions {
  /**
   * Require at least one of these scope strings on the token — any-of. A token with NO
   * scopes satisfies no requirement, so scoping an endpoint never silently admits older,
   * scopeless tokens.
   */
  scope?: string | string[];
  /** Require at least one of these roles on the token's user (`AdapterUser.roles`) — any-of. */
  role?: string | string[];
  /** The 401's message (default `"Missing or invalid bearer token"`). */
  message?: string;
  /** The 403's message when `scope`/`role` is not held (default `"Forbidden"`). */
  forbiddenMessage?: string;
}

/** The token from an `Authorization: Bearer <token>` header, or `""` when absent/malformed. */
function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const space = header.indexOf(" ");
  if (space < 0) return "";
  // The scheme is case-insensitive (RFC 7235); the credential is not.
  if (header.slice(0, space).toLowerCase() !== "bearer") return "";
  return header.slice(space + 1).trim();
}

/** Any-of membership: no requirement allows everything, nothing held satisfies nothing. */
function anyOf(held: string[] | undefined, required: string | string[] | undefined): boolean {
  if (required === undefined) return true;
  const list = Array.isArray(required) ? required : [required];
  // An empty list is unsatisfiable, as `role: []` is: a computed requirement that came out
  // empty must not admit every token.
  return list.length > 0 && !!held && list.some((r) => held.includes(r));
}

/**
 * The single refusal every authentication failure shares — absent header, wrong scheme,
 * unknown token, revoked token, expired token, or a token whose user is gone. One body,
 * so the response can't be used to probe which tokens exist.
 */
function unauthorized(options: RequireBearerOptions): ApiError {
  return new ApiError(401, "unauthorized", {
    message: options.message ?? UNAUTHORIZED,
    headers: { "www-authenticate": "Bearer" },
  });
}

/** A valid token that may not do this: authenticated, but not authorized (RFC 6750 § 3.1). */
function forbidden(options: RequireBearerOptions): ApiError {
  return new ApiError(403, "forbidden", { message: options.forbiddenMessage ?? FORBIDDEN });
}

/**
 * Build the request-scoped {@link AuthSession} a bearer caller acts under. A token with no
 * expiry gets a synthetic window (the configured session `maxAge` from now) so the field
 * is always a number — the token's own liveness is re-checked on every request regardless.
 */
function bearerSession(
  config: AuthConfig,
  token: ApiTokenRecord,
  user: AdapterUser,
): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: isVerified(user.emailVerified),
      image: user.image,
      roles: user.roles,
    },
    provider: BEARER_PROVIDER,
    expiresAt: token.expiresAt ?? now + resolveAuthOptions(config).maxAge,
    v: 2,
    issuedAt: token.createdAt,
    amr: ["bearer"],
  };
}

/** An auth config (it always carries its signing `secret`), as opposed to bearer options. */
function isAuthConfig(value: unknown): value is AuthConfig {
  return typeof value === "object" && value !== null && "secret" in value;
}

/**
 * Require a valid bearer API token (denext auth): verifies `Authorization: Bearer tok_…`,
 * loads the token's user, and extends the handler's context with
 * {@link BearerContext} — or fails with a `401 unauthorized` envelope before any schema
 * runs. A valid token that lacks the required `scope` or `role` fails with `403 forbidden`
 * instead, so "who are you" stays distinguishable from "may you".
 *
 * ```ts
 * // lib/auth.ts
 * export const authed = createApi().use(requireBearer(authConfig, { scope: "pets:write" }));
 * // app/api/pets/route.ts
 * export const POST = authed.define({ body: NewPet }, ({ body, ctx }) => add(ctx.user.id, body));
 * ```
 *
 * The middleware is tagged with `documentsSecurity(…, [{ bearerAuth: [] }])`, so
 * `@denext/openapi` marks every endpoint that applies it as secured — declare the matching
 * `securitySchemes: { bearerAuth: … }` once in the plugin options for the Authorize button.
 *
 * Bearer authentication **never sets a cookie** and never slides a session forward. It is
 * also never accepted on the `{basePath}/*` auth endpoints — minting and revoking tokens
 * requires the interactive session, so a stolen token can't mint more of itself.
 *
 * @param config The app's auth config (the same object passed to `denextAuth`). Throws
 * here — at module load, not on the first request — when no adapter can store tokens.
 * @param options Optional `scope` / `role` requirements and the refusal messages.
 * @returns A middleware adding `{ token, user, session }` to the handler's `ctx`.
 */
export function requireBearer(
  config: AuthConfig,
  options?: RequireBearerOptions,
): ApiMiddleware<object, BearerContext>;
/**
 * Require a valid bearer API token against the active auth config — the one `denextAuth()` was
 * built with (see {@linkcode activeAuthConfig}) — so a route needs no handle on it:
 * `createApi().use(requireBearer({ scope: "pets:write" }))`. When no auth plugin is active yet
 * where this runs, the config is looked up on the first request, which fails with a clear error
 * if there is still none.
 *
 * @param options Optional `scope` / `role` requirements and the refusal messages.
 * @returns A middleware adding `{ token, user, session }` to the handler's `ctx`.
 */
export function requireBearer(options?: RequireBearerOptions): ApiMiddleware<object, BearerContext>;
export function requireBearer(
  configOrOptions?: AuthConfig | RequireBearerOptions,
  maybeOptions: RequireBearerOptions = {},
): ApiMiddleware<object, BearerContext> {
  const explicit = isAuthConfig(configOrOptions) ? configOrOptions : undefined;
  const options = explicit ? maybeOptions : (configOrOptions ?? {}) as RequireBearerOptions;
  let config = explicit ?? peekActiveAuthConfig();
  // Config-time: an API whose auth can never succeed must fail where it is written.
  if (config) requireApiTokenAdapter(config, "requireBearer");
  const resolve = (): AuthConfig => {
    if (config) return config;
    config = activeAuthConfig();
    requireApiTokenAdapter(config, "requireBearer");
    return config;
  };
  const middleware: ApiMiddleware<object, BearerContext> = async ({ request }) => {
    const config = resolve();
    const token = await verifyApiToken(config, bearerToken(request));
    if (!token) throw unauthorized(options);
    const user = await resolveAuthOptions(config).adapter?.getUser(token.userId);
    // A token whose user was deleted is as dead as a revoked one, and says so no louder.
    if (!user) throw unauthorized(options);
    if (!anyOf(token.scopes, options.scope)) throw forbidden(options);
    const session = bearerSession(config, token, user);
    if (!hasRole(session, options.role)) throw forbidden(options);
    return { token, user, session };
  };
  return documentsSecurity(middleware, [{ bearerAuth: [] }]);
}
