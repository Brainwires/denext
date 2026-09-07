// @denext/openapi: the OpenAPI document derived from `defineApi` definitions, the schema
// extraction strategies, the docs renderers, the plugin's three seams, and the CLI verb.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createApi, defineApi } from "../src/server/mod.ts";
import type { StandardSchemaV1 } from "../src/server/mod.ts";
import { type ApiRoute, scanRoutes } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import {
  applyPlugins,
  getPluginCommands,
  getPluginRequestHandler,
  resetPlugins,
  runPluginBuildSteps,
} from "../src/plugin/mod.ts";
import {
  buildOpenApi,
  createOpenapiCommand,
  diffSpecs,
  openapi,
  type OpenApiDocument,
  pathVariants,
  renderDocsHtml,
  toJsonSchema,
} from "../packages/openapi/mod.ts";
import type { CommandContext } from "../src/cli/command.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A Standard Schema that also implements Standard JSON Schema (like Zod ≥ 4.2). */
function schema<T>(json: Record<string, unknown>, vendor = "test"): StandardSchemaV1<T> {
  return {
    "~standard": {
      version: 1,
      vendor,
      validate: (v: unknown) => ({ value: v as T }),
      jsonSchema: {
        input: () => ({ $schema: "https://json-schema.org/draft/2020-12/schema", ...json }),
        output: () => ({ ...json, "x-side": "output" }),
      },
    },
  } as unknown as StandardSchemaV1<T>;
}

/** A Standard Schema with no JSON Schema export at all. */
const opaque = <T>(): StandardSchemaV1<T> => ({
  "~standard": { version: 1, vendor: "opaque-lib", validate: (v) => ({ value: v as T }) },
});

const route = (routePath: string, filePath = routePath + "/route.ts"): ApiRoute => ({
  kind: "api",
  pattern: parsePattern(routePath),
  routePath,
  filePath,
});

const todo = schema<{ id: string }>({
  type: "object",
  properties: { id: { type: "string" }, title: { type: "string", minLength: 1 } },
  required: ["id", "title"],
});

// A real (empty) app tree so `scanRoutes` — the seam the plugin's synthesizer hangs off —
// produces the fixture routes; the in-memory loader below supplies their modules.
const ROOT = await Deno.makeTempDir({ prefix: "denext_openapi_app_" });
globalThis.addEventListener("unload", () => {
  try {
    Deno.removeSync(ROOT, { recursive: true });
  } catch { /* already gone */ }
});
const APP_DIR = join(ROOT, "app");
for (const dir of ["api/todos", "api/todos/[id]", "api/files/[...path]"]) {
  await Deno.mkdir(join(APP_DIR, dir), { recursive: true });
  await Deno.writeTextFile(join(APP_DIR, dir, "route.ts"), "");
}
const file = (rel: string) => join(APP_DIR, rel, "route.ts");

const modules: Record<string, Record<string, unknown>> = {
  [file("api/todos")]: {
    GET: defineApi({
      summary: "List todos",
      query: schema({
        type: "object",
        properties: { done: { enum: ["true", "false"] }, page: { type: "integer" } },
        required: ["page"],
      }),
      response: schema({ type: "array", items: { type: "object" } }),
    }, () => []),
    POST: createApi().use(() => ({ user: "u" })).define({
      summary: "Create a todo",
      description: "Adds one.",
      body: schema({ type: "object", properties: { title: { type: "string" } } }),
      response: todo,
      errors: { duplicate: 409, teapot: { status: 418, message: "Short and stout" } },
      maxBodyBytes: 4096,
    }, () => ({ id: "1" })),
  },
  [file("api/todos/[id]")]: {
    PATCH: defineApi({
      params: schema({ type: "object", properties: { id: { type: "string", format: "uuid" } } }),
      body: opaque(),
      errors: { not_found: 404 },
    }, () => undefined),
    DELETE: () => new Response(null, { status: 204 }), // a plain handler
    HEAD: () => new Response(), // derived-from-GET in denext; never an operation
  },
  [file("api/files/[...path]")]: {
    GET: () => new Response("file"),
  },
};

const manifest = { api: (await scanRoutes(APP_DIR)).api };
assertEquals(manifest.api.map((r) => r.routePath).sort(), [
  "/api/files/[...path]",
  "/api/todos",
  "/api/todos/[id]",
]);
const load: ModuleLoader = (file) => {
  const mod = modules[file];
  return mod ? Promise.resolve(mod) : Promise.reject(new Error(`no module ${file}`));
};

