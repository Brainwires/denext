// Networked e2e for examples/openapi: @denext/openapi end to end through the real CLI —
// `denext build` → `denext start` — asserting the generated OpenAPI 3.1 document (incl. the
// bearer security scheme), the Swagger UI at /docs, and that the login → bearer-token → protected
// endpoint flow works against the served app.
//
// This drives the CLI as a subprocess ON PURPOSE: the example's `zod` (npm) dep only resolves
// once the CLI re-execs with the merged framework+app config (see `maybeReexecForModules` in
// cli.ts). It also degrades gracefully when npm can't be fetched (offline).
//
// Opt-in + NETWORK-REQUIRED (npm fetch on a cold cache): `deno task test:e2e`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { runDeno, startCliServer } from "./harness.ts";

const EXAMPLE = fromFileUrl(new URL("../../examples/openapi", import.meta.url));
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));

const BUILD_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 60_000;

const json = { "content-type": "application/json" };

Deno.test({
  name: "e2e: examples/openapi serves an OpenAPI 3.1 document + Swagger UI, with bearer auth",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  await t.step("build writes openapi.json with the security scheme", async () => {
    const built = await runDeno(["run", "-A", CLI, "build", "."], EXAMPLE, BUILD_TIMEOUT_MS);
    if (!built.ok && /npm|registry|fetch|network/i.test(built.out)) {
      console.warn("e2e: build could not fetch npm deps (offline?) — skipping.\n" + built.out);
      return;
    }
    assert(built.ok, "denext build failed:\n" + built.out);
    const doc = JSON.parse(await Deno.readTextFile(EXAMPLE + "/.denext/openapi.json"));
    assertStringIncludes(doc.openapi, "3.1");
    assertEquals(Object.keys(doc.paths).sort(), ["/api/login", "/api/pets", "/api/pets/{id}"]);
    // The Zod body schema is described in full (Standard JSON Schema), not `{}`.
    const body = doc.paths["/api/pets"].post.requestBody.content["application/json"].schema;
    assertEquals(body.properties.species.enum, ["cat", "dog", "bird"]);
    // The declared error code is a documented response.
    assert("404" in doc.paths["/api/pets/{id}"].get.responses);
    // The bearer scheme is advertised → Swagger's "Authorize" button. Security is inferred from
    // the middleware: reads (no middleware) carry none, writes (the `authed` middleware) require it.
    assertEquals(doc.components.securitySchemes.bearerAuth.scheme, "bearer");
    assertEquals(doc.paths["/api/login"].post.security, undefined);
    assertEquals(doc.paths["/api/pets"].get.security, undefined);
    assertEquals(doc.paths["/api/pets"].post.security, [{ bearerAuth: [] }]);
    assertEquals(doc.paths["/api/pets/{id}"].delete.security, [{ bearerAuth: [] }]);
  });

  const server = await startCliServer(EXAMPLE, READY_TIMEOUT_MS);
  try {
    await t.step("/openapi.json is a valid 3.1 doc (no-cache, ETag'd)", async () => {
      const res = await fetch(server.origin + "/openapi.json");
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("cache-control"), "no-cache");
      assert(res.headers.get("etag"));
      const doc = await res.json();
      assertEquals(doc.openapi, "3.1.0");
      assertEquals(doc.info.title, "Pets API");
    });

    await t.step("/docs renders Swagger UI (from unpkg)", async () => {
      const html = await (await fetch(server.origin + "/docs")).text();
      assertStringIncludes(html, "swagger-ui");
      assertStringIncludes(html, "SwaggerUIBundle");
      assertStringIncludes(html, "unpkg.com/swagger-ui-dist");
    });

    await t.step("reads are public; writes are 401 without a bearer token", async () => {
      const list = await fetch(server.origin + "/api/pets");
      assertEquals(list.status, 200, "GET is public");

      const write = await fetch(server.origin + "/api/pets", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ name: "X", species: "cat" }),
      });
      assertEquals(write.status, 401, "POST requires the token");
      assertEquals((await write.json()).error.code, "unauthorized");
    });

    let token = "";
    await t.step("login: bad credentials 401, good credentials mint a token", async () => {
      const bad = await fetch(server.origin + "/api/login", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ username: "demo", password: "wrong" }),
      });
      assertEquals(bad.status, 401);

      const ok = await fetch(server.origin + "/api/login", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ username: "demo", password: "denext" }),
      });
      assertEquals(ok.status, 200);
      token = (await ok.json()).token;
      assert(token, "login returned a token");
    });

    await t.step("with the token: validation 400, then a round-trip", async () => {
      const auth = { ...json, authorization: `Bearer ${token}` };

      const bad = await fetch(server.origin + "/api/pets", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "" }),
      });
      assertEquals(bad.status, 400, "a bad body is a 400 once past auth");

      const made = await fetch(server.origin + "/api/pets", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "Nimbus", species: "bird" }),
      });
      assertEquals(made.status, 200);
      const pet = await made.json();
      assertEquals(pet.name, "Nimbus");

      // Reads are public — no token needed to see the created pet.
      const got = await fetch(server.origin + "/api/pets/" + pet.id);
      assertEquals((await got.json()).name, "Nimbus");

      const missing = await fetch(server.origin + "/api/pets/does-not-exist");
      assertEquals(missing.status, 404);
    });
  } finally {
    await server.close();
  }
});
