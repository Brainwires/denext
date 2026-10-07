/**
 * Passkeys for denext auth: the relying-party configuration, the ceremony state (single-use,
 * browser-bound challenges), and the registration / authentication flows over the adapter's
 * passkey group. The cryptographic verification is {@link ./webauthn.ts}; the HTTP endpoints
 * are {@link ./routes-passkeys.ts}.
 *
 * **Challenges** (WebAuthn L3 §13.4.3). Each ceremony gets 32 random bytes. Only their SHA-256
 * is stored, through the adapter's atomic `usePasskeyChallenge`, so a challenge verifies once
 * and a replayed response — same challenge — is refused. The challenge record names its
 * ceremony (`register`, `signin`, `mfa`), its user where there is one, and a random binding
 * that also rides a short-lived signed cookie: a response is accepted only from the browser
 * that started the ceremony.
 *
 * **Factors.** A passkey sign-in with user verification (the default policy) proves possession
 * and the user's PIN or biometric — it completes a sign-in even for a user with TOTP, with
 * `amr: ["hwk", "mfa"]`. Without UV (`userVerification: "preferred"`) it is one factor
 * (`amr: ["hwk"]`), and the usual step-up follows. A passkey also completes a pending session's
 * step-up, as `POST {basePath}/mfa` does with a code.
 *
 * @module
 */

import type { AuthAdapter, PasskeyRecord } from "./adapter.ts";
import { sha256Hex } from "./hash.ts";
import { base64UrlEncode, randomToken } from "./oauth.ts";
import { resolveAuthOptions, type ResolvedAuthOptions } from "./options.ts";
import type { AuthConfig, AuthPasskeyConfig } from "./types.ts";
import { PASSKEY_ALGORITHMS, type PasskeyAlgorithm } from "./webauthn.ts";

/** The adapter methods passkeys need, all present. */
export type PasskeyAdapter =
  & Required<
    Pick<
      AuthAdapter,
      | "createPasskey"
      | "getPasskey"
      | "listPasskeys"
      | "updatePasskey"
      | "deletePasskey"
      | "createPasskeyChallenge"
      | "usePasskeyChallenge"
    >
  >
  & Pick<AuthAdapter, "getUser">;

/** The passkey group of `adapter`, or `undefined` when any method is missing. */
export function passkeyAdapterOf(adapter: AuthAdapter | undefined): PasskeyAdapter | undefined {
  if (!adapter) return undefined;
  const required = [
    "createPasskey",
    "getPasskey",
    "listPasskeys",
    "updatePasskey",
    "deletePasskey",
    "createPasskeyChallenge",
    "usePasskeyChallenge",
  ] as const;
  return required.every((m) => typeof adapter[m] === "function")
    ? adapter as PasskeyAdapter
    : undefined;
}

/** The relying party, every default applied. */
export interface ResolvedPasskeys {
  /** The RP ID. */
  rpId: string;
  /** The RP name. */
  rpName: string;
  /** The accepted origins. */
  origins: string[];
  /** Whether UV is required. */
  requireUserVerification: boolean;
  /** The challenge lifetime, seconds. */
  timeout: number;
  /** The algorithms offered at registration. */
  algorithms: readonly PasskeyAlgorithm[];
}

/** The longest WebAuthn `user.id` (§5.4.3): 64 bytes. */
const MAX_USER_HANDLE = 64;

