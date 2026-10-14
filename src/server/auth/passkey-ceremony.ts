/**
 * The WebAuthn ceremony steps denext's passkey endpoints (`{basePath}/passkey*`) and the
 * `/auth/v1` passkey and WebAuthn-factor endpoints share: the options handed to
 * `navigator.credentials.create()` / `.get()`, and the verification of what comes back (the
 * cryptography is {@link ./webauthn.ts}). How a ceremony's challenge is issued and bound to its
 * caller is each endpoint's own business; these steps take the challenge it expects.
 *
 * @module
 */

import type { PasskeyRecord } from "./adapter.ts";
import { checkMdsAttestation } from "./fido-mds.ts";
import { base64UrlDecode, base64UrlEncode } from "./oauth.ts";
import type { PasskeyAdapter, ResolvedPasskeys } from "./passkeys.ts";
import { userHandleOf } from "./passkeys.ts";
import {
  base64UrlField,
  hex,
  parseClientData,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
} from "./webauthn.ts";

/** A `PublicKeyCredential` JSON's id and response. */
export interface CredentialJson {
  /** The credential id (base64url). */
  id: string;
  /** The response object. */
  response: Record<string, unknown>;
}

/**
 * The `credential` of a body — `{ credential: {...} }`, or the credential itself — with
 * `id === rawId` and `type: "public-key"`.
 *
 * @param value The body field.
 * @returns Its id and response.
 * @throws {WebAuthnError} `malformed` for anything else.
 */
export function credentialOf(value: unknown): CredentialJson {
  const credential = value as Record<string, unknown> | undefined;
  const response = credential?.response as Record<string, unknown> | undefined;
  if (
    !credential || typeof credential !== "object" || credential.type !== "public-key" ||
    typeof credential.id !== "string" || credential.id !== credential.rawId ||
    !response || typeof response !== "object"
  ) {
    throw new WebAuthnError("malformed", "not a PublicKeyCredential JSON");
  }
  base64UrlField(credential.id, "credential.id");
  return { id: credential.id, response };
}

/**
 * The challenge a response's `clientDataJSON` signed over (unverified — the caller redeems it).
 *
 * @param credential The credential.
 * @returns The base64url challenge.
 */
export function challengeOf(credential: CredentialJson): string {
  return parseClientData(base64UrlField(credential.response.clientDataJSON, "clientDataJSON"))
    .challenge;
}

/** The transports a registration reported, kept only when they are short strings. */
function transportsOf(response: Record<string, unknown>): string[] | undefined {
  const list = response.transports;
  if (!Array.isArray(list)) return undefined;
  const clean = list.filter((t): t is string => typeof t === "string" && /^[a-z-]{1,32}$/.test(t));
  return clean.length > 0 ? clean.slice(0, 8) : undefined;
}

/**
 * A user-supplied passkey label, trimmed and capped.
 *
 * @param value The label.
 * @returns It, or `undefined`.
 */
export function labelOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, 64);
  return trimmed || undefined;
}

function descriptor(p: PasskeyRecord) {
  return { type: "public-key", id: p.id, ...(p.transports ? { transports: p.transports } : {}) };
}

/**
 * `PublicKeyCredentialCreationOptions` (JSON) for registering a passkey for `user`.
 *
 * @param rp The relying party.
 * @param user The user (id, email, name).
 * @param existing Their passkeys (excluded).
 * @param challenge The challenge.
 * @returns The options.
 */
export function creationOptions(
  rp: ResolvedPasskeys,
  user: { id: string; email?: string; name?: string },
  existing: PasskeyRecord[],
  challenge: string,
): Record<string, unknown> {
  return {
    rp: { id: rp.rpId, name: rp.rpName },
    user: {
      id: userHandleOf(user.id),
      name: user.email ?? user.id,
      displayName: user.name ?? user.email ?? user.id,
    },
    challenge,
    pubKeyCredParams: rp.algorithms.map((alg) => ({ type: "public-key", alg })),
    timeout: rp.timeout * 1000,
    excludeCredentials: existing.map(descriptor),
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: rp.requireUserVerification ? "required" : "preferred",
    },
    // The FIDO Metadata Service checks need the authenticator's certificate.
    attestation: rp.mds ? "direct" : "none",
  };
}

/**
 * `PublicKeyCredentialRequestOptions` (JSON) for an assertion.
 *
 * @param rp The relying party.
 * @param challenge The challenge.
 * @param allow The credentials allowed (`[]`: any discoverable one).
 * @returns The options.
 */
export function requestOptions(
  rp: ResolvedPasskeys,
  challenge: string,
  allow: PasskeyRecord[],
): Record<string, unknown> {
  return {
    challenge,
    rpId: rp.rpId,
    timeout: rp.timeout * 1000,
    userVerification: rp.requireUserVerification ? "required" : "preferred",
    allowCredentials: allow.map(descriptor),
  };
}