// ── Schema extraction ────────────────────────────────────────────────────────

Deno.test("toJsonSchema: Standard JSON Schema first, input vs output side, $schema dropped", () => {
  const input = toJsonSchema(todo, "input");
  assertEquals(input.source, "standard-json-schema");
  assertEquals(input.schema.type, "object");
  assert(!("$schema" in input.schema), "the dialect marker is stripped");
  assertEquals(toJsonSchema(todo, "output").schema["x-side"], "output");
});

Deno.test("toJsonSchema: TypeBox schemas are JSON Schema (symbols dropped)", () => {
  const tb = { [Symbol.for("TypeBox.Kind")]: "Object", type: "object", properties: {} };
  const out = toJsonSchema(tb, "input");
  assertEquals(out, { schema: { type: "object", properties: {} }, source: "typebox" });
});

Deno.test("toJsonSchema: a toJsonSchema() method, a converter (first), and the opaque fallback", () => {
  const ark = { toJsonSchema: () => ({ type: "string" }) };
  assertEquals(toJsonSchema(ark, "input"), {
    schema: { type: "string" },
    source: "to-json-schema",
  });
  const converted = toJsonSchema(todo, "input", () => ({ type: "custom" }));
  assertEquals(converted, { schema: { type: "custom" }, source: "converter" });
  assertEquals(toJsonSchema(opaque(), "input"), { schema: {}, source: "opaque" });
  assertEquals(toJsonSchema(42, "input").source, "opaque");
});

// ── Paths ────────────────────────────────────────────────────────────────────

Deno.test("pathVariants: dynamic, catch-all, optional catch-all, basePath", () => {
  assertEquals(pathVariants(parsePattern("/api/todos/[id]")), ["/api/todos/{id}"]);
  assertEquals(pathVariants(parsePattern("/api/files/[...path]")), ["/api/files/{path}"]);
  assertEquals(pathVariants(parsePattern("/api/docs/[[...slug]]")), [
    "/api/docs",
    "/api/docs/{slug}",
  ]);
  assertEquals(pathVariants(parsePattern("/api/todos/[id]"), "/app"), ["/app/api/todos/{id}"]);
});

// ── The document ─────────────────────────────────────────────────────────────

