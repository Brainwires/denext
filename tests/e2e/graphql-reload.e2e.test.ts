// @denext/graphql's dev reload of a schema it cannot trace, in a real browser: the config builds
// the schema OBJECT itself (it calls the schema module's builder), so no project module exports
// it and the plugin's trace finds none; the schema module loads its fields with a dynamic
// `import()`. Under `denext dev` a page's client component queries `/graphql` from the browser;
// the test edits the schema module and the module it loads dynamically, and the next query from
// the same page sees the new field and the new resolver, with no dev-server restart.
// (tests/graphql-batch-reload.test.ts covers the same reload with a stand-in loader.)
//
// The fixture's server-side npm deps (graphql-yoga, graphql) resolve through the CLI's re-exec
// with the merged config, so the dev server runs as a subprocess, as tests/e2e/graphql.e2e.test.ts
// does. Opt-in + NETWORK-REQUIRED (npm fetch on a cold cache): `deno task test:e2e`.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, toFileUrl } from "@std/path";
import type { Page } from "@astral/astral";
import {
  assertNoConsoleErrors,
  collectConsoleErrors,
  launchBrowser,
  pollFor,
  spawnOnBoundPort,
} from "./harness.ts";

const REPO = fromFileUrl(new URL("../../", import.meta.url));
const CLI = join(REPO, "cli.ts");
const EXAMPLE_LOCK = join(REPO, "examples", "graphql", "deno.lock");

/** A repo path as the fixture's import map names it. */
const repo = (path: string) => toFileUrl(join(REPO, path)).href;

const FIELDS_V1 = `export const fields = { typeDefs: "", resolvers: {} };\n`;
const FIELDS_V2 = `export const fields = {
  typeDefs: "extra: String!",
  resolvers: { extra: () => "added" },
};\n`;
const schemaModule = (hello: string) =>
  `import { createSchema } from "@denext/graphql";
// Loaded dynamically: no static import names it, so only a re-import of this module reaches it.
const { fields } = await import("./fields.ts");
export function buildSchema() {
  return createSchema({
    typeDefs: \`type Query { hello: String! \${fields.typeDefs} }\`,
    resolvers: { Query: { hello: () => ${JSON.stringify(hello)}, ...fields.resolvers } },
  });
}
`;

const FILES: Record<string, string> = {
  "deno.json": JSON.stringify(
    {
      nodeModulesDir: "none",
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "denext",
        lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
      },
      imports: {
        "denext": repo("mod.ts"),
        "denext/jsx-runtime": repo("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": repo("src/jsx/jsx-runtime.ts"),
        "denext/server": repo("src/server/mod.ts"),
        "denext/client": repo("src/client/mod.ts"),
        "@denext/denext": repo("mod.ts"),
        "@denext/denext/server": repo("src/server/mod.ts"),
        "@denext/denext/plugin-kit": repo("src/plugin/kit.ts"),
        "@denext/denext/cli/command": repo("src/cli/command.ts"),
        "@denext/graphql": repo("packages/graphql/mod.ts"),
        "@std/path": "jsr:@std/path@^1.0.0",
        "graphql": "npm:graphql@^16.9.0",
        "graphql-yoga": "npm:graphql-yoga@^5.24.6",
      },
    },
    null,
    2,
  ),
  // The schema object is built here, exported by no module: the plugin can't trace it, so a dev
  // reload re-imports this config through the dev loader.
  "denext.config.ts": `import { graphql } from "@denext/graphql";
import { buildSchema } from "./gql/schema.ts";
export default { plugins: [graphql({ schema: buildSchema() })] };
`,
  "gql/schema.ts": schemaModule("v1"),
  "gql/fields.ts": FIELDS_V1,
  "app/layout.tsx": `export default function Layout({ children }) {
  return <html lang="en"><head><title>gql reload</title></head><body>{children}</body></html>;
}
`,
  "app/page.tsx": `import { Query } from "./query.tsx";
export default function Page() {
  return <main><Query /></main>;
}
`,
  // The browser side: the page's own fetch to /graphql (a same-origin POST carries its Origin).
  "app/query.tsx": `"use client";
import { useEffect, useState } from "denext";
export function Query() {
  const [out, setOut] = useState({ n: 0, body: "" });
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const run = async () => {
    const query = (document.getElementById("q") as HTMLInputElement).value;
    const res = await fetch("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query }),
    });
    const body = await res.text();
    setOut((o) => ({ n: o.n + 1, body }));
  };
  return (
    <div>
      <input id="q" defaultValue="{ hello }" />
      <button type="button" id="run" class={ready ? "ready" : ""} onClick={run}>run</button>
      <pre id="out" data-n={String(out.n)}>{out.body}</pre>
    </div>
  );
}
`,
};

