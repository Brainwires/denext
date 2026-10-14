// Encrypted assertions: golden Responses encrypted (and signed) by xmlsec1, every supported
// algorithm combination, and the attacks specific to XML Encryption — wrong key, tampered
// cipher text, CBC padding manipulation, an unsigned encrypted assertion in an unsigned Response,
// signature wrapping around an EncryptedAssertion, two EncryptedAssertions, a DOCTYPE inside the
// decrypted content — each refused with its stable code. When the cipher text is not covered by
// a verified Response signature, every refusal after decryption starts is `decryption_failed`
// (no decryption / padding / well-formedness oracle).

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  inMemorySamlReplayCache,
  SamlError,
  spMetadataXml,
  verifySamlResponse,
  type VerifySamlResponseOptions,
} from "../src/server/auth/saml/mod.ts";
import {
  encode,
  IDP_ENTITY,
  marker,
  NOW,
  responseXml,
  rsaKey,
  sign,
  SP,
  T0,
} from "./_saml-helpers.ts";
import {
  CONTENT,
  encryptAssertion,
  type EncryptOptions,
  spKey,
  XENC,
} from "./_saml-enc-helpers.ts";

const FIXTURES = new URL("./fixtures/saml/", import.meta.url);
const fixture = (name: string) => Deno.readTextFileSync(new URL(name, FIXTURES));
// TEST-ONLY SP decryption key, generated with the fixtures and trusted nowhere.
const GOLDEN_SP_KEY = fixture("sp-enc.TEST-ONLY.key");
const GOLDEN_SP_CERT = fixture("sp-enc.crt");
const GOLDEN_IDP = fixture("enc-idp.crt");

const idp = await rsaKey();
const attacker = await rsaKey();
const sp = await spKey();
const otherSp = await spKey();

const idpFor = (...certificates: string[]) => ({
  entityId: IDP_ENTITY,
  ssoUrl: "https://idp.example.org/sso",
  certificates,
});

function verify(xml: string, over: Partial<VerifySamlResponseOptions> = {}) {
  return verifySamlResponse({
    samlResponse: encode(xml),
    idp: idpFor(idp.certificate),
    sp: { ...SP, encryptionKey: sp.pem, encryptionCertificate: sp.certificate },
    replayCache: inMemorySamlReplayCache(),
    now: NOW,
    expectedInResponseTo: "_req1",
    ...over,
  });
}

async function refused(xml: string, code: string, over: Partial<VerifySamlResponseOptions> = {}) {
  const err = await assertRejects(() => verify(xml, over), SamlError);
  assertEquals(err.code, code, err.message);
}

const OPEN = "<saml:Assertion";
const CLOSE = "</saml:Assertion>";
const assertionOf = (xml: string) =>
  xml.slice(xml.indexOf(OPEN), xml.lastIndexOf(CLOSE) + CLOSE.length);

/** A Response whose (signed, unless told) Assertion is replaced by an EncryptedAssertion. */
async function encrypted(
  options: EncryptOptions & {
    signAssertion?: boolean;
    signResponse?: boolean;
    fields?: Parameters<typeof responseXml>[0];
    /** Rewrite the (signed) assertion text before it is encrypted. */
    plain?: (assertion: string) => string;
    key?: typeof sp;
    signer?: typeof idp;
  } = {},
): Promise<string> {
  const signAssertion = options.signAssertion ?? true;
  let xml = responseXml({
    assertionSig: signAssertion ? marker("_assert1") : "",
    responseSig: options.signResponse ? marker("_resp1") : "",
    ...options.fields,
  });
  if (signAssertion) xml = await sign(xml, "_assert1", { key: options.signer ?? idp });
  const assertion = assertionOf(xml);
  const plain = options.plain ? options.plain(assertion) : assertion;
  xml = xml.replace(assertion, await encryptAssertion(plain, options.key ?? sp, options));
  if (options.signResponse) xml = await sign(xml, "_resp1", { key: idp });
  return xml;
}

