// `@denext/backend`'s auto-REST routes in `@denext/openapi`'s document: the backend registers an
// OpenAPI source (a global slot — no dependency between the packages) that describes the
// catalog's relations and functions as OpenAPI 3.1 operations, and the plugin merges every
// registered source's paths and schemas into the app's document.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { DenextConfig } from "../src/server/config.ts";
import type { PluginContext } from "../src/plugin/mod.ts";
import { applyPlugins, getPluginRequestHandler, resetPlugins } from "../src/plugin/mod.ts";
import {
  buildOpenApi,
  openapi,
  OPENAPI_SOURCES,
  type OpenApiSource,
  registeredOpenApiSources,
  registerOpenApiSource,
} from "../packages/openapi/mod.ts";
import type { RestCatalog, RestColumn, RestTable } from "../packages/backend/src/rest-catalog.ts";
import { openApiContribution } from "../packages/backend/src/rest-openapi.ts";
import { registerOpenApi, resolveRest, setupRest } from "../packages/backend/src/rest.ts";

const col = (name: string, type: string, extra: Partial<RestColumn> = {}): RestColumn => ({
  name,
  castType: type,
  typeName: type,
  category: type === "int4" ? "N" : type === "bool" ? "B" : "S",
  nullable: false,
  hasDefault: false,
  readOnly: false,
  ...extra,
});

const notes: RestTable = {
  schema: "public",
  name: "notes",
  kind: "table",
  columns: [
    col("id", "int4", { hasDefault: true }),
    col("body", "text"),
    col("done", "bool", { nullable: true }),
    col("total", "int4", { readOnly: true }),
  ],
  primaryKey: ["id"],
};
const stats: RestTable = {
  schema: "public",
  name: "stats",
  kind: "materialized view",
  columns: [col("n", "int4")],
  primaryKey: [],
};
const secret: RestTable = { ...notes, name: "secrets" };

const fn = (name: string, volatility: "i" | "s" | "v", setOf = false) => ({
  schema: "public",
  name,
  args: [{ ...col("x", "int4"), name: "x", hasDefault: false, variadic: false }],
  volatility,
  setOf,
  returns: volatility === "v"
    ? { kind: "void" as const, castType: "void" }
    : { kind: "scalar" as const, castType: "int4", column: col("", "int4") },
});

const service: RestCatalog = {
  schemas: ["public"],
  tables: new Map([["public", new Map([["notes", notes], ["stats", stats], ["secrets", secret]])]]),
  foreignKeys: [],
  functions: new Map([[
    "public",
    new Map([["add", [fn("add", "i", true)]], ["bump", [
      fn("bump", "v"),
    ]]]),
  ]]),
  enums: new Map(),
  compositeTypes: [],
  castTypes: new Map(),
  postgis: false,
};
/** What the RLS roles see: no `secrets`. */
const catalog: RestCatalog = {
  ...service,
  tables: new Map([["public", new Map([["notes", notes], ["stats", stats]])]]),
  service,
};

type Op = Record<string, unknown> & {
  parameters?: { name: string; in: string }[];
  responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
};