Deno.test("buildOpenApi: operations, parameters, body, responses, error enums, extensions", async () => {
  const { document, warnings } = await buildOpenApi({
    manifest,
    load,
    info: { title: "Todos", version: "1.2.3" },
    servers: [{ url: "https://api.example" }],
  });
  assertEquals(document.openapi, "3.1.0");
  assertEquals(document.info, { title: "Todos", version: "1.2.3" });
  assertEquals(document.servers, [{ url: "https://api.example" }]);
  assertEquals(Object.keys(document.paths), [
    "/api/files/{path}",
    "/api/todos",
    "/api/todos/{id}",
  ]);

  const list = document.paths["/api/todos"].get;
  assertEquals(list.operationId, "getApiTodos");
  assertEquals(list.summary, "List todos");
  assertEquals(list.tags, ["todos"]);
  assertEquals(list.parameters, [
    { name: "done", in: "query", required: false, schema: { enum: ["true", "false"] } },
    { name: "page", in: "query", required: true, schema: { type: "integer" } },
  ]);
  const listRes = list.responses as Record<string, Record<string, unknown>>;
  assertEquals(Object.keys(listRes), ["200", "400", "default"]);
  assertEquals(
    (listRes["200"].content as Record<string, { schema: unknown }>)["application/json"].schema,
    { type: "array", items: { type: "object" }, "x-side": "output" },
  );

  const create = document.paths["/api/todos"].post;
  assertEquals(create.operationId, "postApiTodos");
  assertEquals(create.description, "Adds one.");
  assertEquals(create["x-denext-max-body-bytes"], 4096);
  assertEquals(create.requestBody, {
    required: true,
    content: {
      "application/json": {
        schema: { type: "object", properties: { title: { type: "string" } } },
      },
    },
  });
  const createRes = create.responses as Record<string, Record<string, unknown>>;
  assertEquals(Object.keys(createRes), ["200", "400", "409", "418", "default"]);
  assertEquals(createRes["400"].description, "Validation failed; Malformed or non-JSON body");
  assertEquals(createRes["418"].description, "Short and stout");
  assertEquals(createRes["409"].description, "duplicate");
  assertEquals(
    (createRes["409"].content as Record<string, { schema: unknown }>)["application/json"].schema,
    {
      allOf: [
        { $ref: "#/components/schemas/ApiError" },
        { properties: { error: { properties: { code: { enum: ["duplicate"] } } } } },
      ],
    },
  );
  assert(document.components.schemas.ApiError, "the shared envelope schema is present");

  const patch = document.paths["/api/todos/{id}"].patch;
  assertEquals(patch.parameters, [
    { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
  ]);
  assertEquals(
    (patch.requestBody as { content: Record<string, { schema: unknown }> })
      .content["application/json"]
      .schema,
    {},
    "an opaque body schema is emitted as {}",
  );
  assertEquals(Object.keys(patch.responses as object), ["200", "400", "404", "default"]);

  // The plain handlers: listed by path + method, string path params; HEAD never appears.
  const del = document.paths["/api/todos/{id}"].delete;
  assertEquals(del.parameters, [{
    name: "id",
    in: "path",
    required: true,
    schema: { type: "string" },
  }]);
  assertEquals(del.responses, { "200": { description: "OK" } });
  assertEquals(document.paths["/api/todos/{id}"].head, undefined);
  const files = document.paths["/api/files/{path}"].get;
  assertEquals(
    (files.parameters as { description?: string }[])[0].description,
    'One or more path segments, "/"-joined.',
  );

  assertEquals(warnings.map((w) => `${w.code}:${w.method ?? ""}:${w.routePath}`), [
    "missing-summary:PATCH:/api/todos/[id]",
    "opaque-schema:PATCH:/api/todos/[id]",
    "undescribed-route:DELETE:/api/todos/[id]",
    "catch-all-path:GET:/api/files/[...path]",
    "undescribed-route:GET:/api/files/[...path]",
  ]);
  assertStringIncludes(warnings[1].message, "(opaque-lib)");
  assertEquals(warnings[1].part, "body");
});

Deno.test("buildOpenApi: include / tags / converter options, a failing module, duplicate ids", async () => {
  const { document, warnings } = await buildOpenApi({
    manifest: { api: [...manifest.api, route("/api/broken")] },
    load,
    include: (r) => r.routePath !== "/api/files/[...path]",
    tags: () => ["custom"],
    toJsonSchema: (s) => s === todo ? { type: "converted" } : undefined,
  });
  assertEquals(Object.keys(document.paths), ["/api/todos", "/api/todos/{id}"]);
  assertEquals(document.paths["/api/todos"].get.tags, ["custom"]);
  const res = document.paths["/api/todos"].post.responses as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(
    (res["200"].content as Record<string, { schema: unknown }>)["application/json"].schema,
    { type: "converted" },
  );
  assertEquals(warnings.find((w) => w.code === "load-failed")?.routePath, "/api/broken");

  // Two routes that flatten to the same operationId get distinct ids.
  const twins = await buildOpenApi({
    manifest: { api: [route("/api/a-b", "/x/route.ts"), route("/api/a_b", "/x/route.ts")] },
    load: () => Promise.resolve({ GET: () => new Response() }),
  });
  assertEquals(
    Object.values(twins.document.paths).map((p) => p.get.operationId),
    ["getApiAB", "getApiAB2"],
  );
});

Deno.test("buildOpenApi: an optional catch-all yields two distinct operations; a colliding route is dropped with a warning", async () => {
  const mods: Record<string, Record<string, unknown>> = {
    "/x/docs/route.ts": { GET: defineApi({ summary: "Docs root" }, () => "root") },
    "/x/docs/[[...slug]]/route.ts": {
      GET: defineApi({
        summary: "Docs page",
        params: schema({
          type: "object",
          properties: { slug: { type: "array", items: { type: "string" } } },
        }),
      }, () => "page"),
    },
  };
  const { document, warnings } = await buildOpenApi({
    manifest: {
      api: [
        route("/api/docs", "/x/docs/route.ts"),
        route("/api/docs/[[...slug]]", "/x/docs/[[...slug]]/route.ts"),
      ],
    },
    load: (f) => Promise.resolve(mods[f]),
  });
  // The static route keeps `/api/docs`; the catch-all's bare variant collided and was dropped.
  assertEquals(document.paths["/api/docs"].get.summary, "Docs root");
  assertEquals(document.paths["/api/docs"].get.parameters, []);
  assertEquals(warnings.filter((w) => w.code === "path-collision").length, 1);
  // The templated variant carries the path parameter and its own id.
  const page = document.paths["/api/docs/{slug}"].get;
  assertEquals(page.operationId, "getApiDocsBySlug");
  assertEquals((page.parameters as { name: string }[]).map((p) => p.name), ["slug"]);
  // Alone, an optional catch-all yields two operations that share nothing by reference.
  const alone = await buildOpenApi({
    manifest: { api: [route("/api/docs/[[...slug]]", "/x/docs/[[...slug]]/route.ts")] },
    load: (f) => Promise.resolve(mods[f]),
  });
  const bare = alone.document.paths["/api/docs"].get;
  const full = alone.document.paths["/api/docs/{slug}"].get;
  assert(bare !== full, "distinct operation objects");
  assertEquals(bare.operationId, "getApiDocsRoot");
  assertEquals(bare.parameters, [], "no `slug` parameter without a {slug} template");
  assertEquals(full.operationId, "getApiDocsBySlug");
  // Every defined operation carries a `default` envelope response for undeclared errors.
  const responses = full.responses as Record<
    string,
    { content: Record<string, { schema: unknown }> }
  >;
  assertEquals(responses.default.content["application/json"].schema, {
    $ref: "#/components/schemas/ApiError",
  });
});

Deno.test("diffSpecs: added / removed / changed operations and shared schemas", async () => {
  const before = (await buildOpenApi({ manifest, load })).document;
  const after: OpenApiDocument = JSON.parse(JSON.stringify(before));
  delete after.paths["/api/todos"].get;
  after.paths["/api/todos"].post.summary = "Changed";
  after.paths["/api/new"] = { get: { operationId: "getApiNew" } };
  after.components.schemas.Extra = { type: "string" };
  assertEquals(diffSpecs(before, after), [
    { kind: "removed", subject: "GET /api/todos" },
    { kind: "changed", subject: "POST /api/todos" },
    { kind: "added", subject: "GET /api/new" },
    { kind: "added", subject: "components.schemas.Extra" },
  ]);
  assertEquals(diffSpecs(before, before), []);
});

// ── Docs renderers ───────────────────────────────────────────────────────────

Deno.test("renderDocsHtml: builtin is script-free and escaped; scalar/swagger load the CDN", async () => {
  const { document } = await buildOpenApi({ manifest, load, info: { title: "<T&Cs>" } });
  const html = renderDocsHtml(document, {
    ui: "builtin",
    specUrl: "/openapi.json",
    styleUrl: "/docs.css",
  });
  assert(!html.includes("<script"), "the builtin renderer ships no JavaScript");
  assertStringIncludes(html, "&#60;T&#38;Cs&#62;");
  assertStringIncludes(html, '<link rel="stylesheet" href="/docs.css">');
  assertStringIncludes(html, 'id="postApiTodos"');
  assertStringIncludes(html, "Short and stout");
  assertStringIncludes(html, "<code>ApiError</code>"); // the $ref rendered by name
  assertStringIncludes(html, "<code>&#34;duplicate&#34;</code>"); // the code enum, escaped
  assertStringIncludes(html, "minLength: 1"); // a facet

  const scalar = renderDocsHtml(document, { ui: "scalar", specUrl: "/openapi.json" });
  assertStringIncludes(scalar, 'data-url="/openapi.json"');
  assertStringIncludes(
    scalar,
    'src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.67.0/dist/browser/standalone.min.js"',
    "pinned to an exact version",
  );
  const swagger = renderDocsHtml(document, { ui: "swagger", specUrl: "/spec", cdn: "/vendor/sw/" });
  assertStringIncludes(swagger, 'src="/vendor/sw/swagger-ui-bundle.js"');
  assertStringIncludes(swagger, 'url:"/spec"');
});

// ── The plugin ───────────────────────────────────────────────────────────────

function applyOpenapi(
  options: Parameters<typeof openapi>[0] = {},
  config: Partial<DenextConfig> = {},
  mode: "prod" | "dev" = "prod",
) {
  return applyPlugins({
    projectRoot: join(ROOT, "my-project"),
    appDir: APP_DIR,
    config: { plugins: [openapi(options)], ...config } as DenextConfig,
    mode,
    load,
  });
}

/** Register the plugin and scan the fixture tree, which feeds it the manifest (synthesizer seam). */
async function setup(
  options: Parameters<typeof openapi>[0] = {},
  config: Partial<DenextConfig> = {},
  mode: "prod" | "dev" = "prod",
) {
  resetPlugins();
  await applyOpenapi(options, config, mode);
  await scanRoutes(APP_DIR);
  return getPluginRequestHandler()!;
}

Deno.test("openapi plugin: serves /openapi.json with an ETag and 304, and /docs + its stylesheet", async () => {
  try {
    const handle = await setup();
    const res = await handle(new Request("https://x/openapi.json"));
    assert(res, "spec is served");
    assertEquals(res!.status, 200);
    assertEquals(res!.headers.get("content-type"), "application/json; charset=utf-8");
    assertEquals(res!.headers.get("x-denext-openapi-warnings"), "5");
    const etag = res!.headers.get("etag")!;
    const doc = await res!.json();
    assertEquals(doc.info.title, "my-project", "the title defaults to the project directory");
    assertEquals(Object.keys(doc.paths).length, 3);
    const again = await handle(
      new Request("https://x/openapi.json", { headers: { "if-none-match": etag } }),
    );
    assertEquals(again!.status, 304);
    const head = await handle(new Request("https://x/openapi.json", { method: "HEAD" }));
    assertEquals([head!.status, await head!.text()], [200, ""]);

    const docs = await handle(new Request("https://x/docs"));
    assertEquals(docs!.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await docs!.text();
    assertStringIncludes(html, 'href="/docs.css"');
    assertStringIncludes(html, "getApiTodos");
    const css = await handle(new Request("https://x/docs.css"));
    assertEquals(css!.headers.get("content-type"), "text/css; charset=utf-8");
    assertStringIncludes(await css!.text(), ".m.get");

    assertEquals(await handle(new Request("https://x/some/page")), null);
    assertEquals(await handle(new Request("https://x/openapi.json", { method: "POST" })), null);
  } finally {
    resetPlugins();
  }
});

Deno.test("openapi plugin: basePath, custom paths, docs off, authorize falls through to 404", async () => {
  try {
    const handle = await setup(
      {
        path: "/spec.json",
        docs: "/reference",
        ui: "scalar",
        authorize: (r) => r.headers.has("x-ok"),
      },
      { basePath: "/app" },
    );
    // The pipeline strips `basePath` before the plugin seam: the handler matches the
    // app-relative path, while the document and the docs page DESCRIBE the public one.
    assertEquals(await handle(new Request("https://x/app/spec.json")), null);
    assertEquals(await handle(new Request("https://x/spec.json")), null, "unauthorized → pass");
    const ok = await handle(new Request("https://x/spec.json", { headers: { "x-ok": "1" } }));
    assertEquals(ok!.status, 200);
    assertEquals(Object.keys((await ok!.json()).paths)[0], "/app/api/files/{path}");
    const docs = await handle(new Request("https://x/reference", { headers: { "x-ok": "1" } }));
    assertStringIncludes(await docs!.text(), 'data-url="/app/spec.json"');
    assertEquals(
      await handle(new Request("https://x/reference.css", { headers: { "x-ok": "1" } })),
      null,
    );
  } finally {
    resetPlugins();
  }
  try {
    const handle = await setup({ docs: false });
    assertEquals(await handle(new Request("https://x/docs")), null);
    assertEquals((await handle(new Request("https://x/openapi.json")))!.status, 200);
  } finally {
    resetPlugins();
  }
});

Deno.test("openapi plugin: the build step writes openapi.json; outFile: false skips it", async () => {
  const outDir = await Deno.makeTempDir({ prefix: "denext_openapi_" });
  try {
    await setup({ info: { title: "Built", version: "9" } });
    await runPluginBuildSteps({
      projectRoot: ROOT,
      appDir: APP_DIR,
      outDir,
      config: {} as DenextConfig,
    });
    const doc = JSON.parse(await Deno.readTextFile(join(outDir, "openapi.json")));
    assertEquals(doc.info, { title: "Built", version: "9" });
    resetPlugins();
    await setup({ outFile: false });
    await Deno.remove(join(outDir, "openapi.json"));
    await runPluginBuildSteps({
      projectRoot: ROOT,
      appDir: APP_DIR,
      outDir,
      config: {} as DenextConfig,
    });
    let exists = true;
    try {
      await Deno.stat(join(outDir, "openapi.json"));
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  } finally {
    resetPlugins();
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test('openapi plugin: expose:"dev" hides the endpoints in prod, serves them in dev', async () => {
  try {
    const prod = await setup({ expose: "dev" }, {}, "prod");
    assertEquals(await prod(new Request("https://x/openapi.json")), null, "hidden in prod");
    assertEquals(await prod(new Request("https://x/docs")), null);
  } finally {
    resetPlugins();
  }
  try {
    const dev = await setup({ expose: "dev" }, {}, "dev");
    assertEquals((await dev(new Request("https://x/openapi.json")))!.status, 200, "served in dev");
  } finally {
    resetPlugins();
  }
  try {
    // Default is "always": served in prod.
    const always = await setup({}, {}, "prod");
    assertEquals((await always(new Request("https://x/openapi.json")))!.status, 200);
  } finally {
    resetPlugins();
  }
});

Deno.test("openapi plugin: contributes the `denext openapi` verb", async () => {
  try {
    await setup();
    assertEquals(getPluginCommands().map((c) => c.name), ["openapi"]);
  } finally {
    resetPlugins();
  }
});

// ── The command ──────────────────────────────────────────────────────────────

function fakeIo(files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | null = null;
  const io = {
    log: (l: string) => out.push(l),
    error: (l: string) => err.push(l),
    readFile: (p: string) => Promise.resolve(files[p] ?? Promise.reject(new Error("ENOENT " + p))),
    writeFile: (p: string, t: string) => {
      files[p] = t;
      return Promise.resolve();
    },
    exit: (c: number) => {
      exitCode = c;
    },
  };
  return { io, out, err, files, exit: () => exitCode };
}

const ctx = (positionals: string[], flags: Record<string, string | boolean> = {}): CommandContext =>
  ({ positionals, flags, global: {}, rest: [] }) as unknown as CommandContext;

Deno.test("denext openapi: emit (stdout / --out), lint (--strict), diff", async () => {
  const build = () => buildOpenApi({ manifest, load, info: { title: "T", version: "1" } });
  const cmd = createOpenapiCommand(build, fakeIo().io);
  assertEquals(cmd.name, "openapi");

  const emit = fakeIo();
  await createOpenapiCommand(build, emit.io).run(ctx([]));
  assertEquals(JSON.parse(emit.out.join("\n")).info.title, "T");
  assertStringIncludes(emit.err[0], "5 lint warning(s)");

  const written = fakeIo();
  await createOpenapiCommand(build, written.io).run(ctx(["emit"], { out: "spec.json" }));
  assertStringIncludes(written.out[0], "Wrote spec.json (5 operations, 5 warnings)");
  assert(written.files["spec.json"].endsWith("}\n"));

  const lint = fakeIo();
  await createOpenapiCommand(build, lint.io).run(ctx(["lint"]));
  assertStringIncludes(lint.out[0], "missing-summary");
  assertStringIncludes(lint.out[0], "PATCH /api/todos/[id]");
  assertEquals(lint.out.at(-1), "5 finding(s)");
  assertEquals(lint.exit(), null);
  const strict = fakeIo();
  await createOpenapiCommand(build, strict.io).run(ctx(["lint"], { strict: true }));
  assertEquals(strict.exit(), 1);
  const clean = fakeIo();
  await createOpenapiCommand(
    () => buildOpenApi({ manifest: { api: [] }, load }),
    clean.io,
  ).run(ctx(["lint"], { strict: true }));
  assertEquals([clean.out[0], clean.exit()], ["openapi: every operation is fully described", null]);

  const same = fakeIo({ "spec.json": written.files["spec.json"] });
  await createOpenapiCommand(build, same.io).run(ctx(["diff", "spec.json"]));
  assertEquals([same.out[0], same.exit()], ["openapi: spec.json is up to date", null]);
  const stale = JSON.parse(written.files["spec.json"]);
  delete stale.paths["/api/todos"].get;
  const changed = fakeIo({ "spec.json": JSON.stringify(stale) });
  await createOpenapiCommand(build, changed.io).run(ctx(["diff", "spec.json"]));
  assertEquals(changed.out[0], "added   GET /api/todos");
  assertEquals(changed.exit(), 1);

  let threw = "";
  try {
    await createOpenapiCommand(build, fakeIo().io).run(ctx(["bogus"]));
  } catch (e) {
    threw = (e as Error).message;
  }
  assertEquals(threw, "unknown openapi action: bogus");
});