/** Whether `origin` may host a ceremony for `rpId` (§5.1.4.1: equal, or a subdomain). */
function originMatchesRpId(origin: string, rpId: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  const secure = url.protocol === "https:" ||
    (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
  const host = url.hostname;
  return secure && (host === rpId || host.endsWith(`.${rpId}`));
}

const resolved = new WeakMap<AuthConfig, ResolvedPasskeys | null>();

/**
 * Resolve (and validate, once per config) `config.passkeys`. Throws at config time when the
 * relying party can't be determined safely: no RP ID and no `canonicalOrigin` (deriving it
 * from the Host header would let a request choose it), an origin that isn't secure or isn't
 * on the RP ID, or an adapter without the passkey group.
 *
 * @param config The app's auth config.
 * @returns The resolved relying party, or `null` when passkeys aren't configured.
 * @throws {Error} Naming the problem.
 */
export function resolvePasskeys(config: AuthConfig): ResolvedPasskeys | null {
  const cached = resolved.get(config);
  if (cached !== undefined) return cached;
  const result = config.passkeys
    ? resolve(config, config.passkeys === true ? {} : config.passkeys)
    : null;
  resolved.set(config, result);
  return result;
}

/** {@link resolvePasskeys}'s work. */
function resolve(config: AuthConfig, options: AuthPasskeyConfig): ResolvedPasskeys {
  if (!passkeyAdapterOf(config.adapter)) {
    throw new Error(
      "denextAuth: `passkeys` needs an adapter with the passkey group (createPasskey, " +
        "getPasskey, listPasskeys, updatePasskey, deletePasskey, createPasskeyChallenge, " +
        "usePasskeyChallenge) — use `sqliteAuthAdapter({ path })`, or `inMemoryAuthAdapter()` " +
        "in tests.",
    );
  }
  const canonical = config.canonicalOrigin ? new URL(config.canonicalOrigin).origin : undefined;
  const rpId = (options.rpId ?? (canonical ? new URL(canonical).hostname : "")).toLowerCase();
  if (!rpId) {
    throw new Error(
      "denextAuth: `passkeys` needs `passkeys.rpId` or `canonicalOrigin` — the relying party " +
        "must never be derived from the request's Host header.",
    );
  }
  const origins = options.origins ?? (canonical ? [canonical] : []);
  const webOrigins = origins.filter((o) => !o.startsWith("android:apk-key-hash:"));
  if (origins.length === 0 || webOrigins.some((o) => !originMatchesRpId(o, rpId))) {
    throw new Error(
      `denextAuth: every \`passkeys.origins\` entry must be an https origin (http only on ` +
        `localhost) whose host is "${rpId}" or a subdomain of it — got ${JSON.stringify(origins)}.`,
    );
  }
  const timeout = options.timeout ?? 300;
  return {
    rpId,
    rpName: options.rpName?.trim() || rpId,
    origins,
    requireUserVerification: options.userVerification !== "preferred",
    timeout: Number.isFinite(timeout) ? Math.min(900, Math.max(30, Math.floor(timeout))) : 300,
    algorithms: PASSKEY_ALGORITHMS,
  };
}

/** A ceremony a challenge belongs to. */
export type PasskeyCeremony = "register" | "signin" | "mfa";

/** What a challenge record carries. */
export interface ChallengeData {
  /** The ceremony. */
  kind: PasskeyCeremony;
  /** The user it was issued to (`register`, `mfa`). */
  userId?: string;
  /** The random value the ceremony cookie also carries. */
  binding: string;
}

/**
 * Mint and store a single-use challenge.
 *
 * @param adapter The passkey adapter.
 * @param rp The relying party (its `timeout`).
 * @param data The ceremony, user and browser binding.
 * @returns The base64url challenge to hand the client.
 */
export async function issueChallenge(
  adapter: PasskeyAdapter,
  rp: ResolvedPasskeys,
  data: ChallengeData,
): Promise<string> {
  const challenge = randomToken(32);
  await adapter.createPasskeyChallenge({
    hash: await sha256Hex(challenge),
    expiresAt: Math.floor(Date.now() / 1000) + rp.timeout,
    data: JSON.stringify(data),
  });
  return challenge;
}

/**
 * Redeem the challenge a response signed over: atomically consume its record, and return its
 * ceremony data — or `null` when it was never issued, was already used, or expired.
 *
 * @param adapter The passkey adapter.
 * @param challenge The base64url challenge from `clientDataJSON`.
 * @returns The ceremony data, or `null`.
 */
export async function redeemChallenge(
  adapter: PasskeyAdapter,
  challenge: string,
): Promise<ChallengeData | null> {
  const record = await adapter.usePasskeyChallenge(await sha256Hex(challenge));
  if (!record) return null;
  try {
    const data = JSON.parse(record.data) as ChallengeData;
    return typeof data?.binding === "string" && typeof data.kind === "string" ? data : null;
  } catch {
    return null;
  }
}

/**
 * A user's WebAuthn user handle (§5.4.3 `user.id`): the UTF-8 bytes of the adapter id,
 * base64url. Opaque and stable — an adapter id carries no personal data.
 *
 * @param userId The adapter user id.
 * @returns The base64url handle.
 * @throws {Error} When the id is longer than the 64 bytes WebAuthn allows.
 */
export function userHandleOf(userId: string): string {
  const bytes = new TextEncoder().encode(userId);
  if (bytes.length === 0 || bytes.length > MAX_USER_HANDLE) {
    throw new Error("passkeys: a user id must be 1–64 bytes to serve as a WebAuthn user handle");
  }
  return base64UrlEncode(bytes);
}

/** A passkey as the app may show it — no key material. */
export interface PasskeySummary {
  /** The credential ID (base64url). */
  id: string;
  /** The user's label for it, if any. */
  name?: string;
  /** When it was registered, epoch seconds. */
  createdAt: number;
  /** When it last signed in, epoch seconds. */
  lastUsedAt?: number;
  /** Whether it is currently backed up / synced (BS). */
  backedUp: boolean;
  /** The transports the client reported. */
  transports?: string[];
}

/** The summary of a record. */
export function summarize(record: PasskeyRecord): PasskeySummary {
  const out: PasskeySummary = {
    id: record.id,
    createdAt: record.createdAt,
    backedUp: record.backedUp,
  };
  if (record.name !== undefined) out.name = record.name;
  if (record.lastUsedAt !== undefined) out.lastUsedAt = record.lastUsedAt;
  if (record.transports !== undefined) out.transports = record.transports;
  return out;
}

/** The passkey adapter or a descriptive throw. */
function requirePasskeyAdapter(options: ResolvedAuthOptions, fn: string): PasskeyAdapter {
  const adapter = passkeyAdapterOf(options.adapter);
  if (adapter) return adapter;
  throw new Error(`${fn}: the configured \`adapter\` has no passkey group.`);
}

/**
 * A user's passkeys, for an account-settings page — no key material.
 *
 * @param config The app's auth config.
 * @param userId The user.
 * @returns Their passkeys, oldest first.
 * @throws {Error} When the adapter has no passkey group.
 */
export async function listPasskeys(config: AuthConfig, userId: string): Promise<PasskeySummary[]> {
  const adapter = requirePasskeyAdapter(resolveAuthOptions(config), "listPasskeys");
  return (await adapter.listPasskeys(userId)).map(summarize);
}

/**
 * Remove one of a user's passkeys. Gate it yourself (a recent sign-in, as
 * `DELETE {basePath}/passkeys/:id` requires): a stolen session must not strip a user's factors.
 *
 * @param config The app's auth config.
 * @param input The owner, and the credential ID.
 * @returns `true` when the passkey existed, belonged to `userId`, and was removed.
 * @throws {Error} When the adapter has no passkey group.
 */
export async function deletePasskey(
  config: AuthConfig,
  input: { userId: string; id: string },
): Promise<boolean> {
  const adapter = requirePasskeyAdapter(resolveAuthOptions(config), "deletePasskey");
  const record = await adapter.getPasskey(input.id);
  if (!record || record.userId !== input.userId) return false;
  await adapter.deletePasskey(input.id);
  return true;
}
