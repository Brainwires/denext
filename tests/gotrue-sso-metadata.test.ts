// SAML metadata freshness through `/auth/v1` (raw HTTP): `validUntil` / `cacheDuration` decide
// when a stored metadata URL is fetched again; metadata past its `validUntil` fails closed
// (`saml_metadata_expired` for sign-in, ACS and Single Logout; a 400 from the admin API); a failed
// refresh keeps the stored copy only while it is valid; the fetch limiter (single flight per
// provider, five-minute window, backoff doubling to an hour) holds a stream of sign-ins to one
// fetch per window, counted at a fake metadata server; and `refreshSsoMetadata()` / the
// background timer.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import type { GoTrueOptions } from "../src/server/auth/gotrue/options.ts";
import { resetMetadataBackoff, setMetadataClock } from "../src/server/auth/gotrue/sso-metadata.ts";
import {
  ssoMetadataRefreshActive,
  ssoMetadataRefreshTick,
} from "../src/server/auth/gotrue/sso-refresh.ts";
import { resolveSupabaseKeys } from "../src/server/auth/gotrue/keys.ts";
import { installGoTrue, refreshSsoMetadata } from "../src/server/mod.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp } from "./_supabase-auth-app.ts";
import { ACS, requestIdOf, SLO, testIdp } from "./_saml-idp.ts";
import { spKey } from "./_saml-enc-helpers.ts";

const idp = await testIdp();
const signing = await spKey();

const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const nowS = () => Math.floor(Date.now() / 1000);

function pemCert(b64: string): string {
  return `-----BEGIN CERTIFICATE-----\n${
    b64.match(/.{1,64}/g)!.join("\n")
  }\n-----END CERTIFICATE-----`;
}

interface Logged {
  message: string;
  meta?: Record<string, unknown>;
}

async function withApp(
  fn: (app: SupabaseAuthApp, adapter: AuthAdapter, warnings: Logged[]) => Promise<void>,
  auth: GoTrueOptions = { saml: {} },
) {
  const adapter = inMemoryAuthAdapter();
  const warnings: Logged[] = [];
  const app = await supabaseAuthApp({
    adapter,
    auth: { redirectUrls: [`${ORIGIN}/**`], ...auth },
    authConfig: {
      dangerouslyAllowInsecureProviders: true,
      logger: { warn: (message, meta) => void warnings.push({ message, meta }) },
    },
    withClient: false,
  });
  try {
    await fn(app, adapter, warnings);
  } finally {
    setMetadataClock();
    resetMetadataBackoff();
    await app.close();
  }
}

