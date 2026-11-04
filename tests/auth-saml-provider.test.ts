// `saml({ … })` on denextAuth's own endpoints: `GET /auth/signin/:id` sends an AuthnRequest to
// the IdP (its ID and a RelayState in the single-use transaction cookie), the IdP's Response is
// posted to `POST /auth/callback/:id`, and `GET /auth/saml/:id/metadata` publishes the SP. The
// Response goes through `/auth/v1`'s SAML verifier (signature, wrapping, audience, recipient,
// InResponseTo, replay) and the user through its SSO rules (domain-bound email, no takeover of an
// existing account, an SSO user whose session must come from its IdP).

import { assert, assertEquals, assertMatch, assertStringIncludes, assertThrows } from "@std/assert";
import type { AuthAdapter } from "../packages/auth/src/adapter.ts";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import { saml } from "../packages/auth/src/providers.ts";
import { handleAuthRequest } from "../packages/auth/src/routes.ts";
import { isSsoUser } from "../packages/auth/src/sso-user.ts";
import type { AuthConfig } from "../packages/auth/src/types.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { encode, marker, responseXml, rsaKey, sign, type TestKey } from "./_saml-helpers.ts";
import { requestIdOf } from "./_saml-idp.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const IDP = "https://idp.acme.test/metadata";
const SSO_URL = "https://idp.acme.test/sso";
const ACS = `${ORIGIN}/auth/callback/acme`;
const SP_ENTITY = `${ORIGIN}/auth/saml/acme/metadata`;

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function metadataXml(key: TestKey): string {
  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${key.certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${SSO_URL}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

interface ResponseOptions {
  inResponseTo: string;
  nameId: string;
  attributes?: Record<string, string[]>;
  audience?: string;
  recipient?: string;
  assertionId?: string;
  /** Edit the signed XML (a tampering test). */
  tamper?: (xml: string) => string;
}

/** A signed SAMLResponse (base64) for this app's ACS. */
async function response(key: TestKey, o: ResponseOptions): Promise<string> {
  const t = Date.now();
  const id = o.assertionId ?? `_a${crypto.randomUUID().replaceAll("-", "")}`;
  const attributes = Object.entries(o.attributes ?? {}).map(([name, values]) =>
    `<saml:Attribute Name="${name}">${
      values.map((v) => `<saml:AttributeValue>${v}</saml:AttributeValue>`).join("")
    }</saml:Attribute>`
  ).join("");
  const xml = responseXml({
    destination: o.recipient ?? ACS,
    recipient: o.recipient ?? ACS,
    audience: o.audience ?? SP_ENTITY,
    responseIssuer: IDP,
    issuer: IDP,
    responseInResponseTo: o.inResponseTo,
    inResponseTo: o.inResponseTo,
    nameId: o.nameId,
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
  });
  const signed = await sign(xml, id, { key });
  return encode(o.tamper ? o.tamper(signed) : signed);
}

interface App {
  config: AuthConfig;
  adapter: AuthAdapter;
  key: TestKey;
  failures: string[];
}

async function app(extra: Partial<Parameters<typeof saml>[0]> = {}): Promise<App> {
  const key = await rsaKey();
  const adapter = inMemoryAuthAdapter();
  const failures: string[] = [];
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    adapter,
    rateLimit: false,
    providers: [
      saml({ id: "acme", metadataXml: metadataXml(key), domains: ["acme.test"], ...extra }),
    ],
    pages: { signIn: "/login", afterSignIn: "/home" },
    logger: { warn: () => {}, error: () => {}, debug: () => {} },
    events: { signInFailed: (p) => void failures.push(String(p.reason)) },
  };
  return { config, adapter, key, failures };
}

async function call(config: AuthConfig, request: Request) {
  const ctx = createRequestContext(request);
  const res = (await runWithContext(ctx, () => handleAuthRequest(request, config)))!;
  return { res, cookies: ctx.outgoingHeaders.getSetCookie() };
}

/** Start a sign-in: the IdP redirect, its AuthnRequest ID, RelayState and the tx cookie. */
async function start(a: App) {
  const { res, cookies } = await call(a.config, new Request(`${ORIGIN}/auth/signin/acme`));
  assertEquals(res.status, 303);
  const location = res.headers.get("location")!;
  const tx = cookies.find((c) => c.startsWith("__Host-denext_auth_tx="))!;
  return {
    location,
    tx,
    requestId: await requestIdOf(location),
    relay: new URL(location).searchParams.get("RelayState")!,
  };
}

/** Post a Response to the ACS. */
async function acs(a: App, txCookie: string, form: Record<string, string>) {
  const { res, cookies } = await call(
    a.config,
    new Request(ACS, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: txCookie.split(";")[0],
        origin: "https://idp.acme.test",
      },
      body: new URLSearchParams(form),
    }),
  );
  const session = cookies.find((c) =>
    c.startsWith("__Host-denext_auth=") && !c.startsWith("__Host-denext_auth=;")
  );
  return { location: res.headers.get("location") ?? "", status: res.status, session };
}

