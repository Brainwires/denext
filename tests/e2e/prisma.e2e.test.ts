// Networked e2e for examples/prisma: proves Prisma ORM runs on denext over the
// better-sqlite3 compat (Deno's built-in node:sqlite — Rust-free, no native addon),
// end to end. It runs the example's real setup (bundle the compat into the `links`
// package → install → `prisma generate` → `prisma db push`), builds + serves via the
// CLI, then drives a live read + Server-Action write.
//
// Opt-in + NETWORK+CODEGEN-REQUIRED (installs @prisma/* and runs the prisma CLI):
// `deno task test:e2e`. Skipped automatically if setup can't complete (offline).
// Heavier than the other e2es — it runs Prisma's code generator.

import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const EXAMPLE = fromFileUrl(new URL("../../examples/prisma", import.meta.url));
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));
const DENO = Deno.execPath();

// Bounded waits so a wedged step fails fast with a diagnostic instead of hanging the suite.
// Setup is the heaviest (install + prisma generate + db push over the network).
const SETUP_TIMEOUT_MS = 240_000;
const BUILD_TIMEOUT_MS = 180_000;
const READY_TIMEOUT_MS = 60_000;

async function run(
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; out: string }> {
  try {
    const cmd = new Deno.Command(DENO, {
      args,
      cwd: EXAMPLE,
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
    return {
      ok: false,
      out: `\`deno ${args.join(" ")}\` did not finish within ${timeoutMs}ms: ${e}`,
    };
  }
}

Deno.test({
  name: "e2e: examples/prisma runs Prisma ORM over the better-sqlite3 compat",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  // Start from a fresh database so the seeded rows are deterministic.
  try {
    await Deno.remove(join(EXAMPLE, "prisma", "dev.db"));
  } catch { /* absent */ }

  // 1. Full setup: bundle the compat shim, install, prisma generate, prisma db push.
  const setup = await run(["task", "setup"], SETUP_TIMEOUT_MS);
  if (!setup.ok) {
    console.warn(
      "e2e: `deno task setup` failed (offline / npm unreachable?) — skipping.\n" + setup.out,
    );
    return;
  }

  // 2. Build for production via the real CLI (exercises the module re-exec).
  await t.step("build", async () => {
    const built = await run(["run", "-A", CLI, "build", "."], BUILD_TIMEOUT_MS);
    assert(built.ok, "denext build failed:\n" + built.out);
  });

  // 3. Start the prod server on an ephemeral port; parse the bound port.
  const server = new Deno.Command(DENO, {
    args: ["run", "-A", CLI, "start", ".", "--host", "127.0.0.1", "--port", "0"],
    cwd: EXAMPLE,
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Drain stderr concurrently so a startup crash is captured for the failure message.
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
    // Hard-bound the readiness wait: a `reader.cancel()` timer can't unblock a pending read
    // while the re-exec'd child holds the inherited stdout pipe, so race against a deadline.
    origin = await Promise.race([
      readOrigin(server.stdout),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), READY_TIMEOUT_MS)),
    ]);
    assert(
      origin,
      `server never printed its listen URL within ${READY_TIMEOUT_MS}ms` +
        (stderrBuf ? `\nserver stderr:\n${stderrBuf}` : ""),
    );

    await t.step("read path: Prisma query renders seeded rows", async () => {
      const html = await (await fetch(origin + "/")).text();
      assertStringIncludes(html, "Prisma runs on denext");
      assertStringIncludes(html, "node:sqlite");
    });

    await t.step("write path: Server Action inserts through Prisma", async () => {
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
    // Kill the whole tree (parent + the re-exec'd grandchild that binds the port and holds
    // the SQLite file) so the test never leaves an orphan.
    await killTree(server.pid);
    try {
      await server.status;
    } catch { /* already reaped */ }
    await stderrPump.catch(() => {});
  }
});

/**
 * Read the child's stdout until the "denext start ▸ http://host:port" line. The host may be
 * `localhost` OR an IP (the CLI prints `http://localhost:PORT` even with `--host 127.0.0.1`),
 * so match any non-slash host — an IP-only pattern silently never matches and hangs forever.
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
