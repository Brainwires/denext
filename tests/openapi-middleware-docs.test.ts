// @denext/openapi: the responses an endpoint's middleware answers with are described like its
// own (`requireSession`'s 401/403, `requireBearer`'s 401 + challenge header, `rateLimit`'s 429 +
// `retry-after`, `csrf`'s 403, and any middleware tagged with `documentsErrors`), and the
// vendored Swagger UI is served from the app's own origin — verified against its recorded
// SHA-256 — under a strict CSP.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type ApiMiddleware,
  createApi,
  csrf,
  documentsErrors,
  rateLimit,
  requireSession,
} from "../src/server/mod.ts";
import { requireBearer } from "../src/server/auth/bearer.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { ApiRoute } from "../src/router/manifest.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { applyPlugins, getPluginRequestHandler, resetPlugins } from "../src/plugin/mod.ts";
import {
  buildOpenApi,
  docsCsp,
  emitTypes,
  openapi,
  type OpenApiDocument,
  readSwaggerAsset,
  renderDocsHtml,
  SWAGGER_UI_ASSETS,
  SWAGGER_UI_VERSION,
} from "../packages/openapi/mod.ts";

const route = (routePath: string): ApiRoute => ({
  kind: "api",
  pattern: parsePattern(routePath),
  routePath,
  filePath: routePath + "/route.ts",
});

const noop = () => ({ ok: true });

const bearerConfig = {
  secret: "test-secret-value-at-least-32-chars-long",
  canonicalOrigin: "https://app.test",
  providers: [],
  adapter: inMemoryAuthAdapter(),
};

/** A tagged custom middleware: a quota check that answers 402 with a header. */
const quota: ApiMiddleware<object> = documentsErrors(() => undefined, {
  quota_exceeded: {
    status: 402,
    message: "Plan quota used up",
    headers: { "x-quota-reset": "When the quota resets (ISO 8601)" },
  },
});

const modules: Record<string, Record<string, unknown>> = {
  "/api/me/route.ts": { GET: createApi().use(requireSession()).define({}, noop) },
  "/api/admin/route.ts": {
    GET: createApi().use(requireSession({ role: "admin" })).define({}, noop),
  },
  "/api/search/route.ts": {
    GET: createApi().use(rateLimit({ max: 5, windowMs: 1000 })).define({}, noop),
  },
  "/api/pets/route.ts": {
    POST: createApi().use(requireBearer(bearerConfig, { scope: "pets:write" })).define(
      { errors: { duplicate: 409 } },
      noop,
    ),
  },
  "/api/form/route.ts": { POST: createApi().use(csrf()).define({}, noop) },
  "/api/quota/route.ts": {
    GET: createApi().use(quota).define({ errors: { quota_exceeded: 429 } }, noop),
    POST: createApi().use(quota).define({}, noop),
  },
};

async function documentOf(): Promise<OpenApiDocument> {
  const { document } = await buildOpenApi({
    manifest: { api: Object.keys(modules).map((f) => route(f.replace(/\/route\.ts$/, ""))) },
    load: (file) => Promise.resolve(modules[file]),
  });
  return document;
}

type Res = {
  description: string;
  headers?: Record<string, { description: string; schema: unknown }>;
  content: { "application/json": { schema: { allOf: [unknown, unknown] } } };
};
const responsesOf = (doc: OpenApiDocument, path: string, method: string) =>
  doc.paths[path][method].responses as Record<string, Res>;
const codesOf = (r: Res) =>
  (r.content["application/json"].schema.allOf[1] as {
    properties: { error: { properties: { code: { enum: string[] } } } };
  }).properties.error.properties.code.enum;

