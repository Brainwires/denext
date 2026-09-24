// Signing over-the-air UI manifests: ECDSA P-256 / SHA-256 over the canonical payload in
// src/mobile/ota-manifest.ts (`otaSignaturePayload`). `denext ota keygen` makes the key pair,
// `denext ota manifest --sign` (or DENEXT_OTA_SIGNING_KEY, also read by `denext export` with
// `spa.ota`) signs, and `denext mobile add-ota --public-key` embeds the public half in the app
// binary, where the native DenextOta plugin verifies it. WebCrypto only: no dependency.

import {
  type OtaManifest,
  otaManifestVersion,
  otaSignaturePayload,
} from "../mobile/ota-manifest.ts";

/** The env var holding the PEM *contents* of the signing key (for CI secrets). */
export const OTA_SIGNING_KEY_ENV = "DENEXT_OTA_SIGNING_KEY";

const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;

/** Standard, padded base64 of `bytes`. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The bytes of standard base64 `text`; throws on anything else. */
function fromBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error("not base64");
  }
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** `der` as a PEM block with `label`, wrapped at 64 columns. */
function toPem(label: string, der: Uint8Array): string {
  const lines = toBase64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** The DER inside a PEM block with `label`, or undefined when `text` holds no such block. */
function pemBody(text: string, label: string): Uint8Array | undefined {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`)
    .exec(text);
  return match ? fromBase64(match[1].replace(/\s+/g, "")) : undefined;
}

/** A new signing key pair: the PKCS#8 private key as PEM, the public key as base64 SPKI. */
export async function generateOtaKeyPair(): Promise<
  { privateKeyPem: string; publicKey: string }
> {
  const pair = await crypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { privateKeyPem: toPem("PRIVATE KEY", pkcs8), publicKey: toBase64(spki) };
}

/**
 * Import a `-----BEGIN PRIVATE KEY-----` (PKCS#8) P-256 key for signing.
 *
 * @throws When `pem` holds no PKCS#8 block or the key is not an ECDSA P-256 key.
 */
export async function importOtaSigningKey(pem: string): Promise<CryptoKey> {
  const der = pemBody(pem, "PRIVATE KEY");
  if (!der) throw new Error("the signing key is not a -----BEGIN PRIVATE KEY----- (PKCS#8) PEM");
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      der as BufferSource,
      KEY_ALGORITHM,
      false,
      ["sign"],
    );
  } catch {
    throw new Error("the signing key is not an ECDSA P-256 private key");
  }
}

/**
 * Normalise an OTA public key to one-line base64 SPKI, checking it is a P-256 key.
 *
 * @param text Base64 SPKI, or a `-----BEGIN PUBLIC KEY-----` PEM.
 * @throws When `text` is neither, or the key is not an ECDSA P-256 public key.
 */
export async function parseOtaPublicKey(text: string): Promise<string> {
  let der: Uint8Array | undefined;
  try {
    der = pemBody(text, "PUBLIC KEY") ?? fromBase64(text.trim());
  } catch {
    der = undefined;
  }
  if (der) {
    try {
      await crypto.subtle.importKey("spki", der as BufferSource, KEY_ALGORITHM, true, ["verify"]);
      return toBase64(der);
    } catch {
      // Falls through to the error below.
    }
  }
  throw new Error("the public key is not a base64 SPKI (or PUBLIC KEY PEM) ECDSA P-256 key");
}

/** `manifest` with its `signature` set (replacing any earlier one). */
export async function signOtaManifest(
  manifest: OtaManifest,
  key: CryptoKey,
): Promise<OtaManifest> {
  const payload = await otaSignaturePayload(manifest);
  const raw = await crypto.subtle.sign(SIGN_ALGORITHM, key, payload as BufferSource);
  return { ...manifest, signature: toBase64(new Uint8Array(raw)) };
}

/**
 * Verify `manifest` the way the native plugin does: the version must match the file list, and
 * the signature must verify over {@linkcode otaSignaturePayload} with `publicKey`.
 *
 * @param publicKey Base64 SPKI (as `denext ota keygen` writes to `<out>.pub`).
 */
export async function verifyOtaManifest(
  manifest: OtaManifest,
  publicKey: string,
): Promise<boolean> {
  if (typeof manifest.signature !== "string") return false;
  if (await otaManifestVersion(manifest.files) !== manifest.version) return false;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      fromBase64(await parseOtaPublicKey(publicKey)) as BufferSource,
      KEY_ALGORITHM,
      false,
      ["verify"],
    );
    const signature = fromBase64(manifest.signature);
    const payload = await otaSignaturePayload(manifest);
    return await crypto.subtle.verify(
      SIGN_ALGORITHM,
      key,
      signature as BufferSource,
      payload as BufferSource,
    );
  } catch {
    return false;
  }
}

/**
 * The signing key from `keyFile` (a PEM file path) or, without one, from
 * {@linkcode OTA_SIGNING_KEY_ENV}; undefined when neither is set.
 *
 * @throws When the file cannot be read or a key does not parse.
 */
export async function loadOtaSigningKey(keyFile?: string): Promise<CryptoKey | undefined> {
  if (keyFile !== undefined) return await importOtaSigningKey(await Deno.readTextFile(keyFile));
  let pem: string | undefined;
  try {
    pem = Deno.env.get(OTA_SIGNING_KEY_ENV);
  } catch {
    pem = undefined; // No env permission: nothing to sign with.
  }
  if (!pem?.trim()) return undefined;
  try {
    return await importOtaSigningKey(pem);
  } catch (err) {
    throw new Error(`${OTA_SIGNING_KEY_ENV}: ${err instanceof Error ? err.message : err}`);
  }
}
