/**
 * `verifySamlResponse`: validate an HTTP-POST-binding SAML 2.0 Response and return the
 * claims of its one Assertion — read only from the element object whose signature verified.
 *
 * @module
 */

import { decodeBase64 } from "./x509.ts";
import { directSignature, indexIds, verifyEnvelopedSignature } from "./dsig.ts";
import { SamlError } from "./errors.ts";
import {
  attr,
  childElements,
  inScopeNamespaces,
  MAX_XML_BYTES,
  parseXml,
  type XmlDocument,
  type XmlElement,
} from "./xml.ts";
import type { SamlIdpConfig, SamlSpConfig } from "./config.ts";
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
import { decryptAssertion, readEncryptedAssertion } from "./xmlenc.ts";

const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";

/**
 * Where assertion IDs are remembered so each is accepted once. Back it with something every
 * replica shares (a database table, a KV store) when the SP runs on more than one process.
 */
export interface SamlReplayCache {
  /**
   * Record `assertionId`. Return `true` the first time an id is claimed and `false` on every
   * later claim (a replay). The entry must be kept at least until `expiresAt` (epoch seconds:
   * the assertion's NotOnOrAfter plus the allowed clock skew); it may be dropped after.
   */
  claim(assertionId: string, expiresAt: number): Promise<boolean> | boolean;
}

/**
 * A process-local {@link SamlReplayCache}. Right for one server process (and for tests);
 * use a shared store when several replicas receive SAML Responses.
 */
export function inMemorySamlReplayCache(): SamlReplayCache {
  const seen = new Map<string, number>();
  return {
    claim(assertionId, expiresAt) {
      if (seen.has(assertionId)) return false;
      const now = Date.now() / 1000;
      for (const [id, exp] of seen) if (exp < now) seen.delete(id);
      seen.set(assertionId, expiresAt);
      return true;
    },
  };
}

/** The claims of a Response that passed every check. */
export interface VerifiedSamlAssertion {
  /** The Assertion's Issuer (equal to the configured IdP entity id). */
  issuer: string;
  /** The Assertion's ID (already claimed in the replay cache). */
  assertionId: string;
  /** The Subject's NameID text. */
  nameId: string;
  /** The NameID's Format, when given. */
  nameIdFormat?: string;
  /** The AuthnStatement's SessionIndex, when given (needed for Single Logout). */
  sessionIndex?: string;
  /** Attribute values by Attribute `Name` (repeated Attributes merge). */
  attributes: Record<string, string[]>;
  /** When the assertion stops being acceptable, in epoch seconds. */
  notOnOrAfter: number;
  /** The InResponseTo the assertion answers, when it answers an AuthnRequest. */
  inResponseTo?: string;
  /** Whether the Assertion arrived encrypted (an EncryptedAssertion). */
  encrypted?: boolean;
}

/** Options for {@link verifySamlResponse}. */
export interface VerifySamlResponseOptions {
  /** The base64 `SAMLResponse` form field (HTTP-POST binding). */
  samlResponse: string;
  /** The trusted IdP: its entity id and signing certificates. */
  idp: SamlIdpConfig;
  /**
   * This SP: its entity id (the Audience) and ACS URL (Destination / Recipient), and its
   * `encryptionKey` when IdPs encrypt assertions to it.
   */
  sp: SamlSpConfig;
  /**
   * The AuthnRequest ID this Response must answer.
   * - a string: the Response must carry exactly this InResponseTo (SP-initiated).
   * - `null`: the Response must carry NO InResponseTo — only an unsolicited (IdP-initiated)
   *   Response is acceptable, and only with `allowIdpInitiated: true`.
   * - `undefined` (omitted): not compared; an InResponseTo, when present, is returned in
   *   {@link VerifiedSamlAssertion.inResponseTo} for the caller to look up, and a Response
   *   without one is accepted only with `allowIdpInitiated: true`.
   */
  expectedInResponseTo?: string | null;
  /** Accept a Response with no InResponseTo (IdP-initiated SSO). Default `false`. */
  allowIdpInitiated?: boolean;
  /**
   * Require the Assertion itself to be signed; a signature over the Response alone is then
   * not enough. Default `false` (either signature suffices). Set it when the SP metadata
   * says `WantAssertionsSigned="true"`.
   */
  requireSignedAssertion?: boolean;
  /** Where Assertion IDs are remembered, so each is accepted once. */
  replayCache: SamlReplayCache;
  /** The current time, epoch milliseconds. Default `Date.now()`. */
  now?: number;
  /** Clock skew tolerated on every time check, in seconds. Default 60. */
  clockSkewSeconds?: number;
}

