// Test helpers for the SAML SP suites: throwaway IdP keys with minimal self-signed X.509
// certificates (built here in DER), a SAML Response template, and an enveloped XML-DSig
// signer. The signer reuses denext's own exclusive c14n, so it only produces fixtures for
// mutation cases; the golden fixtures in tests/fixtures/saml/ come from xmlsec1.

import { excC14n } from "../src/server/auth/saml/c14n.ts";
import { parseXml, type XmlElement } from "../src/server/auth/saml/xml.ts";

export const SP = {
  entityId: "https://sp.example.com/auth/v1/sso/saml/metadata",
  acsUrl: "https://sp.example.com/auth/v1/sso/saml/acs",
};
export const IDP_ENTITY = "https://idp.example.org/metadata";
/** 2026-10-13T12:00:00Z — every template timestamp is relative to this. */
export const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
/** A verification clock one minute after T0 (inside every template window). */
export const NOW = T0 + 60_000;

export const ALG = {
  rsaSha256: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  rsaSha512: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
  rsaSha1: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
  ecdsaSha256: "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256",
  sha256: "http://www.w3.org/2001/04/xmlenc#sha256",
  sha512: "http://www.w3.org/2001/04/xmlenc#sha512",
  sha1: "http://www.w3.org/2000/09/xmldsig#sha1",
  excC14n: "http://www.w3.org/2001/10/xml-exc-c14n#",
  excC14nComments: "http://www.w3.org/2001/10/xml-exc-c14n#WithComments",
  enveloped: "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
};

// --- minimal DER ---------------------------------------------------------------------------

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

export function der(tag: number, ...parts: (Uint8Array | number[])[]): Uint8Array {
  const body = parts.flatMap((p) => Array.from(p));
  return new Uint8Array([tag, ...derLength(body.length), ...body]);
}

function oidBytes(oid: string): number[] {
  const [a, b, ...rest] = oid.split(".").map(Number);
  const out = [a * 40 + b];
  for (const n of rest) {
    const chunk: number[] = [];
    let v = n;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    out.push(...chunk);
  }
  return out;
}

export const derOid = (oid: string): Uint8Array => der(0x06, oidBytes(oid));
const derUtf8 = (s: string) => der(0x0c, new TextEncoder().encode(s));
const derTime = (s: string) => der(0x17, new TextEncoder().encode(s));

/** A minimal v3 X.509 certificate around `spki` (its signature is filler: SAML pins keys). */
export function certificateFor(spki: Uint8Array, cn = "test IdP"): string {
  const name = der(0x30, der(0x31, der(0x30, derOid("2.5.4.3"), derUtf8(cn))));
  const algId = der(0x30, derOid("1.2.840.113549.1.1.11"), [0x05, 0x00]);
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, [2])),
    der(0x02, [1]),
    algId,
    name,
    der(0x30, derTime("260101000000Z"), derTime("361231000000Z")),
    name,
    spki,
  );
  const cert = der(0x30, tbs, algId, der(0x03, [0, 1, 2, 3]));
  return btoa(String.fromCharCode(...cert));
}

export interface TestKey {
  privateKey: CryptoKey;
  /** Bare base64 DER certificate. */
  certificate: string;
  kind: "RSA" | "EC";
}

export async function rsaKey(hash: "SHA-256" | "SHA-512" = "SHA-256"): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash,
    },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { privateKey: pair.privateKey, certificate: certificateFor(spki), kind: "RSA" };
}

export async function ecKey(curve: "P-256" | "P-384" = "P-256"): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, [
    "sign",
    "verify",
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { privateKey: pair.privateKey, certificate: certificateFor(spki), kind: "EC" };
}

// --- templates -----------------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

export interface ResponseFields {
  responseId: string;
  assertionId: string;
  destination: string | null;
  responseIssuer: string | null;
  issuer: string;
  status: string;
  responseInResponseTo: string | null;
  inResponseTo: string | null;
  recipient: string;
  method: string;
  nameId: string;
  audience: string;
  notBefore: string;
  notOnOrAfter: string;
  confirmationNotOnOrAfter: string;
  issueInstant: string;
  sessionNotOnOrAfter: string;
  /** Raw XML placed in the Response after its Issuer (before the Response signature marker). */
  responseExtra: string;
  /** Raw XML placed at the end of the Response. */
  responseTail: string;
  /** Raw XML placed at the end of the Assertion. */
  assertionTail: string;
  /** The Response signature marker, or "" for an unsigned Response. */
  responseSig: string;
  /** The Assertion signature marker, or "" for an unsigned Assertion. */
  assertionSig: string;
}

