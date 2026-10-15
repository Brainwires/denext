// `denext build --compile`: an app's server as one executable, run with its project gone.
//
// The fixture has what a real app has: a layout importing a stylesheet, a component importing
// another one and reading a data file beside it through `import.meta.url` (so its server copy's
// relocatable pins are exercised), an async Server Component, a client island, a route handler on
// `node:sqlite`, a static asset, a job, a migration and the `@denext/backend` plugin (fs storage;
// Postgres through npm:postgres when DENEXT_TEST_POSTGRES_URL names a database). It is compiled,
// the project directory is DELETED, and the binary runs from another directory on a free port:
// everything it serves must come from what it embedded. The checks: the pages, the stylesheets,
// the island bundle, the public asset, the route handler, the storage round trip, a write outside
// the baked permissions refused, the `.env` of the project NOT embedded while the working
// directory's is read, the run-time state written under ./.denext, `job` and `db migrate`.
//
// Heavy (a full build and a `deno compile`, ~200 MB written): run it where there is room.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { removeTempDir } from "../helpers/temp.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url));
const FW_URL = toFileUrl(FW).href;
const PG_URL = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const STORAGE_SECRET = "compile-test-storage-secret-0123456789abcdef";

/** The fixture project's files (path → content). */
function fixtureFiles(): Record<string, string> {
  return {
    "deno.json": JSON.stringify(
      {
        name: "@acme/compile-fixture",
        nodeModulesDir: "none",
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "denext",
          lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
        },
        imports: {
          "denext": `${FW_URL}mod.ts`,
          "denext/": `${FW_URL}src/`,
          "denext/jsx-runtime": `${FW_URL}src/jsx/jsx-runtime.ts`,
          "denext/jsx-dev-runtime": `${FW_URL}src/jsx/jsx-runtime.ts`,
          "denext/server": `${FW_URL}src/server/mod.ts`,
          "denext/client": `${FW_URL}src/client/mod.ts`,
          "@denext/denext": `${FW_URL}mod.ts`,
          "@denext/denext/server": `${FW_URL}src/server/mod.ts`,
          "@denext/backend": `${FW_URL}packages/backend/mod.ts`,
          "@denext/backend/server": `${FW_URL}packages/backend/server.ts`,
          "postgres": "npm:postgres@3.4.7",
        },
      },
      null,
      2,
    ),
    "denext.config.ts": `import { backend, fs } from "@denext/backend";
import { fromPostgresJs } from "denext/server";
import postgres from "postgres";

const url = Deno.env.get("DATABASE_URL");
export default {
  compile: { include: ["lib/motto.txt"], permissions: { write: ["app.db", ".storage"] } },
  plugins: [
    backend(
      url
        ? { postgres: { sql: fromPostgresJs(postgres(url, { max: 2, onnotice: () => {} })) } }
        : { storage: { driver: fs({ dir: ".storage" }), buckets: { files: { authorize: () => true } } } },
    ),
  ],
};
`,
    ".env": "SECRET=never-embedded\n",
    "app/globals.css": "body { margin: 0; } .page { color: rgb(1, 2, 3); }\n",
    "app/hero.css": ".hero { color: rgb(4, 5, 6); }\n",
    "lib/motto.txt": "compiled and relocated\n",
    "public/hello.txt": "hello from public\n",
    "app/layout.tsx": `import "./globals.css";
export default function RootLayout({ children }: { children: unknown }) {
  return <html lang="en"><head><title>compile fixture</title></head><body>{children}</body></html>;
}
`,
    "app/hero.tsx": `import "./hero.css";
const motto = Deno.readTextFileSync(new URL("../lib/motto.txt", import.meta.url)).trim();
export function Hero() {
  return <h1 class="hero">{motto}</h1>;
}
`,
    "app/counter.tsx": `"use client";
import { useState } from "denext";
export function Counter() {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>Clicked {n}</button>;
}
`,
    "app/page.tsx": `import { Counter } from "./counter.tsx";
import { Hero } from "./hero.tsx";
export default async function Home() {
  const greeting = await Promise.resolve("server component rendered");
  return <main class="page"><Hero /><p>{greeting}</p><Counter /></main>;
}
`,
    "app/api/hello/route.ts": `import { DatabaseSync } from "node:sqlite";
export function GET(): Response {
  const db = new DatabaseSync(":memory:");
  const row = db.prepare("SELECT 40 + 2 AS answer").get() as { answer: number };
  db.close();
  return Response.json({
    answer: row.answer,
    secret: Deno.env.get("SECRET") ?? null,
    fromEnvFile: Deno.env.get("FROM_ENV_FILE") ?? null,
    nodeEnv: Deno.env.get("NODE_ENV") ?? null,
  });
}
`,
    "app/api/outside/route.ts": `export async function GET(): Promise<Response> {
  try {
    await Deno.writeTextFile("not-granted.txt", "x");
    return Response.json({ wrote: true });
  } catch (err) {
    return Response.json({ wrote: false, error: (err as Error).name });
  }
}
`,
    "app/api/backend/route.ts": `import { db, storage } from "@denext/backend/server";
export async function GET(): Promise<Response> {
  if (Deno.env.get("DATABASE_URL")) {
    const rows = await db.service()\`select count(*)::int as n from notes\`;
    return Response.json({ notes: (rows[0] as { n: number }).n });
  }
  const files = storage.bucket("files", { service: true });
  await files.upload("greeting.txt", "stored in the binary's data dir", { contentType: "text/plain" });
  const got = await files.download("greeting.txt");
  return Response.json({ text: got ? await new Response(got.body).text() : null });
}
`,
    "jobs/ping.ts": `import { defineJob } from "denext/server";
export default defineJob({
  description: "ping",
  handler: ({ payload }) => \`pong \${JSON.stringify(payload)}\`,
});
`,
    "migrations/20260101000000_notes.sql": `-- migrate:up
CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
-- migrate:down
DROP TABLE notes;
`,
  };
}

