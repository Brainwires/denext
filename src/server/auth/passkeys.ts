/**
 * Passkeys for denext auth: the relying-party configuration, the ceremony state (single-use,
 * browser-bound challenges), and the registration / authentication flows over the adapter's
 * passkey group. The cryptographic verification is {@link ./webauthn.ts}; the HTTP endpoints
 * are {@link ./routes-passkeys.ts}.
 *
 * **Challenges** (WebAuthn L3 §13.4.3). Each ceremony gets 32 random bytes. Only their SHA-256
 * is stored, through the adapter's atomic `usePasskeyChallenge`, so a challenge verifies once
 * and a replayed response — same challenge — is refused. The challenge record names its
 * ceremony (`register`, `signin`, `mfa`), its user where there is one, and the SHA-256 of a
 * random ceremony id that only the options response carries: the verifying request must
 * present it, so a response is accepted only from the tab that started the ceremony — and
 * several tabs of one browser can each run one.
 *
 * **Factors.** A passkey sign-in with user verification (the default policy) proves possession
 * and the user's PIN or biometric — it completes a sign-in even for a user with TOTP, with
 * `amr: ["hwk", "mfa"]`. Without UV (`userVerification: "preferred"`) it is one factor
 * (`amr: ["hwk"]`), and the usual step-up follows — with a TOTP or backup code only: the same
 * passkey must not count twice. A passkey also completes the step-up of a pending session whose
 * first factor was something else (a password, an email link, OAuth), as `POST {basePath}/mfa`
 * does with a code.
 *
 * **Registration** needs a complete, recent session and — for an account with an email address —
 * a verified address: a passkey planted on an unverified account would outlive the
 * pre-account-hijacking eviction's purpose ({@link ./email.ts}), which also removes every passkey
 * of the account when its owner first proves the mailbox.
 *
 * @module
 */

import type { AuthAdapter, PasskeyRecord } from "./adapter.ts";
import { forgetPasskeyFactor } from "./factors.ts";
import { sha256Hex } from "./hash.ts";
import { base64UrlDecode, base64UrlEncode, randomToken } from "./oauth.ts";
import { resolveAuthOptions, type ResolvedAuthOptions } from "./options.ts";
import { type ResolvedMds, resolveMds } from "./fido-mds.ts";
import type { AuthConfig, AuthPasskeyAndroidApp, AuthPasskeyConfig } from "./types.ts";
import { isAndroidPackageName } from "../app-links.ts";
import { type CorsPolicy, normalizeCorsOrigin, resolveCors } from "../cors.ts";
import { PASSKEY_ALGORITHMS, type PasskeyAlgorithm, WebAuthnError } from "./webauthn.ts";

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
  /**
   * The accepted origins: `passkeys.origins` (default `[canonicalOrigin]`), then the
   * `android:apk-key-hash:` origin of every `passkeys.androidApps` signing certificate.
   */
  origins: string[];
  /** Whether UV is required. */
  requireUserVerification: boolean;
  /** The challenge lifetime, seconds. */
  timeout: number;
  /** The algorithms offered at registration. */
  algorithms: readonly PasskeyAlgorithm[];
  /** The FIDO Metadata Service policy, or `null` when attestation isn't checked. */
  mds: ResolvedMds | null;
  /**
   * The credentialed CORS policy for the origins allowed to call the passkey endpoints from
   * another origin (`passkeys.corsOrigins`), or `null` (same-origin only).
   */
  cors: CorsPolicy | null;
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

/** The prefix of an Android app's WebAuthn origin (`clientDataJSON.origin` in a native app). */
const APK_KEY_HASH = "android:apk-key-hash:";

/**
 * Whether `origin` is a well-formed `android:apk-key-hash:` origin: the prefix, then exactly the
 * unpadded base64url of a 32-byte SHA-256 in its canonical spelling (re-encoding the decoded bytes
 * gives the same text back), so a near miss or a padded variant is never accepted.
 */
function isApkKeyHashOrigin(origin: string): boolean {
  if (!origin.startsWith(APK_KEY_HASH)) return false;
  const hash = origin.slice(APK_KEY_HASH.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(hash)) return false;
  const bytes = base64UrlDecode(hash);
  return bytes.length === 32 && base64UrlEncode(bytes) === hash;
}

/**
 * The WebAuthn origin an Android app signed with the certificate whose SHA-256 fingerprint is
 * `fingerprint` reports in `clientDataJSON.origin`: `android:apk-key-hash:` and the unpadded
 * base64url of the fingerprint's 32 bytes.
 *
 * @param fingerprint The fingerprint as `keytool -list -v` and the Play Console print it
 * (`AB:CD:…`, 32 colon-separated hex pairs) or as 64 hex digits; nothing else.
 * @returns The origin.
 * @throws {Error} When `fingerprint` is not one of those two spellings.
 */
export function apkKeyHashOrigin(fingerprint: string): string {
  const text = typeof fingerprint === "string" ? fingerprint.trim() : "";
  const colon = /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31}$/.test(text);
  if (!colon && !/^[0-9A-Fa-f]{64}$/.test(text)) {
    throw new Error(
      `denextAuth: ${JSON.stringify(fingerprint)} is not a SHA-256 certificate fingerprint ` +
        `("AB:CD:…", 32 hex pairs, or 64 hex digits).`,
    );
  }
  const hex = text.replaceAll(":", "");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return APK_KEY_HASH + base64UrlEncode(bytes);
}

