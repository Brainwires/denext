// SAML Single Logout on denextAuth's own endpoints (a `saml()` provider with `sp.signingKey`):
// `POST /auth/signout` for a SAML session goes on to the IdP with a signed LogoutRequest, whose
// LogoutResponse lands at `/auth/saml/:id/slo`; an IdP-initiated LogoutRequest there ends the
// sessions its NameID (and SessionIndex) started and answers a signed LogoutResponse.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { saml } from "../src/server/auth/providers.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { encode, marker, responseXml, rsaKey, sign, type TestKey } from "./_saml-helpers.ts";
import {
  inflateParam,
  logoutRequestXml,
  logoutResponseXml,
  redirectQuery,
  type SpKey,
  spKey,
  verifySpRedirect,
} from "./_saml-enc-helpers.ts";
import { requestIdOf } from "./_saml-idp.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const IDP = "https://idp.acme.test/metadata";
const SSO_URL = "https://idp.acme.test/sso";
const IDP_SLO = "https://idp.acme.test/slo";
const ACS = `${ORIGIN}/auth/callback/acme`;
const SLO = `${ORIGIN}/auth/saml/acme/slo`;
const SP_ENTITY = `${ORIGIN}/auth/saml/acme/metadata`;

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function metadataXml(key: TestKey, slo = true): string {
  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${key.certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>${
    slo
      ? `<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP_SLO}"/>`
      : ""
  }
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${SSO_URL}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

interface App {
  config: AuthConfig;
  adapter: AuthAdapter;
  key: TestKey;
  sp: SpKey;
  signOuts: number;
}

async function app(options: { store?: boolean; signingKey?: boolean } = {}): Promise<App> {
  const key = await rsaKey();
  const sp = await spKey();
  const adapter = inMemoryAuthAdapter();
  const a: App = { config: {} as AuthConfig, adapter, key, sp, signOuts: 0 };
  a.config = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    adapter,
    rateLimit: false,
    ...(options.store ? { session: { strategy: "database" as const } } : {}),
    providers: [
      saml({
        id: "acme",
        metadataXml: metadataXml(key),
        domains: ["acme.test"],
        ...(options.signingKey === false
          ? {}
          : { sp: { signingKey: sp.pem, signingCertificate: sp.certificate } }),
      }),
    ],
    pages: { signIn: "/login", afterSignIn: "/home", afterSignOut: "/bye" },
    logger: { warn: () => {}, error: () => {}, debug: () => {} },
    events: { signOut: () => void a.signOuts++ },
  };
  return a;
}

async function call(config: AuthConfig, request: Request) {
  const ctx = createRequestContext(request);
  const res = await runWithContext(ctx, () => handleAuthRequest(request, config));
  return { res, cookies: ctx.outgoingHeaders.getSetCookie() };
}

const cookieOf = (cookies: string[], name: string) =>
  cookies.find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))?.split(";")[0];

/** A signed SAMLResponse for this app's ACS. */
async function samlResponse(
  a: App,
  inResponseTo: string,
  nameId: string,
  sessionIndex: string,
): Promise<string> {
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
    nameId,
    notBefore: iso(t - 60_000),
    notOnOrAfter: iso(t + 300_000),
    confirmationNotOnOrAfter: iso(t + 300_000),
    issueInstant: iso(t - 1000),
    sessionNotOnOrAfter: iso(t + 3600_000),
    assertionId: id,
    assertionSig: marker(id),
    assertionTail: "",
  }).replace(`SessionIndex="_session1"`, `SessionIndex="${sessionIndex}"`);
  return encode(await sign(xml, id, { key: a.key }));
}

/** Sign in through the IdP; the session cookie (`name=value`). */
async function signIn(a: App, nameId = "ada@acme.test", sessionIndex = "_s1"): Promise<string> {
  const start = await call(a.config, new Request(`${ORIGIN}/auth/signin/acme`));
  const location = start.res!.headers.get("location")!;
  const tx = cookieOf(start.cookies, "__Host-denext_auth_tx")!;
  const out = await postAcs(a, tx, {
    SAMLResponse: await samlResponse(a, await requestIdOf(location), nameId, sessionIndex),
    RelayState: new URL(location).searchParams.get("RelayState")!,
  });
  assert(out.session, `no session (${out.location})`);
  return out.session;
}