Deno.test("openapi: requireSession documents its 401, and its 403 only with a role", async () => {
  const doc = await documentOf();
  const me = responsesOf(doc, "/api/me", "get");
  assertEquals(Object.keys(me).sort(), ["200", "401", "default"]);
  assertEquals(me["401"].description, "Unauthorized");
  assertEquals(codesOf(me["401"]), ["unauthorized"]);
  const admin = responsesOf(doc, "/api/admin", "get");
  assertEquals(Object.keys(admin).sort(), ["200", "401", "403", "default"]);
  assertEquals(codesOf(admin["403"]), ["forbidden"]);
  assertEquals(doc.paths["/api/me"].get["x-denext-errors"], { unauthorized: 401 });
});

Deno.test("openapi: rateLimit documents its 429 with the retry-after header", async () => {
  const res = responsesOf(await documentOf(), "/api/search", "get");
  assertEquals(res["429"].description, "Too Many Requests");
  assertEquals(codesOf(res["429"]), ["rate_limited"]);
  assertEquals(res["429"].headers, {
    "retry-after": {
      description: "Seconds until the window resets",
      schema: { type: "string" },
    },
  });
});

Deno.test("openapi: requireBearer documents 401 + challenge and the scope's 403 beside the endpoint's own", async () => {
  const doc = await documentOf();
  const res = responsesOf(doc, "/api/pets", "post");
  assertEquals(Object.keys(res).sort(), ["200", "401", "403", "409", "default"]);
  assert(res["401"].headers?.["www-authenticate"], "the bearer challenge header is described");
  assertEquals(codesOf(res["409"]), ["duplicate"]);
  assertEquals(doc.paths["/api/pets"].post.security, [{ bearerAuth: [] }]);
});

Deno.test("openapi: csrf and a documentsErrors-tagged middleware are described; the definition's own spec wins", async () => {
  const doc = await documentOf();
  assertEquals(codesOf(responsesOf(doc, "/api/form", "post")["403"]), ["csrf_failed"]);
  const post = responsesOf(doc, "/api/quota", "post");
  assertEquals(post["402"].description, "Plan quota used up");
  assertEquals(Object.keys(post["402"].headers ?? {}), ["x-quota-reset"]);
  // The GET declares the same code itself: its own status (429) wins over the middleware's.
  const get = responsesOf(doc, "/api/quota", "get");
  assertEquals(get["402"], undefined);
  assertEquals(codesOf(get["429"]), ["quota_exceeded"]);
  // A client generated from the document narrows on the middleware's codes too.
  assertStringIncludes(emitTypes(doc), '"rate_limited"');
});

Deno.test("openapi: the builtin docs page lists a documented response header", async () => {
  const html = renderDocsHtml(await documentOf(), { ui: "builtin", specUrl: "/openapi.json" });
  assertStringIncludes(html, "<code>retry-after</code> — Seconds until the window resets");
});

// ── Vendored Swagger UI ──────────────────────────────────────────────────────

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const VENDOR = new URL("../packages/openapi/vendor/swagger-ui/", import.meta.url);

Deno.test("swagger-ui: the vendored files are the pinned upstream bytes (recorded SHA-256)", async () => {
  assertEquals(SWAGGER_UI_VERSION, "5.32.15");
  for (const [name, asset] of Object.entries(SWAGGER_UI_ASSETS)) {
    const bytes = await Deno.readFile(new URL(asset.file, VENDOR));
    assertEquals(bytes.byteLength, asset.bytes, `${name} length`);
    assertEquals(await sha256Hex(bytes), asset.sha256, `${name} digest`);
    assertEquals(await readSwaggerAsset(name), bytes);
  }
  // The license ships beside the vendored code (Apache-2.0 + NOTICE).
  assertStringIncludes(await Deno.readTextFile(new URL("LICENSE", VENDOR)), "Apache License");
  assertStringIncludes(await Deno.readTextFile(new URL("NOTICE", VENDOR)), "SmartBear");
  await assertRejects(() => readSwaggerAsset("../../mod.ts"), Error, "no vendored");
});

