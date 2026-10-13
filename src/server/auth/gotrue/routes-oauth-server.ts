/**
 * The OAuth 2.1 authorization server: another app (a registered client) sends the user to
 * `GET /oauth/authorize`, the app's own consent page approves or denies it through
 * `supabase.auth.oauth.*`, and the client exchanges the code at `POST /oauth/token` for an
 * access token (a Supabase JWT carrying `client_id` and `scope`), a rotating refresh token and,
 * with `openid`, an id_token.
 *
 * The rules, each enforced here:
 * - the client's `redirect_uri` must equal a registered one byte for byte (a loopback `http:`
 *   one may differ only in its port, RFC 8252 §7.3); an unknown client or redirect is answered
 *   without redirecting anywhere;
 * - PKCE with S256 is mandatory for every client;
 * - an authorization request is bound to the first user who opens it, settles once (approve or
 *   deny, a compare-and-swap), and its code is single-use, short-lived and stored as a hash —
 *   presenting a used code again revokes the tokens it was exchanged for (OAuth 2.1 §4.1.3);
 * - a confidential client authenticates with the method it registered; a public one cannot;
 * - consent is recorded per user and client with its scopes; a later request within them is
 *   approved without asking, and revoking the grant revokes every session the client holds;
 * - refresh tokens are the session families of `./session.ts` — rotated, with reuse
 *   detection — and refresh only for the client they were issued to.
 *
 * @module
 */

import { readCappedBody, STALLED, TOO_LARGE } from "../../body.ts";
import type {
  OAuthAuthorizationRecord,
  OAuthClientRecord,
  OAuthServerStore,
} from "../adapter-oauth-server.ts";
import { constantTimeEqualHex, sha256Hex } from "../hash.ts";
import { base64UrlEncode, randomToken } from "../oauth.ts";
import {
  type CallerUser,
  type GoTrueContext,
  nowSeconds,
  ok,
  readJson,
  requireUser,
} from "./context.ts";
import { GoTrueError } from "./errors.ts";
import { signSupabaseJwt } from "./keys.ts";
import {
  clientSecretMatches,
  isLoopback,
  oauthStore,
  revokeFamilies,
  SUPPORTED_SCOPES,
} from "./routes-oauth-clients.ts";
import { familiesOf, type GoTrueSessionJson, refreshSession, startSession } from "./session.ts";
import { iso } from "./user.ts";

/** Seconds an unanswered authorization request lives. */
const REQUEST_TTL = 600;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

// ── errors ───────────────────────────────────────────────────────────────────

/** An RFC 6749 §5.2 token-endpoint error. */
class OAuthError extends Error {
  constructor(readonly error: string, message: string, readonly status = 400) {
    super(message);
  }
}

function oauthErrorResponse(error: OAuthError): Response {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (error.status === 401) headers["www-authenticate"] = 'Basic realm="oauth"';
  return Response.json({ error: error.error, error_description: error.message }, {
    status: error.status,
    headers,
  });
}

const invalidGrant = (why = "The authorization grant is invalid, expired or used") =>
  new OAuthError("invalid_grant", why);
const invalidClient = () => new OAuthError("invalid_client", "Client authentication failed", 401);

// ── helpers ──────────────────────────────────────────────────────────────────

function codeHash(code: string): Promise<string> {
  return sha256Hex(`gotrue-oauth-code:${code}`);
}

/** Whether `requested` is one of the client's redirect URIs (loopback ports may differ). */
function redirectAllowed(client: OAuthClientRecord, requested: string): boolean {
  if (client.redirectUris.includes(requested)) return true;
  let url: URL;
  try {
    url = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(url)) return false;
  url.port = "";
  return client.redirectUris.some((registered) => {
    try {
      const reg = new URL(registered);
      if (!isLoopback(reg)) return false;
      reg.port = "";
      return reg.href === url.href;
    } catch {
      return false;
    }
  });
}