interface Confirmation {
  notOnOrAfter: number;
  inResponseTo?: string;
}

/** Find a bearer SubjectConfirmation that names this SP and is in its window. */
function bearerConfirmation(subject: XmlElement, sp: SamlSpConfig, clock: Clock): Confirmation {
  let failure: SamlError | undefined;
  for (const sc of childElements(subject, SAML_NS, "SubjectConfirmation")) {
    if (attr(sc, "Method") !== BEARER) continue;
    try {
      const data = single(sc, SAML_NS, "SubjectConfirmationData", true);
      if (attr(data, "Recipient") !== sp.acsUrl) {
        refuse("bad_recipient", "SubjectConfirmationData Recipient is not this ACS URL");
      }
      const notOnOrAfter = parseTime(data, "NotOnOrAfter");
      if (notOnOrAfter === undefined) malformed("bearer confirmation without NotOnOrAfter");
      checkWindow(clock, parseTime(data, "NotBefore"), notOnOrAfter);
      return { notOnOrAfter, inResponseTo: attr(data, "InResponseTo") };
    } catch (err) {
      failure ??= err as SamlError;
    }
  }
  throw failure ?? new SamlError("bad_subject_confirmation", "no bearer SubjectConfirmation");
}

function checkConditions(
  conditions: XmlElement,
  sp: SamlSpConfig,
  clock: Clock,
): number | undefined {
  const notOnOrAfter = parseTime(conditions, "NotOnOrAfter");
  checkWindow(clock, parseTime(conditions, "NotBefore"), notOnOrAfter);
  const restrictions = childElements(conditions, SAML_NS, "AudienceRestriction");
  if (!restrictions.length) refuse("bad_audience", "the assertion has no AudienceRestriction");
  for (const r of restrictions) {
    const audiences = childElements(r, SAML_NS, "Audience").map(textOnly);
    if (!audiences.includes(sp.entityId)) {
      refuse("bad_audience", "an AudienceRestriction does not name this SP");
    }
  }
  return notOnOrAfter;
}

function readAttributes(assertion: XmlElement): Record<string, string[]> {
  const out: Record<string, string[]> = Object.create(null);
  for (const statement of childElements(assertion, SAML_NS, "AttributeStatement")) {
    for (const a of childElements(statement, SAML_NS, "Attribute")) {
      const name = attr(a, "Name");
      if (!name) malformed("Attribute without a Name");
      const values = (out[name] ??= []);
      for (const v of childElements(a, SAML_NS, "AttributeValue")) {
        // A structured value (e.g. a NameID-typed attribute) has no single string form.
        if (v.children.some((c) => c.type === "element")) continue;
        values.push(textOnly(v));
      }
    }
  }
  return { ...out };
}

/**
 * The InResponseTo the Response answers. The signed bearer confirmation's value wins; the
 * Response element's own value counts only when the Response is signed (an unsigned
 * envelope could otherwise turn an unsolicited assertion into a "solicited" one).
 */
function answeredRequest(
  response: XmlElement,
  responseSigned: boolean,
  confirmation: Confirmation,
): string | undefined {
  const onResponse = attr(response, "InResponseTo");
  const fromConfirmation = confirmation.inResponseTo;
  if (
    onResponse !== undefined && fromConfirmation !== undefined && onResponse !== fromConfirmation
  ) {
    refuse("in_response_to_mismatch", "Response and SubjectConfirmationData disagree");
  }
  return fromConfirmation ?? (responseSigned ? onResponse : undefined);
}

