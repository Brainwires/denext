/**
 * XML-DSig verification of an enveloped signature, restricted to the profile SAML uses.
 *
 * Allowed: exclusive c14n (with or without comments) for SignedInfo; RSA-SHA256,
 * RSA-SHA512 and ECDSA-SHA256 signatures; exactly one Reference whose URI is `#` + the ID
 * of the element the Signature is a direct child of; the transforms enveloped-signature
 * then exclusive c14n; SHA-256 / SHA-512 digests. Everything else is refused. The key
 * comes only from the configured certificates — a KeyInfo in the message is ignored.
 *
 * @module
 */

import { excC14n } from "./c14n.ts";
import { SamlError } from "./errors.ts";
import { attr, childElements, isNcName, type XmlDocument, type XmlElement } from "./xml.ts";
import { type CertificateKey, certificateKey, decodeBase64 } from "./x509.ts";

/** The XML-DSig namespace. */
export const DS_NS = "http://www.w3.org/2000/09/xmldsig#";
const EXC_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const EXC_C14N_COMMENTS = "http://www.w3.org/2001/10/xml-exc-c14n#WithComments";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

interface SignatureAlgorithm {
  kind: CertificateKey["kind"];
  hash: "SHA-256" | "SHA-512";
}

const SIGNATURE_ALGORITHMS: Record<string, SignatureAlgorithm> = {
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256": { kind: "RSA", hash: "SHA-256" },
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512": { kind: "RSA", hash: "SHA-512" },
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256": { kind: "EC", hash: "SHA-256" },
};

const DIGEST_ALGORITHMS: Record<string, "SHA-256" | "SHA-512"> = {
  "http://www.w3.org/2001/04/xmlenc#sha256": "SHA-256",
  "http://www.w3.org/2001/04/xmlenc#sha512": "SHA-512",
};

/** Unqualified attribute names treated as IDs when hunting for duplicates. */
const ID_ATTRIBUTES = ["ID", "Id", "id"];

function badSignature(message: string): never {
  throw new SamlError("bad_signature", message);
}

function unsupported(message: string): never {
  throw new SamlError("unsupported_algorithm", message);
}

function wrapping(message: string): never {
  throw new SamlError("signature_wrapping", message);
}

/**
 * Map every ID-like attribute value in the document to the elements carrying it, refusing a
 * document where any value appears twice (an ID must identify one element, or a Reference
 * could be steered to a decoy).
 */
export function indexIds(doc: XmlDocument): Map<string, XmlElement> {
  const ids = new Map<string, XmlElement>();
  for (const el of doc.elements) {
    for (const a of el.attrs) {
      if (a.ns !== "" || !ID_ATTRIBUTES.includes(a.local)) continue;
      if (ids.has(a.value)) wrapping(`duplicate ID "${a.value}"`);
      ids.set(a.value, el);
    }
  }
  return ids;
}

/**
 * The element children of `el`, refusing any non-whitespace text between them (a dsig
 * structure element has element-only content).
 */
function structure(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) {
    if (c.type === "element") out.push(c);
    else if (c.type === "text" && c.value.trim()) badSignature(`text inside <${el.qname}>`);
  }
  return out;
}

function isDs(el: XmlElement | undefined, local: string): el is XmlElement {
  return el !== undefined && el.ns === DS_NS && el.local === local;
}

/** The text of a leaf element, refusing comments or child elements inside it. */
function leafText(el: XmlElement): string {
  let text = "";
  for (const c of el.children) {
    if (c.type !== "text") badSignature(`unexpected markup inside <${el.qname}>`);
    text += c.value;
  }
  return text;
}

/**
 * The single ds:Signature that is a direct child of `el`, or `undefined` when there is none.
 *
 * @throws {SamlError} `signature_wrapping` when `el` has more than one.
 */
export function directSignature(el: XmlElement): XmlElement | undefined {
  const sigs = childElements(el, DS_NS, "Signature");
  if (sigs.length > 1) wrapping(`<${el.qname}> carries ${sigs.length} signatures`);
  return sigs[0];
}

