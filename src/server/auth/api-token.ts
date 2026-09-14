/**
 * **Bearer API tokens** — the non-interactive half of denext auth: a long-lived
 * credential a script, a CI job or a mobile client presents as
 * `Authorization: Bearer tok_…`, instead of carrying a browser session cookie.
 *
 * The rules the rest of the framework relies on:
 * - A token is `tok_` + 256 bits of CSPRNG entropy, and the **plaintext is returned
 *   exactly once** — by {@linkcode issueApiToken}, to the caller that minted it. It is
 *   never stored, never logged, and never recoverable afterwards.
 * - What IS stored is the **SHA-256 (hex) of the full presented string** (the `tok_`
 *   prefix included). A database read therefore yields nothing usable, and verification
 *   is an indexed exact-match lookup on that hash rather than a scan with a comparison —
 *   so there is no secret compared in-process, and no timing oracle to equalise.
 * - Verification is **uniform**: unknown, expired and revoked tokens are all `null`, and
 *   the middleware turns every one of them into the same `401`.
 *
 * Storage is the {@link ./adapter.ts | AuthAdapter}'s API-token group, so tokens live
 * wherever the app's users live. An adapter that doesn't implement the group means the
 * feature isn't configured: every function here throws an actionable error, and
 * `{basePath}/tokens` simply doesn't exist.
 *
 * @module
 */

import type { ApiTokenRecord, AuthAdapter } from "./adapter.ts";
import { sha256Hex } from "./hash.ts";
import { randomToken } from "./oauth.ts";
import { resolveAuthOptions } from "./options.ts";
import type { AuthConfig } from "./types.ts";

/** The prefix every denext API token carries — recognizable in logs and secret scanners. */
const TOKEN_PREFIX = "tok_";
/** Entropy per token, in bytes (256 bits → a 43-character base64url secret). */
const TOKEN_BYTES = 32;
/** The longest lifetime `expiresInSeconds` may ask for (10 years ≈ "effectively forever"). */
const MAX_EXPIRES_IN_SECONDS = 10 * 365 * 24 * 60 * 60;

/**
 * The adapter methods bearer tokens need. `touchApiToken` stays optional — a "last used"
 * column is a nicety, and an adapter without one still authenticates.
 */
export type ApiTokenAdapter =
  & Required<
    Pick<AuthAdapter, "createApiToken" | "getApiTokenByHash" | "revokeApiToken" | "listApiTokens">
  >
  & Pick<AuthAdapter, "touchApiToken">;

/** What {@linkcode issueApiToken} is asked for. */
export interface IssueApiTokenOptions {
  /** The {@link ./adapter.ts | AdapterUser} id the token acts as. */
  userId: string;
  /** A human label shown in a token list ("CI", "laptop"). */
  name?: string;
  /** Scope strings the app interprets — `requireBearer({ scope })` matches them any-of. */
  scopes?: string[];
  /** Lifetime in seconds. Omit for a token that never expires (revocation still ends it). */
  expiresInSeconds?: number;
}

/** What {@linkcode issueApiToken} returns: the plaintext (once) plus the stored record. */
export interface IssuedApiToken {
  /**
   * The `tok_…` string to hand the client. **This is the only time it exists** — nothing
   * stores it, so show it once and tell the user to save it.
   */
  token: string;
  /** The row that was stored (carrying the hash, never the plaintext). */
  record: ApiTokenRecord;
}

/**
 * The configured adapter's API-token group, or `null` when the app has no adapter (or one
 * that doesn't implement the group) — i.e. when bearer tokens are simply not configured.
 *
 * @param config The app's auth config.
 * @returns The adapter narrowed to the API-token methods, or `null`.
 */
export function apiTokenAdapter(config: AuthConfig): ApiTokenAdapter | null {
  const adapter = resolveAuthOptions(config).adapter;
  if (!adapter?.createApiToken || !adapter.getApiTokenByHash) return null;
  if (!adapter.revokeApiToken || !adapter.listApiTokens) return null;
  return adapter as ApiTokenAdapter;
}

/**
 * The same lookup as {@link apiTokenAdapter}, but a misconfiguration is an error rather
 * than a silent no-op: an app that asks for bearer tokens without somewhere to put them
 * must fail loudly, at the call that needs them, not authenticate nobody in silence.
 *
 * @param config The app's auth config.
 * @param fn The caller's name, for the message.
 * @returns The adapter narrowed to the API-token methods.
 */
export function requireApiTokenAdapter(config: AuthConfig, fn: string): ApiTokenAdapter {
  const adapter = apiTokenAdapter(config);
  if (!adapter) {
    throw new Error(
      `${fn}: bearer API tokens need a denextAuth \`adapter\` implementing the API-token group ` +
        "(createApiToken / getApiTokenByHash / revokeApiToken / listApiTokens) — pass e.g. " +
        "`adapter: inMemoryAuthAdapter()` or `adapter: sqliteAuthAdapter({ path })`.",
    );
  }
  return adapter;
}

