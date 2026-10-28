// SAML Single Logout and encrypted assertions through `/auth/v1` end to end (raw HTTP): the SP
// metadata with its keys, an encrypted login, SP-initiated logout (`POST /logout` → a signed
// LogoutRequest URL → the IdP's LogoutResponse at `/sso/saml/slo`), and IdP-initiated logout
// (a signed LogoutRequest over HTTP-Redirect or HTTP-POST ends exactly the sessions it names and
// is answered with a signed LogoutResponse) — plus the refusals (unsigned, replayed, wrong
// destination, a LogoutResponse for another request).

import { assert, assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import type { GoTrueOptions } from "../packages/auth/src/gotrue/options.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp } from "./_supabase-auth-app.ts";
import { ACS, requestIdOf, SLO, testIdp } from "./_saml-idp.ts";
import { encryptNameId, inflateParam, spKey, verifySpRedirect } from "./_saml-enc-helpers.ts";

const idp = await testIdp();
const signing = await spKey();
const encryption = await spKey();

function pemCert(b64: string): string {
  return `-----BEGIN CERTIFICATE-----\n${
    b64.match(/.{1,64}/g)!.join("\n")
  }\n-----END CERTIFICATE-----`;
}

const SAML: GoTrueOptions["saml"] = {
  providers: [{ id: "acme", domains: ["example.com"], metadataXml: idp.metadataXml() }],
  signingKey: signing.pem,
  signingCertificate: pemCert(signing.certificate),
  encryptionKey: encryption.jwk,
  encryptionCertificate: encryption.certificate,
};

async function withSlo(fn: (app: SupabaseAuthApp) => Promise<void>, saml = SAML) {
  const app = await supabaseAuthApp({
    adapter: inMemoryAuthAdapter(),
    auth: { saml, redirectUrls: [`${ORIGIN}/**`] },
    withClient: false,
  });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

const authed = (app: SupabaseAuthApp, token: string) => ({
  apikey: app.publishableKey,
  authorization: `Bearer ${token}`,
});

/** Sign in through the IdP; the access token. */
async function login(
  app: SupabaseAuthApp,
  nameId: string,
  sessionIndex: string,
  encrypt: boolean | "nameId" = false,
): Promise<string> {
  const started = await (await app.fetch(`${ORIGIN}/auth/v1/sso`, {
    method: "POST",
    headers: { apikey: app.publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ provider_id: "acme", redirect_to: `${ORIGIN}/in` }),
  })).json();
  const res = await app.fetch(ACS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      SAMLResponse: await idp.response({
        inResponseTo: await requestIdOf(started.url),
        nameId,
        sessionIndex,
        ...(encrypt === true ? { encryptTo: encryption } : {}),
        ...(encrypt === "nameId" ? { encryptNameIdTo: encryption } : {}),
      }),
      RelayState: new URL(started.url).searchParams.get("RelayState")!,
    }),
    redirect: "manual",
  });
  assertEquals(res.status, 303);
  const token = new URLSearchParams(new URL(res.headers.get("location")!).hash.slice(1))
    .get("access_token");
  assertExists(token, res.headers.get("location")!);
  return token;
}

async function alive(app: SupabaseAuthApp, token: string): Promise<boolean> {
  const res = await app.fetch(`${ORIGIN}/auth/v1/user`, { headers: authed(app, token) });
  await res.body?.cancel();
  return res.status === 200;
}

Deno.test("SLO: SP metadata publishes keys and the SLO endpoint; AuthnRequests are signed", async () => {
  await withSlo(async (app) => {
    const xml = await (await app.fetch(`${ORIGIN}/auth/v1/sso/saml/metadata`)).text();
    assertStringIncludes(xml, `AuthnRequestsSigned="true"`);
    assertStringIncludes(xml, `<md:KeyDescriptor use="signing">`);
    assertStringIncludes(xml, signing.certificate);
    assertStringIncludes(xml, `<md:KeyDescriptor use="encryption">`);
    assertStringIncludes(xml, encryption.certificate);
    assertStringIncludes(xml, `Location="${SLO}"`);
    const started = await (await app.fetch(`${ORIGIN}/auth/v1/sso`, {
      method: "POST",
      headers: { apikey: app.publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ domain: "example.com" }),
    })).json();
    assert(await verifySpRedirect(started.url, signing.spki));
  });
});

Deno.test("SLO: an encrypted assertion signs the user in", async () => {
  await withSlo(async (app) => {
    const token = await login(app, "erin@example.com", "_e1", true);
    assert(await alive(app, token));
  });
});

