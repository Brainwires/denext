/**
 * The API-token endpoints — `POST {basePath}/tokens` (mint), `GET {basePath}/tokens`
 * (list), `DELETE {basePath}/tokens/:id` (revoke). They are the management surface for
 * {@link ./api-token.ts | bearer tokens}: a signed-in user creates a credential for a
 * script, sees what they have issued, and takes one back.
 *
 * Four rules make them safe to expose:
 * - **Cookie session only.** The `Authorization` header is never read here. A bearer
 *   token can therefore never mint another token, widen its own scopes, or revoke a
 *   sibling — escalation from a leaked token stops at whatever that token could already do.
 * - **Complete sessions only.** The session is judged exactly as `auth()` judges it, so a
 *   half-authenticated (`mfaPending`) session mints nothing: a first factor alone can't
 *   produce a credential that outlives the second-factor requirement.
 * - **A recent sign-in to mint.** A token outlives every session and survives
 *   `revokeAllSessions()`, so `POST` needs the session's `authTime` within `mfa.freshness`
 *   (five minutes at least), as `/mfa/enroll` does: a stolen long-lived session can't turn
 *   itself into access that outlasts it.
 * - **Same-origin for the mutations**, like every other state-changing auth POST, and
 *   `no-store` on every answer ({@link ./routes-shared.ts | json}).
 *
 * With no API-token-capable adapter configured the endpoints don't exist: the handlers
 * return `null`, the dispatcher falls through, and `{basePath}/tokens` is a plain 404.
 *
 * @module
 */

import { bufferedRequest, readCappedBody, STALLED, TOO_LARGE } from "../body.ts";
import type { ApiTokenRecord } from "./adapter.ts";
import {
  apiTokenAdapter,
  issueApiToken,
  type IssueApiTokenOptions,
  listApiTokens,
  revokeApiToken,
} from "./api-token.ts";
import { type AuthRouteContext, isSameOrigin, json } from "./routes-shared.ts";
import { recentlyAuthenticated } from "./mfa.ts";
import { readAuthSession } from "./session.ts";
import type { AuthSession } from "./types.ts";

/** The most a `POST /tokens` body may carry (a name, a few scopes, a lifetime). */
const MAX_BODY_BYTES = 4 * 1024;
/** Longest accepted token label. */
const MAX_NAME_LENGTH = 64;
/** Most scopes one token may carry, and the longest any single scope may be. */
const MAX_SCOPES = 32;
/** Longest accepted scope string. */
const MAX_SCOPE_LENGTH = 64;
/**
 * Most LIVE tokens one user may hold. A session can mint tokens in a loop, and an API
 * token never expires unless asked to, so without a cap one compromised session leaves an
 * unbounded number of long-lived credentials behind (and `DELETE /tokens/:id` lists them
 * all on every revoke). Revoking or expiring one frees a slot.
 */
const MAX_ACTIVE_TOKENS = 50;

/** A token as a client may see it: everything except the hash (and the implicit owner). */
interface PublicApiToken {
  /** The token id — what `DELETE {basePath}/tokens/:id` takes. */
  id: string;
  /** The label it was created with, if any. */
  name?: string;
  /** The scopes it carries, if any. */
  scopes?: string[];
  /** Creation time, epoch seconds. */
  createdAt: number;
  /** Expiry, epoch seconds; absent when it never expires. */
  expiresAt?: number;
  /** Last successful presentation, epoch seconds; absent when never used. */
  lastUsedAt?: number;
}

/** Strip the stored hash (and the owner id) from a record before it leaves the server. */
function publicToken(record: ApiTokenRecord): PublicApiToken {
  return {
    id: record.id,
    name: record.name,
    scopes: record.scopes,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
  };
}

/**
 * The signed-in user's id, or `null`. Deliberately reads the cookie session directly and
 * applies `auth()`'s rule (a `mfaPending` session is not signed in) rather than calling
 * `auth()`, so the endpoints judge the config they were dispatched with.
 */
async function sessionUserId(ctx: AuthRouteContext): Promise<string | null> {
  return (await completeSession(ctx))?.user.id ?? null;
}

/** The caller's complete cookie session, or `null` — none, or one still owing a second factor. */
async function completeSession(ctx: AuthRouteContext): Promise<AuthSession | null> {
  const session = await readAuthSession(ctx.config);
  return session && !session.mfaPending ? session : null;
}

/** The shared 401: no cookie session, or one that still owes a second factor. */
function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

/**
 * The gate the two mutating endpoints share: API tokens must be configured, the request
 * must be same-origin (a cross-site POST is CSRF), and the caller must hold a complete
 * cookie session.
 *
 * @param ctx The route context.
 * @returns The caller's complete session when everything passes, otherwise the answer to send —
 * `null` meaning "this endpoint doesn't exist here", so the dispatcher falls through.
 */
async function mutatingCaller(ctx: AuthRouteContext): Promise<AuthSession | Response | null> {
  if (!apiTokenAdapter(ctx.config)) return null;
  if (!isSameOrigin(ctx.request, ctx.config)) return json({ error: "forbidden" }, 403);
  return (await completeSession(ctx)) ?? unauthorized();
}

/** Scopes from a JSON array, or from a form field's space/comma separated list. */
function parseScopes(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const list = typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : value;
  if (!Array.isArray(list) || list.length > MAX_SCOPES) return null;
  const ok = list.every((s) =>
    typeof s === "string" && s.length > 0 && s.length <= MAX_SCOPE_LENGTH
  );
  return ok ? (list as string[]) : null;
}