async function postAcs(a: App, tx: string, form: Record<string, string>) {
  const { res, cookies } = await call(
    a.config,
    new Request(ACS, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: tx },
      body: new URLSearchParams(form),
    }),
  );
  return {
    location: res!.headers.get("location") ?? "",
    session: cookieOf(cookies, "__Host-denext_auth"),
  };
}

async function sessionUser(a: App, cookie: string): Promise<{ id: string } | null> {
  const { res } = await call(
    a.config,
    new Request(`${ORIGIN}/auth/session`, { headers: { accept: "application/json", cookie } }),
  );
  return (await res!.json()).user ?? null;
}

async function signOut(a: App, cookie: string, json = false) {
  return await call(
    a.config,
    new Request(`${ORIGIN}/auth/signout`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie, ...(json ? { accept: "application/json" } : {}) },
    }),
  );
}

/** An IdP LogoutRequest over HTTP-Redirect, to this SP's SLO URL. */
function idpLogoutQuery(
  a: App,
  fields: { nameId: string; sessionIndexes?: string[]; id?: string; issuer?: string },
  relayState?: string,
): Promise<string> {
  return redirectQuery(
    "SAMLRequest",
    logoutRequestXml({
      id: fields.id ?? `_lr${crypto.randomUUID().replaceAll("-", "")}`,
      destination: SLO,
      issuer: fields.issuer ?? IDP,
      issueInstant: iso(Date.now()),
      nameId: fields.nameId,
      sessionIndexes: fields.sessionIndexes ?? [],
      inResponseTo: null,
    }),
    a.key,
    relayState !== undefined ? { relayState } : {},
  );
}

/** The IdP's LogoutResponse over HTTP-Redirect. */
function idpLogoutResponse(a: App, inResponseTo: string, relayState: string, status?: string) {
  return redirectQuery(
    "SAMLResponse",
    logoutResponseXml({
      id: `_lresp${crypto.randomUUID().replaceAll("-", "")}`,
      destination: SLO,
      issuer: IDP,
      issueInstant: iso(Date.now()),
      inResponseTo,
      ...(status ? { status } : {}),
    }),
    a.key,
    { relayState },
  );
}

// ---- metadata -----------------------------------------------------------------------------------

Deno.test("with a signing key the SP metadata lists /auth/saml/:id/slo as its SingleLogoutService", async () => {
  const a = await app();
  const { res } = await call(a.config, new Request(`${ORIGIN}/auth/saml/acme/metadata`));
  assertStringIncludes(await res!.text(), `Location="${SLO}"`);
  const off = await app({ signingKey: false });
  const meta = await call(off.config, new Request(`${ORIGIN}/auth/saml/acme/metadata`));
  assert(!(await meta.res!.text()).includes("SingleLogoutService"));
  assertEquals(
    await call(off.config, new Request(`${SLO}?SAMLRequest=x`)).then((r) => r.res),
    null,
  );
});

// ---- SP-initiated -------------------------------------------------------------------------------

Deno.test("signout of a SAML session ends it and sends a signed LogoutRequest to the IdP", async () => {
  const a = await app();
  const session = await signIn(a);
  const { res, cookies } = await signOut(a, session);
  assertEquals(res!.status, 303);
  const location = res!.headers.get("location")!;
  assert(location.startsWith(`${IDP_SLO}?`), location);
  assert(await verifySpRedirect(location, a.sp.spki), "the query signature verifies");
  const xml = await inflateParam(location, "SAMLRequest");
  assertStringIncludes(xml, ">ada@acme.test</saml:NameID>");
  assertStringIncludes(xml, "<samlp:SessionIndex>_s1</samlp:SessionIndex>");
  assertStringIncludes(xml, `Destination="${IDP_SLO}"`);
  assert(
    cookies.some((c) => c.startsWith("__Host-denext_auth=;")),
    "the local session cookie is cleared at once",
  );
  assert(cookieOf(cookies, "__Host-denext_auth_tx"), "the pending logout rides the tx cookie");
  assertEquals(a.signOuts, 1);
});

