// SAML single sign-on through `/auth/v1` end to end (raw HTTP, an in-test IdP key): `POST /sso`
// builds the AuthnRequest, the IdP's signed response is posted to the ACS, and the browser lands
// on `redirect_to` with a session (implicit) or a one-time code (PKCE). Also: the SP metadata,
// a response for another request, a replayed RelayState, an IdP-initiated response, a tampered
// response, and the email-domain rule for existing accounts.

import { assert, assertEquals, assertExists, assertMatch, assertStringIncludes } from "@std/assert";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import type { GoTrueOptions } from "../src/server/auth/gotrue/options.ts";
import { encode, marker, responseXml, rsaKey, sign, type TestKey } from "./_saml-helpers.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp } from "./_supabase-auth-app.ts";

const IDP = "https://idp.example.org/metadata";
const SP_ENTITY = `${ORIGIN}/auth/v1/sso/saml/metadata`;
const ACS = `${ORIGIN}/auth/v1/sso/saml/acs`;

function metadataXml(cert: string): string {
  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.org/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

async function requestIdOf(url: string): Promise<string> {
  const raw = new URL(url).searchParams.get("SAMLRequest")!;
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  const xml = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
  ).text();
  return xml.match(/ ID="([^"]+)"/)![1];
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

async function samlResponse(key: TestKey, inResponseTo: string | null, nameId: string) {
  const now = Date.now();
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
    notBefore: iso(now - 60_000),
    notOnOrAfter: iso(now + 300_000),
    confirmationNotOnOrAfter: iso(now + 300_000),
    issueInstant: iso(now - 1000),
    sessionNotOnOrAfter: iso(now + 3600_000),
    assertionId: id,
    assertionSig: marker(id),
  });
  return encode(await sign(xml, id, { key }));
}

async function startSso(app: SupabaseAuthApp, body: Record<string, unknown>) {
  const res = await app.fetch(`${ORIGIN}/auth/v1/sso`, {
    method: "POST",
    headers: { apikey: app.publishableKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function postAcs(app: SupabaseAuthApp, form: Record<string, string>) {
  return app.fetch(ACS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    redirect: "manual",
  });
}

async function withSso(fn: (app: SupabaseAuthApp, key: TestKey) => Promise<void>) {
  const key = await rsaKey();
  const auth: GoTrueOptions = {
    saml: {
      providers: [{
        id: "acme",
        domains: ["example.com"],
        metadataXml: metadataXml(key.certificate),
        attributeMapping: { groups: "groups" },
      }],
    },
  };
  const app = await supabaseAuthApp({ adapter: inMemoryAuthAdapter(), auth, withClient: false });
  try {
    await fn(app, key);
  } finally {
    await app.close();
  }
}

Deno.test("SAML SSO: SP-initiated login, implicit landing, and the SP metadata", async () => {
  await withSso(async (app, key) => {
    const metadata = await app.fetch(`${ORIGIN}/auth/v1/sso/saml/metadata`);
    assertEquals(metadata.status, 200);
    assertStringIncludes(await metadata.text(), ACS);
    const started = await startSso(app, {
      domain: "example.com",
      redirect_to: `${ORIGIN}/welcome`,
    });
    assertEquals(started.status, 200);
    assertMatch(started.json.url, /^https:\/\/idp\.example\.org\/sso\?SAMLRequest=/);
    const relay = new URL(started.json.url).searchParams.get("RelayState")!;
    const requestId = await requestIdOf(started.json.url);
    const res = await postAcs(app, {
      SAMLResponse: await samlResponse(key, requestId, "alice@example.com"),
      RelayState: relay,
    });
    assertEquals(res.status, 303);
    const landing = new URL(res.headers.get("location")!);
    assertEquals(landing.pathname, "/welcome");
    const fragment = new URLSearchParams(landing.hash.slice(1));
    const token = fragment.get("access_token")!;
    assertExists(token);
    const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    assertEquals(claims.email, "alice@example.com");
    assertEquals(claims.amr[0].method, "sso/saml");
    assertEquals(claims.app_metadata.provider, "sso:acme");
    // The same RelayState again: refused (single-use).
    const again = await postAcs(app, {
      SAMLResponse: await samlResponse(key, requestId, "alice@example.com"),
      RelayState: relay,
    });
    assertEquals(again.status, 400);
    assertEquals((await again.json()).error_code, "bad_oauth_state");
  });
});

Deno.test("SAML SSO: PKCE, and refused responses land with an error", async () => {
  await withSso(async (app, key) => {
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const started = await startSso(app, {
      provider_id: "acme",
      redirect_to: `${ORIGIN}/cb`,
      code_challenge: challenge,
      code_challenge_method: "s256",
    });
    const relay = new URL(started.json.url).searchParams.get("RelayState")!;
    // A response answering another request: refused, landing with an error query.
    const wrong = await postAcs(app, {
      SAMLResponse: await samlResponse(key, "_someOtherRequest", "bob@example.com"),
      RelayState: relay,
    });
    assertEquals(wrong.status, 303);
    assertStringIncludes(wrong.headers.get("location")!, "error_code=saml_assertion_invalid");
    // A fresh login, signed correctly: a code exchanged with the verifier.
    const second = await startSso(app, {
      provider_id: "acme",
      redirect_to: `${ORIGIN}/cb`,
      code_challenge: challenge,
      code_challenge_method: "s256",
    });
    const res = await postAcs(app, {
      SAMLResponse: await samlResponse(key, await requestIdOf(second.json.url), "bob@example.com"),
      RelayState: new URL(second.json.url).searchParams.get("RelayState")!,
    });
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    assertExists(code);
    const exchanged = await app.fetch(`${ORIGIN}/auth/v1/token?grant_type=pkce`, {
      method: "POST",
      headers: { apikey: app.publishableKey, "content-type": "application/json" },
      body: JSON.stringify({
        auth_code: code,
        code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      }),
    });
    assertEquals(exchanged.status, 200);
    assertEquals((await exchanged.json()).user.email, "bob@example.com");
    // IdP-initiated (no RelayState record) and a tampered body.
    const idpInitiated = await postAcs(app, {
      SAMLResponse: await samlResponse(key, null, "x@example.com"),
    });
    assertEquals(idpInitiated.status, 400);
    assertEquals((await app.fetch(ACS, { method: "POST", body: "x" })).status, 400);
  });
});

Deno.test("SAML SSO: unknown providers, and an existing account outside the IdP's domains", async () => {
  await withSso(async (app, key) => {
    assertEquals(
      (await startSso(app, { domain: "elsewhere.test" })).json.error_code,
      "sso_provider_not_found",
    );
    assertEquals((await startSso(app, {})).status, 404);
    const carol = await (await app.fetch(`${ORIGIN}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: app.secretKey, "content-type": "application/json" },
      body: JSON.stringify({ email: "carol@other.test", email_confirm: true }),
    })).json();
    const started = await startSso(app, { provider_id: "acme" });
    const res = await postAcs(app, {
      SAMLResponse: await samlResponse(
        key,
        await requestIdOf(started.json.url),
        "carol@other.test",
      ),
      RelayState: new URL(started.json.url).searchParams.get("RelayState")!,
    });
    // An address outside the IdP's domains is never matched to (or bound to) an account: the
    // assertion signs in a separate SSO user with no email, never Carol's account.
    assertEquals(res.status, 303);
    const token = new URLSearchParams(new URL(res.headers.get("location")!).hash.slice(1))
      .get("access_token")!;
    const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    assert(claims.sub !== carol.id, "not the existing account");
    assertEquals(claims.email ?? "", "");
  });
});
