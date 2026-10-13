// Test helpers for encrypted assertions and Single Logout: throwaway SP keys (PKCS #8 PEM +
// a minimal certificate), an XML Encryption encrypter (WebCrypto; RSA-OAEP key transport,
// AES-GCM / AES-CBC content), an HTTP-Redirect signer for IdP messages, and LogoutRequest /
// LogoutResponse templates. Mutation fixtures only — the golden ones come from xmlsec1.

import { certificateFor, IDP_ENTITY, T0, type TestKey } from "./_saml-helpers.ts";

export const SLO_URL = "https://sp.example.com/auth/v1/sso/saml/slo";
export const IDP_SLO_URL = "https://idp.example.org/slo";

const b64 = (bytes: ArrayBuffer | Uint8Array): string => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of u) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** An SP RSA key pair: the private key as PKCS #8 PEM and as JWK, and its certificate. */
export interface SpKey {
  pem: string;
  jwk: JsonWebKey;
  certificate: string;
  spki: Uint8Array<ArrayBuffer>;
}

export async function spKey(): Promise<SpKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    b64(pkcs8).match(/.{1,64}/g)!.join("\n")
  }\n-----END PRIVATE KEY-----\n`;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { pem, jwk, certificate: certificateFor(spki, "test SP"), spki };
}

export const XENC = "http://www.w3.org/2001/04/xmlenc#";
const XENC11 = "http://www.w3.org/2009/xmlenc11#";
const DS = "http://www.w3.org/2000/09/xmldsig#";

export const CONTENT = {
  aes128gcm: `${XENC11}aes128-gcm`,
  aes256gcm: `${XENC11}aes256-gcm`,
  aes128cbc: `${XENC}aes128-cbc`,
  aes256cbc: `${XENC}aes256-cbc`,
  aes192cbc: `${XENC}aes192-cbc`,
  tripledes: `${XENC}tripledes-cbc`,
};

export interface EncryptOptions {
  /** Content algorithm URI (default AES-256-GCM). */
  content?: string;
  /** Key transport: mgf1p (SHA-1), oaep (xmlenc11, SHA-1), oaep256 (xmlenc11, SHA-256). */
  transport?: "mgf1p" | "oaep" | "oaep256";
  /** The EncryptionMethod element of the EncryptedKey, verbatim (overrides `transport`). */
  keyMethod?: string;
  /** Where the EncryptedKey goes. */
  keyPlacement?: "keyinfo" | "sibling";
  /** Rewrite the content cipher bytes (IV + cipher text + tag) before encoding. */
  tamperContent?: (bytes: Uint8Array) => Uint8Array;
  /** Rewrite the wrapped key bytes before encoding. */
  tamperKey?: (bytes: Uint8Array) => Uint8Array;
  /** Use this many bytes of content key (default: what the algorithm needs). */
  keyLength?: number;
  /** Raw plaintext bytes for CBC (pre-padded by the caller): no padding is added. */
  rawCbcPlaintext?: Uint8Array;
  /** Extra attributes on EncryptedData. */
  dataAttrs?: string;
}

function keyLengthOf(content: string): number {
  return /aes128/.test(content) ? 16 : /aes192/.test(content) ? 24 : 32;
}

async function wrapKey(
  key: Uint8Array<ArrayBuffer>,
  spki: Uint8Array<ArrayBuffer>,
  hash: string,
): Promise<Uint8Array> {
  const pub = await crypto.subtle.importKey("spki", spki, { name: "RSA-OAEP", hash }, false, [
    "encrypt",
  ]);
  return new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pub, key));
}

/** XML-Encryption padding (PKCS #7-shaped, which is a valid xmlenc padding). */
async function aesEncrypt(
  content: string,
  key: Uint8Array<ArrayBuffer>,
  plain: Uint8Array<ArrayBuffer>,
  raw?: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  if (content.includes("gcm")) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, plain));
    return new Uint8Array([...iv, ...ct]);
  }
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const k = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, k, raw ?? plain));
  // With raw plaintext (already a multiple of 16) drop WebCrypto's extra padding block.
  return new Uint8Array([...iv, ...(raw ? ct.subarray(0, ct.length - 16) : ct)]);
}

function keyMethodXml(transport: EncryptOptions["transport"]): { xml: string; hash: string } {
  if (transport === "oaep256") {
    return {
      xml: `<xenc:EncryptionMethod Algorithm="${XENC11}rsa-oaep">` +
        `<ds:DigestMethod xmlns:ds="${DS}" Algorithm="${XENC}sha256"/>` +
        `<xenc11:MGF xmlns:xenc11="${XENC11}" Algorithm="${XENC11}mgf1sha256"/></xenc:EncryptionMethod>`,
      hash: "SHA-256",
    };
  }
  if (transport === "oaep") {
    return { xml: `<xenc:EncryptionMethod Algorithm="${XENC11}rsa-oaep"/>`, hash: "SHA-1" };
  }
  return {
    xml: `<xenc:EncryptionMethod Algorithm="${XENC}rsa-oaep-mgf1p">` +
      `<ds:DigestMethod xmlns:ds="${DS}" Algorithm="${DS}sha1"/></xenc:EncryptionMethod>`,
    hash: "SHA-1",
  };
}

/** An `<saml:EncryptedAssertion>` holding `assertionXml`, encrypted to the SP key. */
export async function encryptAssertion(
  assertionXml: string,
  sp: SpKey,
  options: EncryptOptions = {},
): Promise<string> {
  const content = options.content ?? CONTENT.aes256gcm;
  const key = crypto.getRandomValues(new Uint8Array(options.keyLength ?? keyLengthOf(content)));
  const aesKey = key.length === 16 || key.length === 32 ? key : new Uint8Array(32);
  let cipher = await aesEncrypt(
    content,
    aesKey,
    new TextEncoder().encode(assertionXml),
    options.rawCbcPlaintext as Uint8Array<ArrayBuffer> | undefined,
  );
  if (options.tamperContent) cipher = options.tamperContent(cipher);
  const method = keyMethodXml(options.transport);
  let wrapped = await wrapKey(key, sp.spki, method.hash);
  if (options.tamperKey) wrapped = options.tamperKey(wrapped);
  const encryptedKey =
    `<xenc:EncryptedKey xmlns:xenc="${XENC}">${options.keyMethod ?? method.xml}` +
    `<xenc:CipherData><xenc:CipherValue>${b64(wrapped)}</xenc:CipherValue></xenc:CipherData>` +
    `</xenc:EncryptedKey>`;
  const inside = options.keyPlacement !== "sibling";
  return `<saml:EncryptedAssertion><xenc:EncryptedData xmlns:xenc="${XENC}" ` +
    `Type="${XENC}Element"${options.dataAttrs ?? ""}>` +
    `<xenc:EncryptionMethod Algorithm="${content}"/>` +
    (inside ? `<ds:KeyInfo xmlns:ds="${DS}">${encryptedKey}</ds:KeyInfo>` : "") +
    `<xenc:CipherData><xenc:CipherValue>${b64(cipher)}</xenc:CipherValue></xenc:CipherData>` +
    `</xenc:EncryptedData>${inside ? "" : encryptedKey}</saml:EncryptedAssertion>`;
}

// --- HTTP-Redirect ----------------------------------------------------------------------

async function deflate(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";

export interface RedirectOptions {
  relayState?: string;
  sigAlg?: string;
  /** Sign this exact octet string instead of the canonical one. */
  signedOctets?: (parts: { message: string; relay?: string; sigAlg: string }) => string;
  /** Leave the signature off. */
  unsigned?: boolean;
  /** Raw deflated bytes override (a DEFLATE bomb, garbage). */
  deflated?: Uint8Array;
}

/** An IdP-signed HTTP-Redirect query (`?SAMLRequest=…&RelayState=…&SigAlg=…&Signature=…`). */
export async function redirectQuery(
  param: "SAMLRequest" | "SAMLResponse",
  xml: string,
  key: TestKey,
  options: RedirectOptions = {},
): Promise<string> {
  const q = encodeURIComponent;
  const message = `${param}=${q(b64(options.deflated ?? await deflate(xml)))}`;
  const relay = options.relayState !== undefined
    ? `RelayState=${q(options.relayState)}`
    : undefined;
  const sigAlg = `SigAlg=${q(options.sigAlg ?? RSA_SHA256)}`;
  const parts = [message, ...(relay ? [relay] : [])];
  if (options.unsigned) return `?${parts.join("&")}`;
  parts.push(sigAlg);
  const octets = options.signedOctets
    ? options.signedOctets({ message, relay, sigAlg })
    : parts.join("&");
  const params = key.kind === "EC"
    ? { name: "ECDSA", hash: "SHA-256" }
    : { name: "RSASSA-PKCS1-v1_5" };
  const sig = await crypto.subtle.sign(params, key.privateKey, new TextEncoder().encode(octets));
  return `?${parts.join("&")}&Signature=${q(b64(sig))}`;
}

// --- logout templates ---------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

export interface LogoutFields {
  id: string;
  issueInstant: string;
  destination: string | null;
  issuer: string | null;
  nameId: string;
  sessionIndexes: string[];
  notOnOrAfter: string | null;
  /** For a response. */
  inResponseTo: string | null;
  status: string;
  /** The signature marker (`{{sig:ID}}`) or "". */
  sig: string;
  extra: string;
}

function fields(over: Partial<LogoutFields>): LogoutFields {
  return {
    id: "_lr1",
    issueInstant: iso(T0),
    destination: SLO_URL,
    issuer: IDP_ENTITY,
    nameId: "alice@example.com",
    sessionIndexes: ["_session1"],
    notOnOrAfter: null,
    inResponseTo: "_spreq1",
    status: "urn:oasis:names:tc:SAML:2.0:status:Success",
    sig: "",
    extra: "",
    ...over,
  };
}

const opt = (name: string, v: string | null) => (v === null ? "" : ` ${name}="${v}"`);
const NS = `xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
  `xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"`;

