// The `/auth/v1` SSO admin API end to end (raw HTTP, GoTrue's shapes): list / create / read /
// update / delete stored SAML providers (service role only), validation and uniqueness (entity
// id and domains, across stored and config-declared providers), registration by metadata URL
// (SSRF-safe fetch, refresh of a stale copy), and a login through a stored provider.

import { assert, assertEquals, assertExists, assertMatch, assertStringIncludes } from "@std/assert";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import type { AuthAdapter } from "../packages/auth/src/adapter.ts";
import type { GoTrueOptions } from "../packages/auth/src/gotrue/options.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp } from "./_supabase-auth-app.ts";
import { ACS, requestIdOf, type TestIdp, testIdp } from "./_saml-idp.ts";

const idp = await testIdp();
const other = await testIdp("https://other-idp.example.net/metadata");
const declared = await testIdp("https://declared.example.com/metadata");

async function withApp(
  fn: (app: SupabaseAuthApp, adapter: AuthAdapter) => Promise<void>,
  auth: GoTrueOptions = {
    saml: {
      providers: [{
        id: "declared",
        domains: ["declared.test"],
        metadataXml: declared.metadataXml(),
      }],
    },
  },
  authConfig = {},
) {
  const adapter = inMemoryAuthAdapter();
  const app = await supabaseAuthApp({ adapter, auth, authConfig, withClient: false });
  try {
    await fn(app, adapter);
  } finally {
    await app.close();
  }
}

