/**
 * XML Encryption for a SAML `EncryptedAssertion`, restricted to what SAML IdPs use.
 *
 * Allowed: key transport RSA-OAEP (`xmlenc#rsa-oaep-mgf1p` — SHA-1; `xmlenc11#rsa-oaep` — SHA-1
 * or SHA-256, its MGF1 digest equal to the OAEP digest, no OAEPparams); content AES-128/256-GCM
 * (`xmlenc11#aes*-gcm`) and AES-128/256-CBC (`xmlenc#aes*-cbc`). Exactly one EncryptedKey (in
 * the EncryptedData's KeyInfo, or a sibling of it inside the EncryptedAssertion); the cipher
 * text inline (`CipherValue`, never a `CipherReference`). Everything else is refused before any
 * key is touched.
 *
 * Decryption yields bytes only: the caller parses them with the strict parser and verifies them
 * exactly like a plaintext Assertion. Encryption is not integrity — anyone holding the SP's
 * public certificate can encrypt — so a decrypted Assertion is trusted only through a signature
 * (the Response's, verified BEFORE decrypting, or the Assertion's own).
 *
 * @module
 */

import { DS_NS } from "./dsig.ts";
import type { SamlPrivateKey } from "./config.ts";
import { SamlError } from "./errors.ts";
import { spPrivateKey } from "./keys.ts";
import { attr, elementOnlyChildren, type XmlElement } from "./xml.ts";
import { decodeBase64 } from "./x509.ts";

/** The XML Encryption 1.0 namespace. */
const XENC_NS = "http://www.w3.org/2001/04/xmlenc#";
/** The XML Encryption 1.1 namespace. */
const XENC11_NS = "http://www.w3.org/2009/xmlenc11#";
const ELEMENT_TYPE = `${XENC_NS}Element`;
const SHA1 = "http://www.w3.org/2000/09/xmldsig#sha1";
const SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";

interface ContentAlgorithm {
  name: "AES-GCM" | "AES-CBC";
  /** Key length, bytes. */
  length: 16 | 32;
}

const CONTENT_ALGORITHMS: Record<string, ContentAlgorithm> = {
  [`${XENC11_NS}aes128-gcm`]: { name: "AES-GCM", length: 16 },
  [`${XENC11_NS}aes256-gcm`]: { name: "AES-GCM", length: 32 },
  [`${XENC_NS}aes128-cbc`]: { name: "AES-CBC", length: 16 },
  [`${XENC_NS}aes256-cbc`]: { name: "AES-CBC", length: 32 },
};

const OAEP_DIGESTS: Record<string, "SHA-1" | "SHA-256"> = { [SHA1]: "SHA-1", [SHA256]: "SHA-256" };
const MGF_DIGESTS: Record<string, "SHA-1" | "SHA-256"> = {
  [`${XENC11_NS}mgf1sha1`]: "SHA-1",
  [`${XENC11_NS}mgf1sha256`]: "SHA-256",
};

/** An EncryptedAssertion, read and checked — nothing decrypted yet. */
export interface EncryptedParts {
  /** The content algorithm. */
  content: ContentAlgorithm;
  /** IV + cipher text (+ tag) of the Assertion. */
  cipherText: Uint8Array<ArrayBuffer>;
  /** The RSA-OAEP digest the content key was wrapped with. */
  oaepHash: "SHA-1" | "SHA-256";
  /** The wrapped content key. */
  wrappedKey: Uint8Array<ArrayBuffer>;
}

function malformed(message: string): never {
  throw new SamlError("malformed_response", message);
}

function unsupported(message: string): never {
  throw new SamlError("unsupported_algorithm", message);
}

const isXenc = (el: XmlElement, local: string) => el.ns === XENC_NS && el.local === local;

/** Element children, refusing non-whitespace text (element-only content). */
function elementsOf(el: XmlElement): XmlElement[] {
  return elementOnlyChildren(el, malformed);
}

/** The inline cipher text of a CipherData element (exactly one CipherValue). */
function cipherValue(parent: XmlElement): Uint8Array<ArrayBuffer> {
  const data = elementsOf(parent).filter((c) => isXenc(c, "CipherData"));
  if (data.length !== 1) malformed(`<${parent.local}> must hold one CipherData`);
  const [value, ...rest] = elementsOf(data[0]);
  if (value && isXenc(value, "CipherReference")) unsupported("CipherReference is not allowed");
  if (!value || !isXenc(value, "CipherValue") || rest.length) {
    malformed("CipherData must hold one CipherValue");
  }
  let text = "";
  for (const c of value.children) {
    if (c.type !== "text") malformed("markup inside CipherValue");
    text += c.value;
  }
  const bytes = decodeBase64(text);
  if (!bytes || !bytes.byteLength) malformed("CipherValue is not base64");
  return bytes;
}

