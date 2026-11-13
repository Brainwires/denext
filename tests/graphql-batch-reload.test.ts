// @denext/graphql: the cost budget covers a whole Yoga batch (summed when the request is parsed,
// refused before any operation runs), and a schema OBJECT imported into `denext.config.ts`
// reloads under `denext dev` — traced to the project module that exports it and re-imported
// from there, as the module-path form is.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import {
  applyPlugins,
  getPluginRequestHandler,
  resetPlugins,
  runMatchingPrepareSteps,
} from "../src/plugin/mod.ts";
import { createSchema, graphql } from "../packages/graphql/mod.ts";
import {
  configGraphWatch,
  infoArgs,
  localModulesOf,
  traceExport,
  watchGlobs,
} from "../packages/graphql/trace.ts";

// graphql-yoga's parse / validate caches (lru-cache) memoize their clock for 1 ms behind a timer:
// let it fire inside each test rather than after it.
Deno.test.afterEach(() => new Promise((r) => setTimeout(r, 10)));

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

Deno.test("graphql dev: a reload names the edited file, and a failed one reaches the dev overlay", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_gql_reload_" }));
  const schemaFile = join(root, "app", "graphql", "schema.ts");
  let broken = false;
  const load =
    (() =>
      broken
        ? Promise.reject(new SyntaxError("Unexpected token in schema.ts"))
        : Promise.resolve({ schema: costSchema })) as unknown as ModuleLoader;
  const reported: { title: string; error: unknown }[] = [];
  const logged: string[] = [];
  const prepare = {
    projectRoot: root,
    appDir: join(root, "app"),
    outDir: join(root, ".denext"),
    config: {},
  };
  const { info, error } = console;
  console.info = (...a: unknown[]) => logged.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logged.push(a.map(String).join(" "));
  try {
    resetPlugins();
    await applyPlugins({
      projectRoot: root,
      appDir: join(root, "app"),
      config: { plugins: [graphql({ schema: "./app/graphql/schema.ts" })] } as DenextConfig,
      mode: "dev",
      load,
      reportDevError: (title, err) => reported.push({ title, error: err }),
    });
    const handle = getPluginRequestHandler()!;
    const hello = async () => (await handle(postJson({ query: "{ hello }" })))!;
    assertEquals((await (await hello()).json()).data.hello, "world");

    // A good edit: one line naming the file, nothing for the overlay.
    assert(await runMatchingPrepareSteps(prepare, [schemaFile]));
    assertEquals((await (await hello()).json()).data.hello, "world");
    assertEquals(logged, [
      `[@denext/graphql] schema reloaded after an edit to ${join("app", "graphql", "schema.ts")}`,
    ]);
    assertEquals(reported, []);

    // A broken edit: logged with the file, and shown in the dev error overlay.
    broken = true;
    logged.length = 0;
    const resolvers = join(root, "app", "graphql", "resolvers.ts");
    assert(await runMatchingPrepareSteps(prepare, [resolvers, schemaFile]));
    await (await hello().catch(() => new Response(null)))?.body?.cancel();
    await new Promise((r) => setTimeout(r, 0));
    const files = `${join("app", "graphql", "resolvers.ts")}, ${
      join("app", "graphql", "schema.ts")
    }`;
    assertEquals(reported.length, 1);
    assertEquals(reported[0].title, `GraphQL schema reload failed after an edit to ${files}`);
    assert(reported[0].error instanceof SyntaxError);
    assertEquals(logged.length, 1);
    assertStringIncludes(
      logged[0],
      `[@denext/graphql] schema reload failed after an edit to ${files}:`,
    );
  } finally {
    console.info = info;
    console.error = error;
    resetPlugins();
    await Deno.remove(root, { recursive: true });
  }
});

/**
 * A temp project whose config reaches its schema through an import-map alias (`#gql/`), which the
 * relative-import trace can't follow.
 */