Deno.test("SLO: SP-initiated — /logout answers the IdP URL, the LogoutResponse lands", async () => {
  await withSlo(async (app) => {
    const token = await login(app, "alice@example.com", "_s1");
    const out = await app.fetch(`${ORIGIN}/auth/v1/logout?scope=local&redirect_to=${ORIGIN}/bye`, {
      method: "POST",
      headers: authed(app, token),
    });
    assertEquals(out.status, 200);
    const { url } = await out.json();
    assert(url.startsWith(`${idp.sloUrl}?SAMLRequest=`));
    assert(await verifySpRedirect(url, signing.spki));
    const request = await inflateParam(url, "SAMLRequest");
    assertStringIncludes(request, `>alice@example.com</saml:NameID>`);
    assertStringIncludes(request, `<samlp:SessionIndex>_s1</samlp:SessionIndex>`);
    assertStringIncludes(request, `Destination="${idp.sloUrl}"`);
    // The local session ended at once.
    assertEquals(await alive(app, token), false);
    const requestId = request.match(/ ID="([^"]+)"/)![1];
    const relay = new URL(url).searchParams.get("RelayState")!;
    // A LogoutResponse for another request lands with an error.
    const wrong = await app.fetch(`${SLO}${await idp.logoutResponseQuery("_other", relay)}`, {
      redirect: "manual",
    });
    assertEquals(wrong.status, 303);
    assertStringIncludes(wrong.headers.get("location")!, "error_code=saml_logout_invalid");
    // The RelayState was single-use: log out again for a fresh one.
    const token2 = await login(app, "alice@example.com", "_s2");
    const again = await (await app.fetch(`${ORIGIN}/auth/v1/logout?redirect_to=${ORIGIN}/bye`, {
      method: "POST",
      headers: authed(app, token2),
    })).json();
    const relay2 = new URL(again.url).searchParams.get("RelayState")!;
    const id2 = (await inflateParam(again.url, "SAMLRequest")).match(/ ID="([^"]+)"/)![1];
    const done = await app.fetch(`${SLO}${await idp.logoutResponseQuery(id2, relay2)}`, {
      redirect: "manual",
    });
    assertEquals([done.status, done.headers.get("location")], [303, `${ORIGIN}/bye`]);
    const replay = await app.fetch(`${SLO}${await idp.logoutResponseQuery(id2, relay2)}`);
    assertEquals([replay.status, (await replay.json()).error_code], [400, "bad_oauth_state"]);
    // A partial logout lands with an error too.
    const token3 = await login(app, "alice@example.com", "_s3");
    const third = await (await app.fetch(`${ORIGIN}/auth/v1/logout`, {
      method: "POST",
      headers: authed(app, token3),
    })).json();
    const partial = await app.fetch(
      `${SLO}${await idp.logoutResponseQuery(
        (await inflateParam(third.url, "SAMLRequest")).match(/ ID="([^"]+)"/)![1],
        new URL(third.url).searchParams.get("RelayState")!,
        "urn:oasis:names:tc:SAML:2.0:status:Responder",
      )}`,
      { redirect: "manual" },
    );
    assertStringIncludes(partial.headers.get("location")!, "error_code=saml_logout_failed");
    assertEquals(requestId.startsWith("_"), true);
  });
});

Deno.test("SLO: /logout of a password session, or scope=others, stays a 204", async () => {
  await withSlo(async (app) => {
    const token = await login(app, "alice@example.com", "_s1");
    const others = await app.fetch(`${ORIGIN}/auth/v1/logout?scope=others`, {
      method: "POST",
      headers: authed(app, token),
    });
    assertEquals(others.status, 204);
    assert(await alive(app, token));
  });
  // Without a signing key there is no Single Logout at all.
  await withSlo(async (app) => {
    const token = await login(app, "alice@example.com", "_s1");
    const out = await app.fetch(`${ORIGIN}/auth/v1/logout`, {
      method: "POST",
      headers: authed(app, token),
    });
    assertEquals(out.status, 204);
    const slo = await app.fetch(`${SLO}?SAMLRequest=x`);
    assertEquals([slo.status, (await slo.json()).error_code], [404, "saml_provider_disabled"]);
    const xml = await (await app.fetch(`${ORIGIN}/auth/v1/sso/saml/metadata`)).text();
    assertEquals(xml.includes("SingleLogoutService"), false);
  }, { providers: SAML!.providers });
  // An IdP without a SingleLogoutService: the local logout stands alone.
  await withSlo(async (app) => {
    const token = await login(app, "alice@example.com", "_s1");
    const out = await app.fetch(`${ORIGIN}/auth/v1/logout`, {
      method: "POST",
      headers: authed(app, token),
    });
    assertEquals(out.status, 204);
  }, {
    ...SAML,
    providers: [{
      id: "acme",
      domains: ["example.com"],
      metadataXml: idp.metadataXml({ slo: false }),
    }],
  });
});

