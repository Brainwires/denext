/**
 * What the SAML protocol readers share: namespaces, strict child / text accessors, `xs:dateTime`
 * parsing, the validity-window and Issuer checks.
 *
 * @module
 */

import { SamlError, type SamlErrorCode } from "./errors.ts";
import { attr, childElements, type XmlElement } from "./xml.ts";
import type { SamlIdpConfig } from "./config.ts";

/** The SAML 2.0 assertion namespace. */
export const SAML_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
/** The SAML 2.0 protocol namespace. */
export const SAMLP_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
/** The top-level success status. */
export const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const ENTITY_FORMAT = "urn:oasis:names:tc:SAML:2.0:nameid-format:entity";

/** Throw a {@link SamlError}. */
export function refuse(code: SamlErrorCode, message: string): never {
  throw new SamlError(code, message);
}

/** Throw `malformed_response`. */
export function malformed(message: string): never {
  throw new SamlError("malformed_response", message);
}

/** The single child `ns:local` of `el`; `required` refuses its absence. */
export function single(el: XmlElement, ns: string, local: string, required: true): XmlElement;
export function single(
  el: XmlElement,
  ns: string,
  local: string,
  required: false,
): XmlElement | undefined;
export function single(el: XmlElement, ns: string, local: string, required: boolean) {
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
export function textOnly(el: XmlElement): string {
  let text = "";
  for (const c of el.children) {
    if (c.type !== "text") refuse("unexpected_markup", `markup inside <${el.local}>`);
    text += c.value;
  }
  return text.trim();
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]00:00)?$/;

/** An `xs:dateTime` attribute in UTC, as epoch milliseconds (`undefined` when absent). */
export function parseTime(el: XmlElement, name: string): number | undefined {
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

/** An Issuer, when present, must be the configured IdP (entity format or none). */
export function checkIssuer(
  el: XmlElement | undefined,
  idp: SamlIdpConfig,
  where: string,
): string {
  if (!el) return "";
  const format = attr(el, "Format");
  if (format !== undefined && format !== ENTITY_FORMAT) {
    refuse("bad_issuer", `${where} Issuer has Format ${format}`);
  }
  const issuer = textOnly(el);
  if (issuer !== idp.entityId) refuse("bad_issuer", `${where} Issuer is not the configured IdP`);
  return issuer;
}

/** The verification clock: now and the tolerated skew, in milliseconds. */
export interface Clock {
  now: number;
  skew: number;
}

/** Refuse a window that has not started or has ended (with skew). */
export function checkWindow(clock: Clock, notBefore?: number, notOnOrAfter?: number): void {
  if (notBefore !== undefined && clock.now + clock.skew < notBefore) {
    refuse("not_yet_valid", "the message is not valid yet");
  }
  if (notOnOrAfter !== undefined && clock.now - clock.skew >= notOnOrAfter) {
    refuse("expired", "the message has expired");
  }
}

/** The top-level StatusCode value of a protocol response (required). */
export function statusOf(response: XmlElement): string {
  const status = single(response, SAMLP_NS, "Status", true);
  const code = single(status, SAMLP_NS, "StatusCode", true);
  return attr(code, "Value") ?? "";
}
