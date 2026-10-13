/**
 * SAML 2.0 metadata: read an IdP's EntityDescriptor, write this SP's.
 *
 * @module
 */

import type { SamlIdpConfig, SamlSpConfig } from "./config.ts";
import { DS_NS } from "./dsig.ts";
import { SamlError } from "./errors.ts";
import { certificateBody } from "./keys.ts";
import { certificateKey } from "./x509.ts";
import { attr, childElements, parseXml, type XmlElement } from "./xml.ts";

const MD_NS = "urn:oasis:names:tc:SAML:2.0:metadata";
const PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
/** The NameID format an SP asks for when none is given. */
export const DEFAULT_NAME_ID_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

function badMetadata(message: string): never {
  throw new SamlError("bad_metadata", message);
}

function text(el: XmlElement): string {
  let out = "";
  for (const c of el.children) {
    if (c.type !== "text") badMetadata(`markup inside <${el.local}>`);
    out += c.value;
  }
  return out.trim();
}

function idpDescriptor(root: XmlElement): { entity: XmlElement; idp: XmlElement } {
  let entities: XmlElement[];
  if (root.ns === MD_NS && root.local === "EntityDescriptor") entities = [root];
  else if (root.ns === MD_NS && root.local === "EntitiesDescriptor") {
    entities = childElements(root, MD_NS, "EntityDescriptor");
  } else badMetadata("the document is not SAML metadata");
  const found = entities.flatMap((entity) =>
    childElements(entity, MD_NS, "IDPSSODescriptor")
      .filter((d) => (attr(d, "protocolSupportEnumeration") ?? "").split(/\s+/).includes(PROTOCOL))
      .map((idp) => ({ entity, idp }))
  );
  if (found.length !== 1) {
    badMetadata(`expected one SAML 2.0 IDPSSODescriptor, found ${found.length}`);
  }
  return found[0];
}

/** Whether denext can verify signatures with this certificate's key. */
function usable(cert: string): boolean {
  try {
    certificateKey(cert);
    return true;
  } catch {
    return false; // a key type denext cannot verify with is no use as a trust anchor
  }
}

/** The X509Certificate values of the signing (or unmarked) KeyDescriptors, de-duplicated. */
function signingCertificates(idp: XmlElement): string[] {
  const certs = childElements(idp, MD_NS, "KeyDescriptor")
    .filter((kd) => (attr(kd, "use") ?? "signing") === "signing")
    .flatMap((kd) => childElements(kd, DS_NS, "KeyInfo"))
    .flatMap((keyInfo) => childElements(keyInfo, DS_NS, "X509Data"))
    .flatMap((data) => childElements(data, DS_NS, "X509Certificate"))
    .map((c) => text(c).replace(/\s+/g, ""))
    .filter(usable);
  return [...new Set(certs)];
}

/**
 * Read an IdP's SAML 2.0 metadata (an EntityDescriptor, or an EntitiesDescriptor holding
 * exactly one IdP). The metadata's own signature is NOT checked — fetch it over HTTPS from
 * a URL you trust, or pin the certificate it yields.
 *
 * @param xml The metadata document.
 * @returns The entity id, the HTTP-Redirect SSO URL, the HTTP-Redirect SingleLogoutService
 *   (when advertised), the signing certificates (bare base64 DER, those with a key type denext
 *   can verify) and the advertised NameID formats.
 * @throws {SamlError} `bad_metadata` (or `malformed_xml` / `doctype_forbidden`).
 */
export function parseIdpMetadata(xml: string): SamlIdpConfig & { nameIdFormats: string[] } {
  const { entity, idp } = idpDescriptor(parseXml(xml).root);
  const entityId = attr(entity, "entityID");
  if (!entityId) badMetadata("EntityDescriptor has no entityID");
  const sso = childElements(idp, MD_NS, "SingleSignOnService")
    .find((s) => attr(s, "Binding") === REDIRECT);
  const ssoUrl = sso && attr(sso, "Location");
  if (!ssoUrl) badMetadata("no HTTP-Redirect SingleSignOnService");
  const certificates = signingCertificates(idp);
  if (!certificates.length) badMetadata("no usable signing certificate");
  const nameIdFormats = childElements(idp, MD_NS, "NameIDFormat").map(text).filter(Boolean);
  const out: SamlIdpConfig & { nameIdFormats: string[] } = {
    entityId,
    ssoUrl,
    certificates,
    nameIdFormats,
  };
  const slo = childElements(idp, MD_NS, "SingleLogoutService")
    .find((s) => attr(s, "Binding") === REDIRECT);
  const sloUrl = slo && attr(slo, "Location");
  if (sloUrl) out.sloUrl = sloUrl;
  const sloResponseUrl = slo && attr(slo, "ResponseLocation");
  if (sloUrl && sloResponseUrl) out.sloResponseUrl = sloResponseUrl;
  return out;
}

