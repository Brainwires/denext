// A test SAML identity provider for the `/auth/v1` suites: its metadata, signed (and optionally
// encrypted) Responses for an AuthnRequest, and signed logout messages — all against the live
// clock, for the app at `ORIGIN`.

import { encode, marker, responseXml, rsaKey, sign, type TestKey } from "./_saml-helpers.ts";
import {
  encryptAssertion,
  type EncryptOptions,
  logoutRequestXml,
  logoutResponseXml,
  redirectQuery,
  type SpKey,
} from "./_saml-enc-helpers.ts";
import { ORIGIN } from "./_supabase-auth-app.ts";

const SP_ENTITY = `${ORIGIN}/auth/v1/sso/saml/metadata`;
export const ACS = `${ORIGIN}/auth/v1/sso/saml/acs`;
export const SLO = `${ORIGIN}/auth/v1/sso/saml/slo`;

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A test IdP. */
export interface TestIdp {
  entityId: string;
  key: TestKey;
  ssoUrl: string;
  sloUrl: string;
  metadataXml(options?: { slo?: boolean; ssoUrl?: string }): string;
  /** A signed SAMLResponse (base64) answering `inResponseTo`. */
  response(options: {
    inResponseTo: string | null;
    nameId: string;
    sessionIndex?: string;
    attributes?: Record<string, string[]>;
    encryptTo?: SpKey;
    encrypt?: EncryptOptions;
  }): Promise<string>;
  /** A LogoutRequest signed over the HTTP-Redirect binding (the query string). */
  logoutRequestQuery(
    fields: Parameters<typeof logoutRequestXml>[0],
    relayState?: string,
  ): Promise<string>;
  /** A LogoutRequest signed with an enveloped XML signature (HTTP-POST). */
  logoutRequestPost(fields: Parameters<typeof logoutRequestXml>[0]): Promise<string>;
  /** A LogoutResponse signed over the HTTP-Redirect binding. */
  logoutResponseQuery(inResponseTo: string, relayState: string, status?: string): Promise<string>;
}

/**
 * Build a test IdP.
 *
 * @param entityId Its entity id.
 * @returns The IdP.
 */
export async function testIdp(entityId = "https://idp.example.org/metadata"): Promise<TestIdp> {
  const key = await rsaKey();
  const host = new URL(entityId).origin;
  const ssoUrl = `${host}/sso`;
  const sloUrl = `${host}/slo`;
  const now = () => Date.now();
  return {
    entityId,
    key,
    ssoUrl,
    sloUrl,
    metadataXml(options = {}) {
      const slo = options.slo === false
        ? ""
        : `<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${sloUrl}"/>`;
      return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${entityId}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${key.certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>${slo}
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${
        options.ssoUrl ?? ssoUrl
      }"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
    },
    async response(options) {
      const t = now();
      const id = `_a${crypto.randomUUID().replaceAll("-", "")}`;
      const attributes = Object.entries(options.attributes ?? {}).map(([name, values]) =>
        `<saml:Attribute Name="${name}">${
          values.map((v) => `<saml:AttributeValue>${v}</saml:AttributeValue>`).join("")
        }</saml:Attribute>`
      ).join("");
      let xml = responseXml({
        destination: ACS,
        recipient: ACS,
        audience: SP_ENTITY,
        responseIssuer: entityId,
        issuer: entityId,
        responseInResponseTo: options.inResponseTo,
        inResponseTo: options.inResponseTo,
        nameId: options.nameId,
        notBefore: iso(t - 60_000),
        notOnOrAfter: iso(t + 300_000),
        confirmationNotOnOrAfter: iso(t + 300_000),
        issueInstant: iso(t - 1000),
        sessionNotOnOrAfter: iso(t + 3600_000),
        assertionId: id,
        assertionSig: marker(id),
        assertionTail: attributes
          ? `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>`
          : "",
      }).replace(
        `SessionIndex="_session1"`,
        `SessionIndex="${options.sessionIndex ?? "_session1"}"`,
      );
      xml = await sign(xml, id, { key });
      if (options.encryptTo) {
        const open = xml.indexOf("<saml:Assertion");
        const close = xml.indexOf("</saml:Assertion>") + "</saml:Assertion>".length;
        const assertion = xml.slice(open, close);
        xml = xml.replace(
          assertion,
          await encryptAssertion(assertion, options.encryptTo, options.encrypt),
        );
      }
      return encode(xml);
    },
    logoutRequestQuery(fields, relayState) {
      return redirectQuery(
        "SAMLRequest",
        logoutRequestXml({
          destination: SLO,
          issuer: entityId,
          issueInstant: iso(now()),
          ...fields,
        }),
        key,
        relayState !== undefined ? { relayState } : {},
      );
    },
    async logoutRequestPost(fields) {
      const id = fields?.id ?? `_lr${crypto.randomUUID().replaceAll("-", "")}`;
      const xml = logoutRequestXml({
        destination: SLO,
        issuer: entityId,
        issueInstant: iso(now()),
        ...fields,
        id,
        sig: marker(id),
      });
      return encode(await sign(xml, id, { key }));
    },
    logoutResponseQuery(inResponseTo, relayState, status) {
      return redirectQuery(
        "SAMLResponse",
        logoutResponseXml({
          id: `_lresp${crypto.randomUUID().replaceAll("-", "")}`,
          destination: SLO,
          issuer: entityId,
          issueInstant: iso(now()),
          inResponseTo,
          ...(status ? { status } : {}),
        }),
        key,
        { relayState },
      );
    },
  };
}

/** The `ID` of the request a redirect URL carries (`SAMLRequest`, DEFLATE + base64). */
export async function requestIdOf(url: string): Promise<string> {
  const raw = new URL(url).searchParams.get("SAMLRequest")!;
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  const xml = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
  ).text();
  return xml.match(/ ID="([^"]+)"/)![1];
}