// --- golden (xmlsec1) ----------------------------------------------------------------------

const goldenSp = { ...SP, encryptionKey: GOLDEN_SP_KEY, encryptionCertificate: GOLDEN_SP_CERT };

Deno.test("saml enc golden: xmlsec1 AES-256-GCM + RSA-OAEP, signed Assertion, verifies", async () => {
  const claims = await verify(fixture("enc-gcm-assertion-signed.xml"), {
    idp: idpFor(GOLDEN_IDP),
    sp: goldenSp,
  });
  assertEquals(claims.nameId, "alice@example.com");
  assertEquals(claims.sessionIndex, "_session1");
  assertEquals(claims.encrypted, true);
  assertEquals(claims.attributes, { email: ["alice@example.com"] });
});

Deno.test("saml enc golden: xmlsec1 AES-128-CBC, Response signed over the cipher text", async () => {
  const claims = await verify(fixture("enc-cbc-response-signed.xml"), {
    idp: idpFor(GOLDEN_IDP),
    sp: goldenSp,
  });
  assertEquals(claims.assertionId, "_assert1");
  assertEquals(claims.notOnOrAfter, (T0 + 300_000) / 1000);
});

Deno.test("saml enc golden: wrong key, tampering, no key configured", async () => {
  const gcm = fixture("enc-gcm-assertion-signed.xml");
  const cbc = fixture("enc-cbc-response-signed.xml");
  const golden = { idp: idpFor(GOLDEN_IDP), sp: goldenSp };
  const wrongKey = { ...golden, sp: { ...goldenSp, encryptionKey: sp.pem } };
  await refused(gcm, "decryption_failed", wrongKey);
  await refused(cbc, "decryption_failed", wrongKey);
  // The content CipherValue is the last one; change one base64 character in it.
  const tamper = (xml: string) => {
    const i = xml.lastIndexOf("<xenc:CipherValue>") + "<xenc:CipherValue>".length + 8;
    return xml.slice(0, i) + (xml[i] === "A" ? "B" : "A") + xml.slice(i + 1);
  };
  await refused(tamper(gcm), "decryption_failed", golden);
  // The Response signature covers the cipher text and is checked before decrypting.
  await refused(tamper(cbc), "bad_signature", golden);
  await refused(gcm, "encrypted_assertion_unsupported", { ...golden, sp: SP });
  // The signed assertion's own trust: a different IdP certificate.
  await refused(gcm, "decryption_failed", { ...golden, idp: idpFor(idp.certificate) });
  await refused(cbc, "bad_signature", { ...golden, idp: idpFor(idp.certificate) });
});

// --- algorithms ----------------------------------------------------------------------------

Deno.test("saml enc: every allowed content x key-transport combination decrypts", async () => {
  for (
    const content of [CONTENT.aes128gcm, CONTENT.aes256gcm, CONTENT.aes128cbc, CONTENT.aes256cbc]
  ) {
    for (const transport of ["mgf1p", "oaep", "oaep256"] as const) {
      const claims = await verify(await encrypted({ content, transport }));
      assertEquals(claims.nameId, "alice@example.com", `${content} ${transport}`);
    }
  }
  // The EncryptedKey beside the EncryptedData (Shibboleth's layout), and a JWK SP key.
  await verify(await encrypted({ keyPlacement: "sibling" }));
  await verify(await encrypted(), { sp: { ...SP, encryptionKey: sp.jwk } });
  // A self-contained Assertion (its own namespace declarations) decrypts the same way.
  await verify(
    await encrypted({
      plain: (a) => a.replace(OPEN, `${OPEN} xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"`),
    }),
  );
});

