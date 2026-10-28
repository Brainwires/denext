/**
 * The SAML 2.0 HTTP-Redirect binding (SAML Bindings §3.4): DEFLATE + base64 + URL encoding of a
 * message into a query string, its signature over `SAMLRequest|SAMLResponse=…&RelayState=…&
 * SigAlg=…` (§3.4.4.1, computed on the URL-encoded values exactly as they travel), and the
 * strict reading of a received one — every parameter at most once, a size cap on the inflated
 * XML, the signature verified against the IdP's configured certificates over the RAW received
 * values (never re-encoded ones), and no XML signature inside the message.
 *
 * @module
 */

import type { SamlPrivateKey } from "./config.ts";
import { verifyWithCertificates } from "./dsig.ts";
import { SamlError } from "./errors.ts";
import { spPrivateKey } from "./keys.ts";
import { MAX_XML_BYTES } from "./xml.ts";
import { decodeBase64 } from "./x509.ts";

/** RSA-SHA256, the algorithm this SP signs with. */
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";

const SIG_ALGS: Record<string, { kind: "RSA" | "EC"; hash: "SHA-256" | "SHA-512" }> = {
  [RSA_SHA256]: { kind: "RSA", hash: "SHA-256" },
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512": { kind: "RSA", hash: "SHA-512" },
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256": { kind: "EC", hash: "SHA-256" },
};

function bad(message: string): never {
  throw new SamlError("bad_binding", message);
}

/** DEFLATE (raw, no zlib header). */
async function deflateRaw(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** INFLATE (raw), refusing more than {@link MAX_XML_BYTES} of output (a DEFLATE bomb). */
async function inflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_XML_BYTES) bad("the inflated message is too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof SamlError) throw error;
    throw new SamlError("malformed_xml", "the message is not valid DEFLATE data");
  }
  return new Uint8Array(await new Blob(chunks as Uint8Array<ArrayBuffer>[]).arrayBuffer());
}

function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}

/** What {@link redirectUrl} puts on the query string. */
export interface RedirectMessage {
  /** `SAMLRequest` or `SAMLResponse`. */
  param: "SAMLRequest" | "SAMLResponse";
  /** The message XML. */
  xml: string;
  /** The RelayState, when any. */
  relayState?: string;
  /** Sign with this SP key (RSA-SHA256); unsigned without it. */
  signingKey?: SamlPrivateKey;
}

/**
 * The URL that carries `message` to `endpoint` over the HTTP-Redirect binding — signed
 * (`SigAlg` + `Signature`) when a key is given.
 *
 * @param endpoint The IdP endpoint (its own query string is kept).
 * @param message The message, RelayState and signing key.
 * @returns The URL to redirect the browser to.
 */
export async function redirectUrl(endpoint: string, message: RedirectMessage): Promise<string> {
  const parts = [`${message.param}=${encodeURIComponent(base64(await deflateRaw(message.xml)))}`];
  if (message.relayState !== undefined) {
    parts.push(`RelayState=${encodeURIComponent(message.relayState)}`);
  }
  if (message.signingKey) {
    parts.push(`SigAlg=${encodeURIComponent(RSA_SHA256)}`);
    const key = await spPrivateKey(message.signingKey, "sign");
    const signed = new TextEncoder().encode(parts.join("&"));
    const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, signed);
    parts.push(`Signature=${encodeURIComponent(base64(new Uint8Array(signature)))}`);
  }
  const url = new URL(endpoint);
  url.hash = "";
  return `${url.href.replace(/\?$/, "")}${url.search ? "&" : "?"}${parts.join("&")}`;
}

/** A received HTTP-Redirect message. */
export interface ReceivedRedirect {
  /** `SAMLRequest` or `SAMLResponse`. */
  param: "SAMLRequest" | "SAMLResponse";
  /** The inflated message bytes. */
  xml: Uint8Array;
  /** The RelayState, decoded. */
  relayState?: string;
}

const BINDING_PARAMS = ["SAMLRequest", "SAMLResponse", "RelayState", "SigAlg", "Signature"];

/** Form-urlencoded decoding of one raw value (`+` is a space). */
function decodeValue(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return bad("a parameter is not valid URL encoding");
  }
}

