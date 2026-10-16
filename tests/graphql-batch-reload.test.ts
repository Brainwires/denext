// @denext/graphql: the cost budget covers a whole Yoga batch (summed when the request is parsed,
// refused before any operation runs), and a schema OBJECT imported into `denext.config.ts`
// reloads under `denext dev` — traced to the project module that exports it and re-imported
// from there, as the module-path form is.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import {
  applyPlugins,
  getPluginRequestHandler,
  resetPlugins,
  runMatchingPrepareSteps,
} from "../src/plugin/mod.ts";
import { createSchema, graphql } from "../packages/graphql/mod.ts";
import { traceExport } from "../packages/graphql/trace.ts";

const noopLoad = (() => Promise.resolve({})) as unknown as ModuleLoader;

let resolved = 0;
const costSchema = createSchema({
  typeDefs: `type Query { nodes(first: Int): [Node!]!, hello: String! } type Node { id: String! }`,
  resolvers: {
    Query: {
      nodes: () => {
        resolved++;
        return [] as { id: string }[];
      },
      hello: () => "world",
    },
  },
});

async function setup(
  options: Partial<Parameters<typeof graphql>[0]>,
  mode: "dev" | "prod" = "prod",
  projectRoot = "/tmp/proj",
  load: ModuleLoader = noopLoad,
) {
  resetPlugins();
  await applyPlugins({
    projectRoot,
    appDir: join(projectRoot, "app"),
    config: { plugins: [graphql({ schema: costSchema, ...options })] } as DenextConfig,
    mode,
    load,
  });
  return getPluginRequestHandler()!;
}

const postJson = (body: unknown) =>
  new Request("https://x/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", host: "x", origin: "https://x" },
    body: JSON.stringify(body),
  });

Deno.test("graphql batching: the cost budget is per batch — refused before any operation runs", async () => {
  // Each operation costs 1 + 40 = 41, under the budget of 60 on its own; three cost 123.
  const op = { query: "{ nodes(first: 40) { id } }" };
  try {
    const handle = await setup({ maxCost: 60, yoga: { batching: true } });
    resolved = 0;
    const refused = (await handle(postJson([op, op, op])))!;
    assertEquals(refused.status, 400);
    assertStringIncludes(await refused.text(), "Batch is too expensive (cost 123, max 60)");
    assertEquals(resolved, 0, "no operation of the batch ran");

    // A variable page size counts at its value in the batch sum too.
    const viaVariable = {
      query: "query($n: Int!) { nodes(first: $n) { id } }",
      variables: { n: 59 },
    };
    const sneaky = (await handle(postJson([{ query: "{ hello }" }, viaVariable])))!;
    assertEquals(sneaky.status, 400, "1 + (1 + 59) = 61 > 60");
    await sneaky.body?.cancel();

    // A batch within the budget runs every operation.
    const ok = (await handle(postJson([op, { query: "{ hello }" }])))!;
    assertEquals(ok.status, 200);
    const results = await ok.json() as { data?: unknown; errors?: unknown }[];
    assertEquals(results.map((r) => r.errors), [undefined, undefined]);
    assertEquals(resolved, 1);

    // A single operation keeps its own check (and a one-element batch is just that).
    const single = await (await handle(postJson({ query: "{ nodes(first: 80) { id } }" })))!
      .json();
    assertStringIncludes(JSON.stringify(single.errors), "too expensive");
  } finally {
    resetPlugins();
  }
});

Deno.test("graphql batching: without maxCost a batch is not limited", async () => {
  try {
    const handle = await setup({ yoga: { batching: true } });
    const op = { query: "{ nodes(first: 400) { id } }" };
    const res = (await handle(postJson([op, op])))!;
    assertEquals(res.status, 200);
    await res.body?.cancel();
  } finally {
    resetPlugins();
  }
});

/** A temp project: a config that imports `graphql/schema.ts`, which builds the schema. */
async function project(): Promise<{ root: string; schemaFile: string }> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_gql_trace_" }));
  await Deno.mkdir(join(root, "graphql"), { recursive: true });
  await Deno.mkdir(join(root, "lib"), { recursive: true });
  const schemaFile = join(root, "graphql", "schema.ts");
  await Deno.writeTextFile(
    schemaFile,
    `// deno-lint-ignore no-explicit-any
export const schema = (globalThis as any).__denextTraceSchema("world");\n`,
  );
  await Deno.writeTextFile(join(root, "lib", "types.ts"), `export type X = 1;\n`);
  await Deno.writeTextFile(
    join(root, "denext.config.ts"),
    `import type { X } from "./lib/types.ts";
import { schema } from "./graphql/schema.ts";
export default { plugins: [], x: schema as unknown as X };\n`,
  );
  return { root, schemaFile };
}

Deno.test("traceExport: finds the module and export a config import resolved to (identity)", async () => {
  const { root, schemaFile } = await project();
  try {
    const made = createSchema({ typeDefs: "type Query { hello: String! }" });
    (globalThis as Record<string, unknown>).__denextTraceSchema = () => made;
    const config = await import(toFileUrl(join(root, "denext.config.ts")).href);
    assert(config.default.x === made);
    assertEquals(await traceExport(made, root), { file: schemaFile, name: "schema" });
    assertEquals(await traceExport({ other: true }, root), null, "an untraceable value");
    assertEquals(await traceExport(made, join(root, "graphql")), null, "no config there");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("graphql dev: a schema object imported into the config reloads from its module", async () => {
  const { root, schemaFile } = await project();
  const schemaFor = (hello: string) =>
    createSchema({
      typeDefs: "type Query { hello: String! }",
      resolvers: { Query: { hello: () => hello } },
    });
  (globalThis as Record<string, unknown>).__denextTraceSchema = schemaFor;
  const { schema } = await import(toFileUrl(schemaFile).href);
  const loads: string[] = [];
  const load = ((path: string) => {
    loads.push(path);
    return Promise.resolve({ schema: schemaFor("reloaded") });
  }) as unknown as ModuleLoader;
  const prepare = {
    projectRoot: root,
    appDir: join(root, "app"),
    outDir: join(root, ".denext"),
    config: {},
  };
  try {
    const handle = await setup({ schema }, "dev", root, load);
    const hello = async () =>
      (await (await handle(postJson({ query: "{ hello }" })))!.json()).data.hello as string;
    assertEquals(await hello(), "world");
    assertEquals(await runMatchingPrepareSteps(prepare, [join(root, "app", "page.tsx")]), false);
    // An edit beside the traced module reloads it through the dev loader.
    assert(await runMatchingPrepareSteps(prepare, [join(root, "graphql", "resolvers.ts")]));
    assertEquals(await hello(), "reloaded");
    assertEquals(loads, [schemaFile]);
  } finally {
    resetPlugins();
    await Deno.remove(root, { recursive: true });
  }
});
