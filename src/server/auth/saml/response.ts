/**
 * `verifySamlResponse`: validate an HTTP-POST-binding SAML 2.0 Response and return the
 * claims of its one Assertion — read only from the element object whose signature verified.
 *
 * @module
 */

import { decodeBase64 } from "./x509.ts";
import { directSignature, indexIds, verifyEnvelopedSignature } from "./dsig.ts";
import { SamlError, type SamlErrorCode } from "./errors.ts";
import {
  attr,
  childElements,
  MAX_XML_BYTES,
  parseXml,
  type XmlDocument,
  type XmlElement,
} from "./xml.ts";
import type { SamlIdpConfig, SamlSpConfig } from "./config.ts";

/** The SAML 2.0 assertion namespace. */
const SAML_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
/** The SAML 2.0 protocol namespace. */
const SAMLP_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const ENTITY_FORMAT = "urn:oasis:names:tc:SAML:2.0:nameid-format:entity";

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
}

/** Options for {@link verifySamlResponse}. */
export interface VerifySamlResponseOptions {
  /** The base64 `SAMLResponse` form field (HTTP-POST binding). */
  samlResponse: string;
  /** The trusted IdP: its entity id and signing certificates. */
  idp: SamlIdpConfig;
  /** This SP: its entity id (the Audience) and ACS URL (Destination / Recipient). */
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

function refuse(code: SamlErrorCode, message: string): never {
  throw new SamlError(code, message);
}

function malformed(message: string): never {
  throw new SamlError("malformed_response", message);
}

/** The single child `ns:local` of `el`; `required` refuses its absence. */
function single(el: XmlElement, ns: string, local: string, required: true): XmlElement;
function single(el: XmlElement, ns: string, local: string, required: false): XmlElement | undefined;
function single(el: XmlElement, ns: string, local: string, required: boolean) {
  const found = childElements(el, ns, local);
  if (found.length > 1) malformed(`<${el.local}> holds ${found.length} <${local}> elements`);
  if (required && !found.length) malformed(`<${el.local}> is missing <${local}>`);
  return found[0];
}

/**
 * The text of an element that must hold only text. A comment or child element inside it
 * is refused: text split around a comment is how NameID truncation attacks
 * (CVE-2017-11427 and kin) smuggle `user@evil.com<!---->.good.com` past a signature.
 */
function textOnly(el: XmlElement): string {
  let text = "";
  for (const c of el.children) {
    if (c.type !== "text") refuse("unexpected_markup", `markup inside <${el.local}>`);
    text += c.value;
  }
  return text.trim();
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]00:00)?$/;

/** An `xs:dateTime` in UTC, as epoch milliseconds. */
function parseTime(el: XmlElement, name: string): number | undefined {
  const raw = attr(el, name);
  if (raw === undefined) return undefined;
  const m = DATE_TIME.exec(raw.trim());
  if (!m) malformed(`bad ${name} "${raw}"`);
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  if (
    check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 ||
    minute > 59 || second > 59
  ) {
    malformed(`bad ${name} "${raw}"`);
  }
  return ms + (m[7] ? Math.floor(Number(`0${m[7]}`) * 1000) : 0);
}

function checkIssuer(el: XmlElement | undefined, idp: SamlIdpConfig, where: string): string {
  if (!el) return "";
  const format = attr(el, "Format");
  if (format !== undefined && format !== ENTITY_FORMAT) {
    refuse("bad_issuer", `${where} Issuer has Format ${format}`);
  }
  const issuer = textOnly(el);
  if (issuer !== idp.entityId) refuse("bad_issuer", `${where} Issuer is not the configured IdP`);
  return issuer;
}

interface Clock {
  now: number;
  skew: number;
}

function checkWindow(clock: Clock, notBefore?: number, notOnOrAfter?: number): void {
  if (notBefore !== undefined && clock.now + clock.skew < notBefore) {
    refuse("not_yet_valid", "the assertion is not valid yet");
  }
  if (notOnOrAfter !== undefined && clock.now - clock.skew >= notOnOrAfter) {
    refuse("expired", "the assertion has expired");
  }
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
  const status = single(response, SAMLP_NS, "Status", true);
  const code = single(status, SAMLP_NS, "StatusCode", true);
  if (attr(code, "Value") !== STATUS_SUCCESS) {
    refuse("status_not_success", `status ${attr(code, "Value") ?? "(none)"}`);
  }
}

/** Exactly one plaintext Assertion in the whole document, a direct child of the Response. */
function soleAssertion(elements: XmlElement[], response: XmlElement): XmlElement {
  const assertions: XmlElement[] = [];
  for (const el of elements) {
    if (el.ns !== SAML_NS) continue;
    if (el.local === "EncryptedAssertion" || el.local === "EncryptedID") {
      refuse("encrypted_assertion_unsupported", `<${el.local}> is not supported`);
    }
    if (el.local === "Assertion") assertions.push(el);
  }
  if (assertions.length > 1) {
    refuse("multiple_assertions", `the document holds ${assertions.length} assertions`);
  }
  const [assertion] = assertions;
  if (!assertion) malformed("the Response holds no Assertion");
  if (assertion.parent !== response) malformed("the Assertion is not a child of the Response");
  return assertion;
}

/**
 * Verify an HTTP-POST-binding SAML 2.0 Response and return its Assertion's claims.
 *
 * Checks, in order: well-formed strict XML (no DOCTYPE); a samlp:Response root with status
 * Success; no encrypted assertion and exactly one Assertion in the whole document, a direct
 * child of the Response; unique IDs; every signature present on the Response or Assertion
 * verifies with a configured certificate, and at least one is present (the Assertion's when
 * `requireSignedAssertion`); Destination; Issuers; a bearer SubjectConfirmation for this
 * ACS URL; Conditions and AudienceRestriction; the AuthnStatement session window;
 * InResponseTo; and finally the replay cache. Claims are read only from the verified
 * element objects.
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
  const assertion = soleAssertion(doc.elements, response);
  const responseSigned = await verifySignatures(doc, response, assertion, options);
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
  return result;
}

/**
 * Verify every signature present on the Response and on its Assertion (each must verify),
 * and require at least one — the Assertion's when `requireSignedAssertion`. A Response
 * signature vouches for the Assertion because `soleAssertion` made it a direct child.
 *
 * @returns Whether the Response itself is signed.
 */
async function verifySignatures(
  doc: XmlDocument,
  response: XmlElement,
  assertion: XmlElement,
  options: VerifySamlResponseOptions,
): Promise<boolean> {
  const ids = indexIds(doc);
  const certificates = options.idp.certificates;
  const responseSignature = directSignature(response);
  if (responseSignature) {
    await verifyEnvelopedSignature(ids, response, responseSignature, certificates);
  }
  const assertionSignature = directSignature(assertion);
  if (assertionSignature) {
    await verifyEnvelopedSignature(ids, assertion, assertionSignature, certificates);
  } else if (options.requireSignedAssertion) {
    refuse("unsigned", "the Assertion is not signed");
  }
  if (!responseSignature && !assertionSignature) {
    refuse("unsigned", "neither Response nor Assertion is signed");
  }
  return responseSignature !== undefined;
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
