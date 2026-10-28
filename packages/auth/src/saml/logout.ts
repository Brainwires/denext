/**
 * SAML 2.0 Single Logout (SAML Profiles §4.4) for a Service Provider: build a signed
 * LogoutRequest / LogoutResponse over the HTTP-Redirect binding, and verify one received over
 * HTTP-Redirect (the query signature, §3.4.4.1) or HTTP-POST (an enveloped XML-DSig signature,
 * checked by the same strict verifier as a Response). A received message must be signed, name
 * this SP's SingleLogoutService as its Destination, come from the configured IdP, be fresh
 * (IssueInstant, NotOnOrAfter), answer the request it claims to (InResponseTo) and be new (its
 * ID is claimed in a replay cache).
 *
 * @module
 */

import { peekRedirect, readRedirect, redirectUrl } from "./binding.ts";
import {
  checkIssuer,
  checkWindow,
  type Clock,
  malformed,
  parseTime,
  refuse,
  SAML_NS,
  SAMLP_NS,
  single,
  STATUS_SUCCESS,
  statusOf,
  textOnly,
} from "./common.ts";
import type { SamlIdpConfig, SamlSpConfig } from "./config.ts";
import { directSignature, DS_NS, indexIds, verifyEnvelopedSignature } from "./dsig.ts";
import { SamlError } from "./errors.ts";
import { soleNameId } from "./encrypted-id.ts";
import { escapeXml } from "./metadata.ts";
import type { SamlReplayCache } from "./response.ts";
import { attr, childElements, isNcName, MAX_XML_BYTES, parseXml, type XmlDocument } from "./xml.ts";
import { decodeBase64 } from "./x509.ts";

/** How a logout message arrived: the raw query (HTTP-Redirect) or the posted form. */
export type SamlBindingInput = { query: string } | { form: URLSearchParams };

/** A message id: `_` + 40 hex digits. */
function messageId(): string {
  const random = crypto.getRandomValues(new Uint8Array(20));
  return "_" + Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
}