Deno.test("openApiContribution: relations and functions as OpenAPI 3.1 operations", () => {
  const { paths, schemas } = openApiContribution(catalog, ["public"], "/app/rest/v1");
  assertEquals(Object.keys(paths).sort(), [
    "/app/rest/v1/notes",
    "/app/rest/v1/rpc/add",
    "/app/rest/v1/rpc/bump",
    "/app/rest/v1/stats",
  ]);
  assertEquals(Object.keys(paths["/app/rest/v1/notes"]).sort(), ["delete", "get", "patch", "post"]);
  assertEquals(
    Object.keys(paths["/app/rest/v1/stats"]),
    ["get"],
    "a materialized view is read-only",
  );
  assertEquals(
    Object.keys(paths["/app/rest/v1/rpc/bump"]),
    ["post"],
    "a volatile function is POST",
  );
  assertEquals(Object.keys(paths["/app/rest/v1/rpc/add"]).sort(), ["get", "post"]);
  const row = schemas["rest.notes"] as {
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
  assertEquals(row.properties.id.type, "integer");
  assertEquals(row.properties.done.type, ["boolean", "null"], "nullable → 3.1 type array");
  assertEquals(row.properties.total.readOnly, true);
  assertEquals(row.required, ["body"]);
  assert(String(row.properties.id.description).includes("Primary Key"));
  const get = paths["/app/rest/v1/notes"].get as Op;
  const names = get.parameters!.map((p) => p.name);
  for (const n of ["id", "body", "select", "order", "limit", "offset", "Range"]) {
    assert(names.includes(n), n);
  }
  assertEquals(get.responses["200"].content!["application/json"].schema, {
    type: "array",
    items: { $ref: "#/components/schemas/rest.notes" },
  });
  const add = paths["/app/rest/v1/rpc/add"].get as Op;
  assertEquals(add.responses["200"].content!["application/json"].schema, {
    type: "array",
    items: { type: ["integer", "null"], format: "int4" },
  });
  assert((paths["/app/rest/v1/rpc/bump"].post as Op).responses["204"], "void → 204");
  assert(schemas["rest.Error"], "PostgREST's error body");
});

Deno.test("openApiContribution: every schema of rest.schemas, the others behind their profile", () => {
  const things: RestTable = { ...notes, schema: "api", name: "things" };
  const shadow: RestTable = { ...notes, schema: "api", columns: [col("other", "text")] };
  const multi: RestCatalog = {
    ...catalog,
    schemas: ["public", "api"],
    tables: new Map([...catalog.tables, ["api", new Map([["things", things], ["notes", shadow]])]]),
    functions: new Map([...catalog.functions, [
      "api",
      new Map([["ping", [{ ...fn("ping", "s"), schema: "api" }]], ["add", [fn("add", "v")]]]),
    ]]),
  };
  const { paths, schemas } = openApiContribution(multi, ["public", "api"], "/rest/v1");
  assertEquals(Object.keys(paths).sort(), [
    "/rest/v1/notes",
    "/rest/v1/rpc/add",
    "/rest/v1/rpc/bump",
    "/rest/v1/rpc/ping",
    "/rest/v1/stats",
    "/rest/v1/things",
  ]);
  type Param = { name: string; in: string; required?: boolean; schema?: { enum?: string[] } };
  const params = (op: unknown) => (op as { parameters?: Param[] }).parameters ?? [];
  const profile = (op: unknown) =>
    params(op).filter((p) => /-Profile$/.test(p.name)).map((p) =>
      `${p.name}=${p.schema?.enum?.join("|")}${p.required ? "!" : ""}`
    );
  const thing = paths["/rest/v1/things"];
  assertEquals(profile(thing.get), ["Accept-Profile=api!"]);
  for (const write of ["post", "patch", "delete"]) {
    assertEquals(profile(thing[write]), ["Content-Profile=api!"], write);
  }
  assertEquals((thing.get as Op).operationId, "rest_select_api.things");
  assertEquals((thing.get as Op).tags, ["api.things"]);
  assertEquals(
    (thing.get as Op).responses["200"].content!["application/json"].schema,
    { type: "array", items: { $ref: "#/components/schemas/rest.api.things" } },
  );
  assert(schemas["rest.api.things"]);
  // The default schema keeps its bare names and takes no profile header.
  assertEquals(profile(paths["/rest/v1/notes"].get), []);
  assertEquals((paths["/rest/v1/notes"].get as Op).operationId, "rest_select_notes");
  assert(!schemas["rest.api.notes"], "a name the default schema also has is described once");
  assertEquals(Object.keys(paths["/rest/v1/rpc/add"]).sort(), ["get", "post"], "public's add");
  const ping = paths["/rest/v1/rpc/ping"];
  assertEquals([profile(ping.get), profile(ping.post)], [["Accept-Profile=api!"], [
    "Content-Profile=api!",
  ]]);
  assertEquals((ping.post as Op).operationId, "rest_rpc_api.ping");
  // The public-only document is unchanged by the extra schema in the catalog.
  assertEquals(
    Object.keys(openApiContribution(multi, ["public"], "/rest/v1").paths).length,
    4,
  );
});

Deno.test("the plugin merges a registered source; sources:false and a failing source", async () => {
  const unregister = registerOpenApi(
    resolveRest({ basePath: "/rest/v1" }),
    () => Promise.resolve(catalog),
  );
  resetPlugins();
  try {
    const dir = join(Deno.cwd(), "tests", "fixtures", "__no_app__");
    const handler = async (options: Parameters<typeof openapi>[0]) => {
      resetPlugins();
      await applyPlugins({
        projectRoot: dir,
        appDir: join(dir, "app"),
        config: { basePath: "/base", plugins: [openapi(options)] } as DenextConfig,
        mode: "prod",
        load: () => Promise.resolve({}),
      });
      const res = await getPluginRequestHandler()!(new Request("https://x/openapi.json"));
      return await res!.json();
    };
    const doc = await handler({});
    assert(doc.paths["/base/rest/v1/notes"].get, "the auto-REST routes are in the document");
    assert(!doc.paths["/base/rest/v1/secrets"], "a relation only the secret key reaches is not");
    assert(doc.components.schemas["rest.notes"]);
    assert(doc.components.schemas.ApiError, "the app's own shared schema stays");
    const off = await handler({ sources: false });
    assertEquals(Object.keys(off.paths), []);

    const failing: OpenApiSource = {
      name: "broken",
      describe: () => Promise.reject(new Error("no database")),
    };
    const built = await buildOpenApi({
      manifest: { api: [] },
      load: () => Promise.resolve({}),
      sources: [failing],
    });
    assertEquals(built.warnings.map((w) => [w.code, w.message]), [[
      "source-failed",
      "broken: no database",
    ]]);
  } finally {
    unregister();
    resetPlugins();
  }
  assert(!registeredOpenApiSources().some((s) => s.name === "@denext/backend rest"));
});

Deno.test("a source never replaces an app route's operation (path-collision)", async () => {
  const stop = registerOpenApiSource({
    name: "dup",
    describe: () => ({ paths: { "/api/x": { get: { summary: "theirs" } } } }),
  });
  try {
    const built = await buildOpenApi({
      manifest: {
        api: [{
          kind: "api",
          pattern: [{ kind: "static", value: "api" }, { kind: "static", value: "x" }],
          routePath: "/api/x",
          filePath: "/x.ts",
        }],
      },
      load: () => Promise.resolve({ GET: () => new Response() }),
      sources: registeredOpenApiSources(),
    });
    assertEquals(built.document.paths["/api/x"].get.summary, undefined, "the app's is kept");
    assert(built.warnings.some((w) => w.code === "path-collision" && w.routePath === "/api/x"));
  } finally {
    stop();
  }
  const slot = (globalThis as unknown as Record<symbol, Map<string, unknown>>)[OPENAPI_SOURCES];
  assertEquals(slot.has("dup"), false);
});

Deno.test("setupRest registers the source unless rest.openapi is false, and its teardown removes it", () => {
  const slot = () =>
    (globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>)[OPENAPI_SOURCES];
  for (const openapiOn of [true, false]) {
    const teardowns: (() => void)[] = [];
    const ctx = {
      mode: "build",
      addRequestHandler() {},
      addPrepareStep() {},
      addTeardown: (fn: () => void) => teardowns.push(fn),
    } as unknown as PluginContext;
    setupRest(ctx, resolveRest({ openapi: openapiOn }));
    assertEquals(slot()?.has("@denext/backend rest") ?? false, openapiOn);
    for (const fn of teardowns) fn();
    assertEquals(slot()?.has("@denext/backend rest") ?? false, false);
  }
});