/**
 * The binding parameters of a raw query string, by name, each with its RAW (still URL-encoded)
 * value. A parameter that appears twice is refused: which copy was signed and which is read
 * must never be a question.
 */
function rawParams(query: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of query.replace(/^\?/, "").split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const name = decodeValue(eq === -1 ? pair : pair.slice(0, eq));
    if (!BINDING_PARAMS.includes(name)) continue;
    if (out.has(name)) bad(`${name} appears more than once`);
    out.set(name, eq === -1 ? "" : pair.slice(eq + 1));
  }
  return out;
}

/** Verify the query signature with the IdP's certificates (it is required). */
async function verifyQuerySignature(
  params: Map<string, string>,
  param: string,
  certificates: readonly string[],
): Promise<void> {
  const sigAlg = params.get("SigAlg");
  const signature = params.get("Signature");
  if (sigAlg === undefined || signature === undefined) {
    throw new SamlError("unsigned", "the redirect-binding message is not signed");
  }
  const alg = decodeValue(sigAlg);
  if (!Object.hasOwn(SIG_ALGS, alg)) {
    throw new SamlError("unsupported_algorithm", `SigAlg ${alg || "(none)"} is not allowed`);
  }
  const relay = params.get("RelayState");
  const octets = `${param}=${params.get(param)}` +
    (relay !== undefined ? `&RelayState=${relay}` : "") + `&SigAlg=${sigAlg}`;
  const bytes = decodeBase64(decodeValue(signature));
  if (!bytes) throw new SamlError("bad_signature", "Signature is not base64");
  const data = new TextEncoder().encode(octets);
  if (!(await verifyWithCertificates(SIG_ALGS[alg], data, bytes, certificates))) {
    throw new SamlError("bad_signature", "the query signature does not verify");
  }
}

/** The message parameter of a binding query (exactly one of SAMLRequest / SAMLResponse). */
function messageParam(params: Map<string, string>): "SAMLRequest" | "SAMLResponse" {
  const has = (name: string) => params.has(name);
  if (has("SAMLRequest") === has("SAMLResponse")) {
    bad("expected exactly one of SAMLRequest and SAMLResponse");
  }
  const param = has("SAMLRequest") ? "SAMLRequest" : "SAMLResponse";
  if (params.get(param)!.length > Math.ceil(MAX_XML_BYTES / 3) * 4 * 3) {
    bad("the message is too large");
  }
  return param;
}

/** Inflate the message parameter and decode the RelayState. */
async function inflateMessage(
  params: Map<string, string>,
  param: "SAMLRequest" | "SAMLResponse",
): Promise<ReceivedRedirect> {
  const deflated = decodeBase64(decodeValue(params.get(param)!));
  if (!deflated) throw new SamlError("malformed_xml", `${param} is not base64`);
  const relay = params.get("RelayState");
  const out: ReceivedRedirect = { param, xml: await inflateRaw(deflated) };
  if (relay !== undefined) out.relayState = decodeValue(relay);
  return out;
}

/**
 * Read and verify a message received over the HTTP-Redirect binding: the signature is checked
 * (over the raw received values) before the message is even inflated.
 *
 * @param query The request's raw query string (`url.search`), exactly as received.
 * @param certificates The IdP's configured signing certificates (the signature is required).
 * @returns The message parameter, its inflated XML and the RelayState.
 * @throws {SamlError} `bad_binding`, `unsigned`, `unsupported_algorithm`, `bad_signature`,
 *   `malformed_xml`.
 */
export async function readRedirect(
  query: string,
  certificates: readonly string[],
): Promise<ReceivedRedirect> {
  const params = rawParams(query);
  const param = messageParam(params);
  await verifyQuerySignature(params, param, certificates);
  return await inflateMessage(params, param);
}

/**
 * Decode an HTTP-Redirect message WITHOUT verifying it — only to learn which IdP sent it (its
 * Issuer) so {@link readRedirect} can then verify it with that IdP's certificates.
 *
 * @param query The raw query string.
 * @returns The (unverified) message.
 */
export async function peekRedirect(query: string): Promise<ReceivedRedirect> {
  const params = rawParams(query);
  return await inflateMessage(params, messageParam(params));
}