/** The `android:apk-key-hash:` origins of `passkeys.androidApps`, validated (throws at config time). */
function androidAppOrigins(apps: readonly AuthPasskeyAndroidApp[] | undefined): string[] {
  if (apps === undefined) return [];
  if (!Array.isArray(apps)) {
    throw new Error(
      "denextAuth: `passkeys.androidApps` must be a list of { packageName, sha256CertFingerprints }.",
    );
  }
  return apps.flatMap((app, i) => {
    if (!isAndroidPackageName(app?.packageName)) {
      throw new Error(
        `denextAuth: \`passkeys.androidApps[${i}].packageName\` must be an application id ` +
          `(e.g. "com.example.app") — got ${JSON.stringify(app?.packageName)}.`,
      );
    }
    const fingerprints = app.sha256CertFingerprints;
    if (!Array.isArray(fingerprints) || fingerprints.length === 0) {
      throw new Error(
        `denextAuth: \`passkeys.androidApps[${i}].sha256CertFingerprints\` must list at least ` +
          "one SHA-256 signing-certificate fingerprint.",
      );
    }
    return fingerprints.map(apkKeyHashOrigin);
  });
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
  const listed = options.origins ?? (canonical ? [canonical] : []);
  const bad = listed.filter((o) =>
    o.startsWith(APK_KEY_HASH) ? !isApkKeyHashOrigin(o) : !originMatchesRpId(o, rpId)
  );
  if (listed.length === 0 || bad.length > 0) {
    throw new Error(
      `denextAuth: every \`passkeys.origins\` entry must be an https origin (http only on ` +
        `localhost) whose host is "${rpId}" or a subdomain of it, or an Android ` +
        `"${APK_KEY_HASH}<43 base64url characters>" origin — got ${JSON.stringify(listed)}.`,
    );
  }
  const origins = [...new Set([...listed, ...androidAppOrigins(options.androidApps)])];
  const timeout = options.timeout ?? 300;
  const cors = resolvePasskeyCors(options.corsOrigins, origins);
  return {
    rpId,
    rpName: options.rpName?.trim() || rpId,
    origins,
    requireUserVerification: options.userVerification !== "preferred",
    timeout: Number.isFinite(timeout) ? Math.min(900, Math.max(30, Math.floor(timeout))) : 300,
    algorithms: PASSKEY_ALGORITHMS,
    mds: resolveMds(options.attestation?.mds, options.attestation?.revocation),
    cors,
  };
}

/**
 * The credentialed CORS policy for `passkeys.corsOrigins`: each entry an exact web origin that
 * is also one of the ceremony `origins` (its page runs the ceremony, so `clientDataJSON.origin`
 * names it). Throws at config time otherwise.
 */
function resolvePasskeyCors(
  corsOrigins: readonly string[] | undefined,
  origins: readonly string[],
): CorsPolicy | null {
  if (!corsOrigins?.length) return null;
  const normalized = corsOrigins.map((o) => normalizeCorsOrigin(o));
  const bad = normalized.filter((o) =>
    !(o.startsWith("https://") || o.startsWith("http://")) || !origins.includes(o)
  );
  if (bad.length) {
    throw new Error(
      `denextAuth: every \`passkeys.corsOrigins\` entry must be a web origin also listed in ` +
        `\`passkeys.origins\` (where its page runs the ceremony) — got ${JSON.stringify(bad)}.`,
    );
  }
  return resolveCors({
    origins: normalized,
    credentials: true,
    methods: ["GET", "POST", "DELETE"],
    headers: ["content-type", "x-denext-auth"],
  });
}

/** A ceremony a challenge belongs to. */
export type PasskeyCeremony = "register" | "signin" | "mfa";

/** What a challenge record carries. */
export interface ChallengeData {
  /** The ceremony. */
  kind: PasskeyCeremony;
  /** The user it was issued to (`register`, `mfa`). */
  userId?: string;
  /** The SHA-256 (hex) of the ceremony id the options response handed out. */
  binding: string;
  /**
   * The `passkeys.corsOrigins` entry that started the ceremony, for one started cross-origin
   * (absent for a same-origin one): only a request from that origin, carrying a client data
   * `origin` equal to it, completes it.
   */
  origin?: string;
  /**
   * Started at `/native/passkey/*` (a native app, no cookie): only those rows complete it, and
   * they complete nothing else.
   */
  native?: true;
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
 * @throws {WebAuthnError} (`"malformed"`) When the id is empty or longer than the 64 bytes
 * WebAuthn allows — the passkey routes answer it as a refused ceremony, never a 500.
 */
export function userHandleOf(userId: string): string {
  const bytes = new TextEncoder().encode(userId);
  if (bytes.length === 0 || bytes.length > MAX_USER_HANDLE) {
    throw new WebAuthnError(
      "malformed",
      "passkeys: a user id must be 1–64 bytes to serve as a WebAuthn user handle",
    );
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
  await forgetPasskeyFactor(config, input.userId, input.id);
  return true;
}