/** The scopes a request may get, or `null` for an unsupported / disallowed one. */
function grantedScopes(client: OAuthClientRecord, requested: string | null): string[] | null {
  const allowed = (client.scope ?? SUPPORTED_SCOPES.join(" ")).split(" ");
  const scopes = requested?.trim()
    ? [...new Set(requested.trim().split(/\s+/))]
    : client.scope?.split(" ") ?? ["openid", "email", "profile"];
  return scopes.every((s) => SUPPORTED_SCOPES.includes(s) && allowed.includes(s)) ? scopes : null;
}

/** The client's redirect with response parameters (and `iss`, RFC 9207). */
function clientRedirect(
  ctx: GoTrueContext,
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  url.searchParams.set("iss", ctx.session.issuer);
  return url.href;
}

function found(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

/** The consent page's URL for an authorization. */
function consentUrl(ctx: GoTrueContext, id: string): string {
  const path = ctx.options.oauthServer?.authorizationPath ?? "/oauth/consent";
  const url = new URL(path, ctx.siteUrl);
  url.searchParams.set("authorization_id", id);
  return url.href;
}

function codeExpiry(ctx: GoTrueContext): number {
  const value = ctx.options.oauthServer?.codeExpiry ?? 120;
  return Number.isFinite(value) ? Math.min(600, Math.max(10, Math.floor(value))) : 120;
}

// ── /oauth/authorize ─────────────────────────────────────────────────────────

/** The client and redirect a request names — refused without a redirect when either is bad. */
async function requestClient(
  ctx: GoTrueContext,
  store: OAuthServerStore,
): Promise<{ client: OAuthClientRecord; redirectUri: string }> {
  const params = ctx.url.searchParams;
  const clientId = params.get("client_id") ?? "";
  const client = /^[\w-]{1,64}$/.test(clientId) ? await store.getOAuthClient(clientId) : undefined;
  if (!client) throw new GoTrueError(400, "oauth_client_not_found", "invalid client_id");
  const requested = params.get("redirect_uri") ??
    (client.redirectUris.length === 1 ? client.redirectUris[0] : "");
  if (!redirectAllowed(client, requested)) {
    throw new GoTrueError(400, "validation_failed", "redirect_uri is not registered");
  }
  return { client, redirectUri: requested };
}

/** What is wrong with a request whose client and redirect are good (an RFC 6749 error code). */
function requestProblem(
  client: OAuthClientRecord,
  params: URLSearchParams,
): { error: string; description: string } | null {
  if (params.get("response_type") !== "code") {
    return { error: "unsupported_response_type", description: "response_type must be code" };
  }
  if (!client.grantTypes.includes("authorization_code")) {
    return { error: "unauthorized_client", description: "client may not use this grant" };
  }
  const challenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !CHALLENGE_RE.test(challenge)) {
    return { error: "invalid_request", description: "PKCE with S256 is required" };
  }
  if (!grantedScopes(client, params.get("scope"))) {
    return { error: "invalid_scope", description: "the requested scope is not allowed" };
  }
  const state = params.get("state");
  const nonce = params.get("nonce");
  if ((state && state.length > 1024) || (nonce && nonce.length > 512)) {
    return { error: "invalid_request", description: "state or nonce too long" };
  }
  return null;
}

/** `GET /oauth/authorize` — the client's authorization request. */
export async function oauthAuthorize(ctx: GoTrueContext): Promise<Response> {
  const store = oauthStore(ctx);
  const { client, redirectUri } = await requestClient(ctx, store);
  const params = ctx.url.searchParams;
  const state = params.get("state") ?? undefined;
  const problem = requestProblem(client, params);
  if (problem) {
    return found(clientRedirect(ctx, redirectUri, {
      error: problem.error,
      error_description: problem.description,
      state,
    }));
  }
  const at = nowSeconds();
  const record: OAuthAuthorizationRecord = {
    id: randomToken(24),
    clientId: client.id,
    redirectUri,
    scope: grantedScopes(client, params.get("scope"))!.join(" "),
    codeChallenge: params.get("code_challenge")!,
    status: "pending",
    createdAt: at,
    expiresAt: at + REQUEST_TTL,
    ...(state ? { state } : {}),
    ...(params.get("nonce") ? { nonce: params.get("nonce")! } : {}),
  };
  await store.createOAuthAuthorization(record);
  return found(consentUrl(ctx, record.id));
}