function admin(app: SupabaseAuthApp, method: string, path: string, body?: unknown, key?: string) {
  return app.fetch(`${ORIGIN}/auth/v1/admin/sso/providers${path}`, {
    method,
    headers: {
      apikey: key ?? app.secretKey,
      authorization: `Bearer ${key ?? app.secretKey}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(res: Response) {
  return { status: res.status, body: await res.json() };
}

Deno.test("SSO admin: create, list, read, update and delete a provider (GoTrue's shape)", async () => {
  await withApp(async (app) => {
    const created = await json(
      await admin(app, "POST", "", {
        type: "saml",
        metadata_xml: idp.metadataXml(),
        domains: ["Example.com", "example.com", "corp.example.com"],
        attribute_mapping: {
          keys: { name: { name: "displayName" }, groups: { name: "groups", array: true } },
        },
        name_id_format: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      }),
    );
    assertEquals(created.status, 201);
    const p = created.body;
    assertMatch(p.id, /^[0-9a-f-]{36}$/);
    assertEquals(p.saml.entity_id, idp.entityId);
    assertEquals(p.saml.metadata_xml, idp.metadataXml());
    assertEquals(p.saml.attribute_mapping.keys.groups, { name: "groups", array: true });
    assertEquals(p.saml.name_id_format, "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent");
    assertEquals(
      p.domains,
      [{ domain: "example.com" }, { domain: "corp.example.com" }].sort((a, b) =>
        a.domain < b.domain ? -1 : 1
      ),
    );
    assertExists(p.created_at);
    assertEquals(
      (await json(await admin(app, "GET", ""))).body.items.map((i: { id: string }) => i.id),
      [p.id],
    );
    assertEquals((await json(await admin(app, "GET", `/${p.id}`))).body, p);
    const updated = await json(
      await admin(app, "PUT", `/${p.id}`, {
        domains: ["new.example.com"],
        metadata_xml: idp.metadataXml({ slo: false }),
      }),
    );
    assertEquals(updated.status, 200);
    assertEquals(updated.body.domains, [{ domain: "new.example.com" }]);
    assertEquals(updated.body.saml.attribute_mapping.keys.name, { name: "displayName" });
    // Metadata for another entity is not an update.
    const mismatch = await json(
      await admin(app, "PUT", `/${p.id}`, { metadata_xml: other.metadataXml() }),
    );
    assertEquals([mismatch.status, mismatch.body.error_code], [400, "saml_entity_id_mismatch"]);
    const removed = await json(await admin(app, "DELETE", `/${p.id}`));
    assertEquals([removed.status, removed.body.id], [200, p.id]);
    for (const method of ["GET", "PUT", "DELETE"]) {
      const gone = await json(
        await admin(app, method, `/${p.id}`, method === "PUT" ? {} : undefined),
      );
      assertEquals([gone.status, gone.body.error_code], [404, "sso_provider_not_found"]);
    }
    assertEquals((await json(await admin(app, "GET", "/..%2Fx"))).status, 404);
  });
});

Deno.test("SSO admin: service role only; refused without SAML or an SSO-capable adapter", async () => {
  await withApp(async (app) => {
    const anon = await json(await admin(app, "GET", "", undefined, app.publishableKey));
    assertEquals([anon.status, anon.body.error_code], [403, "not_admin"]);
    const none = await app.fetch(`${ORIGIN}/auth/v1/admin/sso/providers`);
    assertEquals(none.status, 401);
  });
  await withApp(async (app) => {
    const res = await json(await admin(app, "GET", ""));
    assertEquals([res.status, res.body.error_code], [404, "saml_provider_disabled"]);
    const meta = await app.fetch(`${ORIGIN}/auth/v1/sso/saml/metadata`);
    assertEquals([meta.status, (await meta.json()).error_code], [404, "sso_provider_not_found"]);
  }, {});
  // An adapter without the SSO group.
  const base = inMemoryAuthAdapter() as unknown as Record<string, unknown>;
  const { createSsoProvider: _c, ...partial } = base;
  const app = await supabaseAuthApp({
    adapter: partial as unknown as AuthAdapter,
    auth: { saml: {} },
    withClient: false,
  });
  try {
    const res = await json(await admin(app, "GET", ""));
    assertEquals([res.status, res.body.error_code], [500, "unexpected_failure"]);
  } finally {
    await app.close();
  }
});

Deno.test("SSO admin: validation of the body", async () => {
  await withApp(async (app) => {
    const bad = async (body: unknown, code = "validation_failed", status = 400) => {
      const res = await json(await admin(app, "POST", "", body));
      assertEquals([res.status, res.body.error_code], [status, code], JSON.stringify(body));
    };
    const xml = idp.metadataXml();
    await bad({ metadata_xml: xml });
    await bad({ type: "oidc", metadata_xml: xml });
    await bad({ type: "saml" });
    await bad({ type: "saml", metadata_xml: xml, metadata_url: "https://idp.example.org/m" });
    await bad({ type: "saml", metadata_xml: "<nope/>" });
    await bad({ type: "saml", metadata_xml: `<!DOCTYPE x>${xml}` });
    await bad({ type: "saml", metadata_xml: xml, domains: "example.com" });
    for (const domain of ["", "no_tld", "-x.com", "a..b", 7, "x.com/", "évil.com"]) {
      await bad({ type: "saml", metadata_xml: xml, domains: [domain] });
    }
    await bad({ type: "saml", metadata_xml: xml, name_id_format: "urn:custom" });
    await bad({ type: "saml", metadata_xml: xml, attribute_mapping: [] });
    await bad({ type: "saml", metadata_xml: xml, attribute_mapping: { keys: [] } });
    await bad({ type: "saml", metadata_xml: xml, attribute_mapping: { keys: { a: "x" } } });
    await bad({ type: "saml", metadata_xml: xml, attribute_mapping: { keys: { a: { name: 1 } } } });
    await bad({
      type: "saml",
      metadata_xml: xml,
      attribute_mapping: { keys: { a: { names: [1] } } },
    });
    await bad({ type: "saml", metadata_url: "http://idp.example.org/metadata" });
    await bad({ type: "saml", metadata_url: "not a url" });
    await bad({ type: "saml", metadata_url: "https://user:pw@idp.example.org/m" });
    // An HTTPS URL that resolves to a private address is refused by the SSRF guard.
    await bad(
      { type: "saml", metadata_url: "https://127.0.0.1:9/metadata" },
      "saml_metadata_fetch_failed",
    );
    await bad("not an object", "bad_json");
  });
});

Deno.test("SSO admin: an entity id and every domain belong to one provider", async () => {
  await withApp(async (app) => {
    const create = (meta: TestIdp, domains: string[]) =>
      admin(app, "POST", "", { type: "saml", metadata_xml: meta.metadataXml(), domains }).then(
        json,
      );
    const first = await create(idp, ["a.test"]);
    assertEquals(first.status, 201);
    const sameEntity = await create(idp, ["z.test"]);
    assertEquals([sameEntity.status, sameEntity.body.error_code], [422, "saml_idp_already_exists"]);
    const sameDomain = await create(other, ["z.test", "A.test"]);
    assertEquals([sameDomain.status, sameDomain.body.error_code], [
      400,
      "sso_domain_already_exists",
    ]);
    // Config-declared providers count too.
    const declaredEntity = await create(declared, []);
    assertEquals(declaredEntity.body.error_code, "saml_idp_already_exists");
    const declaredDomain = await create(other, ["declared.test"]);
    assertEquals(declaredDomain.body.error_code, "sso_domain_already_exists");
    const second = await create(other, ["b.test"]);
    const steal = await json(
      await admin(app, "PUT", `/${second.body.id}`, { domains: ["a.test"] }),
    );
    assertEquals(steal.body.error_code, "sso_domain_already_exists");
    const stealDeclared = await json(
      await admin(app, "PUT", `/${second.body.id}`, { domains: ["declared.test"] }),
    );
    assertEquals(stealDeclared.body.error_code, "sso_domain_already_exists");
  });
});

/** A metadata server on loopback (development only: `dangerouslyAllowInsecureProviders`). */
function metadataServer(initial: string) {
  let body = initial;
  let status = 200;
  let hits = 0;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () => {
    hits++;
    return new Response(body, {
      status,
      headers: { "content-type": "application/samlmetadata+xml" },
    });
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

async function startSso(app: SupabaseAuthApp, body: Record<string, unknown>) {
  const res = await app.fetch(`${ORIGIN}/auth/v1/sso`, {
    method: "POST",
    headers: { apikey: app.publishableKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

Deno.test("SSO admin: a provider registered by metadata URL, refreshed when stale", async () => {
  const server = metadataServer(idp.metadataXml());
  try {
    await withApp(
      async (app, adapter) => {
        // http is refused even in development unless the host is loopback.
        const created = await json(
          await admin(app, "POST", "", {
            type: "saml",
            metadata_url: server.url,
            domains: ["url.test"],
          }),
        );
        assertEquals(created.status, 201, JSON.stringify(created.body));
        assertEquals(created.body.saml.metadata_url, server.url);
        assertEquals(server.hits, 1);
        // A fresh copy is used as stored.
        assertMatch(
          (await startSso(app, { domain: "url.test" })).json.url,
          /^https:\/\/idp\.example\.org\/sso\?/,
        );
        assertEquals(server.hits, 1);
        // Age the stored copy: the next sign-in fetches again and uses the new metadata.
        const id = created.body.id;
        const record = (await adapter.getSsoProvider!(id))!;
        assertEquals(record.metadataRefreshAfter, record.updatedAt + 86_400);
        await adapter.updateSsoProvider!({ ...record, metadataRefreshAfter: record.updatedAt - 1 });
        server.set(idp.metadataXml({ ssoUrl: "https://idp.example.org/sso-v2" }));
        assertMatch((await startSso(app, { domain: "url.test" })).json.url, /\/sso-v2\?/);
        assertEquals(server.hits, 2);
        assertStringIncludes((await adapter.getSsoProvider!(id))!.metadataXml, "sso-v2");
        // A refresh that yields metadata for another entity keeps the cached copy.
        server.set(other.metadataXml());
        const id2 = (await json(
          await admin(app, "POST", "", {
            type: "saml",
            metadata_url: server.url.replace("/metadata", "/m2"),
            domains: ["url2.test"],
          }),
        )).body.id;
        server.set(declared.metadataXml());
        const r2 = (await adapter.getSsoProvider!(id2))!;
        await adapter.updateSsoProvider!({ ...r2, metadataRefreshAfter: r2.updatedAt - 1 });
        assertMatch(
          (await startSso(app, { domain: "url2.test" })).json.url,
          /^https:\/\/other-idp\.example\.net\/sso\?/,
        );
        server.set("oops", 500);
        const unreachable = await json(
          await admin(app, "PUT", `/${id}`, { metadata_url: server.url }),
        );
        assertEquals(unreachable.body.error_code, "saml_metadata_fetch_failed");
      },
      { saml: {} },
      { dangerouslyAllowInsecureProviders: true },
    );
    await withApp(async (app) => {
      const res = await json(
        await admin(app, "POST", "", { type: "saml", metadata_url: server.url }),
      );
      assertEquals([res.status, res.body.msg], [400, "metadata_url needs to use HTTPS"]);
    }, { saml: {} });
  } finally {
    await server.close();
  }
});

Deno.test("SSO: sign in through a stored provider, with GoTrue's attribute mapping", async () => {
  await withApp(async (app) => {
    const created = await json(
      await admin(app, "POST", "", {
        type: "saml",
        metadata_xml: idp.metadataXml(),
        domains: ["stored.test"],
        attribute_mapping: {
          keys: {
            name: { names: ["cn", "displayName"] },
            groups: { name: "groups", array: true },
            tier: { name: "absent", default: "basic" },
          },
        },
      }),
    );
    const started = await startSso(app, { domain: "Stored.Test", redirect_to: `${ORIGIN}/in` });
    assertEquals(started.status, 200);
    const relay = new URL(started.json.url).searchParams.get("RelayState")!;
    const res = await app.fetch(ACS, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        SAMLResponse: await idp.response({
          inResponseTo: await requestIdOf(started.json.url),
          nameId: "dana@stored.test",
          attributes: { displayName: ["Dana"], groups: ["a", "b"] },
        }),
        RelayState: relay,
      }),
      redirect: "manual",
    });
    assertEquals(res.status, 303);
    const fragment = new URLSearchParams(new URL(res.headers.get("location")!).hash.slice(1));
    const token = fragment.get("access_token")!;
    const user = await (await app.fetch(`${ORIGIN}/auth/v1/user`, {
      headers: { apikey: app.publishableKey, authorization: `Bearer ${token}` },
    })).json();
    assertEquals(user.email, "dana@stored.test");
    assertEquals(user.user_metadata.name, "Dana");
    assertEquals(user.user_metadata.groups, ["admins", "staff", "a", "b"]);
    assertEquals(user.user_metadata.tier, "basic");
    assertEquals(user.app_metadata.provider, `sso:${created.body.id}`);
    // By provider id too; an unknown id is a 404.
    assertEquals((await startSso(app, { provider_id: created.body.id })).status, 200);
    assertEquals(
      (await startSso(app, { provider_id: "../nope" })).json.error_code,
      "sso_provider_not_found",
    );
    assertEquals((await startSso(app, { provider_id: crypto.randomUUID() })).status, 404);
    assert(true);
  });
});