/** The EncryptionMethod child of `el` (exactly one). */
function encryptionMethod(el: XmlElement): XmlElement {
  const methods = elementsOf(el).filter((c) => isXenc(c, "EncryptionMethod"));
  if (methods.length !== 1) malformed(`<${el.local}> must hold one EncryptionMethod`);
  return methods[0];
}

/** The digest of an RSA-OAEP method's DigestMethod child (SHA-1 when absent). */
function oaepDigest(params: XmlElement[]): "SHA-1" | "SHA-256" {
  const digests = params.filter((p) => p.ns === DS_NS && p.local === "DigestMethod");
  if (digests.length > 1) malformed("more than one DigestMethod");
  if (!digests.length) return "SHA-1";
  const alg = attr(digests[0], "Algorithm") ?? "";
  if (!Object.hasOwn(OAEP_DIGESTS, alg) || elementsOf(digests[0]).length) {
    unsupported(`OAEP digest ${alg || "(none)"} is not allowed`);
  }
  return OAEP_DIGESTS[alg];
}

/** The MGF1 digest of an `xmlenc11#rsa-oaep` method (SHA-1 when absent). */
function mgfDigest(params: XmlElement[]): "SHA-1" | "SHA-256" {
  const mgfs = params.filter((p) => p.ns === XENC11_NS && p.local === "MGF");
  if (mgfs.length > 1) malformed("more than one MGF");
  if (!mgfs.length) return "SHA-1";
  const alg = attr(mgfs[0], "Algorithm") ?? "";
  if (!Object.hasOwn(MGF_DIGESTS, alg) || elementsOf(mgfs[0]).length) {
    unsupported(`MGF ${alg || "(none)"} is not allowed`);
  }
  return MGF_DIGESTS[alg];
}

/** The RSA-OAEP digest of an EncryptedKey's EncryptionMethod; anything else is refused. */
function keyTransport(method: XmlElement): "SHA-1" | "SHA-256" {
  const alg = attr(method, "Algorithm") ?? "";
  const params = elementsOf(method);
  const known = (p: XmlElement) =>
    (p.ns === DS_NS && p.local === "DigestMethod") || (p.ns === XENC11_NS && p.local === "MGF");
  const stray = params.find((p) => !known(p));
  if (stray) unsupported(`<${stray.qname}> is not allowed on the key transport`);
  const digest = oaepDigest(params);
  if (alg === `${XENC_NS}rsa-oaep-mgf1p`) {
    if (params.some((p) => p.local === "MGF")) unsupported("rsa-oaep-mgf1p takes no MGF");
    if (digest !== "SHA-1") unsupported("rsa-oaep-mgf1p is SHA-1 only");
    return digest;
  }
  if (alg === `${XENC11_NS}rsa-oaep`) {
    if (mgfDigest(params) !== digest) {
      unsupported("an MGF1 digest other than the OAEP digest is not supported");
    }
    return digest;
  }
  return unsupported(`key transport ${alg || "(none)"} is not allowed`);
}

/** The children an EncryptedData / EncryptedKey may hold (XML Encryption's content model). */
const DATA_CHILDREN = ["EncryptionMethod", "CipherData", "EncryptionProperties"];
const KEY_CHILDREN = [...DATA_CHILDREN, "ReferenceList", "CarriedKeyName"];

/** Refuse a child outside the content model (an EncryptedKey hidden in EncryptedData, …). */
function checkChildren(el: XmlElement, allowed: string[]): void {
  for (const c of elementsOf(el)) {
    const ok = (c.ns === XENC_NS && allowed.includes(c.local)) ||
      (c.ns === DS_NS && c.local === "KeyInfo");
    if (!ok) malformed(`unexpected <${c.qname}> in <${el.local}>`);
  }
}

/** The one EncryptedKey: inside the EncryptedData's KeyInfo, or a sibling of the EncryptedData. */
function encryptedKey(container: XmlElement, data: XmlElement): XmlElement {
  const keyInfos = elementsOf(data).filter((c) => c.ns === DS_NS && c.local === "KeyInfo");
  if (keyInfos.length > 1) malformed("EncryptedData holds more than one KeyInfo");
  const inside = keyInfos.flatMap((k) => elementsOf(k)).filter((c) => isXenc(c, "EncryptedKey"));
  const siblings = elementsOf(container).filter((c) => isXenc(c, "EncryptedKey"));
  const keys = [...inside, ...siblings];
  if (keys.length !== 1) malformed(`expected one EncryptedKey, found ${keys.length}`);
  checkChildren(keys[0], KEY_CHILDREN);
  return keys[0];
}