async function sessionUser(a: App, cookie: string) {
  const { res } = await call(
    a.config,
    new Request(`${ORIGIN}/auth/session`, {
      headers: { accept: "application/json", cookie: cookie.split(";")[0] },
    }),
  );
  return (await res.json()).user as Record<string, unknown> | null;
}

// ---- the flow --------------------------------------------------------------------------------

Deno.test("signin sends an AuthnRequest to the IdP; the tx cookie is SameSite=None", async () => {
  const a = await app();
  const s = await start(a);
  assert(s.location.startsWith(`${SSO_URL}?`));
  assertMatch(s.requestId, /^_[0-9a-f]{40}$/);
  assert(s.relay.length >= 16);
  assertStringIncludes(s.tx.toLowerCase(), "samesite=none");
});

Deno.test("a signed Response for the request signs in an SSO user with a domain-bound email", async () => {
  const a = await app({ attributeMapping: { name: "displayName" } });
  const s = await start(a);
  const out = await acs(a, s.tx, {
    SAMLResponse: await response(a.key, {
      inResponseTo: s.requestId,
      nameId: "ada@acme.test",
      attributes: { displayName: ["Ada"] },
    }),
    RelayState: s.relay,
  });
  assert(out.session, `no session (${out.location})`);
  assertEquals(new URL(out.location, ORIGIN).pathname, "/home");
  const user = await sessionUser(a, out.session);
  assertEquals(user?.email, "ada@acme.test");
  const stored = await a.adapter.getUserByEmail("ada@acme.test");
  assert(stored && isSsoUser(stored), "an SSO user");
  assertEquals(stored.appMetadata?.provider, "sso:acme");
  assert(stored.emailVerified !== undefined);
  // The same NameID signs in the same user next time.
  const again = await start(a);
  const second = await acs(a, again.tx, {
    SAMLResponse: await response(a.key, { inResponseTo: again.requestId, nameId: "ada@acme.test" }),
    RelayState: again.relay,
  });
  assertEquals((await sessionUser(a, second.session!))?.id, user?.id);
});

Deno.test("an address off the provider's domains is never bound to the account", async () => {
  const a = await app();
  const s = await start(a);
  const out = await acs(a, s.tx, {
    SAMLResponse: await response(a.key, { inResponseTo: s.requestId, nameId: "victim@other.test" }),
    RelayState: s.relay,
  });
  assert(out.session);
  assertEquals((await sessionUser(a, out.session))?.email, undefined);
  assertEquals(await a.adapter.getUserByEmail("victim@other.test"), undefined);
});

Deno.test("an existing account with the address is not taken over (account_not_linked)", async () => {
  const a = await app();
  await a.adapter.createUser({ email: "boss@acme.test", emailVerified: 1 });
  const s = await start(a);
  const out = await acs(a, s.tx, {
    SAMLResponse: await response(a.key, { inResponseTo: s.requestId, nameId: "boss@acme.test" }),
    RelayState: s.relay,
  });
  assertEquals(out.session, undefined);
  assertStringIncludes(out.location, "error=account_not_linked");
});

// ---- the hardening -----------------------------------------------------------------------------

Deno.test("a tampered (re-written after signing) assertion is refused", async () => {
  const a = await app();
  const s = await start(a);
  const out = await acs(a, s.tx, {
    SAMLResponse: await response(a.key, {
      inResponseTo: s.requestId,
      nameId: "ada@acme.test",
      tamper: (xml) => xml.replace("ada@acme.test", "admin@acme.test"),
    }),
    RelayState: s.relay,
  });
  assertEquals(out.session, undefined);
  assertStringIncludes(out.location, "error=invalid_token");
});