/** A lifetime from a JSON number or a form field's digits. */
function parseTtl(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.floor(seconds);
}

/**
 * Validate a parsed body into the mint options, or `null` when any field is unusable —
 * a bad request is a `400`, never a token with a silently dropped scope.
 */
function tokenOptions(body: Record<string, unknown>): Omit<IssueApiTokenOptions, "userId"> | null {
  const name = body.name;
  if (name !== undefined && (typeof name !== "string" || name.length > MAX_NAME_LENGTH)) {
    return null;
  }
  const scopes = parseScopes(body.scopes);
  const expiresInSeconds = parseTtl(body.expiresInSeconds);
  if (scopes === null || expiresInSeconds === null) return null;
  return { name: name as string | undefined, scopes, expiresInSeconds };
}

/** Parse a JSON (or form-encoded) body to a plain object, or `null` when unusable. */
async function parseBody(ctx: AuthRouteContext): Promise<Record<string, unknown> | null> {
  const bytes = await readCappedBody(ctx.request, MAX_BODY_BYTES);
  if (bytes === TOO_LARGE || bytes === STALLED) return null;
  if (bytes.byteLength === 0) return {}; // no body at all → every field defaults
  const capped = bufferedRequest(ctx.request, bytes);
  try {
    const parsed = (ctx.request.headers.get("content-type") ?? "").includes("application/json")
      ? await capped.json()
      : Object.fromEntries(await capped.formData());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (error) {
    ctx.options.logger.debug("denextAuth: could not parse the /tokens body", {
      error: String(error),
    });
    return null;
  }
}

/**
 * Mints in flight, per user. Counting live tokens and creating one are two adapter calls, so
 * concurrent POSTs could each see room under the cap; each mint waits for the user's previous
 * one instead. Per process — replicas behind a shared adapter can each overshoot by one.
 */
const minting = new Map<string, Promise<void>>();

/** Run `fn` once every earlier call for `key` has settled; the entry goes when idle. */
function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (minting.get(key) ?? Promise.resolve()).then(fn);
  const settled = run.then(() => {}, () => {});
  minting.set(key, settled);
  void settled.then(() => {
    if (minting.get(key) === settled) minting.delete(key);
  });
  return run;
}

/**
 * `POST {basePath}/tokens` — mint an API token for the signed-in user and return the
 * plaintext **once**. Body (JSON or form-encoded, all optional):
 * `{ name?, scopes?, expiresInSeconds? }`.
 *
 * @param ctx The route context.
 * @returns `201` with the token, `400` on an unusable body, `401` without a complete
 * session, `403` cross-origin or without a recent sign-in (`reauth_required`), `409` once the caller holds `MAX_ACTIVE_TOKENS` live
 * tokens — or `null` when API tokens aren't configured.
 */
export async function handleCreateToken(ctx: AuthRouteContext): Promise<Response | null> {
  const session = await mutatingCaller(ctx);
  if (!session || session instanceof Response) return session;
  if (!recentlyAuthenticated(ctx.options, session)) {
    return json({ error: "reauth_required" }, 403);
  }
  const userId = session.user.id;
  const body = await parseBody(ctx);
  const options = body && tokenOptions(body);
  if (!options) return json({ error: "invalid request" }, 400);
  return await oneAtATime(userId, async () => {
    const live = await listApiTokens(ctx.config, userId);
    if (live.length >= MAX_ACTIVE_TOKENS) {
      return json({ error: "too many tokens", max: MAX_ACTIVE_TOKENS }, 409);
    }
    const issued = await issueApiToken(ctx.config, { userId, ...options });
    // The one and only time the plaintext is disclosed.
    return json({ token: issued.token, ...publicToken(issued.record) }, 201);
  });
}

/**
 * `GET {basePath}/tokens` — the signed-in user's live tokens, redacted (no hashes, and
 * never the plaintext, which no longer exists anywhere).
 *
 * @param ctx The route context.
 * @returns `200` with `{ tokens }`, `401` without a complete session — or `null` when API
 * tokens aren't configured.
 */
export async function handleListTokens(ctx: AuthRouteContext): Promise<Response | null> {
  if (!apiTokenAdapter(ctx.config)) return null;
  const userId = await sessionUserId(ctx);
  if (!userId) return unauthorized();
  const tokens = await listApiTokens(ctx.config, userId);
  return json({ tokens: tokens.map(publicToken) });
}

/**
 * `DELETE {basePath}/tokens/:id` — revoke one of the signed-in user's own tokens.
 *
 * Ownership is proved by finding the id among the caller's live tokens, so another user's
 * id answers `404` — the same answer an unknown id gets, and the same one an already
 * revoked or expired token of your own gets (it is already gone). A `404` never confirms
 * that someone else's token exists.
 *
 * @param ctx The route context.
 * @returns `200` `{ ok: true }`, `404` when the caller owns no such live token, `401`
 * without a complete session, `403` cross-origin — or `null` when API tokens aren't
 * configured.
 */
export async function handleRevokeToken(ctx: AuthRouteContext): Promise<Response | null> {
  const session = await mutatingCaller(ctx);
  if (!session || session instanceof Response) return session;
  const own = await listApiTokens(ctx.config, session.user.id);
  if (!own.some((token) => token.id === ctx.params.id)) return json({ error: "not found" }, 404);
  await revokeApiToken(ctx.config, ctx.params.id);
  return json({ ok: true });
}