/** Hold the answered request id against `expectedInResponseTo` / `allowIdpInitiated`. */
function checkInResponseTo(
  inResponseTo: string | undefined,
  options: VerifySamlResponseOptions,
): void {
  const expected = options.expectedInResponseTo;
  if (inResponseTo !== undefined) {
    if (expected === null || (typeof expected === "string" && inResponseTo !== expected)) {
      refuse("in_response_to_mismatch", "InResponseTo is not the expected request");
    }
    return;
  }
  if (typeof expected === "string") {
    refuse("in_response_to_mismatch", "the Response does not answer the expected request");
  }
  if (!options.allowIdpInitiated) {
    refuse("idp_initiated_disallowed", "unsolicited Responses are not accepted");
  }
}

/** Decode the form field into bytes, refusing non-base64 and oversized input. */
function decodeField(samlResponse: string): Uint8Array {
  if (samlResponse.length > Math.ceil(MAX_XML_BYTES / 3) * 4 + 16384) {
    refuse("malformed_xml", "SAMLResponse is too large");
  }
  const bytes = decodeBase64(samlResponse);
  if (!bytes) refuse("malformed_xml", "SAMLResponse is not base64");
  return bytes;
}

/** The Response's top-level status must be Success. */
function checkStatus(response: XmlElement): void {
  const status = statusOf(response);
  if (status !== STATUS_SUCCESS) refuse("status_not_success", `status ${status || "(none)"}`);
}

/** The one assertion of a Response: plaintext, or an EncryptedAssertion still to open. */
type Located = { encrypted: false; el: XmlElement } | { encrypted: true; el: XmlElement };

/**
 * Exactly one Assertion or EncryptedAssertion in the whole document, a direct child of the
 * Response; never an EncryptedID; an EncryptedAssertion only when a decryption key is set.
 */
function soleAssertion(
  elements: XmlElement[],
  response: XmlElement,
  canDecrypt: boolean,
): Located {
  const found: Located[] = [];
  for (const el of elements) {
    if (el.ns !== SAML_NS) continue;
    if (el.local === "EncryptedID" || (el.local === "EncryptedAssertion" && !canDecrypt)) {
      refuse("encrypted_assertion_unsupported", `<${el.local}> is not supported`);
    }
    if (el.local === "Assertion") found.push({ encrypted: false, el });
    if (el.local === "EncryptedAssertion") found.push({ encrypted: true, el });
  }
  if (found.length > 1) {
    refuse("multiple_assertions", `the document holds ${found.length} assertions`);
  }
  const [assertion] = found;
  if (!assertion) malformed("the Response holds no Assertion");
  if (assertion.el.parent !== response) {
    malformed("the Assertion is not a child of the Response");
  }
  return assertion;
}

/**
 * Verify an HTTP-POST-binding SAML 2.0 Response and return its Assertion's claims.
 *
 * Checks, in order: well-formed strict XML (no DOCTYPE); a samlp:Response root with status
 * Success; no EncryptedID and exactly one Assertion or EncryptedAssertion in the whole document,
 * a direct child of the Response; unique IDs; the Response signature, when present, BEFORE
 * anything is decrypted (so it covers the cipher text); an EncryptedAssertion decrypted with
 * `sp.encryptionKey` and its content parsed by the same strict parser (no DOCTYPE, exactly one
 * Assertion, IDs unique across the outer document and the decrypted one); every signature
 * present verifies with a configured certificate and at least one is present (the Assertion's
 * when `requireSignedAssertion`); Destination; Issuers; a bearer SubjectConfirmation for this
 * ACS URL; Conditions and AudienceRestriction; the AuthnStatement session window; InResponseTo;
 * and finally the replay cache. Claims are read only from the verified element objects.
 *
 * @throws {SamlError} With a stable `code` naming the first failed check.
 */
