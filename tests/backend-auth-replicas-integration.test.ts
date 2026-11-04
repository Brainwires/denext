// Two app replicas (separate processes sharing only a real Postgres) behind `backend({ postgres })`:
// the auth limiters and the SAML replay cache must hold across them, as they do for one process.
//   - an `/auth/v1/otp` send budget spent on one replica is spent on the other;
//   - a SAML assertion accepted by one replica is refused as a replay by the other;
// both with `backendAuthAdapter()` as is (its own Postgres stores) and with those stores removed
// from the adapter (the backend's Postgres is found by itself, never a per-process fallback).
//
// Opt-in, on denext's Deno runtime (the built-in `Deno.SQL`), with a superuser URL:
//
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
//     deno test -A tests/backend-auth-replicas-integration.test.ts

import { fromFileUrl } from "@std/path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { builtinSql } from "../src/server/postgres.ts";
import { generateSupabaseKeys } from "../src/server/auth/gotrue/keys.ts";
import { backendAuthAdapter } from "../packages/backend/mod.ts";
import { postgresEnvironment } from "./helpers/postgres-env.ts";
import { encode, marker, responseXml, rsaKey, sign, type TestKey } from "./_saml-helpers.ts";

const URL_ = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const SQL = builtinSql();
const reason = !URL_
  ? "set DENEXT_TEST_POSTGRES_URL"
  : !SQL
  ? "needs denext's Deno runtime (Deno.SQL)"
  : undefined;
const label = reason ? ` (skipped: ${reason})` : "";

const IDP = "https://idp.example.org/metadata";

function metadataXml(cert: string): string {
  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.org/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

/** A replica process. */
interface Replica {
  origin: string;
  /** Close its stdin: a clean shutdown. */
  stop(): Promise<void>;
}

async function replica(env: Record<string, string>): Promise<Replica> {
  const script = fromFileUrl(new URL("./helpers/auth-replica.ts", import.meta.url));
  const config = fromFileUrl(new URL("../deno.json", import.meta.url));
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", config, script],
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let port = 0;
  while (!port) {
    // A replica that fails to start exits, which ends the read (no clock involved).
    const { value, done } = await lines.read();
    if (done) throw new Error("the replica exited before it was ready");
    buffer += value;
    const match = /READY (\d+)/.exec(buffer);
    if (match) port = Number(match[1]);
  }
  (async () => {
    try {
      while (!(await lines.read()).done) { /* drain */ }
    } catch { /* closed */ }
  })();
  const writer = child.stdin.getWriter();
  return {
    origin: `http://127.0.0.1:${port}`,
    async stop() {
      await writer.close().catch(() => {});
      await child.status;
    },
  };
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

async function requestIdOf(url: string): Promise<string> {
  const raw = new URL(url).searchParams.get("SAMLRequest")!;
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  const xml = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
  ).text();
  return xml.match(/ ID="([^"]+)"/)![1];
}

/**
 * One SP-initiated login on `app` whose IdP answers with `assertionId`; resolves where the
 * browser lands.
 */
async function ssoLogin(
  app: Replica,
  publishableKey: string,
  key: TestKey,
  assertionId: string,
): Promise<URL> {
  const started = await fetch(`${app.origin}/auth/v1/sso`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ domain: "example.com", redirect_to: `${app.origin}/welcome` }),
  });
  assertEquals(started.status, 200);
  const { url } = await started.json();
  const relay = new URL(url).searchParams.get("RelayState")!;
  const requestId = await requestIdOf(url);
  const acs = `${app.origin}/auth/v1/sso/saml/acs`;
  const now = Date.now();
  const xml = responseXml({
    responseId: `_r${crypto.randomUUID().replaceAll("-", "")}`,
    destination: acs,
    recipient: acs,
    audience: `${app.origin}/auth/v1/sso/saml/metadata`,
    responseIssuer: IDP,
    issuer: IDP,
    responseInResponseTo: requestId,
    inResponseTo: requestId,
    nameId: "alice@example.com",
    notBefore: iso(now - 60_000),
    notOnOrAfter: iso(now + 300_000),
    confirmationNotOnOrAfter: iso(now + 300_000),
    issueInstant: iso(now - 1000),
    sessionNotOnOrAfter: iso(now + 3600_000),
    assertionId,
    assertionSig: marker(assertionId),
  });
  const res = await fetch(acs, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      SAMLResponse: encode(await sign(xml, assertionId, { key })),
      RelayState: relay,
    }),
    redirect: "manual",
  });
  await res.body?.cancel();
  assertEquals(res.status, 303);
  return new URL(res.headers.get("location")!);
}

Deno.test({
  name: `two replicas on one Postgres share the auth send budget and the SAML replay cache${label}`,
  ignore: reason !== undefined,
  async fn(t) {
    // The adapter keeps both stores itself (the strip variant removes them).
    const probe = backendAuthAdapter();
    assert(probe.rateLimits, "backendAuthAdapter() has a rateLimits store");
    assertEquals(typeof probe.claimSamlMessageId, "function");

    const env = await postgresEnvironment(true, SQL!, URL_!);
    const keys = await generateSupabaseKeys();
    const key = await rsaKey();
    try {
      for (const strip of [false, true]) {
        await t.step(
          strip ? "the backend's Postgres, found by itself" : "the adapter's stores",
          async () => {
            const replicaEnv = {
              REPLICA_DB_URL: env.url,
              REPLICA_KEYS: JSON.stringify({
                publishableKey: keys.publishableKey,
                secretKey: keys.secretKey,
                signingKeys: keys.signingKey,
              }),
              REPLICA_IDP_METADATA: metadataXml(key.certificate),
              ...(strip ? { REPLICA_STRIP: "1" } : {}),
            };
            const a = await replica(replicaEnv);
            const b = await replica(replicaEnv);
            try {
              // The send budget: 3 per address per 15 minutes, spent on A, then refused on B.
              const email = `budget-${strip ? "strip" : "full"}@mail.test`;
              const otp = (app: Replica) =>
                fetch(`${app.origin}/auth/v1/otp`, {
                  method: "POST",
                  headers: { apikey: keys.publishableKey, "content-type": "application/json" },
                  body: JSON.stringify({ email }),
                });
              for (let i = 0; i < 3; i++) {
                const sent = await otp(a);
                assertEquals(sent.status, 200, await sent.text());
              }
              const fourth = await otp(b);
              assertEquals(fourth.status, 429);
              assertEquals((await fourth.json()).error_code, "over_email_send_rate_limit");

              // A SAML assertion accepted by A is a replay on B, even inside a fresh login there.
              const assertionId = `_a${crypto.randomUUID().replaceAll("-", "")}`;
              const first = await ssoLogin(a, keys.publishableKey, key, assertionId);
              assert(new URLSearchParams(first.hash.slice(1)).get("access_token"), first.href);
              const replayed = await ssoLogin(b, keys.publishableKey, key, assertionId);
              const fragment = new URLSearchParams(replayed.hash.slice(1));
              assertEquals(fragment.get("access_token"), null);
              assertStringIncludes(fragment.get("error_code") ?? "", "saml_assertion_invalid");
              // B itself is fine: a fresh assertion signs in there.
              const fresh = `_a${crypto.randomUUID().replaceAll("-", "")}`;
              const ok = await ssoLogin(b, keys.publishableKey, key, fresh);
              assert(new URLSearchParams(ok.hash.slice(1)).get("access_token"), ok.href);
            } finally {
              await a.stop();
              await b.stop();
            }
          },
        );
      }
    } finally {
      await env.drop();
    }
  },
});