/**
 * Verify a registration response against the expected challenge and build the passkey record
 * (not stored).
 *
 * @param rp The relying party.
 * @param credential The credential.
 * @param challenge The challenge the ceremony issued.
 * @param userId The owner.
 * @param name A label.
 * @returns The record to store.
 * @throws {WebAuthnError} When it does not verify.
 */
export async function verifyNewPasskey(
  rp: ResolvedPasskeys,
  credential: CredentialJson,
  challenge: string,
  userId: string,
  name?: string,
): Promise<PasskeyRecord> {
  const { id, response } = credential;
  const clientDataJSON = base64UrlField(response.clientDataJSON, "clientDataJSON");
  const attestationObject = base64UrlField(response.attestationObject, "attestationObject");
  const result = await verifyRegistration(
    { clientDataJSON, attestationObject },
    {
      challenge,
      origins: rp.origins,
      rpId: rp.rpId,
      requireUserVerification: rp.requireUserVerification,
      algorithms: rp.algorithms,
      // Asking for "direct" attestation brings formats denext doesn't verify (`tpm`, …): with
      // unattested passkeys allowed, they register as unattested, held to the AAGUID's status.
      acceptUnverifiedFormats: rp.mds?.allowUnattested === true,
    },
  );
  if (rp.mds) await checkMdsAttestation(rp.mds, result);
  const credentialId = base64UrlEncode(result.credentialId);
  if (credentialId !== id) throw new WebAuthnError("malformed", "credential.id mismatch");
  const record: PasskeyRecord = {
    id: credentialId,
    userId,
    publicKey: base64UrlEncode(result.publicKey),
    alg: result.alg,
    signCount: result.signCount,
    backupEligible: result.backupEligible,
    backedUp: result.backedUp,
    aaguid: hex(result.aaguid),
    createdAt: Math.floor(Date.now() / 1000),
  };
  const transports = transportsOf(response);
  if (transports) record.transports = transports;
  if (name) record.name = name;
  return record;
}

/** A verified assertion. */
export interface VerifiedPasskeyAssertion {
  /** The passkey that signed (its counter already advanced). */
  record: PasskeyRecord;
  /** Whether the authenticator verified the user (PIN, biometric). */
  userVerified: boolean;
}

/**
 * Verify an assertion against the expected challenge, the stored credential and — when given —
 * its expected owner, then advance the signature counter by compare-and-swap.
 *
 * @param rp The relying party.
 * @param adapter The passkey adapter.
 * @param credential The credential.
 * @param challenge The challenge the ceremony issued.
 * @param expectedUserId The user the ceremony was for, if any.
 * @returns The record and whether the user was verified.
 * @throws {WebAuthnError} When it does not verify.
 */
export async function verifyPasskeyAssertion(
  rp: ResolvedPasskeys,
  adapter: PasskeyAdapter,
  credential: CredentialJson,
  challenge: string,
  expectedUserId: string | undefined,
): Promise<VerifiedPasskeyAssertion> {
  const { id, response } = credential;
  const record = await adapter.getPasskey(id);
  if (!record) throw new WebAuthnError("signature", "unknown credential");
  if (expectedUserId !== undefined && record.userId !== expectedUserId) {
    throw new WebAuthnError("signature", "the credential belongs to another user");
  }
  if (response.userHandle !== undefined && response.userHandle !== null) {
    if (response.userHandle !== userHandleOf(record.userId)) {
      throw new WebAuthnError("signature", "the user handle is not the credential's owner");
    }
  }
  const result = await verifyAuthentication(
    {
      clientDataJSON: base64UrlField(response.clientDataJSON, "clientDataJSON"),
      authenticatorData: base64UrlField(response.authenticatorData, "authenticatorData"),
      signature: base64UrlField(response.signature, "signature"),
    },
    {
      publicKey: base64UrlDecode(record.publicKey),
      signCount: record.signCount,
      backupEligible: record.backupEligible,
    },
    {
      challenge,
      origins: rp.origins,
      rpId: rp.rpId,
      requireUserVerification: rp.requireUserVerification,
    },
  );
  const lastUsedAt = Math.floor(Date.now() / 1000);
  const swapped = await adapter.updatePasskey(record.id, record.signCount, {
    signCount: result.signCount,
    backedUp: result.backedUp,
    lastUsedAt,
  });
  if (!swapped) throw new WebAuthnError("counter", "a concurrent assertion advanced the counter");
  return {
    record: { ...record, signCount: result.signCount, backedUp: result.backedUp, lastUsedAt },
    userVerified: result.userVerified,
  };
}