async function writeFixture(dir: string): Promise<void> {
  for (const [rel, body] of Object.entries(FILES)) {
    const path = join(dir, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, body);
  }
  // The example's lock: the same graphql-yoga / graphql the rest of the suite resolves.
  await Deno.copyFile(EXAMPLE_LOCK, join(dir, "deno.lock"));
}

/** Start `denext dev` on `dir` and wait until it serves the page. */
async function startDev(dir: string): Promise<{ origin: string; close(): Promise<void> }> {
  const server = await spawnOnBoundPort(
    ["run", "-A", CLI, "dev", ".", "--host", "127.0.0.1", "--port", "0"],
    dir,
  );
  const origin = `http://127.0.0.1:${server.port}`;
  for (let i = 0; i < 240 && !server.exited(); i++) {
    try {
      const res = await fetch(origin + "/");
      await res.body?.cancel();
      if (res.ok) return { origin, close: server.close };
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  await server.close();
  throw new Error("denext dev did not serve / within 120 s");
}

/** Run `query` from the page's client component; the parsed GraphQL response. */
async function queryFromPage(page: Page, query: string): Promise<unknown> {
  const n = Number(await page.evaluate(`document.querySelector("#out").dataset.n`));
  await page.evaluate(`document.querySelector("#q").value = ${JSON.stringify(query)}`);
  await (await page.$("#run"))!.click();
  await pollFor(page, `Number(document.querySelector("#out").dataset.n) > ${n}`);
  return JSON.parse(String(await page.evaluate(`document.querySelector("#out").textContent`)));
}

Deno.test({
  name: "e2e: @denext/graphql reloads a schema it cannot trace under denext dev (browser queries)",
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-gql-reload-" }));
  try {
    await writeFixture(dir);
    const dev = await startDev(dir);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage(dev.origin + "/");
      const errors = collectConsoleErrors(page);
      await pollFor(page, `document.querySelector("#run.ready") !== null`);
      assertEquals(await queryFromPage(page, "{ hello }"), { data: { hello: "v1" } });
      const before = await queryFromPage(page, "{ hello extra }") as { errors?: unknown[] };
      assert(before.errors?.length, "no `extra` field before the edit");

      // Edit the module the schema loads dynamically, and the schema module itself.
      await Deno.writeTextFile(join(dir, "gql", "fields.ts"), FIELDS_V2);
      await Deno.writeTextFile(join(dir, "gql", "schema.ts"), schemaModule("v2"));

      // The next query from the same page sees both edits (the dev server noticing the edit takes
      // a moment, so ask until it does, on the same page and server).
      const want = JSON.stringify({ data: { hello: "v2", extra: "added" } });
      const deadline = Date.now() + 60_000;
      let last: unknown;
      while (Date.now() < deadline) {
        last = await queryFromPage(page, "{ hello extra }");
        if (JSON.stringify(last) === want) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assertEquals(JSON.stringify(last), want, "the reloaded schema answers the next query");
      assertNoConsoleErrors(errors);
    } finally {
      await browser.close();
      await dev.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