function admin(app: SupabaseAuthApp, method: string, path: string, body?: unknown) {
  return app.fetch(`${ORIGIN}/auth/v1/admin/sso/providers${path}`, {
    method,
    headers: {
      apikey: app.secretKey,
      authorization: `Bearer ${app.secretKey}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function startSso(app: SupabaseAuthApp, body: Record<string, unknown>) {
  const res = await app.fetch(`${ORIGIN}/auth/v1/sso`, {
    method: "POST",
    headers: { apikey: app.publishableKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** A counting metadata server on loopback. */
function metadataServer(initial: string) {
  let body = initial;
  let status = 200;
  let hits = 0;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async () => {
    hits++;
    await new Promise((r) => setTimeout(r, 5));
    return new Response(body, { status, headers: { "content-type": "application/xml" } });
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}/metadata`,
    set(next: string, nextStatus = 200) {
      body = next;
      status = nextStatus;
    },
    get hits() {
      return hits;
    },
    close: () => server.shutdown(),
  };
}

/** Move the metadata clock to `base + seconds`. */
const clockAt = (base: number) => (seconds: number) =>
  setMetadataClock(() => (base + seconds) * 1000);

Deno.test("SSO metadata: config-declared metadata past its validUntil fails closed", async () => {
  const expired = idp.metadataXml({ validUntil: iso(nowS() - 60) });
  await withApp(async (app, _adapter, warnings) => {
    for (let i = 0; i < 3; i++) {
      const res = await startSso(app, { provider_id: "old" });
      assertEquals([res.status, res.json.error_code], [400, "saml_metadata_expired"]);
    }
    const warned = warnings.filter((w) => w.message.includes("has expired"));
    assertEquals(warned.length, 1, "warned once per provider");
    assertEquals(warned[0].meta?.provider, "old");
  }, { saml: { providers: [{ id: "old", domains: ["old.test"], metadataXml: expired }] } });
});

Deno.test("SSO metadata: the admin API refuses expired or malformed validity", async () => {
  await withApp(async (app) => {
    const expired = await admin(app, "POST", "", {
      type: "saml",
      metadata_xml: idp.metadataXml({ validUntil: iso(nowS() - 1) }),
    });
    const body = await expired.json();
    assertEquals([expired.status, body.error_code], [400, "validation_failed"]);
    assertMatch(body.msg, /expired/);
    for (const attrs of [{ validUntil: "soon" }, { cacheDuration: "P" }]) {
      const res = await admin(app, "POST", "", {
        type: "saml",
        metadata_xml: idp.metadataXml(attrs),
      });
      const json = await res.json();
      assertEquals([res.status, json.error_code], [400, "validation_failed"]);
      assertMatch(json.msg, /bad_metadata/);
    }
    // A valid one stores its validUntil.
    const until = nowS() + 7200;
    const ok = await (await admin(app, "POST", "", {
      type: "saml",
      metadata_xml: idp.metadataXml({ validUntil: iso(until) }),
      domains: ["fresh.test"],
    })).json();
    const updated = await admin(app, "PUT", `/${ok.id}`, {
      metadata_xml: idp.metadataXml({ validUntil: iso(nowS() - 5) }),
    });
    assertEquals(updated.status, 400);
    await updated.body?.cancel();
  });
});

Deno.test("SSO metadata: ACS and Single Logout refuse a provider whose metadata expired", async () => {
  const until = nowS() + 3600;
  const saml: GoTrueOptions["saml"] = {
    signingKey: signing.pem,
    signingCertificate: pemCert(signing.certificate),
  };
  await withApp(async (app, _adapter, warnings) => {
    const created = await (await admin(app, "POST", "", {
      type: "saml",
      metadata_xml: idp.metadataXml({ validUntil: iso(until) }),
      domains: ["exp.test"],
    })).json();
    const started = await startSso(app, { domain: "exp.test", redirect_to: `${ORIGIN}/in` });
    assertEquals(started.status, 200);
    // The metadata expires while the user is at the IdP.
    clockAt(until)(1);
    const res = await app.fetch(ACS, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        SAMLResponse: await idp.response({
          inResponseTo: await requestIdOf(started.json.url),
          nameId: "eve@exp.test",
        }),
        RelayState: new URL(started.json.url).searchParams.get("RelayState")!,
      }),
      redirect: "manual",
    });
    assertEquals(res.status, 303);
    const landed = new URLSearchParams(new URL(res.headers.get("location")!).hash.slice(1));
    assertEquals(landed.get("error_code"), "saml_metadata_expired");
    // IdP-initiated Single Logout: refused in GoTrue's JSON shape.
    const slo = await app.fetch(
      `${SLO}${await idp.logoutRequestQuery({ nameId: "eve@exp.test" })}`,
    );
    const body = await slo.json();
    assertEquals([slo.status, body.error_code], [400, "saml_metadata_expired"]);
    assertEquals(
      warnings.filter((w) => w.meta?.provider === created.id && w.message.includes("expired"))
        .length,
      1,
    );
    // Fresh metadata through the admin API clears it.
    setMetadataClock();
    const put = await admin(app, "PUT", `/${created.id}`, {
      metadata_xml: idp.metadataXml({ validUntil: iso(nowS() + 86400) }),
    });
    assertEquals(put.status, 200);
    await put.body?.cancel();
    assertEquals((await startSso(app, { domain: "exp.test" })).status, 200);
  }, { saml });
});