export async function verifySamlResponse(
  options: VerifySamlResponseOptions,
): Promise<VerifiedSamlAssertion> {
  const clock: Clock = {
    now: options.now ?? Date.now(),
    skew: (options.clockSkewSeconds ?? 60) * 1000,
  };
  const doc = parseXml(decodeField(options.samlResponse));
  const response = doc.root;
  if (response.ns !== SAMLP_NS || response.local !== "Response") {
    malformed("the document element is not a samlp:Response");
  }
  if (attr(response, "Version") !== "2.0") malformed("the Response is not SAML 2.0");
  checkStatus(response);
  const located = soleAssertion(doc.elements, response, !!options.sp.encryptionKey);
  const { assertion, responseSigned } = await verifySignatures(doc, response, located, options);
  checkEnvelope(response, responseSigned, options);
  const claims = readAssertion(assertion, options, clock);
  const inResponseTo = answeredRequest(response, responseSigned, claims.confirmation);
  checkInResponseTo(inResponseTo, options);
  const attributes = readAttributes(assertion);

  const notOnOrAfterMs = Math.min(claims.confirmation.notOnOrAfter, claims.conditionsEnd);
  const expiresAt = Math.ceil((notOnOrAfterMs + clock.skew) / 1000);
  if (!(await options.replayCache.claim(claims.assertionId, expiresAt))) {
    refuse("replay", "the Assertion was already used");
  }
  const result: VerifiedSamlAssertion = {
    issuer: claims.issuer,
    assertionId: claims.assertionId,
    nameId: claims.nameId,
    attributes,
    notOnOrAfter: Math.floor(notOnOrAfterMs / 1000),
  };
  if (claims.nameIdFormat !== undefined) result.nameIdFormat = claims.nameIdFormat;
  if (claims.sessionIndex !== undefined) result.sessionIndex = claims.sessionIndex;
  if (inResponseTo !== undefined) result.inResponseTo = inResponseTo;
  if (located.encrypted) result.encrypted = true;
  return result;
}

/**
 * Verify every signature present on the Response and on its Assertion (each must verify),
 * and require at least one — the Assertion's when `requireSignedAssertion`. A Response
 * signature vouches for the Assertion (or the EncryptedAssertion's cipher text) because
 * `soleAssertion` made it a direct child; it is verified before anything is decrypted.
 *
 * @returns The (decrypted, when it was encrypted) Assertion and whether the Response is signed.
 */
async function verifySignatures(
  doc: XmlDocument,
  response: XmlElement,
  located: Located,
  options: VerifySamlResponseOptions,
): Promise<{ assertion: XmlElement; responseSigned: boolean }> {
  const ids = indexIds(doc);
  const certificates = options.idp.certificates;
  const responseSignature = directSignature(response);
  if (responseSignature) {
    await verifyEnvelopedSignature(ids, response, responseSignature, certificates);
  }
  const responseSigned = responseSignature !== undefined;
  if (located.encrypted) {
    const assertion = await openEncrypted(doc, located.el, responseSigned, options);
    return { assertion, responseSigned };
  }
  const assertionSigned = await verifyAssertionSignature(ids, located.el, options);
  requireSignature(responseSigned, assertionSigned, options);
  return { assertion: located.el, responseSigned };
}

/** Verify the Assertion's own signature when it has one. @returns Whether it is signed. */
async function verifyAssertionSignature(
  ids: Map<string, XmlElement>,
  assertion: XmlElement,
  options: VerifySamlResponseOptions,
): Promise<boolean> {
  const signature = directSignature(assertion);
  if (!signature) return false;
  await verifyEnvelopedSignature(ids, assertion, signature, options.idp.certificates);
  return true;
}

/** At least one signature, and the Assertion's when `requireSignedAssertion`. */
function requireSignature(
  responseSigned: boolean,
  assertionSigned: boolean,
  options: VerifySamlResponseOptions,
): void {
  if (!assertionSigned && options.requireSignedAssertion) {
    refuse("unsigned", "the Assertion is not signed");
  }
  if (!responseSigned && !assertionSigned) {
    refuse("unsigned", "neither Response nor Assertion is signed");
  }
}

/**
 * Decrypt an EncryptedAssertion and verify what it holds exactly as a plaintext Assertion.
 *
 * When the Response signature does not cover the cipher text (the Response is unsigned), the
 * cipher text is attacker-malleable (AES-CBC) or attacker-made (anyone can encrypt to the SP's
 * public key), so every refusal from the key unwrap to the decrypted Assertion's signature is
 * the one `decryption_failed`: the answer is no decryption, padding or well-formedness oracle.
 */