Deno.test("saml enc: algorithms and parameters outside the allow-list are refused", async () => {
  const method = (alg: string, inner = "") =>
    `<xenc:EncryptionMethod Algorithm="${alg}">${inner}</xenc:EncryptionMethod>`;
  const DS = "http://www.w3.org/2000/09/xmldsig#";
  const X11 = "http://www.w3.org/2009/xmlenc11#";
  const cases: EncryptOptions[] = [
    { content: CONTENT.aes192cbc },
    { content: CONTENT.tripledes },
    { content: "constructor" },
    { keyMethod: method(`${XENC}rsa-1_5`) },
    { keyMethod: method("toString") },
    {
      keyMethod: method(
        `${XENC}rsa-oaep-mgf1p`,
        `<ds:DigestMethod xmlns:ds="${DS}" Algorithm="${XENC}sha256"/>`,
      ),
    },
    {
      keyMethod: method(
        `${X11}rsa-oaep`,
        `<ds:DigestMethod xmlns:ds="${DS}" Algorithm="${XENC}sha256"/>`,
      ),
    }, // SHA-256 OAEP with the default (SHA-1) MGF1
    {
      keyMethod: method(`${X11}rsa-oaep`, `<x:MGF xmlns:x="${X11}" Algorithm="${X11}mgf1sha512"/>`),
    },
    { keyMethod: method(`${XENC}rsa-oaep-mgf1p`, `<xenc:OAEPparams>AAAA</xenc:OAEPparams>`) },
    {
      keyMethod: method(
        `${XENC}rsa-oaep-mgf1p`,
        `<ds:DigestMethod xmlns:ds="${DS}" Algorithm="${DS}sha1"><e:x xmlns:e="urn:e"/></ds:DigestMethod>`,
      ),
    },
    {
      keyMethod: method(
        `${XENC}rsa-oaep-mgf1p`,
        `<x:MGF xmlns:x="${X11}" Algorithm="${X11}mgf1sha1"/>`,
      ),
    },
  ];
  for (const options of cases) {
    await refused(await encrypted(options), "unsupported_algorithm");
  }
  const xml = await encrypted();
  await refused(
    xml.replace(`Type="${XENC}Element"`, `Type="${XENC}Content"`),
    "unsupported_algorithm",
  );
  await refused(
    xml.replace(
      /(<xenc:EncryptedData[^>]*>)<xenc:EncryptionMethod Algorithm="([^"]+)"\/>/,
      `$1<xenc:EncryptionMethod Algorithm="$2"><e:p xmlns:e="urn:e"/></xenc:EncryptionMethod>`,
    ),
    "unsupported_algorithm",
  );
  // The cipher text by reference (an external fetch) is never followed.
  const last = xml.lastIndexOf("<xenc:CipherData>");
  await refused(
    xml.slice(0, last) +
      xml.slice(last).replace(
        /<xenc:CipherData>[\s\S]*?<\/xenc:CipherData>/,
        `<xenc:CipherData><xenc:CipherReference URI="https://evil.example/x"/></xenc:CipherData>`,
      ),
    "unsupported_algorithm",
  );
});

Deno.test("saml enc: a malformed EncryptedAssertion structure is refused", async () => {
  const xml = await encrypted({ keyPlacement: "sibling" });
  const key = xml.match(/<xenc:EncryptedKey[\s\S]*?<\/xenc:EncryptedKey>/)![0];
  const data = xml.match(/<xenc:EncryptedData[\s\S]*?<\/xenc:EncryptedData>/)![0];
  await refused(xml.replace(key, key + key), "malformed_response");
  await refused(xml.replace(key, ""), "malformed_response");
  await refused(xml.replace(data, data + data), "malformed_response");
  await refused(xml.replace(key, key + `<e:x xmlns:e="urn:e"/>`), "malformed_response");
  await refused(xml.replace(key, key + "text"), "malformed_response");
  await refused(
    xml.replace(/(<xenc:EncryptedData[^>]*>)<xenc:EncryptionMethod[^>]*\/>/, "$1"),
    "malformed_response",
  );
  const inside = await encrypted();
  const keyInfo = inside.match(/<ds:KeyInfo[\s\S]*?<\/ds:KeyInfo>/)![0];
  await refused(inside.replace(keyInfo, keyInfo + keyInfo), "malformed_response");
  await refused(inside.replace(keyInfo, keyInfo + key), "malformed_response");
  const lastValue = inside.lastIndexOf("<xenc:CipherValue>") + "<xenc:CipherValue>".length;
  await refused(inside.slice(0, lastValue) + "!!" + inside.slice(lastValue), "malformed_response");
  await refused(
    inside.slice(0, lastValue) + "<!---->" + inside.slice(lastValue),
    "malformed_response",
  );
  await refused(
    inside.replace(/<xenc:CipherData>(?![\s\S]*<xenc:CipherData>)[\s\S]*?<\/xenc:CipherData>/, ""),
    "malformed_response",
  );
});

