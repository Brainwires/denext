/**
 * The SP's own RSA keys: a PKCS #8 PEM or an RSA private JWK, imported once per use
 * (RSASSA-PKCS1-v1_5 / SHA-256 to sign, RSA-OAEP with SHA-1 or SHA-256 to unwrap a content
 * key), and checked against the certificate published for it.
 *
 * @module
 */

import type { SamlPrivateKey } from "./config.ts";
import { SamlError } from "./errors.ts";
import { certificateKey, decodeBase64 } from "./x509.ts";

function badKey(message: string): never {
  throw new SamlError("bad_key", message);
}

/** The PKCS #8 DER of a `PRIVATE KEY` PEM block. */
function pkcs8Der(pem: string): Uint8Array<ArrayBuffer> {
  const m = /^-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----$/.exec(pem.trim());
  if (!m) {
    badKey(
      "an SP key must be a PKCS #8 PEM (-----BEGIN PRIVATE KEY-----) or a JWK; convert a PKCS #1 " +
        "key with `openssl pkcs8 -topk8 -nocrypt`",
    );
  }
  const der = decodeBase64(m[1]);
  if (!der || !der.byteLength) badKey("the SP key PEM is not valid base64");
  return der;
}

type Usage = "sign" | "decrypt";
type OaepHash = "SHA-1" | "SHA-256";

const imported = new Map<string, Promise<CryptoKey>>();
const jwkIds = new WeakMap<object, string>();

/** A stable cache key for one key input. */
function keyId(key: SamlPrivateKey): string {
  if (typeof key === "string") return `pem:${key}`;
  let id = jwkIds.get(key);
  if (!id) {
    id = `jwk:${crypto.randomUUID()}`;
    jwkIds.set(key, id);
  }
  return id;
}

async function importKey(
  key: SamlPrivateKey,
  usage: Usage,
  hash: OaepHash | "SHA-256",
  extractable: boolean,
): Promise<CryptoKey> {
  const algorithm = usage === "sign"
    ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
    : { name: "RSA-OAEP", hash };
  try {
    if (typeof key === "string") {
      return await crypto.subtle.importKey("pkcs8", pkcs8Der(key), algorithm, extractable, [
        usage,
      ]);
    }
    if (key.kty !== "RSA" || typeof key.d !== "string") {
      badKey("an SP JWK must be an RSA private key");
    }
    const { alg: _alg, key_ops: _ops, use: _use, ...bare } = key;
    return await crypto.subtle.importKey("jwk", bare, algorithm, extractable, [usage]);
  } catch (error) {
    if (error instanceof SamlError) throw error;
    return badKey("the SP key cannot be imported as an RSA private key");
  }
}

/**
 * The SP key imported for `usage` (memoized per key and algorithm).
 *
 * @param key The configured key.
 * @param usage `sign` (RSA-SHA256) or `decrypt` (RSA-OAEP).
 * @param hash The RSA-OAEP digest, for `decrypt`.
 * @throws {SamlError} `bad_key`.
 */
export function spPrivateKey(
  key: SamlPrivateKey,
  usage: Usage,
  hash: OaepHash = "SHA-1",
): Promise<CryptoKey> {
  const id = `${keyId(key)}|${usage}|${usage === "sign" ? "" : hash}`;
  let found = imported.get(id);
  if (!found) {
    found = importKey(key, usage, usage === "sign" ? "SHA-256" : hash, false);
    found.catch(() => imported.delete(id));
    imported.set(id, found);
  }
  return found;
}

/** The modulus (base64url) of the public half of an SP key. */
async function modulusOf(key: SamlPrivateKey): Promise<string> {
  if (typeof key !== "string") {
    if (typeof key.n !== "string") badKey("the SP JWK has no modulus");
    return key.n;
  }
  const jwk = await crypto.subtle.exportKey("jwk", await importKey(key, "sign", "SHA-256", true));
  return jwk.n!;
}

/** The modulus (base64url) of a certificate's RSA key. */
async function certificateModulus(certificate: string): Promise<string> {
  const pub = certificateKey(certificate);
  if (pub.kind !== "RSA") badKey("an SP certificate must hold an RSA key");
  const key = await crypto.subtle.importKey(
    "spki",
    pub.spki,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"],
  );
  return (await crypto.subtle.exportKey("jwk", key)).n!;
}

const pairs = new Map<string, Promise<void>>();

/**
 * Check, once per pair, that `certificate` publishes the public half of `key` — a mismatch
 * would make every IdP refuse (or be unable to encrypt to) this SP.
 *
 * @param key The SP private key.
 * @param certificate Its certificate (PEM or bare base64 DER).
 * @throws {SamlError} `bad_key` / `bad_certificate`.
 */
export function checkKeyPair(key: SamlPrivateKey, certificate: string): Promise<void> {
  const id = `${keyId(key)}|${certificate}`;
  let found = pairs.get(id);
  if (!found) {
    found = (async () => {
      const [a, b] = await Promise.all([modulusOf(key), certificateModulus(certificate)]);
      if (a !== b) badKey("the SP certificate does not match its private key");
    })();
    found.catch(() => pairs.delete(id));
    pairs.set(id, found);
  }
  return found;
}

/** The bare base64 DER body of a certificate given as PEM or bare base64. */
export function certificateBody(certificate: string): string {
  certificateKey(certificate); // refuse what cannot be parsed
  return certificate.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
}