interface C14nMethod {
  withComments: boolean;
  inclusivePrefixes: string[];
}

/** Read an exclusive-c14n method element (CanonicalizationMethod or Transform). */
function c14nMethod(el: XmlElement): C14nMethod {
  const alg = attr(el, "Algorithm");
  if (alg !== EXC_C14N && alg !== EXC_C14N_COMMENTS) {
    unsupported(`canonicalization ${alg ?? "(none)"} is not allowed`);
  }
  const kids = structure(el);
  let inclusivePrefixes: string[] = [];
  if (kids.length) {
    const [inc] = kids;
    if (kids.length > 1 || inc.ns !== EXC_C14N || inc.local !== "InclusiveNamespaces") {
      unsupported(`unexpected parameters on ${alg}`);
    }
    inclusivePrefixes = (attr(inc, "PrefixList") ?? "").split(/[ \t\n]+/).filter(Boolean);
  }
  return { withComments: alg === EXC_C14N_COMMENTS, inclusivePrefixes };
}

/** The transforms of a Reference: exactly enveloped-signature, then exclusive c14n. */
function referenceTransforms(transforms: XmlElement | undefined): C14nMethod {
  if (!isDs(transforms, "Transforms")) badSignature("Reference is missing Transforms");
  const list = structure(transforms);
  for (const t of list) if (!isDs(t, "Transform")) badSignature("unexpected Transforms child");
  const algs = list.map((t) => attr(t, "Algorithm"));
  if (list.length !== 2 || algs[0] !== ENVELOPED) {
    unsupported(`transforms ${algs.join(", ")} are not allowed`);
  }
  if (structure(list[0]).length) unsupported("enveloped-signature takes no parameters");
  return c14nMethod(list[1]);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const encoder = new TextEncoder();

async function verifyWithCertificates(
  algorithm: SignatureAlgorithm,
  data: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer>,
  certificates: readonly string[],
): Promise<boolean> {
  for (const cert of certificates) {
    const key = certificateKey(cert);
    if (key.kind !== algorithm.kind) continue;
    const params = key.kind === "RSA"
      ? { name: "RSASSA-PKCS1-v1_5", hash: algorithm.hash }
      : { name: "ECDSA", namedCurve: key.namedCurve! };
    let cryptoKey: CryptoKey;
    try {
      cryptoKey = await crypto.subtle.importKey("spki", key.spki, params, false, ["verify"]);
    } catch {
      throw new SamlError("bad_certificate", "a configured certificate's key cannot be imported");
    }
    const verifyParams = key.kind === "RSA"
      ? { name: "RSASSA-PKCS1-v1_5" }
      : { name: "ECDSA", hash: algorithm.hash };
    if (await crypto.subtle.verify(verifyParams, cryptoKey, signature, data)) return true;
  }
  return false;
}

/** The allow-listed value for `el`'s Algorithm; unknown algorithms and parameters are refused. */
function allowed<T>(table: Record<string, T>, el: XmlElement, what: string): T {
  const alg = attr(el, "Algorithm") ?? "";
  if (!Object.hasOwn(table, alg)) unsupported(`${what} ${alg || "(none)"} is not allowed`);
  if (structure(el).length) unsupported(`${what} parameters are not allowed`);
  return table[alg];
}

/** Signature = SignedInfo, SignatureValue, then only KeyInfo / Object. */
function signatureParts(signature: XmlElement): [XmlElement, XmlElement] {
  const [signedInfo, signatureValue, ...rest] = structure(signature);
  if (!isDs(signedInfo, "SignedInfo") || !isDs(signatureValue, "SignatureValue")) {
    badSignature("Signature must start with SignedInfo and SignatureValue");
  }
  const stray = rest.find((r) => r.ns !== DS_NS || (r.local !== "KeyInfo" && r.local !== "Object"));
  if (stray) badSignature(`unexpected <${stray.qname}> in Signature`);
  return [signedInfo, signatureValue];
}

interface SignedInfoParts {
  canonicalization: C14nMethod;
  algorithm: SignatureAlgorithm;
  reference: XmlElement;
}

/** SignedInfo = CanonicalizationMethod, SignatureMethod, exactly one Reference. */
function signedInfoParts(signedInfo: XmlElement): SignedInfoParts {
  const [canon, method, ...references] = structure(signedInfo);
  if (!isDs(canon, "CanonicalizationMethod") || !isDs(method, "SignatureMethod")) {
    badSignature("SignedInfo must start with CanonicalizationMethod and SignatureMethod");
  }
  const algorithm = allowed(SIGNATURE_ALGORITHMS, method, "signature method");
  const [reference] = references;
  if (references.length !== 1 || !isDs(reference, "Reference")) {
    badSignature("SignedInfo must hold exactly one Reference");
  }
  return { canonicalization: c14nMethod(canon), algorithm, reference };
}

/** The Reference must name the signature's parent by its ID, and that ID must be unique. */
function checkReferenceTarget(
  ids: Map<string, XmlElement>,
  signed: XmlElement,
  reference: XmlElement,
): void {
  const uri = attr(reference, "URI");
  const id = attr(signed, "ID");
  if (!id || !isNcName(id) || uri !== `#${id}`) {
    wrapping(`Reference URI ${JSON.stringify(uri ?? null)} does not name the signed element`);
  }
  if (ids.get(id) !== signed) wrapping(`ID "${id}" does not resolve to the signed element`);
}

interface ReferenceParts {
  canonicalization: C14nMethod;
  hash: "SHA-256" | "SHA-512";
  digest: Uint8Array;
}

/** Reference = Transforms, DigestMethod, DigestValue. */
function referenceParts(reference: XmlElement): ReferenceParts {
  const [transforms, digestMethod, digestValue, ...extra] = structure(reference);
  if (!isDs(digestMethod, "DigestMethod") || !isDs(digestValue, "DigestValue") || extra.length) {
    badSignature("Reference must hold Transforms, DigestMethod and DigestValue");
  }
  const canonicalization = referenceTransforms(transforms);
  const hash = allowed(DIGEST_ALGORITHMS, digestMethod, "digest method");
  const digest = decodeBase64(leafText(digestValue));
  if (!digest) badSignature("DigestValue is not base64");
  return { canonicalization, hash, digest };
}

/**
 * Verify the enveloped `signature` (a direct ds:Signature child of `signed`) over `signed`.
 * On success the caller may trust `signed` — that exact element object — and nothing else.
 *
 * @param ids The document's ID index from {@link indexIds}.
 * @param signed The element the signature claims to cover (its parent).
 * @param signature The ds:Signature element.
 * @param certificates The IdP's configured signing certificates.
 * @throws {SamlError} `bad_signature`, `signature_wrapping`, `unsupported_algorithm` or
 *   `bad_certificate`.
 */
export async function verifyEnvelopedSignature(
  ids: Map<string, XmlElement>,
  signed: XmlElement,
  signature: XmlElement,
  certificates: readonly string[],
): Promise<void> {
  if (signature.parent !== signed) wrapping("the signature is not a child of the signed element");
  const [signedInfo, signatureValue] = signatureParts(signature);
  const { canonicalization, algorithm, reference } = signedInfoParts(signedInfo);
  checkReferenceTarget(ids, signed, reference);
  const ref = referenceParts(reference);

  // A same-document "#id" reference drops comments whatever the c14n variant (XML-DSig
  // §4.3.3.3), so the digest never covers comment nodes.
  const content = excC14n(signed, {
    withComments: false,
    inclusivePrefixes: ref.canonicalization.inclusivePrefixes,
    exclude: signature,
  });
  const actual = new Uint8Array(await crypto.subtle.digest(ref.hash, encoder.encode(content)));
  if (!timingSafeEqual(actual, ref.digest)) badSignature("digest mismatch");

  const signatureBytes = decodeBase64(leafText(signatureValue));
  if (!signatureBytes) badSignature("SignatureValue is not base64");
  const data = encoder.encode(excC14n(signedInfo, canonicalization));
  if (!(await verifyWithCertificates(algorithm, data, signatureBytes, certificates))) {
    badSignature("signature does not verify with any configured certificate");
  }
}