export function logoutRequestXml(over: Partial<LogoutFields> = {}): string {
  const f = fields(over);
  return `<samlp:LogoutRequest ${NS} ID="${f.id}" Version="2.0" IssueInstant="${f.issueInstant}"${
    opt("Destination", f.destination)
  }${opt("NotOnOrAfter", f.notOnOrAfter)}>` +
    (f.issuer === null ? "" : `<saml:Issuer>${f.issuer}</saml:Issuer>`) + f.sig +
    `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${f.nameId}</saml:NameID>` +
    f.sessionIndexes.map((s) => `<samlp:SessionIndex>${s}</samlp:SessionIndex>`).join("") +
    f.extra + `</samlp:LogoutRequest>`;
}

export function logoutResponseXml(over: Partial<LogoutFields> = {}): string {
  const f = fields({ id: "_lresp1", ...over });
  return `<samlp:LogoutResponse ${NS} ID="${f.id}" Version="2.0" IssueInstant="${f.issueInstant}"${
    opt("Destination", f.destination)
  }${opt("InResponseTo", f.inResponseTo)}>` +
    (f.issuer === null ? "" : `<saml:Issuer>${f.issuer}</saml:Issuer>`) + f.sig +
    `<samlp:Status><samlp:StatusCode Value="${f.status}"/></samlp:Status>` + f.extra +
    `</samlp:LogoutResponse>`;
}

/** Inflate a `SAMLRequest` / `SAMLResponse` query value from a URL this SP built. */
export async function inflateParam(url: string, param: string): Promise<string> {
  const raw = new URL(url).searchParams.get(param)!;
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  return await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
  ).text();
}

/** Verify an SP-signed redirect URL's query signature with the SP certificate's key. */
export async function verifySpRedirect(url: string, spki: Uint8Array<ArrayBuffer>) {
  const query = new URL(url).search.slice(1);
  const pairs = query.split("&");
  const get = (n: string) => pairs.find((p) => p.startsWith(`${n}=`));
  const octets = ["SAMLRequest", "SAMLResponse", "RelayState", "SigAlg"].map(get).filter(Boolean)
    .join("&");
  const sig = Uint8Array.from(
    atob(decodeURIComponent(get("Signature")!.slice(10))),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "spki",
    spki,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sig,
    new TextEncoder().encode(octets),
  );
}