// --- the signature rules -------------------------------------------------------------------

Deno.test("saml enc: an unsigned encrypted assertion needs a signed Response", async () => {
  // Inside an unsigned Response: anyone can encrypt to the SP — refused, uniformly.
  await refused(await encrypted({ signAssertion: false }), "decryption_failed");
  // Inside a signed Response, the signature covers the cipher text: accepted.
  const claims = await verify(await encrypted({ signAssertion: false, signResponse: true }));
  assertEquals(claims.nameId, "alice@example.com");
  // …unless the Assertion itself must be signed.
  await refused(
    await encrypted({ signAssertion: false, signResponse: true }),
    "unsigned",
    { requireSignedAssertion: true },
  );
  await verify(await encrypted({ signResponse: true }), { requireSignedAssertion: true });
  // Signed by an attacker key: uniform when unauthenticated, specific under a Response signature.
  await refused(await encrypted({ signer: attacker }), "decryption_failed");
  await refused(await encrypted({ signer: attacker, signResponse: true }), "bad_signature");
});

Deno.test("saml enc: wrong key, tampered cipher text and tampered key are refused", async () => {
  await refused(await encrypted({ key: otherSp }), "decryption_failed");
  const flip = (at: number) => (b: Uint8Array) => {
    const c = b.slice();
    c[at] ^= 1;
    return c;
  };
  for (const content of [CONTENT.aes256gcm, CONTENT.aes128cbc]) {
    await refused(await encrypted({ content, tamperContent: flip(20) }), "decryption_failed");
    await refused(await encrypted({ content, tamperContent: flip(0) }), "decryption_failed");
    await refused(await encrypted({ content, tamperKey: flip(5) }), "decryption_failed");
    await refused(
      await encrypted({ content, tamperContent: (b) => b.slice(0, b.length - 3) }),
      "decryption_failed",
    );
    await refused(
      await encrypted({ content, tamperContent: (b) => b.slice(0, 12) }),
      "decryption_failed",
    );
  }
  // A content key of the wrong length for the declared algorithm.
  await refused(
    await encrypted({ content: CONTENT.aes256gcm, keyLength: 16 }),
    "decryption_failed",
  );
  // Under a Response signature, any cipher text change breaks the signature first.
  await refused(
    (await encrypted({ signResponse: true })).replace(
      /(<xenc:CipherValue>)([A-Za-z0-9+/])/g,
      (_m, open, c) => open + (c === "A" ? "B" : "A"),
    ),
    "bad_signature",
  );
});