Deno.test("signature wrapping: an unsigned assertion ahead of the signed one is refused", async () => {
  const a = await app();
  const s = await start(a);
  const out = await acs(a, s.tx, {
    SAMLResponse: await response(a.key, {
      inResponseTo: s.requestId,
      nameId: "ada@acme.test",
      tamper: (xml) => {
        const open = xml.indexOf("<saml:Assertion");
        const close = xml.indexOf("</saml:Assertion>") + "</saml:Assertion>".length;
        const evil = xml.slice(open, close)
          .replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, "")
          .replace(/ID="[^"]+"/, 'ID="_evil"')
          .replace("ada@acme.test", "admin@acme.test");
        return xml.slice(0, open) + evil + xml.slice(open);
      },
    }),
    RelayState: s.relay,
  });
  assertEquals(out.session, undefined);
});

Deno.test("audience, recipient and a key the metadata doesn't name are each refused", async () => {
  const a = await app();
  const other = await rsaKey();
  for (
    const opts of [
      { audience: `${ORIGIN}/auth/v1/sso/saml/metadata` },
      { recipient: `${ORIGIN}/auth/v1/sso/saml/acs` },
    ]
  ) {
    const s = await start(a);
    const out = await acs(a, s.tx, {
      SAMLResponse: await response(a.key, {
        inResponseTo: s.requestId,
        nameId: "ada@acme.test",
        ...opts,
      }),
      RelayState: s.relay,
    });
    assertEquals(out.session, undefined, JSON.stringify(opts));
  }
  const s = await start(a);
  const forged = await acs(a, s.tx, {
    SAMLResponse: await response(other, { inResponseTo: s.requestId, nameId: "ada@acme.test" }),
    RelayState: s.relay,
  });
  assertEquals(forged.session, undefined);
});

Deno.test("a Response for another request, or a replayed assertion, is refused", async () => {
  const a = await app();
  const first = await start(a);
  const second = await start(a);
  const wrongRequest = await acs(a, second.tx, {
    SAMLResponse: await response(a.key, { inResponseTo: first.requestId, nameId: "ada@acme.test" }),
    RelayState: second.relay,
  });
  assertEquals(wrongRequest.session, undefined);
  // An assertion id that was accepted once is never accepted again.
  const s1 = await start(a);
  const ok = await acs(a, s1.tx, {
    SAMLResponse: await response(a.key, {
      inResponseTo: s1.requestId,
      nameId: "ada@acme.test",
      assertionId: "_replayed",
    }),
    RelayState: s1.relay,
  });
  assert(ok.session);
  const s2 = await start(a);
  const replay = await acs(a, s2.tx, {
    SAMLResponse: await response(a.key, {
      inResponseTo: s2.requestId,
      nameId: "ada@acme.test",
      assertionId: "_replayed",
    }),
    RelayState: s2.relay,
  });
  assertEquals(replay.session, undefined);
});

Deno.test("no transaction, another RelayState, or an IdP-initiated Response: invalid_state", async () => {
  const a = await app();
  const s = await start(a);
  const body = await response(a.key, { inResponseTo: s.requestId, nameId: "ada@acme.test" });
  const noTx = await acs(a, "x=y", { SAMLResponse: body, RelayState: s.relay });
  assertStringIncludes(noTx.location, "error=invalid_state");
  const s2 = await start(a);
  const wrongRelay = await acs(a, s2.tx, { SAMLResponse: body, RelayState: "forged" });
  assertStringIncludes(wrongRelay.location, "error=invalid_state");
  // A GET to the ACS is not a SAML binding at all.
  const { res } = await call(a.config, new Request(ACS));
  assertEquals(res.status, 405);
});

Deno.test("the SP metadata names the ACS and entity id; providers lists the SAML provider", async () => {
  const a = await app({ name: "Acme SSO" });
  const { res } = await call(a.config, new Request(SP_ENTITY));
  assertEquals(res.status, 200);
  const xml = await res.text();
  assertStringIncludes(xml, `entityID="${SP_ENTITY}"`);
  assertStringIncludes(xml, `Location="${ACS}"`);
  const list = await (await call(a.config, new Request(`${ORIGIN}/auth/providers`))).res.json();
  assertEquals(list, [{ id: "acme", name: "Acme SSO", type: "saml" }]);
});

Deno.test("saml(): an unsafe id, a bad domain or unparseable metadata is refused up front", async () => {
  const key = await rsaKey();
  assertThrows(() => saml({ id: "../x", metadataXml: metadataXml(key) }), TypeError);
  assertThrows(
    () => saml({ id: "acme", metadataXml: metadataXml(key), domains: ["https://acme.test"] }),
    TypeError,
    "domain",
  );
  assertThrows(() => saml({ id: "acme", metadataXml: "<nope/>" }), TypeError, "metadata");
});