export function marker(id: string): string {
  return `{{sig:${id}}}`;
}

/** A SAML Response document with `{{sig:ID}}` markers where signatures go. */
export function responseXml(over: Partial<ResponseFields> = {}): string {
  const f: ResponseFields = {
    responseId: "_resp1",
    assertionId: "_assert1",
    destination: SP.acsUrl,
    responseIssuer: IDP_ENTITY,
    issuer: IDP_ENTITY,
    status: "urn:oasis:names:tc:SAML:2.0:status:Success",
    responseInResponseTo: "_req1",
    inResponseTo: "_req1",
    recipient: SP.acsUrl,
    method: "urn:oasis:names:tc:SAML:2.0:cm:bearer",
    nameId: "alice@example.com",
    audience: SP.entityId,
    notBefore: iso(T0 - 30_000),
    notOnOrAfter: iso(T0 + 300_000),
    confirmationNotOnOrAfter: iso(T0 + 300_000),
    issueInstant: iso(T0),
    sessionNotOnOrAfter: iso(T0 + 8 * 3600_000),
    responseExtra: "",
    responseTail: "",
    assertionTail: "",
    responseSig: "",
    assertionSig: marker("_assert1"),
    ...over,
  };
  const opt = (name: string, v: string | null) => (v === null ? "" : ` ${name}="${v}"`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${f.responseId}" Version="2.0" IssueInstant="${f.issueInstant}"${
    opt("Destination", f.destination)
  }${opt("InResponseTo", f.responseInResponseTo)}>
  ${
    f.responseIssuer === null
      ? ""
      : `<saml:Issuer>${f.responseIssuer}</saml:Issuer>`
  }${f.responseSig}${f.responseExtra}
  <samlp:Status><samlp:StatusCode Value="${f.status}"/></samlp:Status>
  <saml:Assertion ID="${f.assertionId}" Version="2.0" IssueInstant="${f.issueInstant}">
    <saml:Issuer>${f.issuer}</saml:Issuer>${f.assertionSig}
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${f.nameId}</saml:NameID>
      <saml:SubjectConfirmation Method="${f.method}">
        <saml:SubjectConfirmationData${
    opt("InResponseTo", f.inResponseTo)
  } NotOnOrAfter="${f.confirmationNotOnOrAfter}" Recipient="${f.recipient}"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${f.notBefore}" NotOnOrAfter="${f.notOnOrAfter}">
      <saml:AudienceRestriction><saml:Audience>${f.audience}</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${f.issueInstant}" SessionIndex="_session1" SessionNotOnOrAfter="${f.sessionNotOnOrAfter}"/>
    <saml:AttributeStatement>
      <saml:Attribute Name="email"><saml:AttributeValue>alice@example.com</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="groups"><saml:AttributeValue>admins</saml:AttributeValue><saml:AttributeValue>staff</saml:AttributeValue></saml:Attribute>
    </saml:AttributeStatement>${f.assertionTail}
  </saml:Assertion>${f.responseTail}
</samlp:Response>`;
}

// --- signer --------------------------------------------------------------------------------

export interface SignOptions {
  key: TestKey;
  signatureAlgorithm?: string;
  digestAlgorithm?: string;
  /** The Reference URI (default `#` + id). */
  uri?: string;
  /** The Reference's Transforms element content (default enveloped + exc-c14n). */
  transforms?: string;
  prefixList?: string;
  canonicalization?: string;
  /** A certificate to embed in KeyInfo (never trusted by the verifier). */
  keyInfoCertificate?: string;
}