// ── the consent page's calls ─────────────────────────────────────────────────

const notFound = () =>
  new GoTrueError(404, "oauth_authorization_not_found", "Authorization not found or expired");

/** A pending request, bound to the caller (the first user to open it), with its client. */
async function boundRequest(
  ctx: GoTrueContext,
  store: OAuthServerStore,
  userId: string,
): Promise<{ record: OAuthAuthorizationRecord; client: OAuthClientRecord }> {
  const id = ctx.params.id;
  const record = /^[\w-]{16,64}$/.test(id) ? await store.getOAuthAuthorization(id) : undefined;
  if (!record || record.status !== "pending" || record.expiresAt <= nowSeconds()) {
    throw notFound();
  }
  if (record.userId === undefined) {
    const bound = await store.updateOAuthAuthorization(id, { userId }, { userId: null });
    if (!bound && (await store.getOAuthAuthorization(id))?.userId !== userId) throw notFound();
  } else if (record.userId !== userId) throw notFound();
  const client = await store.getOAuthClient(record.clientId);
  if (!client) throw notFound();
  return { record: { ...record, userId }, client };
}

/** Approve: record consent, mint the code, answer the client's redirect. */
async function approve(
  ctx: GoTrueContext,
  store: OAuthServerStore,
  record: OAuthAuthorizationRecord,
  userId: string,
): Promise<string> {
  const code = randomToken(32);
  const settled = await store.updateOAuthAuthorization(record.id, {
    status: "approved",
    codeHash: await codeHash(code),
    expiresAt: nowSeconds() + codeExpiry(ctx),
  }, { status: "pending", userId });
  if (!settled) throw notFound();
  const previous = await store.getOAuthConsent(userId, record.clientId);
  const kept = previous && previous.revokedAt === undefined ? previous.scopes : [];
  await store.putOAuthConsent({
    userId,
    clientId: record.clientId,
    scopes: [...new Set([...kept, ...record.scope.split(" ")])],
    grantedAt: nowSeconds(),
  });
  return clientRedirect(ctx, record.redirectUri, { code, state: record.state });
}

async function deny(
  ctx: GoTrueContext,
  store: OAuthServerStore,
  record: OAuthAuthorizationRecord,
  userId: string,
): Promise<string> {
  const settled = await store.updateOAuthAuthorization(record.id, { status: "denied" }, {
    status: "pending",
    userId,
  });
  if (!settled) throw notFound();
  return clientRedirect(ctx, record.redirectUri, {
    error: "access_denied",
    error_description: "The user denied the request",
    state: record.state,
  });
}

/** Whether the user already consented to every scope the request asks for. */
async function alreadyConsented(
  store: OAuthServerStore,
  record: OAuthAuthorizationRecord,
  userId: string,
): Promise<boolean> {
  const consent = await store.getOAuthConsent(userId, record.clientId);
  if (!consent || consent.revokedAt !== undefined) return false;
  return record.scope.split(" ").every((scope) => consent.scopes.includes(scope));
}

/**
 * The consenting user: a first-party session that owes no second factor — a password alone must
 * not hand a third party a session the user's MFA would have stopped.
 */
async function requireConsentingUser(ctx: GoTrueContext): Promise<CallerUser> {
  const caller = await requireUser(ctx);
  if (caller.claims.aal === "aal2" || !caller.sessionId) return caller;
  const family = await familiesOf(ctx.config).getNativeSession(caller.sessionId);
  let pending = false;
  try {
    pending = (JSON.parse(family?.session ?? "{}") as { pending?: unknown }).pending === true;
  } catch { /* not a snapshot: nothing owed */ }
  if (pending) {
    throw new GoTrueError(403, "insufficient_aal", "AAL2 required to answer an OAuth request");
  }
  return caller;
}