Deno.test("SSO metadata: cacheDuration / validUntil schedule the refresh; the limiter holds", async () => {
  const base = nowS();
  const until = base + 3 * 86400;
  const server = metadataServer(idp.metadataXml({ validUntil: iso(until), cacheDuration: "PT1H" }));
  try {
    await withApp(async (app, adapter) => {
      const created = await (await admin(app, "POST", "", {
        type: "saml",
        metadata_url: server.url,
        domains: ["url.test"],
      })).json();
      assertEquals(server.hits, 1);
      const record = (await adapter.getSsoProvider!(created.id))!;
      assertEquals(record.metadataValidUntil, until);
      assertEquals(record.metadataRefreshAfter, record.updatedAt + 3600);
      const at = clockAt(record.updatedAt);
      const signIn = () => startSso(app, { domain: "url.test" });
      assertEquals((await signIn()).status, 200);
      assertEquals(server.hits, 1, "not due yet");

      // Due, and the server fails: a burst of sign-ins makes ONE fetch and keeps the copy.
      server.set("down", 503);
      at(3601);
      const burst = await Promise.all(Array.from({ length: 10 }, signIn));
      assert(burst.every((r) => r.status === 200));
      assertEquals(server.hits, 2, "single flight");
      for (let i = 0; i < 5; i++) assertEquals((await signIn()).status, 200);
      assertEquals(server.hits, 2, "backed off");
      at(3601 + 299);
      await signIn();
      assertEquals(server.hits, 2, "inside the first five-minute backoff");
      at(3601 + 300);
      await signIn();
      assertEquals(server.hits, 3, "the backoff ended");
      at(3601 + 300 + 599);
      await signIn();
      assertEquals(server.hits, 3, "the backoff doubled to ten minutes");
      at(3601 + 300 + 600);
      await signIn();
      assertEquals(server.hits, 4);

      // Fetched metadata that has itself expired is a failed refresh too.
      server.set(idp.metadataXml({ validUntil: iso(base - 10) }));
      at(3601 + 300 + 600 + 1200);
      assertEquals((await signIn()).status, 200);
      assertEquals(server.hits, 5);
      assertEquals((await adapter.getSsoProvider!(created.id))!.metadataXml, record.metadataXml);

      // Past validUntil with the refresh still failing: closed.
      server.set("down", 503);
      at(until - record.updatedAt + 1);
      const closed = await signIn();
      assertEquals([closed.status, closed.json.error_code], [400, "saml_metadata_expired"]);
      assertEquals(server.hits, 6);
      assertEquals((await signIn()).json.error_code, "saml_metadata_expired");
      assertEquals(server.hits, 6, "still one fetch per window");

      // Fresh metadata once the backoff ends: open again, its schedule stored.
      server.set(idp.metadataXml({ validUntil: iso(until + 10 * 86400) }));
      at(until - record.updatedAt + 1 + 3600);
      assertEquals((await signIn()).status, 200);
      assertEquals(server.hits, 7);
      const after = (await adapter.getSsoProvider!(created.id))!;
      const fetchedAt = until + 1 + 3600;
      assertEquals(after.metadataValidUntil, until + 10 * 86400);
      assertEquals(after.metadataRefreshAfter, fetchedAt + 86400);
      assertEquals(after.updatedAt, fetchedAt);
    });
  } finally {
    await server.close();
  }
});

