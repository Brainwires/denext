/**
 * SAML 2.0 metadata: read an IdP's EntityDescriptor, write this SP's.
 *
 * @module
 */

import type { SamlIdpConfig, SamlSpConfig } from "./config.ts";
import { DS_NS } from "./dsig.ts";
import { SamlError } from "./errors.ts";
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
 * @returns The entity id, the HTTP-Redirect SSO URL, the signing certificates (bare base64
 *   DER, those with a key type denext can verify) and the advertised NameID formats.
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
  return { entityId, ssoUrl, certificates, nameIdFormats };
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

/**
 * This SP's SAML 2.0 metadata (an EntityDescriptor with one SPSSODescriptor and its
 * HTTP-POST AssertionConsumerService), for the IdP administrator to import.
 *
 * @param sp This SP's entity id and ACS URL.
 * @param options `nameIdFormat` (default email address) and `wantAssertionsSigned`
 *   (default `true`; pair it with `requireSignedAssertion` when verifying).
 * @returns The metadata document.
 */
export function spMetadataXml(
  sp: SamlSpConfig,
  options: { nameIdFormat?: string; wantAssertionsSigned?: boolean } = {},
): string {
  const want = options.wantAssertionsSigned ?? true;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<md:EntityDescriptor xmlns:md="${MD_NS}" entityID="${escapeXml(sp.entityId)}">`,
    `  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="${want}" protocolSupportEnumeration="${PROTOCOL}">`,
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