async function aliasedProject(): Promise<{ root: string; config: string }> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_gql_alias_" }));
  await Deno.mkdir(join(root, "graphql"), { recursive: true });
  await Deno.mkdir(join(root, "app"), { recursive: true });
  await Deno.writeTextFile(join(root, "deno.json"), `{ "imports": { "#gql/": "./graphql/" } }\n`);
  await Deno.writeTextFile(join(root, "graphql", "schema.ts"), `export const schema = {};\n`);
  await Deno.writeTextFile(join(root, "app", "page.tsx"), `export default () => null;\n`);
  const config = join(root, "denext.config.ts");
  await Deno.writeTextFile(
    config,
    `import { schema } from "#gql/schema.ts";\nexport default { plugins: [], x: schema };\n`,
  );
  return { root, config };
}

Deno.test("configGraphWatch: the directories of the project modules the config reaches, aliases too", async () => {
  const { root, config } = await aliasedProject();
  try {
    // Written with `/` on every OS: the watcher joins the glob onto the project root itself.
    assertEquals(await configGraphWatch(config, root), [
      "graphql/**/*.{ts,tsx,js,jsx,mts,mjs,graphql,gql}",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("graphql dev: a schema object it can't trace reloads by re-importing the config", async () => {
  const { root, config } = await aliasedProject();
  const schemaFor = (hello: string) =>
    createSchema({
      typeDefs: "type Query { hello: String! }",
      resolvers: { Query: { hello: () => hello } },
    });
  const loads: string[] = [];
  let next = "reloaded";
  const load = ((path: string) => {
    loads.push(path);
    // The re-imported config: another graphql() plugin elsewhere, and this one at /graphql.
    return Promise.resolve({
      default: () => ({
        plugins: [
          { name: "other" },
          graphql({ schema: schemaFor("wrong path"), path: "/other" }),
          graphql({ schema: schemaFor(next) }),
        ],
      }),
    });
  }) as unknown as ModuleLoader;
  const prepare = {
    projectRoot: root,
    appDir: join(root, "app"),
    outDir: join(root, ".denext"),
    config: {},
  };
  const warned: string[] = [];
  const { warn } = console;
  console.warn = (...a: unknown[]) => warned.push(a.map(String).join(" "));
  try {
    const handle = await setup({ schema: schemaFor("world") }, "dev", root, load);
    const hello = async () =>
      (await (await handle(postJson({ query: "{ hello }" })))!.json()).data.hello as string;
    assertEquals(await hello(), "world");
    assertEquals(warned, [], "no restart notice");
    assertEquals(await runMatchingPrepareSteps(prepare, [join(root, "app", "page.tsx")]), false);
    // An edit under a directory the config's graph reaches re-reads the schema from the config.
    assert(await runMatchingPrepareSteps(prepare, [join(root, "graphql", "resolvers.ts")]));
    assertEquals(await hello(), "reloaded");
    next = "again";
    assert(await runMatchingPrepareSteps(prepare, [join(root, "graphql", "schema.ts")]));
    assertEquals(await hello(), "again");
    assertEquals(loads, [config, config]);
  } finally {
    console.warn = warn;
    resetPlugins();
    await Deno.remove(root, { recursive: true });
  }
});

const GLOB = "**/*.{ts,tsx,js,jsx,mts,mjs,graphql,gql}";

Deno.test("watchGlobs: Windows paths — drive letters, case, verbatim prefix, 8.3 roots, other drives", () => {
  const root = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\denext_gql_alias_x";
  const realRoot = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\denext_gql_alias_x";
  const globs = watchGlobs(
    [
      // deno info's real path, with a lower-case drive letter and the verbatim prefix.
      "\\\\?\\c:\\Users\\runneradmin\\AppData\\Local\\Temp\\denext_gql_alias_x\\GraphQL\\schema.ts",
      // A forward-slash spelling, nested below another watched folder.
      "C:/Users/runneradmin/AppData/Local/Temp/denext_gql_alias_x/GraphQL/types/user.ts",
      realRoot + "\\lib\\deep\\util.ts",
      realRoot + "\\root-module.ts",
      realRoot + "\\denext.config.ts", // the config itself
      realRoot + "\\node_modules\\pkg\\index.js",
      realRoot + "\\.denext\\gen.ts",
      "D:\\Users\\runneradmin\\AppData\\Local\\Temp\\denext_gql_alias_x\\other.ts", // another drive
      "C:\\elsewhere\\x.ts",
    ],
    [root, realRoot],
    [root + "\\denext.config.ts", realRoot.toUpperCase() + "\\DENEXT.CONFIG.TS"],
    "windows",
  );
  assertEquals(globs, [`GraphQL/${GLOB}`, `lib/deep/${GLOB}`, "root-module.ts"]);
});

Deno.test("watchGlobs: POSIX paths are case-sensitive and use the root's real path too", () => {
  const globs = watchGlobs(
    [["/var/p/graphql/schema.ts", "/private/var/p/graphql/schema.ts"], "/private/var/P/x/y.ts"],
    ["/var/p", "/private/var/p"],
    ["/var/p/denext.config.ts"],
    "posix",
  );
  assertEquals(globs, [`graphql/${GLOB}`]);
});

// What `deno info --json --no-lock C:\\…\\denext.config.ts` printed on Windows (runtime
// 3.0.0-denext.17), exit 0 and nothing on stderr: the bare path read as a URL with a `c:` scheme.
const WINDOWS_BARE_PATH_INFO = JSON.stringify({
  version: 1,
  roots: ["c:\\denext-debug\\gqlwatch\\proj\\denext.config.ts"],
  modules: [{ kind: "external", specifier: "c:\\denext-debug\\gqlwatch\\proj\\denext.config.ts" }],
  redirects: {},
  npmPackages: {},
});

Deno.test("infoArgs: the entry goes to deno info as a file: URL, never a bare Windows path", () => {
  assertEquals(infoArgs("C:\\denext-debug\\proj\\denext.config.ts", "windows"), [
    "info",
    "--json",
    "--no-lock",
    "file:///C:/denext-debug/proj/denext.config.ts",
  ]);
  assertEquals(
    infoArgs("/srv/app/denext.config.ts", "posix").at(-1),
    "file:///srv/app/denext.config.ts",
  );
});

Deno.test("localModulesOf: an entry deno info didn't read as a local module is an error, not an empty graph", () => {
  const bare = "c:\\denext-debug\\gqlwatch\\proj\\denext.config.ts";
  let err = assertThrows(() => localModulesOf(WINDOWS_BARE_PATH_INFO, bare));
  assertStringIncludes((err as Error).message, "did not read");
  const url = "file:///srv/app/denext.config.ts";
  err = assertThrows(() =>
    localModulesOf(
      JSON.stringify({ roots: [url], modules: [{ specifier: url, error: "Module not found" }] }),
      url,
    )
  );
  assertStringIncludes((err as Error).message, "Module not found");
  const ok = JSON.stringify({
    roots: [url],
    modules: [
      { kind: "esm", specifier: url },
      { kind: "esm", specifier: "file:///srv/app/graphql/schema.ts" },
      { kind: "esm", specifier: "https://jsr.io/@std/path/1.1.6/mod.ts" },
    ],
  });
  // `fromFileUrl` gives this OS's spelling (a backslashed path on Windows).
  assertEquals(localModulesOf(ok, url), [
    fromFileUrl(url),
    fromFileUrl("file:///srv/app/graphql/schema.ts"),
  ]);
});

Deno.test("configGraphWatch: deno info's failure is thrown with its stderr, and the plugin reports it", async () => {
  const { root, config } = await aliasedProject();
  try {
    await Deno.writeTextFile(join(root, "deno.json"), "{ not json");
    const err = await assertRejects(() => configGraphWatch(config, root));
    assertStringIncludes((err as Error).message, "deno info");
    assertStringIncludes((err as Error).message, "failed (exit");
    // Through the plugin: a dev notice and the dev overlay, and no reload is wired.
    const reported: string[] = [];
    const logged: string[] = [];
    const { error } = console;
    console.error = (...a: unknown[]) => logged.push(a.map(String).join(" "));
    try {
      resetPlugins();
      await applyPlugins({
        projectRoot: root,
        appDir: join(root, "app"),
        config: { plugins: [graphql({ schema: costSchema })] } as DenextConfig,
        mode: "dev",
        load: noopLoad,
        reportDevError: (title) => reported.push(title),
      });
    } finally {
      console.error = error;
    }
    assertEquals(reported, [
      "GraphQL schema reload is off: the config's module graph could not be read",
    ]);
    assertStringIncludes(logged.join("\n"), "a schema edit needs a dev-server restart");
  } finally {
    resetPlugins();
    await Deno.remove(root, { recursive: true });
  }
});
