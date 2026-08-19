// Networked e2e for examples/drizzle: proves Drizzle ORM runs on denext over the
// better-sqlite3 compat (Deno's built-in node:sqlite, no native addon), end to end
// through the real CLI — `deno install` → `denext build` → `denext start` — then a
// live read + Server-Action write against the served app.
//
// This drives the CLI as a subprocess ON PURPOSE: a server-side npm dep (drizzle)
// only resolves once the CLI re-execs with the merged framework+app config (see
// `maybeReexecForModules` in cli.ts). The in-process build harness runs under the
// framework's own config, where a bare `import "drizzle-orm"` can't resolve — so
// this can't use buildAndServe().
//
// Opt-in + NETWORK-REQUIRED (`deno install` fetches drizzle-orm from npm):
// `deno task test:e2e`. Skipped automatically if the install can't reach npm.

import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";

const EXAMPLE = fromFileUrl(new URL("../../examples/drizzle", import.meta.url));
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));
const DENO = Deno.execPath();

async function run(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  const cmd = new Deno.Command(DENO, { args, cwd, stdout: "piped", stderr: "piped" });
  const { success, stdout, stderr } = await cmd.output();
  return { ok: success, out: new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr) };
}

Deno.test({
  name: "e2e: examples/drizzle runs Drizzle ORM over the better-sqlite3 compat",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  // 1. Install deps (drizzle-orm from npm + the local better-sqlite3 shim).
  const install = await run(["install"], EXAMPLE);
  if (!install.ok) {
    console.warn(
      "e2e: `deno install` failed (npm unreachable / offline?) — skipping.\n" + install.out,
    );
    return;
  }

  // 2. Build for production via the real CLI (exercises the module re-exec).
  await t.step("build", async () => {
    const built = await run(["run", "-A", CLI, "build", "."], EXAMPLE);
    assert(built.ok, "denext build failed:\n" + built.out);
  });

  // 3. Start the prod server on an ephemeral port; parse the bound port from its
  //    startup line ("denext start ▸ http://127.0.0.1:PORT").
  const server = new Deno.Command(DENO, {
    args: ["run", "-A", CLI, "start", ".", "--host", "127.0.0.1", "--port", "0"],
    cwd: EXAMPLE,
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  let origin = "";
  try {
    origin = await readOrigin(server.stdout);
    assert(origin, "server never printed its listen URL");

    await t.step("read path: Drizzle query renders seeded rows", async () => {
      const html = await (await fetch(origin + "/")).text();
      assertStringIncludes(html, "Drizzle runs on denext");
      assertStringIncludes(html, "node:sqlite");
    });

    await t.step("write path: Server Action inserts through Drizzle", async () => {
      const home = await (await fetch(origin + "/")).text();
      const action = home.match(/action="([^"]+)"/)?.[1];
      assert(action, "no Server Action endpoint in the form markup");
      const post = await fetch(origin + action, {
        method: "POST",
        headers: { "Origin": origin, "Content-Type": "application/x-www-form-urlencoded" },
        body: "title=inserted-by-e2e",
        redirect: "manual",
      });
      assert(post.status === 303, `expected 303 redirect, got ${post.status}`);
      await post.body?.cancel();
      const after = await (await fetch(origin + "/")).text();
      assertStringIncludes(after, "inserted-by-e2e");
    });
  } finally {
    try {
      server.kill("SIGTERM");
    } catch { /* already exited */ }
    await server.status;
  }
});

/** Read the child's stdout until the "denext start ▸ http://host:port" line. */
async function readOrigin(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return "";
      buf += decoder.decode(value, { stream: true });
      const m = buf.match(/https?:\/\/[\d.]+:\d+/);
      if (m) return m[0];
    }
  } finally {
    reader.releaseLock();
  }
}