async function openEncrypted(
  doc: XmlDocument,
  container: XmlElement,
  responseSigned: boolean,
  options: VerifySamlResponseOptions,
): Promise<XmlElement> {
  const parts = readEncryptedAssertion(container);
  const open = async () => {
    const bytes = await decryptAssertion(parts, options.sp.encryptionKey!);
    const inner = parseXml(bytes, { inScope: inScopeNamespaces(container) });
    const assertion = decryptedAssertion(inner);
    const ids = indexIds({ root: doc.root, elements: [...doc.elements, ...inner.elements] });
    const signed = await verifyAssertionSignature(ids, assertion, options);
    requireSignature(responseSigned, signed, options);
    return assertion;
  };
  if (responseSigned) return await open();
  try {
    return await open();
  } catch (error) {
    if (error instanceof SamlError && error.code === "bad_key") throw error;
    throw new SamlError("decryption_failed", "the encrypted assertion could not be opened");
  }
}

/** The decrypted content must be one saml:Assertion holding no other (encrypted) assertion. */
function decryptedAssertion(inner: XmlDocument): XmlElement {
  const root = inner.root;
  if (root.ns !== SAML_NS || root.local !== "Assertion") {
    malformed("the EncryptedAssertion does not hold an Assertion");
  }
  for (const el of inner.elements) {
    if (el === root || el.ns !== SAML_NS) continue;
    if (el.local === "Assertion" || el.local === "EncryptedAssertion") {
      refuse("multiple_assertions", "the decrypted Assertion holds another assertion");
    }
    if (el.local === "EncryptedID") {
      refuse("encrypted_assertion_unsupported", "<EncryptedID> is not supported");
    }
  }
  return root;
}

/** Destination (required on a signed Response) and the Response Issuer, when present. */
function checkEnvelope(
  response: XmlElement,
  responseSigned: boolean,
  options: VerifySamlResponseOptions,
): void {
  const destination = attr(response, "Destination");
  if (destination !== undefined ? destination !== options.sp.acsUrl : responseSigned) {
    refuse("bad_destination", "the Response Destination is not this ACS URL");
  }
  checkIssuer(single(response, SAML_NS, "Issuer", false), options.idp, "Response");
}

interface AssertionClaims {
  issuer: string;
  assertionId: string;
  nameId: string;
  nameIdFormat?: string;
  sessionIndex?: string;
  confirmation: Confirmation;
  /** Conditions NotOnOrAfter in epoch ms (`Infinity` when absent). */
  conditionsEnd: number;
}

/** Every check on the (verified) Assertion element itself. */
function readAssertion(
  assertion: XmlElement,
  options: VerifySamlResponseOptions,
  clock: Clock,
): AssertionClaims {
  if (attr(assertion, "Version") !== "2.0") malformed("the Assertion is not SAML 2.0");
  const assertionId = attr(assertion, "ID");
  if (!assertionId) malformed("the Assertion has no ID");
  const issuer = checkIssuer(single(assertion, SAML_NS, "Issuer", true), options.idp, "Assertion");
  const issueInstant = parseTime(assertion, "IssueInstant");
  if (issueInstant === undefined) malformed("the Assertion has no IssueInstant");
  checkWindow(clock, issueInstant);

  const subject = single(assertion, SAML_NS, "Subject", true);
  const nameIdEl = single(subject, SAML_NS, "NameID", true);
  const nameId = textOnly(nameIdEl);
  if (!nameId) malformed("empty NameID");
  const confirmation = bearerConfirmation(subject, options.sp, clock);
  const conditions = single(assertion, SAML_NS, "Conditions", true);
  const conditionsEnd = checkConditions(conditions, options.sp, clock) ?? Infinity;

  const authn = childElements(assertion, SAML_NS, "AuthnStatement");
  if (!authn.length) malformed("the Assertion has no AuthnStatement");
  for (const statement of authn) {
    checkWindow(clock, undefined, parseTime(statement, "SessionNotOnOrAfter"));
  }
  return {
    issuer,
    assertionId,
    nameId,
    nameIdFormat: attr(nameIdEl, "Format"),
    sessionIndex: attr(authn[0], "SessionIndex"),
    confirmation,
    conditionsEnd,
  };
}