/**
 * Read an EncryptedAssertion's structure and algorithms. Pure parsing: no key is used, so
 * its refusals depend only on the (attacker-visible) markup.
 *
 * @param container The `saml:EncryptedAssertion` element.
 * @throws {SamlError} `malformed_response` or `unsupported_algorithm`.
 */
export function readEncryptedAssertion(container: XmlElement): EncryptedParts {
  const children = elementsOf(container);
  const data = children.filter((c) => isXenc(c, "EncryptedData"));
  const stray = children.find((c) => !isXenc(c, "EncryptedData") && !isXenc(c, "EncryptedKey"));
  if (data.length !== 1 || stray) malformed("EncryptedAssertion must hold one EncryptedData");
  checkChildren(data[0], DATA_CHILDREN);
  const type = attr(data[0], "Type");
  if (type !== undefined && type !== ELEMENT_TYPE) unsupported(`EncryptedData Type ${type}`);
  const methodEl = encryptionMethod(data[0]);
  const alg = attr(methodEl, "Algorithm") ?? "";
  if (!Object.hasOwn(CONTENT_ALGORITHMS, alg) || elementsOf(methodEl).length) {
    unsupported(`content encryption ${alg || "(none)"} is not allowed`);
  }
  const key = encryptedKey(container, data[0]);
  return {
    content: CONTENT_ALGORITHMS[alg],
    cipherText: cipherValue(data[0]),
    oaepHash: keyTransport(encryptionMethod(key)),
    wrappedKey: cipherValue(key),
  };
}

function failed(): never {
  throw new SamlError("decryption_failed", "the encrypted assertion could not be decrypted");
}

/**
 * Raw AES-CBC decryption (no padding check) with WebCrypto, which only offers PKCS #7: a final
 * block is appended that decrypts to a full PKCS #7 padding block (the encryption of an empty
 * message with the last cipher block as IV), so WebCrypto strips exactly that block and every
 * original byte — XML Encryption's own padding included — comes back untouched.
 */
async function aesCbcRaw(
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  body: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  const last = body.slice(body.length - 16);
  const filler = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CBC", iv: last }, key, new Uint8Array(0)),
  );
  const joined = new Uint8Array(body.length + 16);
  joined.set(body);
  joined.set(filler, body.length);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, joined));
}

/**
 * Strip XML Encryption padding (the last byte counts the padding bytes, 1–16; the others are
 * arbitrary) without branching on the padding's validity: an invalid length strips one block
 * and is reported through the returned flag, checked by the caller after the same work.
 */
function stripPadding(raw: Uint8Array): { plain: Uint8Array; ok: number } {
  const n = raw[raw.length - 1];
  // ok = 1 when 1 <= n <= 16, computed without a data-dependent branch.
  const ok = 1 ^ (((n - 1) >>> 31) | ((16 - n) >>> 31));
  const mask = -ok;
  const cut = (n & mask) | (16 & ~mask);
  return { plain: raw.subarray(0, raw.length - cut), ok };
}

async function decryptContent(
  parts: EncryptedParts,
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  const { content, cipherText } = parts;
  if (keyBytes.byteLength !== content.length) failed();
  const usages: KeyUsage[] = content.name === "AES-CBC" ? ["encrypt", "decrypt"] : ["decrypt"];
  const key = await crypto.subtle.importKey("raw", keyBytes, content.name, false, usages);
  if (content.name === "AES-GCM") {
    if (cipherText.byteLength < 12 + 16) failed();
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: cipherText.subarray(0, 12), tagLength: 128 },
        key,
        cipherText.subarray(12),
      ),
    );
  }
  if (cipherText.byteLength < 32 || cipherText.byteLength % 16) failed();
  const raw = await aesCbcRaw(key, cipherText.subarray(0, 16), cipherText.subarray(16));
  const { plain, ok } = stripPadding(raw);
  if (!ok) failed();
  return plain;
}

/**
 * Decrypt an EncryptedAssertion's content with the SP key. Every failure — the key unwrap, the
 * content key length, a GCM tag, CBC padding — is the one `decryption_failed`.
 *
 * @param parts From {@link readEncryptedAssertion}.
 * @param key The SP decryption key.
 * @returns The decrypted bytes (the serialized Assertion element).
 * @throws {SamlError} `decryption_failed` (or `bad_key` for an unusable configured key).
 */
export async function decryptAssertion(
  parts: EncryptedParts,
  key: SamlPrivateKey,
): Promise<Uint8Array> {
  const rsa = await spPrivateKey(key, "decrypt", parts.oaepHash);
  try {
    const contentKey = new Uint8Array(
      await crypto.subtle.decrypt({ name: "RSA-OAEP" }, rsa, parts.wrappedKey),
    );
    return await decryptContent(parts, contentKey);
  } catch {
    return failed();
  }
}