Deno.test("saml enc: CBC padding manipulation gives no oracle", async () => {
  const assertion = assertionOf(await sign(responseXml(), "_assert1", { key: idp }));
  const body = new TextEncoder().encode(assertion);
  const padded = (pad: number[], filler = 0x41) => {
    const total = Math.ceil((body.length + pad.length) / 16) * 16;
    const out = new Uint8Array(total).fill(filler);
    out.set(body);
    out.set(pad, total - pad.length);
    return out;
  };
  const enc = (raw: Uint8Array) =>
    encrypted({ content: CONTENT.aes128cbc, rawCbcPlaintext: raw, plain: () => assertion });
  // XML Encryption padding: only the last byte counts; the others are arbitrary.
  const pad = 16 - (body.length % 16 || 16) || 16;
  const arbitrary = Array.from({ length: pad }, (_, i) => (i === pad - 1 ? pad : 0xee));
  assertEquals((await verify(await enc(padded(arbitrary)))).nameId, "alice@example.com");
  // A zero or over-long padding length, and a length that eats into the Assertion: one code.
  const last = (n: number) => {
    const raw = padded(arbitrary);
    raw[raw.length - 1] = n;
    return raw;
  };
  for (const n of [0, 17, 255, pad === 16 ? 15 : 16]) {
    await refused(await enc(last(n)), "decryption_failed");
  }
  // Bit flips in the IV / previous block steer the plaintext — still one code.
  const flipIv = (b: Uint8Array) => {
    const c = b.slice();
    c[15] ^= 0x01;
    return c;
  };
  await refused(
    await encrypted({ content: CONTENT.aes128cbc, tamperContent: flipIv }),
    "decryption_failed",
  );
});

// --- assertion count, wrapping and the decrypted content -----------------------------------

Deno.test("saml enc: two EncryptedAssertions, or one beside an Assertion, are refused", async () => {
  const xml = await encrypted();
  const enc = xml.match(/<saml:EncryptedAssertion>[\s\S]*?<\/saml:EncryptedAssertion>/)![0];
  await refused(xml.replace(enc, enc + enc), "multiple_assertions");
  const plain = await sign(responseXml(), "_assert1", { key: idp });
  await refused(
    plain.replace("</samlp:Response>", `${enc}</samlp:Response>`),
    "multiple_assertions",
  );
  // Hidden in Extensions (where a Response signature would not vouch for it).
  await refused(
    xml.replace(enc, "").replace(
      "<samlp:Status>",
      `<samlp:Extensions>${enc}</samlp:Extensions><samlp:Status>`,
    ),
    "malformed_response",
  );
});

Deno.test("saml enc: signature wrapping around an EncryptedAssertion is refused", async () => {
  const signed = await encrypted({ signAssertion: false, signResponse: true });
  const original = signed.slice(signed.indexOf("<samlp:Response"));
  // XSW1-style: an evil Response (another EncryptedAssertion) carrying the signed one inside.
  const evil = await encrypted({ signAssertion: false, fields: { nameId: "attacker@evil.com" } });
  const evilBody = evil.slice(evil.indexOf("<samlp:Response")).replace(`ID="_resp1"`, `ID="_evil"`);
  await refused(
    evilBody.replace(
      "<samlp:Status>",
      `<samlp:Extensions>${original}</samlp:Extensions><samlp:Status>`,
    ),
    "multiple_assertions",
  );
  // The signed Response's signature moved onto an evil Response with the same ID.
  const sig = signed.match(/<ds:Signature[\s\S]*?<\/ds:Signature>/)![0];
  await refused(
    evilBody.replace(`ID="_evil"`, `ID="_resp1"`).replace(
      "<saml:Issuer>https://idp.example.org/metadata</saml:Issuer>",
      `<saml:Issuer>https://idp.example.org/metadata</saml:Issuer>${sig}`,
    ),
    "bad_signature",
  );
  // The decrypted Assertion reuses an ID of the outer document: one ID, two elements.
  await refused(
    await encrypted({
      signAssertion: false,
      signResponse: true,
      plain: (a) => a.replace(`ID="_assert1"`, `ID="_resp1"`),
    }),
    "signature_wrapping",
  );
  // The decrypted content hides the IdP-signed assertion under a forged one (in Advice).
  const genuine = assertionOf(await sign(responseXml(), "_assert1", { key: idp }));
  await refused(
    await encrypted({
      signResponse: true,
      signAssertion: false,
      plain: (a) =>
        a.replace("alice@example.com</saml:NameID>", "attacker@evil.com</saml:NameID>")
          .replace(
            CLOSE,
            `<saml:Advice>${genuine.replace(`"_assert1"`, `"_g"`)}</saml:Advice>${CLOSE}`,
          ),
    }),
    "multiple_assertions",
  );
});

