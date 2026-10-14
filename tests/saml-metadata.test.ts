// SAML SP configuration helpers: IdP metadata parsing, SP metadata, the HTTP-Redirect
// AuthnRequest, and the minimal X.509 reader that pins IdP keys.

import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import {
  buildAuthnRequest,
  parseIdpMetadata,
  SamlError,
  spMetadataXml,
} from "../src/server/auth/saml/mod.ts";
import { certificateKey } from "../src/server/auth/saml/x509.ts";
import { parseXml, type XmlElement } from "../src/server/auth/saml/xml.ts";
import * as server from "../src/server/mod.ts";
import { certificateFor, der, derOid, ecKey, rsaKey, SP } from "./_saml-helpers.ts";

const rsa = await rsaKey();
const ec = await ecKey();
const GOLDEN_RSA = Deno.readTextFileSync(new URL("./fixtures/saml/idp-rsa.crt", import.meta.url));

function code(fn: () => unknown): string {
  return assertThrows(fn, SamlError).code;
}

const MD =
  `xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"`;

function idpMetadata(inner: string, entityId = "https://idp.example.org/metadata"): string {
  return `<?xml version="1.0"?>
<md:EntityDescriptor ${MD} entityID="${entityId}">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
${inner}
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

const keyDescriptor = (cert: string, use?: string) =>
  `<md:KeyDescriptor${use ? ` use="${use}"` : ""}><ds:KeyInfo><ds:X509Data><ds:X509Certificate>
${cert.match(/.{1,64}/g)!.join("\n")}
</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`;

const SSO =
  `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.org/sso/post"/>
<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.org/sso/redirect"/>`;

Deno.test("saml metadata: parses an IdP EntityDescriptor", () => {
  const xml = idpMetadata(
    keyDescriptor(rsa.certificate, "signing") + keyDescriptor(ec.certificate) +
      keyDescriptor(rsa.certificate) + // a duplicate is listed once
      keyDescriptor(GOLDEN_RSA.replace(/-----[A-Z ]+-----|\s/g, ""), "encryption") +
      `<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
<md:NameIDFormat> urn:oasis:names:tc:SAML:2.0:nameid-format:persistent </md:NameIDFormat>` + SSO,
  );
  const idp = parseIdpMetadata(xml);
  assertEquals(idp.entityId, "https://idp.example.org/metadata");
  assertEquals(idp.ssoUrl, "https://idp.example.org/sso/redirect");
  assertEquals(idp.certificates, [rsa.certificate, ec.certificate]);
  assertEquals(idp.nameIdFormats, [
    "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  ]);
});

Deno.test("saml metadata: an EntitiesDescriptor with one IdP", () => {
  const sp =
    `<md:EntityDescriptor entityID="sp"><md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"/></md:EntityDescriptor>`;
  const inner = idpMetadata(keyDescriptor(rsa.certificate) + SSO).replace(/^<\?xml[^>]*>\n/, "")
    .replace(` ${MD}`, "");
  const idp = parseIdpMetadata(
    `<md:EntitiesDescriptor ${MD}>${sp}${inner}</md:EntitiesDescriptor>`,
  );
  assertEquals(idp.entityId, "https://idp.example.org/metadata");
  assertEquals(
    code(() =>
      parseIdpMetadata(`<md:EntitiesDescriptor ${MD}>${inner}${inner}</md:EntitiesDescriptor>`)
    ),
    "bad_metadata",
  );
});

Deno.test("saml metadata: refuses incomplete or hostile metadata", () => {
  assertEquals(code(() => parseIdpMetadata(`<a/>`)), "bad_metadata");
  assertEquals(code(() => parseIdpMetadata(idpMetadata(SSO))), "bad_metadata"); // no cert
  assertEquals(
    code(() => parseIdpMetadata(idpMetadata(keyDescriptor(rsa.certificate)))),
    "bad_metadata",
  ); // no redirect
  assertEquals(
    code(() => parseIdpMetadata(idpMetadata(keyDescriptor(rsa.certificate) + SSO, ""))),
    "bad_metadata",
  );
  assertEquals(
    code(() => parseIdpMetadata(idpMetadata(keyDescriptor(rsa.certificate, "encryption") + SSO))),
    "bad_metadata",
  );
  assertEquals(
    code(() => parseIdpMetadata(idpMetadata(keyDescriptor("bm90IGEgY2VydA==") + SSO))),
    "bad_metadata",
  );
  const commented = idpMetadata(keyDescriptor(rsa.certificate) + SSO).replace(
    "<ds:X509Certificate>",
    "<ds:X509Certificate><!---->",
  );
  assertEquals(code(() => parseIdpMetadata(commented)), "bad_metadata");
  const saml1 = idpMetadata(keyDescriptor(rsa.certificate) + SSO).replace(
    'protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"',
    'protocolSupportEnumeration="urn:oasis:names:tc:SAML:1.1:protocol"',
  );
  assertEquals(code(() => parseIdpMetadata(saml1)), "bad_metadata");
  assertEquals(
    code(() => parseIdpMetadata(`<!DOCTYPE x>${idpMetadata(SSO)}`)),
    "doctype_forbidden",
  );
});

Deno.test("saml metadata: spMetadataXml round-trips and escapes", () => {
  const xml = spMetadataXml({ entityId: `https://sp.example.com/m?a=1&b="2"`, acsUrl: SP.acsUrl });
  const root = parseXml(xml).root;
  const attr = (el: XmlElement, n: string) => el.attrs.find((a) => a.local === n)?.value;
  assertEquals(attr(root, "entityID"), `https://sp.example.com/m?a=1&b="2"`);
  const desc = root.children.find((c): c is XmlElement => c.type === "element")!;
  assertEquals(attr(desc, "WantAssertionsSigned"), "true");
  const els = desc.children.filter((c): c is XmlElement => c.type === "element");
  assertEquals(els.map((e) => e.local), ["NameIDFormat", "AssertionConsumerService"]);
  assertEquals(attr(els[1], "Location"), SP.acsUrl);
  assertEquals(attr(els[1], "Binding"), "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST");
  const custom = spMetadataXml(SP, {
    nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    wantAssertionsSigned: false,
  });
  assertMatch(custom, /WantAssertionsSigned="false"/);
  assertMatch(custom, /<md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</);
});

async function inflate(b64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}

Deno.test("saml AuthnRequest: HTTP-Redirect encoding and content", async () => {
  const idp = {
    entityId: "https://idp",
    ssoUrl: "https://idp.example.org/sso?tenant=a&x=1",
    certificates: [],
  };
  const { id, url } = await buildAuthnRequest({
    sp: SP,
    idp,
    relayState: "state & more",
    now: Date.UTC(2026, 9, 13, 12, 0, 0, 456),
    forceAuthn: true,
  });
  assertMatch(id, /^_[0-9a-f]{40}$/);
  const u = new URL(url);
  assertEquals(u.origin + u.pathname, "https://idp.example.org/sso");
  assertEquals(u.searchParams.get("tenant"), "a");
  assertEquals(u.searchParams.get("RelayState"), "state & more");
  const xml = await inflate(u.searchParams.get("SAMLRequest")!);
  const root = parseXml(xml).root;
  const attr = (n: string) => root.attrs.find((a) => a.local === n)?.value;
  assertEquals([root.ns, root.local], ["urn:oasis:names:tc:SAML:2.0:protocol", "AuthnRequest"]);
  assertEquals(attr("ID"), id);
  assertEquals(attr("IssueInstant"), "2026-10-13T12:00:00Z");
  assertEquals(attr("Destination"), idp.ssoUrl);
  assertEquals(attr("AssertionConsumerServiceURL"), SP.acsUrl);
  assertEquals(attr("ForceAuthn"), "true");
  assertMatch(
    xml,
    /<saml:Issuer>https:\/\/sp\.example\.com\/auth\/v1\/sso\/saml\/metadata<\/saml:Issuer>/,
  );
  assertMatch(xml, /Format="urn:oasis:names:tc:SAML:1\.1:nameid-format:emailAddress"/);

  const plain = await buildAuthnRequest({
    sp: SP,
    idp: { ...idp, ssoUrl: "https://idp/sso" },
    nameIdFormat: "urn:x",
  });
  const p = new URL(plain.url);
  assertEquals(p.searchParams.has("RelayState"), false);
  const plainXml = await inflate(p.searchParams.get("SAMLRequest")!);
  assertEquals(plainXml.includes("ForceAuthn"), false);
  assertMatch(plainXml, /Format="urn:x"/);
  assertEquals(plain.id === id, false);
});

Deno.test("saml x509: reads RSA and EC keys from PEM or base64 certificates", () => {
  assertEquals(certificateKey(GOLDEN_RSA).kind, "RSA");
  assertEquals(certificateKey(ec.certificate).namedCurve, "P-256");
  const golden = certificateKey(GOLDEN_RSA);
  assertEquals(golden.spki[0], 0x30);
});

Deno.test("saml x509: refuses what it cannot pin", () => {
  const spki = (alg: Uint8Array) => der(0x30, alg, der(0x03, [0, 1, 2]));
  const bad = [
    "",
    "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
    "!!!!",
    btoa("\x31\x00"), // a SET, not a SEQUENCE
    btoa("\x30\x05\x02\x01"), // truncated
    btoa("\x30\x85\x00\x00\x00\x00\x00"), // 5-byte length
    btoa("\x30\x80"), // indefinite length
    btoa("\x1f\x00"), // high tag number
    btoa("\x30"), // no length
    btoa("\x30\x82\x01"), // truncated length
    btoa("\x30\x03\x30\x01\x02"), // tbs without SPKI
    certificateFor(spki(der(0x30, derOid("1.2.840.10045.2.1"), derOid("1.3.132.0.10")))), // secp256k1
    certificateFor(spki(der(0x30, derOid("1.2.840.10045.2.1")))), // EC without a curve
    certificateFor(spki(der(0x30, derOid("1.2.840.113549.1.1.10")))), // RSA-PSS
    certificateFor(spki(der(0x30, der(0x05, [])))), // not an OID
    certificateFor(der(0x30, der(0x02, [1]))), // SPKI without an AlgorithmIdentifier
    certificateFor(der(0x31, [])), // SPKI not a SEQUENCE
  ];
  for (const cert of bad) assertEquals(code(() => certificateKey(cert)), "bad_certificate", cert);
});

Deno.test("saml: the primitives are public API of denext/server", () => {
  assertEquals(typeof server.verifySamlResponse, "function");
  assertEquals(typeof server.buildAuthnRequest, "function");
  assertEquals(typeof server.parseIdpMetadata, "function");
  assertEquals(typeof server.spMetadataXml, "function");
  assertEquals(typeof server.inMemorySamlReplayCache, "function");
  assertEquals(new server.SamlError("replay", "x").code, "replay");
  assertEquals(new server.SamlError("replay", "x").name, "SamlError");
});