Deno.test("swagger-ui: the page loads only same-origin files — no CDN, no inline script", async () => {
  const html = renderDocsHtml(await documentOf(), {
    ui: "swagger",
    specUrl: "/app/openapi.json",
    assetBase: "/app/docs/swagger-ui",
  });
  assert(!/https?:\/\//.test(html), "no absolute URL: nothing loads from a CDN");
  assert(!/<script>/.test(html), "no inline script");
  assertStringIncludes(html, 'src="/app/docs/swagger-ui/swagger-ui-bundle.js"');
  assertStringIncludes(html, 'href="/app/docs/swagger-ui/swagger-ui.css"');
  assertStringIncludes(html, 'src="/app/docs/swagger-ui/init.js"');
  assertStringIncludes(html, 'data-url="/app/openapi.json"');
  // An explicit CDN still works (opt-in), with the start-up script kept same-origin.
  const cdn = renderDocsHtml(await documentOf(), {
    ui: "swagger",
    specUrl: "/s",
    cdn: "https://unpkg.com/swagger-ui-dist@5.32.15/",
  });
  assertStringIncludes(cdn, 'src="https://unpkg.com/swagger-ui-dist@5.32.15/swagger-ui-bundle.js"');
  assertStringIncludes(cdn, 'src="/docs/swagger-ui/init.js"');
});

Deno.test("swagger-ui: CSPs — builtin and swagger allow no other origin and no inline script", () => {
  for (const ui of ["builtin", "swagger"] as const) {
    const csp = docsCsp(ui);
    assert(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"), csp);
    assert(!/https?:/.test(csp), csp);
    assertStringIncludes(csp, "default-src 'none'");
    assertStringIncludes(csp, "frame-ancestors 'none'");
  }
  assertStringIncludes(docsCsp("swagger"), "script-src 'self';");
  assertStringIncludes(
    docsCsp("swagger", "https://unpkg.com/swagger-ui-dist@5/"),
    "script-src 'self' https://unpkg.com;",
  );
  assertStringIncludes(
    docsCsp("scalar", "https://cdn.jsdelivr.net/npm/x.js"),
    "script-src https://cdn.jsdelivr.net;",
  );
});

Deno.test("openapi plugin (swagger): serves the page under its CSP and the vendored files", async () => {
  resetPlugins();
  try {
    await applyPlugins({
      projectRoot: join(Deno.cwd(), "p"),
      appDir: join(Deno.cwd(), "p", "app"),
      config: { plugins: [openapi({ ui: "swagger", docs: "/reference" })] } as DenextConfig,
      mode: "prod",
      load: () => Promise.resolve({}),
    });
    const handle = getPluginRequestHandler()!;
    const page = (await handle(new Request("https://x/reference")))!;
    assertEquals(page.headers.get("content-security-policy"), docsCsp("swagger"));
    assertStringIncludes(await page.text(), 'src="/reference/swagger-ui/swagger-ui-bundle.js"');
    const js = (await handle(new Request("https://x/reference/swagger-ui/swagger-ui-bundle.js")))!;
    assertEquals(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    assertEquals((await js.bytes()).byteLength, SWAGGER_UI_ASSETS["swagger-ui-bundle.js"].bytes);
    const again = await handle(
      new Request("https://x/reference/swagger-ui/swagger-ui-bundle.js", {
        headers: { "if-none-match": js.headers.get("etag")! },
      }),
    );
    assertEquals(again!.status, 304);
    const css = (await handle(new Request("https://x/reference/swagger-ui/swagger-ui.css")))!;
    assertEquals(css.headers.get("content-type"), "text/css; charset=utf-8");
    await css.body?.cancel();
    const init = (await handle(new Request("https://x/reference/swagger-ui/init.js")))!;
    assertStringIncludes(await init.text(), "SwaggerUIBundle");
    assertEquals(await handle(new Request("https://x/reference/swagger-ui/index.html")), null);
    assertEquals(await handle(new Request("https://x/reference/swagger-ui/LICENSE")), null);
  } finally {
    resetPlugins();
  }
});