/** `GET /oauth/authorizations/:id` — the consent page's details (or an auto-approval). */
export async function getAuthorization(ctx: GoTrueContext): Promise<Response> {
  const store = oauthStore(ctx);
  const { user } = await requireConsentingUser(ctx);
  const { record, client } = await boundRequest(ctx, store, user.id);
  if (await alreadyConsented(store, record, user.id)) {
    return ok({ redirect_url: await approve(ctx, store, record, user.id) });
  }
  return ok({
    authorization_id: record.id,
    redirect_uri: record.redirectUri,
    client: {
      id: client.id,
      name: client.name,
      uri: client.clientUri ?? "",
      logo_uri: client.logoUri ?? "",
    },
    user: { id: user.id, email: user.email ?? "" },
    scope: record.scope,
  });
}

/** `POST /oauth/authorizations/:id/consent` — `{ action: "approve" | "deny" }`. */
export async function consent(ctx: GoTrueContext): Promise<Response> {
  const store = oauthStore(ctx);
  const { user } = await requireConsentingUser(ctx);
  const body = await readJson(ctx);
  if (body.action !== "approve" && body.action !== "deny") {
    throw new GoTrueError(400, "validation_failed", "action must be approve or deny");
  }
  const { record } = await boundRequest(ctx, store, user.id);
  const redirect = body.action === "approve"
    ? await approve(ctx, store, record, user.id)
    : await deny(ctx, store, record, user.id);
  return ok({ redirect_url: redirect });
}

// ── the user's grants ────────────────────────────────────────────────────────

/** `GET /user/oauth/grants`. */
export async function listGrants(ctx: GoTrueContext): Promise<Response> {
  const store = oauthStore(ctx);
  const { user } = await requireUser(ctx);
  const grants = [];
  for (const grant of await store.listOAuthConsents(user.id)) {
    if (grant.revokedAt !== undefined) continue;
    const client = await store.getOAuthClient(grant.clientId);
    if (!client) continue;
    grants.push({
      client: {
        id: client.id,
        name: client.name,
        uri: client.clientUri ?? "",
        logo_uri: client.logoUri ?? "",
      },
      scopes: grant.scopes,
      granted_at: iso(grant.grantedAt),
    });
  }
  return ok(grants);
}

/** `DELETE /user/oauth/grants?client_id=…` — the consent, and every token the client holds. */
export async function revokeGrant(ctx: GoTrueContext): Promise<Response> {
  const store = oauthStore(ctx);
  const { user } = await requireUser(ctx);
  const clientId = ctx.url.searchParams.get("client_id") ?? "";
  const grant = /^[\w-]{1,64}$/.test(clientId)
    ? await store.getOAuthConsent(user.id, clientId)
    : undefined;
  if (!grant || grant.revokedAt !== undefined) {
    throw new GoTrueError(404, "oauth_client_not_found", "No grant for this client");
  }
  await store.putOAuthConsent({ ...grant, revokedAt: nowSeconds() });
  await revokeFamilies(ctx, await store.listOAuthSessions(user.id, clientId));
  return new Response(null, { status: 204 });
}

// ── /oauth/token ─────────────────────────────────────────────────────────────

/** The token request's parameters: a urlencoded form (RFC 6749 §4.1.3) or JSON. */
async function readTokenParams(ctx: GoTrueContext): Promise<URLSearchParams> {
  const type = (ctx.request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type === "application/json") {
    const body = await readJson(ctx);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") params.set(key, value);
    }
    return params;
  }
  if (!ctx.request.body) return new URLSearchParams();
  const bytes = await readCappedBody(ctx.request, 16 * 1024);
  if (bytes === TOO_LARGE || bytes === STALLED) {
    throw new OAuthError("invalid_request", "request body too large or stalled");
  }
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

/** The Basic credentials of the request, if any (RFC 6749 §2.3.1: form-encoded parts). */
function basicCredentials(request: Request): { id: string; secret: string } | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!match) return null;
  try {
    const decoded = atob(match[1]);
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    const part = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
    return { id: part(decoded.slice(0, colon)), secret: part(decoded.slice(colon + 1)) };
  } catch {
    return null;
  }
}