Deno.test("SSO metadata: refreshSsoMetadata() refreshes what is due and reports it", async () => {
  const server = metadataServer(idp.metadataXml());
  try {
    await withApp(async (app, adapter) => {
      const a = await (await admin(app, "POST", "", {
        type: "saml",
        metadata_url: server.url,
        domains: ["a.test"],
      })).json();
      const other = await testIdp("https://other.example.net/metadata");
      server.set(other.metadataXml());
      await (await admin(app, "POST", "", {
        type: "saml",
        metadata_url: server.url.replace("/metadata", "/b"),
        domains: ["b.test"],
      })).body?.cancel();
      await (await admin(app, "POST", "", {
        type: "saml",
        metadata_xml: (await testIdp("https://inline.example.net/metadata")).metadataXml(),
      })).body?.cancel();
      assertEquals(server.hits, 2);
      const none = await refreshSsoMetadata(app.config);
      assertEquals(
        [none.checked, none.skipped, none.refreshed, none.unchanged, none.failed],
        [2, 2, 0, 0, 0],
      );
      // Make `a` due; the server now has new metadata for it.
      const record = (await adapter.getSsoProvider!(a.id))!;
      await adapter.updateSsoProvider!({ ...record, metadataRefreshAfter: record.updatedAt - 1 });
      server.set(idp.metadataXml({ ssoUrl: "https://idp.example.org/sso-v2" }));
      const one = await refreshSsoMetadata(app.config, { jitterMs: 1 });
      assertEquals([one.checked, one.refreshed, one.skipped], [2, 1, 1]);
      assertEquals(one.results, [{ id: a.id, outcome: "refreshed" }]);
      assertEquals(server.hits, 3);
      // force: `b`'s server answers another entity's metadata → failed; `a` is held back.
      const forced = await refreshSsoMetadata(app.config, { force: true });
      assertEquals([forced.failed, forced.skipped], [1, 1]);
      assertEquals(forced.results.find((r) => r.id === a.id)?.outcome, "backoff");
      // After the window, the same document again: unchanged, its next refresh moved on.
      setMetadataClock(() => (nowS() + 301) * 1000);
      const again = await refreshSsoMetadata(app.config, { force: true });
      assertEquals(again.results.find((r) => r.id === a.id)?.outcome, "unchanged");
      const kept = (await adapter.getSsoProvider!(a.id))!;
      assertEquals(kept.metadataRefreshAfter, nowS() + 301 + 86400);
    });
  } finally {
    await server.close();
  }
});

Deno.test("SSO metadata: saml.metadataRefresh starts a timer the teardown stops", async () => {
  await withApp(() => {
    assert(ssoMetadataRefreshActive());
    return Promise.resolve();
  }, { saml: { metadataRefresh: { intervalSeconds: 1 } } });
  assert(!ssoMetadataRefreshActive());
  await withApp(() => {
    assert(!ssoMetadataRefreshActive());
    return Promise.resolve();
  }, { saml: { metadataRefresh: false } });
});

Deno.test("SSO metadata: the timer does not start when not serving (build/export)", async () => {
  const keys = await resolveSupabaseKeys({ jwtSecret: "s".repeat(40) }, () => undefined);
  await withApp(() => {
    assert(ssoMetadataRefreshActive());
    const handler = { options: { saml: { metadataRefresh: { intervalSeconds: 1 } } }, keys };
    installGoTrue(handler, false);
    assert(!ssoMetadataRefreshActive());
    installGoTrue(handler, true);
    assert(ssoMetadataRefreshActive());
    return Promise.resolve();
  }, { saml: { metadataRefresh: { intervalSeconds: 1 } } });
  assert(!ssoMetadataRefreshActive());
});

Deno.test("SSO metadata: a background pass logs a failure, never throws", async () => {
  const warnings: Logged[] = [];
  const adapter = inMemoryAuthAdapter();
  const config = {
    secret: "supabase-auth-secret-at-least-32-characters!",
    providers: [],
    adapter: {
      ...adapter,
      listSsoProviders: () => Promise.reject(new Error("database down")),
    },
    logger: {
      warn: (message: string, meta?: Record<string, unknown>) =>
        void warnings.push({ message, meta }),
    },
  };
  await ssoMetadataRefreshTick(config, 0);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].meta?.error, "database down");
  // No SSO group: nothing to do, nothing logged.
  await ssoMetadataRefreshTick({ ...config, adapter: { getUser: () => undefined } as never }, 0);
  assertEquals(warnings.length, 1);
});