Deno.test("saml enc: the decrypted content goes through the strict parser", async () => {
  const signedOuter = (plain: (a: string) => string) =>
    encrypted({ signAssertion: false, signResponse: true, plain });
  await refused(
    await signedOuter((a) => `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${a}`),
    "doctype_forbidden",
  );
  // Without a Response signature the same content is the uniform refusal.
  await refused(
    await encrypted({ plain: (a) => `<!DOCTYPE x [<!ENTITY e "x">]>${a}` }),
    "decryption_failed",
  );
  await refused(await signedOuter((a) => a + "<x/>"), "malformed_xml");
  await refused(
    await signedOuter(() => `<saml:Issuer>x</saml:Issuer>`),
    "malformed_response",
  );
  await refused(
    await signedOuter((a) =>
      a.replace(/<saml:NameID[^>]*>[^<]*<\/saml:NameID>/, `<saml:EncryptedID/>`)
    ),
    "malformed_response", // an EncryptedID is read by EncryptedAssertion's rules
  );
  await refused(
    await signedOuter((a) => a.replace("<saml:Issuer>", "<s:Issuer>")),
    "malformed_xml",
  );
  // A comment-injected NameID inside a validly signed, encrypted Assertion.
  await refused(
    await encrypted({ fields: { nameId: "alice@example.com<!---->.evil.com" } }),
    "unexpected_markup",
  );
});

Deno.test("saml enc: conditions, InResponseTo and replay apply to the decrypted Assertion", async () => {
  const xml = await encrypted();
  const cache = inMemorySamlReplayCache();
  await verify(xml, { replayCache: cache });
  await refused(xml, "replay", { replayCache: cache });
  await refused(xml, "expired", { now: T0 + 3600_000 });
  await refused(xml, "in_response_to_mismatch", { expectedInResponseTo: "_other" });
  await refused(await encrypted({ fields: { audience: "https://other" } }), "bad_audience");
  await refused(await encrypted({ fields: { recipient: "https://other/acs" } }), "bad_recipient");
  await refused(await encrypted({ fields: { issuer: "https://evil" } }), "bad_issuer");
});

Deno.test("saml enc: an unusable SP key is a configuration error, never masked", async () => {
  const xml = await encrypted();
  await refused(xml, "bad_key", { sp: { ...SP, encryptionKey: "not a key" } });
  await refused(xml, "bad_key", {
    sp: {
      ...SP,
      encryptionKey: "-----BEGIN RSA PRIVATE KEY-----\nAA==\n-----END RSA PRIVATE KEY-----",
    },
  });
  await refused(xml, "bad_key", { sp: { ...SP, encryptionKey: { kty: "EC", d: "x" } } });
  await refused(xml, "bad_key", {
    sp: { ...SP, encryptionKey: "-----BEGIN PRIVATE KEY-----\n!!\n-----END PRIVATE KEY-----" },
  });
  await refused(xml, "bad_key", {
    sp: { ...SP, encryptionKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" },
  });
});

Deno.test("saml enc: the SP metadata publishes the encryption certificate and methods", () => {
  const xml = spMetadataXml({
    ...SP,
    encryptionKey: sp.pem,
    encryptionCertificate: sp.certificate,
  });
  assertStringIncludes(xml, `<md:KeyDescriptor use="encryption">`);
  assertStringIncludes(xml, sp.certificate);
  assertStringIncludes(xml, `Algorithm="http://www.w3.org/2009/xmlenc11#aes256-gcm"`);
  assertStringIncludes(xml, `Algorithm="http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p"`);
});
