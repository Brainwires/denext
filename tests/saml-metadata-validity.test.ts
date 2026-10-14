// IdP metadata `validUntil` (xs:dateTime) and `cacheDuration` (xs:duration): strict parsing,
// the earliest / shortest over an EntitiesDescriptor and its EntityDescriptor, garbage refused
// as `bad_metadata`.

import { assertEquals, assertThrows } from "@std/assert";
import { parseIdpMetadata, SamlError } from "../src/server/auth/saml/mod.ts";
import { parseCacheDuration, parseValidUntil } from "../src/server/auth/saml/metadata.ts";
import { rsaKey } from "./_saml-helpers.ts";

const rsa = await rsaKey();
const MD = `xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" ` +
  `xmlns:ds="http://www.w3.org/2000/09/xmldsig#"`;

function entity(attrs = "", ns = true): string {
  return `<md:EntityDescriptor ${ns ? MD + " " : ""}entityID="https://idp.example.org/m"${attrs}>
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${rsa.certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.org/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

const code = (fn: () => unknown) => assertThrows(fn, SamlError).code;
const at = (iso: string) => Date.parse(iso) / 1000;

Deno.test("saml metadata validity: validUntil and cacheDuration are read", () => {
  const plain = parseIdpMetadata(entity());
  assertEquals([plain.validUntil, plain.cacheDuration], [undefined, undefined]);
  const both = parseIdpMetadata(
    entity(` validUntil="2030-01-02T03:04:05Z" cacheDuration="PT6H"`),
  );
  assertEquals(both.validUntil, at("2030-01-02T03:04:05Z"));
  assertEquals(both.cacheDuration, 6 * 3600);
});

Deno.test("saml metadata validity: the earliest validUntil and shortest cacheDuration win", () => {
  const wrap = (outer: string, inner: string) =>
    `<md:EntitiesDescriptor ${MD}${outer}>${entity(inner, false)}</md:EntitiesDescriptor>`;
  const a = parseIdpMetadata(
    wrap(
      ` validUntil="2030-01-01T00:00:00Z" cacheDuration="P1D"`,
      ` validUntil="2031-01-01T00:00:00Z" cacheDuration="PT1H"`,
    ),
  );
  assertEquals([a.validUntil, a.cacheDuration], [at("2030-01-01T00:00:00Z"), 3600]);
  const b = parseIdpMetadata(
    wrap(` cacheDuration="PT30M"`, ` validUntil="2029-06-01T00:00:00+02:00"`),
  );
  assertEquals([b.validUntil, b.cacheDuration], [at("2029-05-31T22:00:00Z"), 1800]);
});

Deno.test("saml metadata validity: xs:dateTime is parsed strictly", () => {
  assertEquals(parseValidUntil("2030-01-01T00:00:00Z"), at("2030-01-01T00:00:00Z"));
  assertEquals(parseValidUntil("2030-01-01T00:00:00.999Z"), at("2030-01-01T00:00:00Z"));
  assertEquals(parseValidUntil("2030-01-01T05:30:00+05:30"), at("2030-01-01T00:00:00Z"));
  assertEquals(parseValidUntil("2029-12-31T20:00:00-04:00"), at("2030-01-01T00:00:00Z"));
  for (
    const bad of [
      "",
      "tomorrow",
      "2030-01-01",
      "2030-01-01T00:00:00", // no time zone
      "2030-02-30T00:00:00Z",
      "2030-13-01T00:00:00Z",
      "2030-01-01T24:00:00Z",
      "2030-01-01T00:60:00Z",
      "2030-01-01T00:00:60Z",
      "2030-01-01T00:00:00+15:00",
      "2030-01-01T00:00:00+14:30",
      "2030-01-01T00:00:00+05:60",
      " 2030-01-01T00:00:00Z",
      "1969-12-31T23:59:59Z",
      "+2030-01-01T00:00:00Z",
    ]
  ) {
    assertEquals(code(() => parseValidUntil(bad)), "bad_metadata", bad);
    assertEquals(
      code(() => parseIdpMetadata(entity(` validUntil="${bad}"`))),
      "bad_metadata",
      bad,
    );
  }
});

Deno.test("saml metadata validity: xs:duration is parsed strictly", () => {
  const cases: Array<[string, number]> = [
    ["PT6H", 21600],
    ["P1D", 86400],
    ["PT0S", 0],
    ["PT90M", 5400],
    ["PT1.5S", 1],
    ["P1Y", 365 * 86400],
    ["P1M", 30 * 86400],
    ["P1Y2M3DT4H5M6S", 365 * 86400 + 60 * 86400 + 3 * 86400 + 4 * 3600 + 5 * 60 + 6],
  ];
  for (const [raw, seconds] of cases) assertEquals(parseCacheDuration(raw), seconds, raw);
  for (
    const bad of ["", "P", "PT", "P1DT", "-PT6H", "PT6", "6H", "PT6H ", "P1H", "PT1D", "P1.5D"]
  ) {
    assertEquals(code(() => parseCacheDuration(bad)), "bad_metadata", bad);
    assertEquals(
      code(() => parseIdpMetadata(entity(` cacheDuration="${bad}"`))),
      "bad_metadata",
      bad,
    );
  }
});