function instant(now?: number): string {
  return new Date(now ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function signingKeyOf(sp: SamlSpConfig) {
  if (!sp.signingKey) throw new SamlError("bad_key", "Single Logout needs an SP signing key");
  return sp.signingKey;
}

/** Options for {@link buildLogoutRequest}. */
export interface BuildLogoutRequestOptions {
  /** This SP (its entity id and `signingKey`). */
  sp: SamlSpConfig;
  /** The IdP (its `sloUrl`). */
  idp: SamlIdpConfig;
  /** The NameID the session was established for. */
  nameId: string;
  /** Its Format, when the assertion gave one. */
  nameIdFormat?: string;
  /** The AuthnStatement's SessionIndex, when the assertion gave one. */
  sessionIndex?: string;
  /** Opaque state the IdP echoes with its LogoutResponse. */
  relayState?: string;
  /** The IssueInstant, epoch milliseconds. Default `Date.now()`. */
  now?: number;
}

/**
 * Build an SP-initiated LogoutRequest, signed over the HTTP-Redirect binding (RSA-SHA256), and
 * the IdP URL that carries it. Remember the returned `id`: the LogoutResponse must answer it.
 *
 * @returns `id` and `url` (where to send the browser).
 * @throws {SamlError} `bad_key` without an SP signing key, `bad_metadata` when the IdP has no
 *   HTTP-Redirect SingleLogoutService.
 */
export async function buildLogoutRequest(
  options: BuildLogoutRequestOptions,
): Promise<{ id: string; url: string }> {
  const { sp, idp } = options;
  const key = signingKeyOf(sp);
  if (!idp.sloUrl) throw new SamlError("bad_metadata", "the IdP has no SingleLogoutService");
  const id = messageId();
  const format = options.nameIdFormat ? ` Format="${escapeXml(options.nameIdFormat)}"` : "";
  const xml = `<samlp:LogoutRequest xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}"` +
    ` ID="${id}" Version="2.0" IssueInstant="${instant(options.now)}"` +
    ` Destination="${escapeXml(idp.sloUrl)}">` +
    `<saml:Issuer>${escapeXml(sp.entityId)}</saml:Issuer>` +
    `<saml:NameID${format}>${escapeXml(options.nameId)}</saml:NameID>` +
    (options.sessionIndex !== undefined
      ? `<samlp:SessionIndex>${escapeXml(options.sessionIndex)}</samlp:SessionIndex>`
      : "") +
    `</samlp:LogoutRequest>`;
  const url = await redirectUrl(idp.sloUrl, {
    param: "SAMLRequest",
    xml,
    relayState: options.relayState,
    signingKey: key,
  });
  return { id, url };
}

/** Options for {@link buildLogoutResponse}. */
export interface BuildLogoutResponseOptions {
  /** This SP (its entity id and `signingKey`). */
  sp: SamlSpConfig;
  /** The IdP (its `sloResponseUrl` or `sloUrl`). */
  idp: SamlIdpConfig;
  /** The ID of the LogoutRequest answered. */
  inResponseTo: string;
  /** The RelayState the request carried, echoed back. */
  relayState?: string;
  /** The top-level status. Default `…:status:Success`. */
  status?: string;
  /** The IssueInstant, epoch milliseconds. Default `Date.now()`. */
  now?: number;
}

/**
 * Build the LogoutResponse answering an IdP-initiated LogoutRequest, signed over the
 * HTTP-Redirect binding, and the IdP URL that carries it.
 *
 * @returns The URL to send the browser to.
 * @throws {SamlError} `bad_key` / `bad_metadata` as {@link buildLogoutRequest}.
 */
export async function buildLogoutResponse(options: BuildLogoutResponseOptions): Promise<string> {
  const { sp, idp } = options;
  const key = signingKeyOf(sp);
  const endpoint = idp.sloResponseUrl ?? idp.sloUrl;
  if (!endpoint) throw new SamlError("bad_metadata", "the IdP has no SingleLogoutService");
  const xml = `<samlp:LogoutResponse xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}"` +
    ` ID="${messageId()}" Version="2.0" IssueInstant="${instant(options.now)}"` +
    ` Destination="${escapeXml(endpoint)}" InResponseTo="${escapeXml(options.inResponseTo)}">` +
    `<saml:Issuer>${escapeXml(sp.entityId)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${
      escapeXml(options.status ?? STATUS_SUCCESS)
    }"/></samlp:Status>` +
    `</samlp:LogoutResponse>`;
  return await redirectUrl(endpoint, {
    param: "SAMLResponse",
    xml,
    relayState: options.relayState,
    signingKey: key,
  });
}

/** What a logout message says before anything is verified — only to choose the IdP. */
export interface PeekedLogoutMessage {
  /** `LogoutRequest` or `LogoutResponse` (anything else is refused). */
  kind: "LogoutRequest" | "LogoutResponse";
  /** The Issuer text, UNVERIFIED. */
  issuer?: string;
  /** The RelayState, UNVERIFIED. */
  relayState?: string;
}

interface Decoded {
  doc: XmlDocument;
  binding: "redirect" | "post";
  relayState?: string;
}

/** The one value of a form field (absent, or refused when repeated). */
function formField(form: URLSearchParams, name: string): string | undefined {
  const values = form.getAll(name);
  if (values.length > 1) throw new SamlError("bad_binding", `${name} appears more than once`);
  return values[0];
}

/** Decode an HTTP-POST form: exactly one of SAMLRequest / SAMLResponse, base64. */
function decodePost(form: URLSearchParams): Decoded {
  const request = formField(form, "SAMLRequest");
  const response = formField(form, "SAMLResponse");
  if ((request === undefined) === (response === undefined)) {
    throw new SamlError("bad_binding", "expected exactly one of SAMLRequest and SAMLResponse");
  }
  const field = (request ?? response)!;
  if (field.length > Math.ceil(MAX_XML_BYTES / 3) * 4 + 16384) {
    throw new SamlError("malformed_xml", "the message is too large");
  }
  const bytes = decodeBase64(field);
  if (!bytes) throw new SamlError("malformed_xml", "the message is not base64");
  const relayState = formField(form, "RelayState");
  return { doc: parseXml(bytes), binding: "post", ...(relayState !== undefined && { relayState }) };
}

/**
 * Read a logout message's kind, Issuer and RelayState WITHOUT verifying it — enough to pick the
 * IdP whose certificates then verify it. Never act on what this returns.
 *
 * @param input The raw query (HTTP-Redirect) or the posted form (HTTP-POST).
 * @throws {SamlError} When the message cannot be decoded or is not a logout message.
 */
export async function peekLogoutMessage(input: SamlBindingInput): Promise<PeekedLogoutMessage> {
  const decoded = "form" in input
    ? decodePost(input.form)
    : await decodeRedirect(input.query, null);
  const root = decoded.doc.root;
  if (root.ns !== SAMLP_NS || (root.local !== "LogoutRequest" && root.local !== "LogoutResponse")) {
    malformed("not a SAML logout message");
  }
  const issuerEl = childElements(root, SAML_NS, "Issuer")[0];
  const out: PeekedLogoutMessage = { kind: root.local };
  if (issuerEl) out.issuer = textOnly(issuerEl);
  if (decoded.relayState !== undefined) out.relayState = decoded.relayState;
  return out;
}

/** Decode (and, with certificates, verify) an HTTP-Redirect query. */
async function decodeRedirect(query: string, certificates: readonly string[] | null) {
  const received = certificates === null
    ? await peekRedirect(query)
    : await readRedirect(query, certificates);
  const doc = parseXml(received.xml);
  // Bindings §3.4.4.1: a signature travels in the query, never inside the message.
  if (doc.elements.some((el) => el.ns === DS_NS && el.local === "Signature")) {
    throw new SamlError("bad_binding", "an HTTP-Redirect message carries an XML signature");
  }
  const decoded: Decoded = { doc, binding: "redirect" };
  if (received.relayState !== undefined) decoded.relayState = received.relayState;
  return decoded;
}

/** Decode and verify the signature (the binding's) of a received message. */
async function receive(input: SamlBindingInput, idp: SamlIdpConfig): Promise<Decoded> {
  if (!("form" in input)) return await decodeRedirect(input.query, idp.certificates);
  const decoded = decodePost(input.form);
  const root = decoded.doc.root;
  const signature = directSignature(root);
  if (!signature) throw new SamlError("unsigned", "the logout message is not signed");
  await verifyEnvelopedSignature(indexIds(decoded.doc), root, signature, idp.certificates);
  return decoded;
}

/** Options for {@link verifyLogoutRequest} / {@link verifyLogoutResponse}. */
export interface VerifyLogoutOptions {
  /** How the message arrived. */
  input: SamlBindingInput;
  /** The IdP that must have signed it. */
  idp: SamlIdpConfig;
  /** This SP; `sloUrl` is the Destination the message must carry. */
  sp: SamlSpConfig;
  /** Where message IDs are remembered, so each is accepted once. */
  replayCache: SamlReplayCache;
  /** The current time, epoch milliseconds. Default `Date.now()`. */
  now?: number;
  /** Clock skew tolerated, seconds. Default 60. */
  clockSkewSeconds?: number;
  /** How old an IssueInstant may be, seconds. Default 300. */
  maxAgeSeconds?: number;
}

interface Envelope {
  id: string;
  issuer: string;
  relayState?: string;
  root: XmlDocument["root"];
  clock: Clock;
  /** When the message stops being acceptable (epoch ms). */
  expiresAt: number;
}

/** Checks every received logout message shares: signature, shape, freshness, Destination, Issuer. */
async function envelope(
  options: VerifyLogoutOptions,
  kind: "LogoutRequest" | "LogoutResponse",
): Promise<Envelope> {
  const clock: Clock = {
    now: options.now ?? Date.now(),
    skew: (options.clockSkewSeconds ?? 60) * 1000,
  };
  const decoded = await receive(options.input, options.idp);
  const root = decoded.doc.root;
  if (root.ns !== SAMLP_NS || root.local !== kind) malformed(`expected a samlp:${kind}`);
  if (attr(root, "Version") !== "2.0") malformed(`the ${kind} is not SAML 2.0`);
  const id = attr(root, "ID");
  if (!id || id.length > 256 || !isNcName(id)) malformed(`the ${kind} has no valid ID`);
  const issued = parseTime(root, "IssueInstant");
  if (issued === undefined) malformed(`the ${kind} has no IssueInstant`);
  const expiresAt = issued + (options.maxAgeSeconds ?? 300) * 1000;
  checkWindow(clock, issued, expiresAt);
  if (!options.sp.sloUrl || attr(root, "Destination") !== options.sp.sloUrl) {
    refuse("bad_destination", `the ${kind} Destination is not this SingleLogoutService`);
  }
  const issuerEl = single(root, SAML_NS, "Issuer", false);
  if (!issuerEl) refuse("bad_issuer", `the ${kind} has no Issuer`);
  const issuer = checkIssuer(issuerEl, options.idp, kind);
  const out: Envelope = { id, issuer, root, clock, expiresAt };
  if (decoded.relayState !== undefined) out.relayState = decoded.relayState;
  return out;
}

/** Claim the message ID (per issuer) until it could no longer be accepted anyway. */
async function claim(options: VerifyLogoutOptions, env: Envelope): Promise<void> {
  const until = Math.ceil((env.expiresAt + env.clock.skew) / 1000);
  if (!(await options.replayCache.claim(`${env.issuer}|${env.id}`, until))) {
    refuse("replay", "the logout message was already used");
  }
}

/** A LogoutRequest that passed every check. */
export interface VerifiedLogoutRequest {
  /** The request ID (the LogoutResponse's InResponseTo). */
  id: string;
  /** The IdP entity id. */
  issuer: string;
  /** The NameID whose sessions end. */
  nameId: string;
  /** Its Format, when given. */
  nameIdFormat?: string;
  /** The SessionIndexes named (none = every session of the NameID). */
  sessionIndexes: string[];
  /** The RelayState to echo. */
  relayState?: string;
}

/**
 * Verify an IdP-initiated LogoutRequest.
 *
 * @throws {SamlError} `unsigned`, `bad_signature`, `signature_wrapping`, `bad_binding`,
 *   `malformed_response`, `bad_destination`, `bad_issuer`, `expired`, `not_yet_valid`,
 *   `unexpected_markup`, `encrypted_assertion_unsupported` (an EncryptedID without an SP
 *   decryption key), `decryption_failed` / `unsupported_algorithm` (an EncryptedID) or `replay`.
 */
export async function verifyLogoutRequest(
  options: VerifyLogoutOptions,
): Promise<VerifiedLogoutRequest> {
  const env = await envelope(options, "LogoutRequest");
  checkWindow(env.clock, undefined, parseTime(env.root, "NotOnOrAfter"));
  // envelope() verified the signature (the query's or the enveloped one), which covers an
  // EncryptedID's cipher text: it is decrypted only now.
  const nameIdEl = await soleNameId(env.root, options.sp.encryptionKey, true);
  const nameId = textOnly(nameIdEl);
  if (!nameId) malformed("empty NameID");
  const sessionIndexes = childElements(env.root, SAMLP_NS, "SessionIndex").map(textOnly);
  await claim(options, env);
  const out: VerifiedLogoutRequest = { id: env.id, issuer: env.issuer, nameId, sessionIndexes };
  const format = attr(nameIdEl, "Format");
  if (format !== undefined) out.nameIdFormat = format;
  if (env.relayState !== undefined) out.relayState = env.relayState;
  return out;
}

/** A LogoutResponse that passed every check. */
export interface VerifiedLogoutResponse {
  /** The response ID. */
  id: string;
  /** The request it answers. */
  inResponseTo: string;
  /** Whether the IdP reports the logout succeeded (`…:status:Success`). */
  success: boolean;
  /** The top-level status code. */
  status: string;
  /** The RelayState echoed. */
  relayState?: string;
}

/**
 * Verify the LogoutResponse answering an SP-initiated LogoutRequest.
 *
 * @param options The message, the IdP, the SP, the replay cache and `expectedInResponseTo`.
 * @throws {SamlError} As {@link verifyLogoutRequest}, plus `in_response_to_mismatch`.
 */
export async function verifyLogoutResponse(
  options: VerifyLogoutOptions & { expectedInResponseTo: string },
): Promise<VerifiedLogoutResponse> {
  const env = await envelope(options, "LogoutResponse");
  const inResponseTo = attr(env.root, "InResponseTo");
  if (inResponseTo === undefined || inResponseTo !== options.expectedInResponseTo) {
    refuse("in_response_to_mismatch", "the LogoutResponse does not answer the expected request");
  }
  const status = statusOf(env.root);
  await claim(options, env);
  const out: VerifiedLogoutResponse = {
    id: env.id,
    inResponseTo,
    success: status === STATUS_SUCCESS,
    status,
  };
  if (env.relayState !== undefined) out.relayState = env.relayState;
  return out;
}
