/**
 * Single-use **verification tokens** — the proof-of-mailbox primitive under email
 * verification and password reset (and, later, magic links and one-time codes).
 *
 * The rules every flow built on it inherits:
 * - A token is 256 bits of CSPRNG entropy ({@link ./oauth.ts | randomToken}). The
 *   plaintext goes into the email and **nowhere else**: storage only ever sees its
 *   SHA-256 ({@link ./hash.ts | sha256Hex}), so a database read yields nothing usable.
 * - A token is scoped by `(identifier, purpose)`: a password-reset token can never verify
 *   an address, and one address's token can never act for another.
 * - Redemption goes through the adapter's **atomic** `useVerificationToken`, keyed by the
 *   presented token's hash — so a wrong guess matches nothing and can't burn the real
 *   token, two concurrent redemptions yield exactly one record, and an expired token is
 *   consumed and refused in the same step.
 * - An identifier is ONE normalised email address (trimmed, lower-cased). A value that
 *   isn't exactly one address — `a@x.com,b@y.com`, `a@x.com; b@y.com`, a display-name
 *   form — is refused outright; it is never split into several recipients.
 *
 * @module
 */

import type { AuthAdapter, VerificationPurpose, VerificationTokenRecord } from "./adapter.ts";
import { constantTimeEqualHex, sha256Hex } from "./hash.ts";
import { randomToken } from "./oauth.ts";
import { resolveAuthOptions } from "./options.ts";
import type { AuthConfig } from "./types.ts";

/** Entropy per token, in bytes (256 bits → a 43-character base64url string). */
const TOKEN_BYTES = 32;
/** The longest presented token worth hashing — an issued one is 43 characters. */
const MAX_TOKEN_LENGTH = 256;
/** RFC 5321's path limit: no deliverable address is longer. */
const MAX_ADDRESS_LENGTH = 254;
/** RFC 5321's local-part limit. */
const MAX_LOCAL_LENGTH = 64;
/**
 * The WHATWG `<input type="email">` grammar (applied after lower-casing): one local part,
 * one `@`, one domain. It admits no whitespace, `,`, `;`, quotes or angle brackets, so a
 * value that matches can only ever name a single recipient.
 */
const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** The adapter methods verification tokens need: store one, and atomically redeem one. */
export type VerificationTokenAdapter = Required<
  Pick<AuthAdapter, "createVerificationToken" | "useVerificationToken">
>;

/** What {@linkcode issueVerificationToken} is asked for. */
export interface IssueVerificationTokenOptions {
  /** The email address the token proves control of (normalised before storage). */
  identifier: string;
  /** Which token space it belongs to. */
  purpose: VerificationPurpose;
  /** Lifetime in seconds (a positive, finite number). */
  ttl: number;
  /** Opaque payload handed back on redemption (e.g. a pending email change). */
  data?: string;
}

/** What {@linkcode issueVerificationToken} returns. */
export interface IssuedVerificationToken {
  /** The plaintext token — put it in the email and nowhere else; it is not stored. */
  token: string;
  /** Expiry, epoch seconds. */
  expiresAt: number;
}

/** What {@linkcode redeemVerificationToken} is asked to redeem. */
export interface RedeemVerificationTokenOptions {
  /** The address the token was issued for (normalised the same way it was at issue). */
  identifier: string;
  /** The token space to redeem it in. */
  purpose: VerificationPurpose;
  /** The presented plaintext token. */
  token: string;
}

/** The current time in epoch seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Normalise a submitted email address into a verification identifier: trimmed,
 * lower-cased, and exactly ONE address — or `null`. Nothing is split: a list
 * (`a@x.com,b@y.com`), a display-name form (`"A" <a@x.com>`) or an over-long address is
 * simply refused, so a token can only ever be mailed to one recipient.
 *
 * @param input The submitted value (anything — a non-string is refused).
 * @returns The normalised address, or `null` when it isn't a single valid address.
 */
export function normalizeEmailIdentifier(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const address = input.trim().toLowerCase();
  if (address.length > MAX_ADDRESS_LENGTH || !EMAIL_RE.test(address)) return null;
  return address.indexOf("@") <= MAX_LOCAL_LENGTH ? address : null;
}

/**
 * The configured adapter's verification-token group, or `null` when the app has no
 * adapter (or one without the group) — i.e. when the email-token flows aren't configured.
 *
 * @param config The app's auth config.
 * @returns The adapter narrowed to the verification-token methods, or `null`.
 */