/** The Assertion or Response with this ID (decoys carrying the same ID are skipped). */
function findById(root: XmlElement, id: string): XmlElement {
  const stack = [root];
  while (stack.length) {
    const el = stack.pop()!;
    const signable = ["Assertion", "Response", "LogoutRequest", "LogoutResponse"].includes(
      el.local,
    );
    if (signable && el.attrs.some((a) => a.local === "ID" && a.value === id)) return el;
    for (const c of el.children) if (c.type === "element") stack.push(c);
  }
  throw new Error(`no element with ID ${id}`);
}

function b64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

/**
 * Replace `{{sig:id}}` in `xml` with an enveloped signature over the element with that ID.
 * Sign inner elements first (an Assertion before its Response).
 */
const HASH_OF: Record<string, string> = { [ALG.sha512]: "SHA-512", [ALG.sha1]: "SHA-1" };

/** The digest of the element with `id` in `xml` (no signature yet), base64. */
async function digestOf(xml: string, id: string, digestAlg: string, prefixList?: string) {
  const content = excC14n(findById(parseXml(xml).root, id), {
    inclusivePrefixes: prefixList?.split(" ").filter(Boolean) ?? [],
  });
  const hash = Object.hasOwn(HASH_OF, digestAlg) ? HASH_OF[digestAlg] : "SHA-256";
  return b64(await crypto.subtle.digest(hash, new TextEncoder().encode(content)));
}

function defaultTransforms(prefixList?: string): string {
  const inc = prefixList
    ? `<ec:InclusiveNamespaces xmlns:ec="${ALG.excC14n}" PrefixList="${prefixList}"/>`
    : "";
  return `<ds:Transform Algorithm="${ALG.enveloped}"/><ds:Transform Algorithm="${ALG.excC14n}">${inc}</ds:Transform>`;
}

function keyInfoXml(cert?: string): string {
  return cert
    ? `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`
    : "";
}

function childNamed(el: XmlElement, local: string): XmlElement {
  return el.children.find((c): c is XmlElement => c.type === "element" && c.local === local)!;
}

/**
 * Replace `{{sig:id}}` in `xml` with an enveloped signature over the element with that ID.
 * Sign inner elements first (an Assertion before its Response).
 */
export async function sign(xml: string, id: string, options: SignOptions): Promise<string> {
  const m = marker(id);
  if (!xml.includes(m)) throw new Error(`no ${m} marker`);
  const digestAlg = options.digestAlgorithm ?? ALG.sha256;
  const digest = await digestOf(xml.replace(m, ""), id, digestAlg, options.prefixList);
  const sigAlg = options.signatureAlgorithm ??
    (options.key.kind === "EC" ? ALG.ecdsaSha256 : ALG.rsaSha256);
  const canonicalization = options.canonicalization ?? ALG.excC14n;
  const placeholder = `SIGVALUE-${id}`;
  const signature = `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">` +
    `<ds:SignedInfo><ds:CanonicalizationMethod Algorithm="${canonicalization}"/>` +
    `<ds:SignatureMethod Algorithm="${sigAlg}"/>` +
    `<ds:Reference URI="${options.uri ?? `#${id}`}">` +
    `<ds:Transforms>${
      options.transforms ?? defaultTransforms(options.prefixList)
    }</ds:Transforms>` +
    `<ds:DigestMethod Algorithm="${digestAlg}"/><ds:DigestValue>${digest}</ds:DigestValue>` +
    `</ds:Reference></ds:SignedInfo><ds:SignatureValue>${placeholder}</ds:SignatureValue>` +
    `${keyInfoXml(options.keyInfoCertificate)}</ds:Signature>`;
  const withSig = xml.replace(m, signature);
  const signedInfo = childNamed(
    childNamed(findById(parseXml(withSig).root, id), "Signature"),
    "SignedInfo",
  );
  const canonical = excC14n(signedInfo, { withComments: canonicalization === ALG.excC14nComments });
  const params = options.key.kind === "EC"
    ? { name: "ECDSA", hash: "SHA-256" }
    : { name: "RSASSA-PKCS1-v1_5" };
  const value = await crypto.subtle.sign(
    params,
    options.key.privateKey,
    new TextEncoder().encode(canonical),
  );
  return withSig.replace(placeholder, b64(value));
}

/** Base64 of a UTF-8 string — the HTTP-POST `SAMLResponse` field. */
export function encode(xml: string): string {
  const bytes = new TextEncoder().encode(xml);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