Deno.test("a JSON signout answers { ok, url } for the IdP", async () => {
  const a = await app();
  const { res } = await signOut(a, await signIn(a), true);
  const body = await res!.json();
  assertEquals(body.ok, true);
  assert(String(body.url).startsWith(`${IDP_SLO}?`));
});

Deno.test("the IdP's LogoutResponse to our request lands on the sign-out target", async () => {
  const a = await app();
  const { res, cookies } = await signOut(a, await signIn(a));
  const location = res!.headers.get("location")!;
  const tx = cookieOf(cookies, "__Host-denext_auth_tx")!;
  const relay = new URL(location).searchParams.get("RelayState")!;
  const query = await idpLogoutResponse(a, await requestIdOf(location), relay);
  const back = await call(a.config, new Request(`${SLO}${query}`, { headers: { cookie: tx } }));
  assertEquals(back.res!.status, 303);
  assertEquals(back.res!.headers.get("location"), "/bye");
});

Deno.test("a LogoutResponse with the wrong RelayState, answering another request, or without the transaction is refused", async () => {
  const a = await app();
  const { res, cookies } = await signOut(a, await signIn(a));
  const location = res!.headers.get("location")!;
  const tx = cookieOf(cookies, "__Host-denext_auth_tx")!;
  const relay = new URL(location).searchParams.get("RelayState")!;
  const id = await requestIdOf(location);
  const cases = [
    { query: await idpLogoutResponse(a, id, "not-the-relay"), cookie: tx },
    { query: await idpLogoutResponse(a, "_someone_else", relay), cookie: tx },
    { query: await idpLogoutResponse(a, id, relay), cookie: "" },
  ];
  for (const c of cases) {
    const back = await call(
      a.config,
      new Request(`${SLO}${c.query}`, { headers: c.cookie ? { cookie: c.cookie } : {} }),
    );
    assertEquals(back.res!.status, 303);
    assertMatch(back.res!.headers.get("location")!, /\?error=saml_logout_failed$/);
  }
});

Deno.test("an IdP-reported partial logout lands with ?error=saml_logout_failed", async () => {
  const a = await app();
  const { res, cookies } = await signOut(a, await signIn(a));
  const location = res!.headers.get("location")!;
  const query = await idpLogoutResponse(
    a,
    await requestIdOf(location),
    new URL(location).searchParams.get("RelayState")!,
    "urn:oasis:names:tc:SAML:2.0:status:Responder",
  );
  const back = await call(
    a.config,
    new Request(`${SLO}${query}`, {
      headers: { cookie: cookieOf(cookies, "__Host-denext_auth_tx")! },
    }),
  );
  assertEquals(back.res!.headers.get("location"), "/bye?error=saml_logout_failed");
});

Deno.test("the ACS never accepts a Single Logout transaction as a sign-in", async () => {
  const a = await app();
  await a.adapter.createUser({ email: "eve@acme.test" });
  const { res, cookies } = await signOut(a, await signIn(a));
  const location = res!.headers.get("location")!;
  const out = await postAcs(a, cookieOf(cookies, "__Host-denext_auth_tx")!, {
    SAMLResponse: await samlResponse(a, await requestIdOf(location), "ada@acme.test", "_s9"),
    RelayState: new URL(location).searchParams.get("RelayState")!,
  });
  assertEquals(out.session, undefined);
  assertMatch(out.location, /error=invalid_state/);
});

Deno.test("a session from another provider signs out locally only", async () => {
  const a = await app();
  const user = await a.adapter.createUser({ email: "x@y.test" });
  const ctx = createRequestContext(new Request(`${ORIGIN}/`));
  const { issueAuthSession } = await import("../src/server/auth/session.ts");
  await runWithContext(
    ctx,
    () =>
      issueAuthSession(a.config, { id: user.id, email: "x@y.test" }, "credentials", {
        amr: ["pwd"],
      }),
  );
  const cookie = cookieOf(ctx.outgoingHeaders.getSetCookie(), "__Host-denext_auth")!;
  const { res } = await signOut(a, cookie);
  assertEquals(res!.headers.get("location"), "/bye");
});

// ---- IdP-initiated ------------------------------------------------------------------------------