/** Authenticate the client by the method it registered. */
async function authenticateClient(
  ctx: GoTrueContext,
  store: OAuthServerStore,
  params: URLSearchParams,
): Promise<OAuthClientRecord> {
  const basic = basicCredentials(ctx.request);
  const id = basic?.id ?? params.get("client_id") ?? "";
  const client = /^[\w-]{1,64}$/.test(id) ? await store.getOAuthClient(id) : undefined;
  if (!client) throw invalidClient();
  if (params.get("client_id") && params.get("client_id") !== client.id) throw invalidClient();
  const method = client.tokenEndpointAuthMethod;
  if (method === "none") {
    if (basic || params.has("client_secret")) throw invalidClient();
    return client;
  }
  const secret = method === "client_secret_basic" ? basic?.secret : params.get("client_secret");
  if ((method === "client_secret_basic") !== !!basic) throw invalidClient();
  if (!secret || !(await clientSecretMatches(client, secret))) throw invalidClient();
  return client;
}

async function pkceMatches(verifier: string | null, challenge: string): Promise<boolean> {
  if (!verifier || !VERIFIER_RE.test(verifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return constantTimeEqualHex(base64UrlEncode(new Uint8Array(digest)), challenge);
}

/** Redeem a code once: a replay revokes what the code was exchanged for. */
async function redeemCode(
  ctx: GoTrueContext,
  store: OAuthServerStore,
  client: OAuthClientRecord,
  code: string,
): Promise<OAuthAuthorizationRecord> {
  if (!code || code.length > 128) throw invalidGrant();
  const record = await store.getOAuthAuthorizationByCode(await codeHash(code));
  if (!record || record.clientId !== client.id) throw invalidGrant();
  const won = record.status === "approved" &&
    await store.updateOAuthAuthorization(record.id, { status: "used" }, { status: "approved" });
  if (!won) {
    const used = await store.getOAuthAuthorization(record.id);
    if (used?.sessionId) await revokeFamilies(ctx, [used.sessionId]);
    throw invalidGrant();
  }
  if (record.expiresAt <= nowSeconds()) throw invalidGrant();
  return record;
}

/** The id_token for an `openid` grant (OIDC Core §2). */
async function idToken(
  ctx: GoTrueContext,
  session: GoTrueSessionJson,
  clientId: string,
  nonce?: string,
): Promise<string> {
  const user = session.user as Record<string, unknown>;
  const scopes = (session.scope ?? "").split(" ");
  const at = nowSeconds();
  return await signSupabaseJwt(ctx.keys, {
    iss: ctx.session.issuer,
    sub: user.id,
    aud: clientId,
    iat: at,
    exp: at + session.expires_in,
    auth_time: at,
    ...(nonce ? { nonce } : {}),
    ...(scopes.includes("email") && user.email
      ? { email: user.email, email_verified: !!user.email_confirmed_at }
      : {}),
    ...(scopes.includes("phone") && user.phone
      ? { phone_number: user.phone, phone_number_verified: !!user.phone_confirmed_at }
      : {}),
  });
}

/** The token response (no `user`: the client asks userinfo, within its scopes). */
async function tokenResponse(
  ctx: GoTrueContext,
  session: GoTrueSessionJson,
  clientId: string,
  nonce?: string,
): Promise<Response> {
  const body: Record<string, unknown> = {
    access_token: session.access_token,
    token_type: "bearer",
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    refresh_token: session.refresh_token,
    scope: session.scope ?? "",
  };
  if ((session.scope ?? "").split(" ").includes("openid")) {
    body.id_token = await idToken(ctx, session, clientId, nonce);
  }
  return ok(body);
}

/**
 * The token request's `redirect_uri` is the authorization request's (RFC 6749 §4.1.3); a client
 * with one registered URI may omit it, as it may at `/oauth/authorize`.
 */
function redirectMatches(
  client: OAuthClientRecord,
  record: OAuthAuthorizationRecord,
  given: string | null,
): boolean {
  if (given !== null) return given === record.redirectUri;
  return client.redirectUris.length === 1 && client.redirectUris[0] === record.redirectUri;
}

async function codeGrant(
  ctx: GoTrueContext,
  store: OAuthServerStore,
  client: OAuthClientRecord,
  params: URLSearchParams,
): Promise<Response> {
  const record = await redeemCode(ctx, store, client, params.get("code") ?? "");
  if (!redirectMatches(client, record, params.get("redirect_uri"))) {
    throw invalidGrant("redirect_uri mismatch");
  }
  if (!(await pkceMatches(params.get("code_verifier"), record.codeChallenge))) {
    throw invalidGrant("code_verifier does not match the challenge");
  }
  const grant = await store.getOAuthConsent(record.userId!, client.id);
  const user = await ctx.adapter.getUser(record.userId!);
  if (!grant || grant.revokedAt !== undefined || !user) throw invalidGrant();
  const session = await startSession(
    ctx.session,
    user,
    { method: "oauth", timestamp: nowSeconds() },
    undefined,
    { clientId: client.id, scope: record.scope },
  );
  const sessionId = session.refresh_token.split(".")[0];
  await store.linkOAuthSession({
    sessionId,
    userId: user.id,
    clientId: client.id,
    createdAt: nowSeconds(),
  });
  await store.updateOAuthAuthorization(record.id, { sessionId }, { status: "used" });
  return await tokenResponse(ctx, session, client.id, record.nonce);
}

async function refreshGrant(
  ctx: GoTrueContext,
  client: OAuthClientRecord,
  params: URLSearchParams,
): Promise<Response> {
  if (!client.grantTypes.includes("refresh_token")) {
    throw new OAuthError("unauthorized_client", "client may not use refresh_token");
  }
  let session: GoTrueSessionJson;
  try {
    session = await refreshSession(ctx.session, params.get("refresh_token") ?? "", client.id);
  } catch (error) {
    if (error instanceof GoTrueError) throw invalidGrant(error.message);
    throw error;
  }
  return await tokenResponse(ctx, session, client.id);
}

/** `POST /oauth/token` — `authorization_code` and `refresh_token` grants. */
export async function oauthToken(ctx: GoTrueContext): Promise<Response> {
  const store = oauthStore(ctx);
  try {
    const params = await readTokenParams(ctx);
    const client = await authenticateClient(ctx, store, params);
    const grant = params.get("grant_type");
    if (grant === "authorization_code") return await codeGrant(ctx, store, client, params);
    if (grant === "refresh_token") return await refreshGrant(ctx, client, params);
    throw new OAuthError("unsupported_grant_type", "grant_type is not supported");
  } catch (error) {
    if (error instanceof OAuthError) return oauthErrorResponse(error);
    if (error instanceof GoTrueError && error.code === "bad_json") {
      return oauthErrorResponse(new OAuthError("invalid_request", error.message));
    }
    throw error;
  }
}

// ── discovery and userinfo ───────────────────────────────────────────────────

/** `GET /.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`. */
export function oauthMetadata(ctx: GoTrueContext): Response {
  oauthStore(ctx);
  const issuer = ctx.session.issuer;
  return Response.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    scopes_supported: SUPPORTED_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["ES256", "RS256", "HS256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  }, { headers: { "cache-control": "public, max-age=600" } });
}

/** `GET /oauth/userinfo` — the user's claims, within the token's scopes. */
export async function userinfo(ctx: GoTrueContext): Promise<Response> {
  const { user, claims } = await requireUser(ctx, { allowOAuthClient: true });
  const scopes = typeof claims.scope === "string" ? claims.scope.split(" ") : SUPPORTED_SCOPES;
  const meta = user.userMetadata ?? {};
  return ok({
    sub: user.id,
    ...(scopes.includes("email") && user.email
      ? { email: user.email, email_verified: user.emailVerified !== undefined }
      : {}),
    ...(scopes.includes("phone") && user.phone
      ? { phone_number: user.phone, phone_number_verified: user.phoneVerified !== undefined }
      : {}),
    ...(scopes.includes("profile")
      ? {
        ...(typeof meta.name === "string" ? { name: meta.name } : {}),
        ...(typeof meta.avatar_url === "string" ? { picture: meta.avatar_url } : {}),
        updated_at: user.updatedAt,
      }
      : {}),
  });
}