/** Write the fixture under `dir`. */
async function writeFixture(dir: string): Promise<void> {
  for (const [rel, content] of Object.entries(fixtureFiles())) {
    const path = join(dir, ...rel.split("/"));
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
}

/** A free loopback port. */
function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

const dec = new TextDecoder();

/** Run a command to completion: its exit code and combined output. */
async function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  const r = await new Deno.Command(cmd, {
    args,
    cwd,
    env: { NO_COLOR: "1", ...env },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: r.code, out: dec.decode(r.stdout) + dec.decode(r.stderr) };
}

/** A running binary: fetch its pages, then stop it. */
interface Served {
  get(path: string): Promise<{ status: number; type: string; text: string }>;
  stop(): Promise<string>;
}

/** Start the binary on a free port and wait until `/` answers. */
async function serve(bin: string, cwd: string, env: Record<string, string>): Promise<Served> {
  const port = freePort();
  const child = new Deno.Command(bin, {
    cwd,
    env: { NO_COLOR: "1", PORT: String(port), ...env },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const d = new TextDecoder();
    for await (const chunk of stream) output += d.decode(chunk, { stream: true });
  };
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
  let exited = false;
  child.status.then(() => exited = true);
  const origin = `http://127.0.0.1:${port}`;
  const get = async (path: string) => {
    const res = await fetch(origin + path);
    return {
      status: res.status,
      type: res.headers.get("content-type") ?? "",
      text: await res.text(),
    };
  };
  const stop = async () => {
    if (!exited) child.kill("SIGTERM");
    // An app-owned Postgres pool (npm:postgres) keeps the process alive after the drain, as
    // under `denext start`: give it the drain deadline, then stop it hard.
    const hard = setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, 15_000);
    await child.status;
    clearTimeout(hard);
    await drained;
    return output;
  };
  for (let i = 0; i < 1200 && !exited; i++) {
    try {
      if ((await get("/")).status === 200) return { get, stop };
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the binary never served /:\n${await stop()}`);
}

Deno.test({
  name: "denext build --compile: one executable serves the app with its project deleted",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_compile_" }));
    const project = join(root, "project");
    const runDir = join(root, "run");
    const bin = join(root, "bin", Deno.build.os === "windows" ? "app.exe" : "app");
    try {
      await writeFixture(project);
      await Deno.mkdir(runDir);
      await Deno.writeTextFile(join(runDir, ".env"), "FROM_ENV_FILE=yes\n");
      let compiled = false;

      await t.step("compiles", async () => {
        const r = await run(
          Deno.execPath(),
          [
            "run",
            "-A",
            "--config",
            join(project, "deno.json"),
            join(FW, "cli.ts"),
            "build",
            "--compile",
            "--output",
            bin,
            project,
          ],
          project,
        );
        assertEquals(r.code, 0, r.out);
        assertStringIncludes(r.out, "--allow-write=.denext,.storage,app.db");
        assert(!r.out.includes("--allow-all"), r.out);
        // Nothing left to read from: the binary must carry everything.
        await Deno.remove(project, { recursive: true });
        compiled = true;
      });

      await t.step({
        name: "serves pages, stylesheets, the island, assets and handlers",
        ignore: !compiled,
        fn: async () => {
          const env = { DENEXT_STORAGE_SECRET: STORAGE_SECRET };
          const app = await serve(bin, runDir, env);
          let output = "";
          try {
            const home = await app.get("/");
            assertStringIncludes(home.text, "server component rendered");
            assertStringIncludes(home.text, "compiled and relocated"); // a copy's import.meta pin
            assertStringIncludes(home.text, "Clicked 0");
            assertStringIncludes(home.text, "/_denext/client/flight.js");
            const href = /<link rel="stylesheet" href="([^"]+)"/.exec(home.text)?.[1];
            assert(href, `no stylesheet link in ${home.text}`);
            const css = await app.get(href);
            assertEquals(css.status, 200);
            assertStringIncludes(css.text, "#010203");
            assertStringIncludes(css.text, "#040506");
            const island = await app.get("/_denext/client/flight.js");
            assertEquals(island.status, 200);
            assertStringIncludes(island.type, "javascript");
            assertEquals((await app.get("/hello.txt")).text, "hello from public\n");

            const hello = JSON.parse((await app.get("/api/hello")).text);
            assertEquals(hello, {
              answer: 42,
              secret: null, // the project's .env was not embedded
              fromEnvFile: "yes", // the working directory's was read
              nodeEnv: "production",
            });
            const outside = JSON.parse((await app.get("/api/outside")).text);
            assertEquals(outside, { wrote: false, error: "NotCapable" });
            const stored = JSON.parse((await app.get("/api/backend")).text);
            assertEquals(stored, { text: "stored in the binary's data dir" });
          } finally {
            output = await app.stop();
          }
          assert(!output.includes("Module not found"), output);
          // The run-time state went to the working directory, not into the binary.
          await Deno.stat(join(runDir, ".denext", "cache.db"));
          await Deno.stat(join(runDir, ".storage", "files", "greeting.txt"));
        },
      });

      await t.step({
        name: "runs a job",
        ignore: !compiled,
        fn: async () => {
          const r = await run(bin, ["job", "ping", "--payload", '{"a":1}'], runDir);
          assertEquals(r.code, 0, r.out);
          assertStringIncludes(r.out, 'pong {"a":1}');
        },
      });

      await t.step({
        name: "migrates its SQLite database in the working directory",
        ignore: !compiled,
        fn: async () => {
          const r = await run(bin, ["db", "migrate"], runDir);
          assertEquals(r.code, 0, r.out);
          assertStringIncludes(r.out, "20260101000000_notes.sql");
          await Deno.stat(join(runDir, "app.db"));
          const status = await run(bin, ["db", "status"], runDir);
          assertEquals(status.code, 0, status.out);
          assertStringIncludes(status.out, "20260101000000");
        },
      });

      await t.step({
        name: "migrates and queries Postgres through @denext/backend",
        ignore: !PG_URL || !compiled,
        fn: async () => {
          const env = { DATABASE_URL: PG_URL!, DENEXT_STORAGE_SECRET: STORAGE_SECRET };
          const up = await run(bin, ["db", "migrate"], runDir, env);
          assertEquals(up.code, 0, up.out);
          try {
            const app = await serve(bin, runDir, env);
            try {
              assertEquals(JSON.parse((await app.get("/api/backend")).text), { notes: 0 });
            } finally {
              await app.stop();
            }
          } finally {
            const down = await run(bin, ["db", "rollback"], runDir, env);
            assertEquals(down.code, 0, down.out);
          }
        },
      });
    } finally {
      await removeTempDir(root);
    }
  },
});