Deno.test("an IdP LogoutRequest ends the NameID's sessions and answers a signed LogoutResponse", async () => {
  const a = await app();
  const ada = await signIn(a, "ada@acme.test");
  const bob = await signIn(a, "bob@acme.test");
  const query = await idpLogoutQuery(a, { nameId: "ada@acme.test", id: "_idp_lr_1" }, "rs-1");
  // The clock moves on a second: a stateless session ends when signed in before now.
  const realNow = Date.now;
  Date.now = () => realNow() + 1500;
  try {
    const { res } = await call(a.config, new Request(`${SLO}${query}`));
    assertEquals(res!.status, 303);
    const location = res!.headers.get("location")!;
    assert(location.startsWith(`${IDP_SLO}?`));
    assert(await verifySpRedirect(location, a.sp.spki));
    const xml = await inflateParam(location, "SAMLResponse");
    assertStringIncludes(xml, `InResponseTo="_idp_lr_1"`);
    assertStringIncludes(xml, "status:Success");
    assertEquals(new URL(location).searchParams.get("RelayState"), "rs-1");
    assertEquals(await sessionUser(a, ada), null, "ada's session ended");
    assert(await sessionUser(a, bob), "bob's session lives");
  } finally {
    Date.now = realNow;
  }
});

Deno.test("with a session store, a LogoutRequest ends exactly the session its SessionIndex names", async () => {
  const a = await app({ store: true });
  const first = await signIn(a, "ada@acme.test", "_s1");
  const second = await signIn(a, "ada@acme.test", "_s2");
  const query = await idpLogoutQuery(a, { nameId: "ada@acme.test", sessionIndexes: ["_s1"] });
  const { res } = await call(a.config, new Request(`${SLO}${query}`));
  assertEquals(res!.status, 303);
  assertEquals(await sessionUser(a, first), null);
  assert(await sessionUser(a, second), "the other session of the same NameID lives");
});

Deno.test("an IdP LogoutRequest over HTTP-POST (an enveloped signature) is answered too", async () => {
  const a = await app({ store: true });
  const session = await signIn(a);
  const id = "_idp_lr_post";
  const xml = logoutRequestXml({
    id,
    destination: SLO,
    issuer: IDP,
    issueInstant: iso(Date.now()),
    nameId: "ada@acme.test",
    sessionIndexes: [],
    inResponseTo: null,
    sig: marker(id),
  });
  const { res } = await call(
    a.config,
    new Request(SLO, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ SAMLRequest: encode(await sign(xml, id, { key: a.key })) }),
    }),
  );
  assertEquals(res!.status, 303);
  assertEquals(await sessionUser(a, session), null);
});

Deno.test("an unsigned, foreign, misdirected or replayed LogoutRequest is refused and ends nothing", async () => {
  const a = await app({ store: true });
  const session = await signIn(a);
  const other = await rsaKey();
  const unsigned = await redirectQuery(
    "SAMLRequest",
    logoutRequestXml({
      destination: SLO,
      issuer: IDP,
      issueInstant: iso(Date.now()),
      nameId: "ada@acme.test",
      sessionIndexes: [],
      inResponseTo: null,
    }),
    a.key,
    { unsigned: true },
  );
  const forged = await idpLogoutQuery({ ...a, key: other }, { nameId: "ada@acme.test" });
  const foreignIssuer = await idpLogoutQuery(a, {
    nameId: "ada@acme.test",
    issuer: "https://evil.test/metadata",
  });
  const misdirected = await redirectQuery(
    "SAMLRequest",
    logoutRequestXml({
      destination: `${ORIGIN}/auth/v1/sso/saml/slo`,
      issuer: IDP,
      issueInstant: iso(Date.now()),
      nameId: "ada@acme.test",
      sessionIndexes: [],
      inResponseTo: null,
    }),
    a.key,
  );
  for (const query of [unsigned, forged, foreignIssuer, misdirected]) {
    const { res } = await call(a.config, new Request(`${SLO}${query}`));
    assertEquals(res!.status, 400, query.slice(0, 40));
  }
  assert(await sessionUser(a, session), "nothing ended");
  // A replay: the first is answered, the same message again is refused.
  const once = await idpLogoutQuery(a, { nameId: "nobody@acme.test", id: "_idp_once" });
  assertEquals((await call(a.config, new Request(`${SLO}${once}`))).res!.status, 303);
  assertEquals((await call(a.config, new Request(`${SLO}${once}`))).res!.status, 400);
});
