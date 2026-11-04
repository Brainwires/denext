// EncryptedID: a Subject's (or a LogoutRequest's) NameID encrypted to the SP. Golden messages
// encrypted and signed by xmlsec1, every supported algorithm combination, and the attacks — a
// tampered cipher text under a signature, an unsigned one, two identifiers, decrypted content
// that is not exactly one NameID, a wrong key, algorithms outside the allow-list — each refused
// with its stable code. The EncryptedID is opened only after the signature covering it verified;
// without one, every refusal inside the decryption window is `decryption_failed`.

import { assertEquals, assertRejects } from "@std/assert";
import {
  inMemorySamlReplayCache,
  SamlError,
  type SamlIdpConfig,
  type VerifyLogoutOptions,
  verifyLogoutRequest,
  verifySamlResponse,
  type VerifySamlResponseOptions,
} from "../packages/auth/src/saml/mod.ts";
import { decryptNameId } from "../packages/auth/src/saml/encrypted-id.ts";
import { parseXml } from "../packages/auth/src/saml/xml.ts";
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
  encryptNameId,
  type EncryptOptions,
  logoutRequestXml,
  redirectQuery,
  SLO_URL,
  spKey,
  XENC,
} from "./_saml-enc-helpers.ts";

const FIXTURES = new URL("./fixtures/saml/", import.meta.url);
const fixture = (name: string) => Deno.readTextFileSync(new URL(name, FIXTURES));
// TEST-ONLY SP decryption key, generated with the fixtures and trusted nowhere.
const GOLDEN_SP_KEY = fixture("sp-enc.TEST-ONLY.key");
const GOLDEN_SP_CERT = fixture("sp-enc.crt");
const GOLDEN_IDP = fixture("encid-idp.crt");

const idp = await rsaKey();
const sp = await spKey();
const otherSp = await spKey();

const idpFor = (...certificates: string[]): SamlIdpConfig => ({
  entityId: IDP_ENTITY,
  ssoUrl: "https://idp.example.org/sso",
  sloUrl: "https://idp.example.org/slo",
  certificates,
});
const SP_KEYED = { ...SP, encryptionKey: sp.pem, encryptionCertificate: sp.certificate };
const GOLDEN_SP = { ...SP, encryptionKey: GOLDEN_SP_KEY, encryptionCertificate: GOLDEN_SP_CERT };