// ---- signature refusals, table-driven ------------------------------------------------------------

/** A Response whose signature must not be trusted, and the verifier's exact reason. */
interface SignatureRefusal {
  name: string;
  /** The base64 SAMLResponse for request `requestId`, signed by the trusted `key` or not. */
  build: (key: TestKey, requestId: string) => Promise<string>;
  /** The code the verifier refused it with (logged; the user sees `invalid_token`). */
  code: string;
}

const NAME_ID = "ada@acme.test";
const unsignedAssertion = (xml: string) => xml.replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, "");

const SIGNATURE_REFUSALS: SignatureRefusal[] = [
  {
    name: "an unsigned Response",
    build: (key, inResponseTo) =>
      response(key, { inResponseTo, nameId: NAME_ID, tamper: unsignedAssertion }),
    code: "unsigned",
  },
  {
    name: "a Response signed by a key the metadata doesn't name",
    build: async (_key, inResponseTo) =>
      response(await rsaKey(), { inResponseTo, nameId: NAME_ID }),
    code: "bad_signature",
  },
  {
    name: "a Response signed by another key that embeds its own certificate in KeyInfo",
    build: async (_key, inResponseTo) => {
      const other = await rsaKey();
      const t = Date.now();
      const id = `_a${crypto.randomUUID().replaceAll("-", "")}`;
      const xml = responseXml({
        destination: ACS,
        recipient: ACS,
        audience: SP_ENTITY,
        responseIssuer: IDP,
        issuer: IDP,
        responseInResponseTo: inResponseTo,
        inResponseTo,
        nameId: NAME_ID,
        notBefore: iso(t - 60_000),
        notOnOrAfter: iso(t + 300_000),
        confirmationNotOnOrAfter: iso(t + 300_000),
        issueInstant: iso(t - 1000),
        sessionNotOnOrAfter: iso(t + 3600_000),
        assertionId: id,
        assertionSig: marker(id),
        assertionTail: "",
      });
      return encode(await sign(xml, id, { key: other, keyInfoCertificate: other.certificate }));
    },
    code: "bad_signature",
  },
  {
    name: "a wrapped assertion (an unsigned copy ahead of the signed one)",
    build: (key, inResponseTo) =>
      response(key, {
        inResponseTo,
        nameId: NAME_ID,
        tamper: (xml) => {
          const open = xml.indexOf("<saml:Assertion");
          const close = xml.indexOf("</saml:Assertion>") + "</saml:Assertion>".length;
          const evil = unsignedAssertion(xml.slice(open, close))
            .replace(/ID="[^"]+"/, 'ID="_evil"')
            .replace(NAME_ID, "admin@acme.test");
          return xml.slice(0, open) + evil + xml.slice(open);
        },
      }),
    code: "multiple_assertions",
  },
  {
    name: "a signed assertion re-written after signing",
    build: (key, inResponseTo) =>
      response(key, {
        inResponseTo,
        nameId: NAME_ID,
        tamper: (xml) => xml.replace(NAME_ID, "admin@acme.test"),
      }),
    code: "bad_signature", // the digest no longer matches the signed bytes
  },
];

for (const row of SIGNATURE_REFUSALS) {
  Deno.test(`saml signature refusal: ${row.name} (${row.code}) mints no session or user`, async () => {
    const a = await app();
    const codes: string[] = [];
    a.config.logger = {
      debug: () => {},
      error: () => {},
      warn: (_message: string, data?: unknown) =>
        void codes.push(String((data as { code?: string } | undefined)?.code)),
    };
    const s = await start(a);
    const out = await acs(a, s.tx, {
      SAMLResponse: await row.build(a.key, s.requestId),
      RelayState: s.relay,
    });
    assertEquals(out.status, 303);
    assertEquals(new URL(out.location, ORIGIN).search, "?error=invalid_token");
    assertEquals(out.session, undefined, "no session cookie");
    assertEquals(codes, [row.code]);
    assertEquals(a.failures, ["invalid_token"]);
    assertEquals(await a.adapter.getUserByEmail(NAME_ID), undefined, "no user was created");
    assertEquals(await a.adapter.getUserByEmail("admin@acme.test"), undefined);
  });
}