/** Reject a lifetime that isn't a positive, finite, in-range number of seconds. */
function expiryAt(now: number, expiresInSeconds: number | undefined): number | undefined {
  if (expiresInSeconds === undefined) return undefined;
  const seconds = Math.floor(expiresInSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_EXPIRES_IN_SECONDS) {
    throw new Error(
      `issueApiToken: \`expiresInSeconds\` must be a positive number of seconds up to ` +
        `${MAX_EXPIRES_IN_SECONDS} (got ${JSON.stringify(expiresInSeconds)}).`,
    );
  }
  return now + seconds;
}

/**
 * Mint a bearer API token for a user and store its hash.
 *
 * The returned `token` is the ONLY copy of the plaintext: show it to the user once (the
 * way GitHub shows a PAT) and never log it. Everything else about the token — its id,
 * name, scopes and expiry — stays readable through {@link listApiTokens}.
 *
 * @param config The app's auth config (the same object passed to `denextAuth`).
 * @param options The owner, plus the optional label, scopes and lifetime.
 * @returns The plaintext token (once) and the stored {@link ApiTokenRecord}.
 */
export async function issueApiToken(
  config: AuthConfig,
  options: IssueApiTokenOptions,
): Promise<IssuedApiToken> {
  const adapter = requireApiTokenAdapter(config, "issueApiToken");
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = expiryAt(now, options.expiresInSeconds);
  const token = TOKEN_PREFIX + randomToken(TOKEN_BYTES);
  const record: ApiTokenRecord = {
    id: crypto.randomUUID(),
    userId: options.userId,
    name: options.name,
    // The full string is hashed, `tok_` prefix included, so a stored hash can't be
    // computed from a truncated secret either.
    tokenHash: await sha256Hex(token),
    createdAt: now,
    expiresAt,
    scopes: options.scopes ? [...options.scopes] : undefined,
  };
  await adapter.createApiToken(record);
  return { token, record };
}

/**
 * Record a successful presentation. Best-effort by contract: a store that refuses the
 * write (a read replica, a locked row) must never fail the request it was observing, so
 * the failure goes to the logger and the caller is authenticated anyway.
 */
async function touch(config: AuthConfig, adapter: ApiTokenAdapter, id: string): Promise<void> {
  if (!adapter.touchApiToken) return;
  try {
    await adapter.touchApiToken(id, Math.floor(Date.now() / 1000));
  } catch (error) {
    resolveAuthOptions(config).logger.error("denextAuth: touchApiToken failed", error);
  }
}

/**
 * Verify a presented bearer token: hash it, look the hash up (an indexed exact match — no
 * secret is ever compared in-process), and check it is still live.
 *
 * Every failure mode returns the same `null`: an unknown token, a revoked one, an expired
 * one, a malformed one, and "bearer tokens aren't configured at all". Callers must keep
 * that uniformity in their answer — see `requireBearer`.
 *
 * @param config The app's auth config.
 * @param presented The raw token from the `Authorization` header.
 * @returns The live {@link ApiTokenRecord}, or `null`.
 */
export async function verifyApiToken(
  config: AuthConfig,
  presented: string,
): Promise<ApiTokenRecord | null> {
  const adapter = apiTokenAdapter(config);
  if (!adapter || !presented) return null;
  const record = await adapter.getApiTokenByHash(await sha256Hex(presented));
  if (!record) return null;
  // The adapter contract already hides revoked/expired rows; re-checking here means a
  // third-party adapter that forgets to can't turn a dead token into a live session.
  if (record.revokedAt !== undefined) return null;
  if (record.expiresAt !== undefined && record.expiresAt <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  await touch(config, adapter, record.id);
  return record;
}

/**
 * Revoke a token by id — it stops authenticating immediately and can never be revived.
 * Revoking an unknown (or already revoked) id is a no-op, not an error.
 *
 * @param config The app's auth config.
 * @param id The {@link ApiTokenRecord.id} to revoke.
 */
export async function revokeApiToken(config: AuthConfig, id: string): Promise<void> {
  await requireApiTokenAdapter(config, "revokeApiToken").revokeApiToken(id);
}

/**
 * A user's live API tokens (revoked and expired ones are already hidden by the adapter).
 * The records carry `tokenHash`, never a usable token — redact it before sending a list
 * to a client.
 *
 * @param config The app's auth config.
 * @param userId The owner.
 * @returns The user's live tokens.
 */
export async function listApiTokens(
  config: AuthConfig,
  userId: string,
): Promise<ApiTokenRecord[]> {
  return await requireApiTokenAdapter(config, "listApiTokens").listApiTokens(userId);
}
