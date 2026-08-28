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

// Bounded waits so a wedged step fails fast with a diagnostic instead of hanging the whole
// suite for 30+ minutes (e.g. a stale drizzle server holding the SQLite file, an npm fetch
// that stalls, or a re-exec that never binds a port). `deno install` can be slow (network),
// so it gets the longest bound; the server must print its listen URL well within a minute.
const INSTALL_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 180_000;
const READY_TIMEOUT_MS = 60_000;

async function run(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; out: string }> {
  try {
    const cmd = new Deno.Command(DENO, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const { success, stdout, stderr } = await cmd.output();
    return {
      ok: success,
      out: new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr),
    };
  } catch (e) {
    // AbortSignal.timeout fired (or spawn failed): the child is killed. Report, don't hang.
    return {
      ok: false,
      out: `\`deno ${args.join(" ")}\` did not finish within ${timeoutMs}ms: ${e}`,
    };
  }
}

Deno.test({
  name: "e2e: examples/drizzle runs Drizzle ORM over the better-sqlite3 compat",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  // 1. Install deps (drizzle-orm from npm + the local better-sqlite3 shim).
  const install = await run(["install"], EXAMPLE, INSTALL_TIMEOUT_MS);
  if (!install.ok) {
    console.warn(
      "e2e: `deno install` failed (npm unreachable / offline?) — skipping.\n" + install.out,
    );
    return;
  }

  // 2. Build for production via the real CLI (exercises the module re-exec).
  await t.step("build", async () => {
    const built = await run(["run", "-A", CLI, "build", "."], EXAMPLE, BUILD_TIMEOUT_MS);
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

  // Drain the server's stderr concurrently so a startup crash (a locked SQLite file, a
  // failed re-exec) is captured for the failure message rather than lost.
  let stderrBuf = "";
  const stderrPump = (async () => {
    const reader = server.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        stderrBuf += decoder.decode(value, { stream: true });
      }
    } catch {
      /* cancelled on teardown */
    } finally {
      reader.releaseLock();
    }
  })();

  let origin = "";
  try {
    // Hard-bound the readiness wait with Promise.race: `reader.cancel()` alone does NOT
    // unblock a pending read while the re-exec'd child holds the inherited stdout pipe
    // open, so a timeout timer isn't enough — race the read against a deadline that always
    // resolves. The losing readOrigin read is abandoned (sanitizeResources:false) and its
    // pipe closes when the tree is killed below.
    origin = await Promise.race([
      readOrigin(server.stdout),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), READY_TIMEOUT_MS)),
    ]);
    assert(
      origin,
      `server never printed its listen URL within ${READY_TIMEOUT_MS}ms` +
        (stderrBuf ? `\nserver stderr:\n${stderrBuf}` : ""),
    );

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
    // Kill the whole tree (parent + the re-exec'd grandchild that actually binds the port
    // and inherits stdout). Killing only `server` leaves that grandchild orphaned — holding
    // the stdout pipe and the SQLite file — which is what poisoned earlier runs.
    await killTree(server.pid);
    try {
      await server.status;
    } catch { /* already reaped */ }
    await stderrPump.catch(() => {});
  }
});

/** Recursively SIGKILL a process and its descendants (macOS/Linux; via `pgrep -P`). */
async function killTree(pid: number): Promise<void> {
  try {
    const out = await new Deno.Command("pgrep", { args: ["-P", String(pid)], stdout: "piped" })
      .output();
    const kids = new TextDecoder().decode(out.stdout).trim().split(/\s+/).filter(Boolean);
    for (const k of kids) await killTree(Number(k));
  } catch { /* pgrep missing or no children */ }
  try {
    Deno.kill(pid, "SIGKILL");
  } catch { /* already exited */ }
}

/**
 * Read the child's stdout until the "denext start ▸ http://host:port" line. Returns the
 * origin, or `""` if the stream closes first. The caller bounds this with a deadline.
 *
 * The host may be `localhost` OR an IP (the CLI prints `http://localhost:PORT` even when
 * started with `--host 127.0.0.1`), so match any non-slash host — an IP-only pattern
 * (`[\d.]+`) silently never matches `localhost` and hangs forever.
 */
async function readOrigin(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return "";
      buf += decoder.decode(value, { stream: true });
      const m = buf.match(/https?:\/\/[^/\s]+:\d+/);
      if (m) return m[0];
    }
  } finally {
    reader.releaseLock();
  }
}