export function verificationAdapter(config: AuthConfig): VerificationTokenAdapter | null {
  const adapter = resolveAuthOptions(config).adapter;
  if (!adapter?.createVerificationToken || !adapter.useVerificationToken) return null;
  return adapter as VerificationTokenAdapter;
}

/**
 * The same lookup as {@link verificationAdapter}, but a misconfiguration is an error: a
 * flow that needs verification tokens must fail loudly at the call, not silently no-op.
 *
 * @param config The app's auth config.
 * @param fn The caller's name, for the message.
 * @returns The adapter narrowed to the verification-token methods.
 */
function requireVerificationAdapter(
  config: AuthConfig,
  fn: string,
): VerificationTokenAdapter {
  const adapter = verificationAdapter(config);
  if (!adapter) {
    throw new Error(
      `${fn}: verification tokens need a denextAuth \`adapter\` implementing ` +
        "createVerificationToken / useVerificationToken — pass e.g. " +
        "`adapter: inMemoryAuthAdapter()` or `adapter: sqliteAuthAdapter({ path })`.",
    );
  }
  return adapter;
}

/**
 * Mint a single-use token for `(identifier, purpose)` and store only its SHA-256.
 *
 * The returned `token` is the only copy of the plaintext: put it in the link or the code
 * you send, never in a log. An adapter keeping one token per `(identifier, purpose)` (the
 * SQLite one does) invalidates the previous token as it stores this one.
 *
 * @param config The app's auth config.
 * @param options The address, the token space, the lifetime and an optional payload.
 * @returns The plaintext token (once) and its expiry.
 */
export async function issueVerificationToken(
  config: AuthConfig,
  options: IssueVerificationTokenOptions,
): Promise<IssuedVerificationToken> {
  const adapter = requireVerificationAdapter(config, "issueVerificationToken");
  const identifier = normalizeEmailIdentifier(options.identifier);
  if (!identifier) {
    throw new Error("issueVerificationToken: `identifier` must be exactly one email address.");
  }
  if (!Number.isFinite(options.ttl) || options.ttl < 1) {
    throw new Error(
      `issueVerificationToken: \`ttl\` must be a positive number of seconds (got ${
        JSON.stringify(options.ttl)
      }).`,
    );
  }
  const token = randomToken(TOKEN_BYTES);
  const expiresAt = nowSeconds() + Math.floor(options.ttl);
  const record: VerificationTokenRecord = {
    identifier,
    tokenHash: await sha256Hex(token),
    expires: expiresAt,
    purpose: options.purpose,
  };
  if (options.data !== undefined) record.data = options.data;
  await adapter.createVerificationToken(record);
  return { token, expiresAt };
}

/**
 * Redeem a presented token: hash it, atomically consume the matching
 * `(identifier, purpose, hash)` row, and re-check what came back.
 *
 * Every failure is the same `null` — no such token, a wrong token, an already-spent one,
 * an expired one (which the adapter consumes as it refuses it), a malformed address. A
 * wrong token matches no row, so it never burns the real one. The returned record is
 * re-verified here (hash compared in constant time, identifier, purpose and expiry), so
 * a third-party adapter that returns the wrong row still can't redeem it.
 *
 * @param config The app's auth config.
 * @param options The address, the token space and the presented token.
 * @returns The consumed record, or `null`.
 */
export async function redeemVerificationToken(
  config: AuthConfig,
  options: RedeemVerificationTokenOptions,
): Promise<VerificationTokenRecord | null> {
  const adapter = requireVerificationAdapter(config, "redeemVerificationToken");
  const identifier = normalizeEmailIdentifier(options.identifier);
  const token = typeof options.token === "string" ? options.token : "";
  if (!identifier || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const tokenHash = await sha256Hex(token);
  const record = await adapter.useVerificationToken({
    identifier,
    purpose: options.purpose,
    tokenHash,
  });
  // Compare on a miss too (against itself), so a miss does the same work as a hit.
  const hashMatches = constantTimeEqualHex(record?.tokenHash ?? tokenHash, tokenHash);
  if (!record || !hashMatches) return null;
  const scoped = record.identifier === identifier && record.purpose === options.purpose;
  return scoped && record.expires > nowSeconds() ? record : null;
}