function verify(xml: string, over: Partial<VerifySamlResponseOptions> = {}) {
  return verifySamlResponse({
    samlResponse: encode(xml),
    idp: idpFor(idp.certificate),
    sp: SP_KEYED,
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

const NAME_ID_RE = /<saml:NameID[^>]*>[^<]*<\/saml:NameID>/;
const NAME_ID =
  `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">alice@example.com</saml:NameID>`;

/** A Response whose Subject carries an EncryptedID (the Assertion signed unless told). */
async function withEncryptedId(
  options: EncryptOptions & {
    /** The plaintext encrypted inside the EncryptedID (default: the NameID). */
    plain?: string;
    /** Replace the Subject's NameID with this markup (`{{enc}}` = the EncryptedID). */
    subject?: string;
    signAssertion?: boolean;
    signResponse?: boolean;
    key?: typeof sp;
  } = {},
): Promise<string> {
  const signAssertion = options.signAssertion ?? true;
  const enc = await encryptNameId(options.plain ?? NAME_ID, options.key ?? sp, options);
  let xml = responseXml({
    assertionSig: signAssertion ? marker("_assert1") : "",
    responseSig: options.signResponse ? marker("_resp1") : "",
  }).replace(NAME_ID_RE, (options.subject ?? "{{enc}}").replaceAll("{{enc}}", enc));
  if (signAssertion) xml = await sign(xml, "_assert1", { key: idp });
  if (options.signResponse) xml = await sign(xml, "_resp1", { key: idp });
  return xml;
}

/** Change one base64 character of the last CipherValue (the content cipher text). */
function tamper(xml: string): string {
  const i = xml.lastIndexOf("<xenc:CipherValue>") + "<xenc:CipherValue>".length + 8;
  return xml.slice(0, i) + (xml[i] === "A" ? "B" : "A") + xml.slice(i + 1);
}

// --- golden (xmlsec1) ----------------------------------------------------------------------

Deno.test("saml encid golden: xmlsec1 AES-256-GCM EncryptedID in a signed Assertion", async () => {
  const claims = await verify(fixture("encid-gcm-assertion-signed.xml"), {
    idp: idpFor(GOLDEN_IDP),
    sp: GOLDEN_SP,
  });
  assertEquals(claims.nameId, "alice@example.com");
  assertEquals(claims.nameIdFormat, "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress");
  assertEquals(claims.sessionIndex, "_session1");
});

Deno.test("saml encid golden: xmlsec1 AES-128-CBC EncryptedID, the Response signed", async () => {
  const claims = await verify(fixture("encid-cbc-response-signed.xml"), {
    idp: idpFor(GOLDEN_IDP),
    sp: GOLDEN_SP,
  });
  assertEquals(claims.nameId, "alice@example.com");
});

Deno.test("saml encid golden: tampering, wrong key, no key", async () => {
  const golden = { idp: idpFor(GOLDEN_IDP), sp: GOLDEN_SP };
  for (const name of ["encid-gcm-assertion-signed.xml", "encid-cbc-response-signed.xml"]) {
    const xml = fixture(name);
    // The signature covers the cipher text and is checked before decrypting.
    await refused(tamper(xml), "bad_signature", golden);
    await refused(xml, "decryption_failed", { ...golden, sp: { ...SP, encryptionKey: sp.pem } });
    await refused(xml, "encrypted_assertion_unsupported", { ...golden, sp: SP });
  }
});

const logoutOptions = (
  input: VerifyLogoutOptions["input"],
  over: Partial<VerifyLogoutOptions> = {},
): VerifyLogoutOptions => ({
  input,
  idp: idpFor(idp.certificate),
  sp: { ...SP_KEYED, sloUrl: SLO_URL },
  replayCache: inMemorySamlReplayCache(),
  now: T0 + 30_000,
  ...over,
});

const post = (xml: string) => ({ form: new URLSearchParams({ SAMLRequest: encode(xml) }) });

async function refusedLogout(
  input: VerifyLogoutOptions["input"],
  code: string,
  over: Partial<VerifyLogoutOptions> = {},
) {
  const err = await assertRejects(
    () => verifyLogoutRequest(logoutOptions(input, over)),
    SamlError,
  );
  assertEquals(err.code, code, err.message);
}

Deno.test("saml encid golden: xmlsec1-signed HTTP-POST LogoutRequest with an EncryptedID", async () => {
  const xml = fixture("encid-slo-request-post-signed.xml");
  const golden = { idp: idpFor(GOLDEN_IDP), sp: { ...GOLDEN_SP, sloUrl: SLO_URL } };
  const req = await verifyLogoutRequest(logoutOptions(post(xml), golden));
  assertEquals(req, {
    id: "_logout1",
    issuer: IDP_ENTITY,
    nameId: "alice@example.com",
    nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    sessionIndexes: ["_session1"],
  });
  await refusedLogout(post(tamper(xml)), "bad_signature", golden);
  await refusedLogout(post(xml), "decryption_failed", {
    ...golden,
    sp: { ...SP, sloUrl: SLO_URL, encryptionKey: sp.pem },
  });
  await refusedLogout(post(xml), "encrypted_assertion_unsupported", {
    ...golden,
    sp: { ...SP, sloUrl: SLO_URL },
  });
});

// --- algorithms ------------------------------------------------------------------------------

Deno.test("saml encid: every allowed content x key-transport combination decrypts", async () => {
  for (
    const content of [CONTENT.aes128gcm, CONTENT.aes256gcm, CONTENT.aes128cbc, CONTENT.aes256cbc]
  ) {
    for (const transport of ["mgf1p", "oaep", "oaep256"] as const) {
      const claims = await verify(await withEncryptedId({ content, transport }));
      assertEquals(claims.nameId, "alice@example.com", `${content} ${transport}`);
    }
  }
  await verify(await withEncryptedId({ keyPlacement: "sibling" }));
  await verify(await withEncryptedId({ signAssertion: false, signResponse: true }));
  // A self-contained NameID (its own namespace declaration) decrypts the same way.
  const own = NAME_ID.replace(
    "<saml:NameID",
    `<saml:NameID xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"`,
  );
  assertEquals((await verify(await withEncryptedId({ plain: own }))).nameId, "alice@example.com");
});

Deno.test("saml encid: algorithms outside the allow-list are refused", async () => {
  for (const content of [CONTENT.aes192cbc, CONTENT.tripledes]) {
    await refused(await withEncryptedId({ content }), "unsupported_algorithm");
  }
  await refused(
    await withEncryptedId({ keyMethod: `<xenc:EncryptionMethod Algorithm="${XENC}rsa-1_5"/>` }),
    "unsupported_algorithm",
  );
});

// --- attacks ---------------------------------------------------------------------------------

Deno.test("saml encid: tampered cipher text under a signature is bad_signature", async () => {
  await refused(tamper(await withEncryptedId()), "bad_signature");
  await refused(
    tamper(await withEncryptedId({ signAssertion: false, signResponse: true })),
    "bad_signature",
  );
});

Deno.test("saml encid: unsigned — never decrypted, or decryption_failed", async () => {
  // A plaintext unsigned Assertion is refused before anything is decrypted.
  await refused(await withEncryptedId({ signAssertion: false }), "unsigned");
  // Inside an EncryptedAssertion of an unsigned Response, every failure is decryption_failed.
  const inner = await withEncryptedId({ signAssertion: false, plain: "<saml:Issuer/>" });
  const assertion = inner.slice(
    inner.indexOf("<saml:Assertion"),
    inner.lastIndexOf("</saml:Assertion>") + "</saml:Assertion>".length,
  );
  await refused(
    inner.replace(assertion, await encryptAssertion(assertion, sp)),
    "decryption_failed",
  );
  // The primitive itself: not covered by a signature, every inner failure is the one code.
  const container = async (plain: string, key = sp) =>
    parseXml(
      `<saml:Subject xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${await encryptNameId(
        plain,
        key,
      )}</saml:Subject>`,
    ).root.children.find((c) => c.type === "element")!;
  for (
    const [plain, key, coveredCode] of [
      ["<saml:Issuer>x</saml:Issuer>", sp, "malformed_response"],
      ["<saml:NameID>a<!---->b</saml:NameID>", sp, "unexpected_markup"],
      ["<saml:NameID>a</saml:NameID><saml:NameID>b</saml:NameID>", sp, "malformed_xml"],
      [NAME_ID, otherSp, "decryption_failed"],
    ] as const
  ) {
    const el = await container(plain, key);
    const uncovered = await assertRejects(() => decryptNameId(el, sp.pem, false), SamlError);
    assertEquals(uncovered.code, "decryption_failed", plain);
    const covered = await assertRejects(() => decryptNameId(el, sp.pem, true), SamlError);
    assertEquals(covered.code, coveredCode, plain);
  }
  // An unusable configured key is a configuration error, never masked.
  const el = await container(NAME_ID);
  const bad = await assertRejects(() => decryptNameId(el, "not a key", false), SamlError);
  assertEquals(bad.code, "bad_key");
});

Deno.test("saml encid: two identifiers, or one beside a NameID, are malformed", async () => {
  await refused(await withEncryptedId({ subject: "{{enc}}{{enc}}" }), "malformed_response");
  await refused(await withEncryptedId({ subject: `{{enc}}${NAME_ID}` }), "malformed_response");
  await refused(await withEncryptedId({ subject: `${NAME_ID}{{enc}}` }), "malformed_response");
});

Deno.test("saml encid: the decrypted content must be exactly one NameID", async () => {
  // Signed, so the refusals are not masked.
  await refused(
    await withEncryptedId({ plain: "<saml:Issuer>x</saml:Issuer>" }),
    "malformed_response",
  );
  await refused(
    await withEncryptedId({ plain: `${NAME_ID}${NAME_ID}` }),
    "malformed_xml",
  );
  await refused(
    await withEncryptedId({ plain: "<saml:NameID>alice@example.com<!---->.evil</saml:NameID>" }),
    "unexpected_markup",
  );
  await refused(
    await withEncryptedId({ plain: "<saml:NameID><saml:NameID>x</saml:NameID></saml:NameID>" }),
    "unexpected_markup",
  );
  await refused(
    await withEncryptedId({ plain: "<saml:NameID> </saml:NameID>" }),
    "malformed_response",
  );
  await refused(
    await withEncryptedId({ plain: `<!DOCTYPE x [<!ENTITY e "x">]>${NAME_ID}` }),
    "doctype_forbidden",
  );
  await refused(
    await withEncryptedId({ plain: '<x:NameID xmlns:x="urn:x">a</x:NameID>' }),
    "malformed_response",
  );
});

Deno.test("saml encid: wrong key, and an EncryptedID anywhere but the Subject", async () => {
  await refused(await withEncryptedId({ key: otherSp }), "decryption_failed");
  await refused(
    await withEncryptedId({ tamperKey: (b) => b.map((x, i) => (i === 3 ? x ^ 1 : x)) }),
    "decryption_failed",
  );
  const enc = await encryptNameId(NAME_ID, sp);
  let xml = responseXml({ assertionSig: marker("_assert1") }).replace(
    '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">',
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">${enc}`,
  );
  xml = await sign(xml, "_assert1", { key: idp });
  await refused(xml, "encrypted_assertion_unsupported");
  // No SP decryption key: refused before anything else.
  await refused(await withEncryptedId(), "encrypted_assertion_unsupported", { sp: SP });
});

// --- LogoutRequest -------------------------------------------------------------------------

async function logoutWithEncryptedId(
  subject = "{{enc}}",
  plain = NAME_ID,
  options: EncryptOptions = {},
): Promise<string> {
  const enc = await encryptNameId(plain, sp, options);
  return logoutRequestXml({ sig: marker("_lr1") }).replace(
    NAME_ID_RE,
    subject.replaceAll("{{enc}}", enc),
  );
}

const signedPost = async (xml: string) => post(await sign(xml, "_lr1", { key: idp }));

Deno.test("saml encid: a LogoutRequest's EncryptedID over HTTP-POST and HTTP-Redirect", async () => {
  const req = await verifyLogoutRequest(
    logoutOptions(await signedPost(await logoutWithEncryptedId())),
  );
  assertEquals(req.nameId, "alice@example.com");
  const query = await redirectQuery(
    "SAMLRequest",
    (await logoutWithEncryptedId("{{enc}}", NAME_ID, { content: CONTENT.aes128cbc })).replace(
      marker("_lr1"),
      "",
    ),
    idp,
  );
  assertEquals((await verifyLogoutRequest(logoutOptions({ query }))).nameId, "alice@example.com");
  await refusedLogout({ query: tamper(decodeURIComponent(query)) }, "bad_signature");
});

Deno.test("saml encid: LogoutRequest attacks", async () => {
  await refusedLogout(
    post(tamper(await sign(await logoutWithEncryptedId(), "_lr1", { key: idp }))),
    "bad_signature",
  );
  // Unsigned over HTTP-POST: refused before anything is decrypted.
  await refusedLogout(
    post((await logoutWithEncryptedId()).replace(marker("_lr1"), "")),
    "unsigned",
  );
  await refusedLogout(
    await signedPost(await logoutWithEncryptedId("{{enc}}{{enc}}")),
    "malformed_response",
  );
  await refusedLogout(
    await signedPost(await logoutWithEncryptedId(`{{enc}}${NAME_ID}`)),
    "malformed_response",
  );
  await refusedLogout(
    await signedPost(
      await logoutWithEncryptedId("{{enc}}", "<saml:NameID>a<!---->b</saml:NameID>"),
    ),
    "unexpected_markup",
  );
  await refusedLogout(
    await signedPost(
      await logoutWithEncryptedId("{{enc}}", "<saml:SessionIndex>x</saml:SessionIndex>"),
    ),
    "malformed_response",
  );
  await refusedLogout(
    await signedPost(
      await logoutWithEncryptedId("{{enc}}", NAME_ID, { content: CONTENT.tripledes }),
    ),
    "unsupported_algorithm",
  );
  await refusedLogout(await signedPost(await logoutWithEncryptedId()), "decryption_failed", {
    sp: { ...SP, sloUrl: SLO_URL, encryptionKey: otherSp.pem },
  });
  await refusedLogout(
    await signedPost(await logoutWithEncryptedId()),
    "encrypted_assertion_unsupported",
    {
      sp: { ...SP, sloUrl: SLO_URL },
    },
  );
});