/** Escape a string for an XML attribute value or text. */
export function escapeXml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      c === "&"
        ? "&amp;"
        : c === "<"
        ? "&lt;"
        : c === ">"
        ? "&gt;"
        : c === '"'
        ? "&quot;"
        : "&apos;",
  );
}

/** The algorithms an IdP may encrypt to this SP with (advertised with the encryption key). */
const ENCRYPTION_METHODS = [
  "http://www.w3.org/2009/xmlenc11#aes256-gcm",
  "http://www.w3.org/2009/xmlenc11#aes128-gcm",
  "http://www.w3.org/2001/04/xmlenc#aes256-cbc",
  "http://www.w3.org/2001/04/xmlenc#aes128-cbc",
  "http://www.w3.org/2009/xmlenc11#rsa-oaep",
  "http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p",
];

function keyDescriptor(use: "signing" | "encryption", certificate: string): string[] {
  const methods = use === "encryption"
    ? ENCRYPTION_METHODS.map((m) => `      <md:EncryptionMethod Algorithm="${m}"/>`)
    : [];
  return [
    `    <md:KeyDescriptor use="${use}">`,
    `      <ds:KeyInfo xmlns:ds="${DS_NS}"><ds:X509Data><ds:X509Certificate>${
      certificateBody(certificate)
    }</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`,
    ...methods,
    `    </md:KeyDescriptor>`,
  ];
}

/**
 * This SP's SAML 2.0 metadata (an EntityDescriptor with one SPSSODescriptor), for the IdP
 * administrator to import: its signing and encryption certificates (when configured), its
 * SingleLogoutService (HTTP-Redirect and HTTP-POST, when `sp.sloUrl` is set), the NameID
 * format and the HTTP-POST AssertionConsumerService.
 *
 * @param sp This SP's entity id, ACS URL and (optionally) SLO URL and certificates.
 * @param options `nameIdFormat` (default email address) and `wantAssertionsSigned`
 *   (default `true`; pair it with `requireSignedAssertion` when verifying).
 * @returns The metadata document.
 */
export function spMetadataXml(
  sp: SamlSpConfig,
  options: { nameIdFormat?: string; wantAssertionsSigned?: boolean } = {},
): string {
  const want = options.wantAssertionsSigned ?? true;
  const signs = !!(sp.signingKey && sp.signingCertificate);
  const slo = sp.sloUrl
    ? [REDIRECT, POST].map((b) =>
      `    <md:SingleLogoutService Binding="${b}" Location="${escapeXml(sp.sloUrl!)}"/>`
    )
    : [];
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<md:EntityDescriptor xmlns:md="${MD_NS}" entityID="${escapeXml(sp.entityId)}">`,
    `  <md:SPSSODescriptor AuthnRequestsSigned="${signs}" WantAssertionsSigned="${want}" protocolSupportEnumeration="${PROTOCOL}">`,
    ...(sp.signingCertificate ? keyDescriptor("signing", sp.signingCertificate) : []),
    ...(sp.encryptionCertificate ? keyDescriptor("encryption", sp.encryptionCertificate) : []),
    ...slo,
    `    <md:NameIDFormat>${
      escapeXml(options.nameIdFormat ?? DEFAULT_NAME_ID_FORMAT)
    }</md:NameIDFormat>`,
    `    <md:AssertionConsumerService Binding="${POST}" Location="${
      escapeXml(sp.acsUrl)
    }" index="0" isDefault="true"/>`,
    `  </md:SPSSODescriptor>`,
    `</md:EntityDescriptor>`,
    ``,
  ].join("\n");
}