Deno.test("SLO: IdP-initiated — ends exactly the sessions named, answers a signed response", async () => {
  await withSlo(async (app) => {
    const a1 = await login(app, "alice@example.com", "_a1");
    const a2 = await login(app, "alice@example.com", "_a2");
    const bob = await login(app, "bob@example.com", "_b1");
    // HTTP-POST, naming one SessionIndex.
    const posted = await app.fetch(SLO, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        SAMLRequest: await idp.logoutRequestPost({ sessionIndexes: ["_a1"] }),
        RelayState: "rs",
      }),
      redirect: "manual",
    });
    assertEquals(posted.status, 303);
    const answer = posted.headers.get("location")!;
    assert(answer.startsWith(`${idp.sloUrl}?SAMLResponse=`));
    assert(await verifySpRedirect(answer, signing.spki));
    assertEquals(new URL(answer).searchParams.get("RelayState"), "rs");
    assertStringIncludes(await inflateParam(answer, "SAMLResponse"), `status:Success`);
    assertEquals(
      [await alive(app, a1), await alive(app, a2), await alive(app, bob)],
      [false, true, true],
    );
    // HTTP-Redirect, no SessionIndex: every session of the NameID.
    const query = await idp.logoutRequestQuery({ id: "_lr-all", sessionIndexes: [] });
    const redirected = await app.fetch(`${SLO}${query}`, { redirect: "manual" });
    assertEquals(redirected.status, 303);
    assertStringIncludes(
      await inflateParam(redirected.headers.get("location")!, "SAMLResponse"),
      `InResponseTo="_lr-all"`,
    );
    assertEquals([await alive(app, a2), await alive(app, bob)], [false, true]);
    // Refusals: replayed, unsigned, wrong destination, unknown IdP, garbage.
    const replay = await app.fetch(`${SLO}${query}`);
    assertEquals([replay.status, (await replay.json()).error_code], [400, "validation_failed"]);
    const unsigned = await app.fetch(SLO, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        SAMLRequest: btoa(
          `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_u" Version="2.0" IssueInstant="${
            new Date().toISOString()
          }" Destination="${SLO}"><saml:Issuer>${idp.entityId}</saml:Issuer><saml:NameID>bob@example.com</saml:NameID></samlp:LogoutRequest>`,
        ),
      }),
    });
    assertEquals(unsigned.status, 400);
    const misdirected = await app.fetch(
      `${SLO}${await idp.logoutRequestQuery({ id: "_lr-x", destination: "https://evil/slo" })}`,
    );
    assertEquals(misdirected.status, 400);
    const stranger = await testIdp("https://stranger.example/metadata");
    const unknown = await app.fetch(`${SLO}${await stranger.logoutRequestQuery({ id: "_s" })}`);
    assertEquals([unknown.status, (await unknown.json()).error_code], [
      404,
      "sso_provider_not_found",
    ]);
    assertEquals((await app.fetch(`${SLO}?SAMLRequest=%%`)).status, 400);
    assertEquals((await app.fetch(SLO, { method: "POST", body: "x" })).status, 400);
    assert(await alive(app, bob));
  });
});

Deno.test("SLO: a PKCE login keeps its SAML origin for Single Logout", async () => {
  await withSlo(async (app) => {
    const started = await (await app.fetch(`${ORIGIN}/auth/v1/sso`, {
      method: "POST",
      headers: { apikey: app.publishableKey, "content-type": "application/json" },
      body: JSON.stringify({
        provider_id: "acme",
        redirect_to: `${ORIGIN}/cb`,
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "s256",
      }),
    })).json();
    const res = await app.fetch(ACS, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        SAMLResponse: await idp.response({
          inResponseTo: await requestIdOf(started.url),
          nameId: "pat@example.com",
          sessionIndex: "_p1",
        }),
        RelayState: new URL(started.url).searchParams.get("RelayState")!,
      }),
      redirect: "manual",
    });
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const session = await (await app.fetch(`${ORIGIN}/auth/v1/token?grant_type=pkce`, {
      method: "POST",
      headers: { apikey: app.publishableKey, "content-type": "application/json" },
      body: JSON.stringify({
        auth_code: code,
        code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      }),
    })).json();
    assert(await alive(app, session.access_token));
    await app.fetch(
      `${SLO}${await idp.logoutRequestQuery({
        nameId: "pat@example.com",
        sessionIndexes: ["_p1"],
      })}`,
    )
      .then((r) => r.body?.cancel());
    assertEquals(await alive(app, session.access_token), false);
  });
});

Deno.test("SLO: an EncryptedID signs in, and an IdP LogoutRequest's EncryptedID logs out", async () => {
  await withSlo(async (app) => {
    const token = await login(app, "carol@example.com", "_e1", "nameId");
    const user = await (await app.fetch(`${ORIGIN}/auth/v1/user`, { headers: authed(app, token) }))
      .json();
    assertEquals(user.email, "carol@example.com");
    const nameIdElement = await encryptNameId(
      `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">carol@example.com</saml:NameID>`,
      encryption,
    );
    const posted = await app.fetch(SLO, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        SAMLRequest: await idp.logoutRequestPost({ nameIdElement, sessionIndexes: ["_e1"] }),
      }),
      redirect: "manual",
    });
    assertEquals(posted.status, 303);
    assertEquals(await alive(app, token), false);
  });
});
