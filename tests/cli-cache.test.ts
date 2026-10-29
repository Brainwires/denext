// The remote CLI's module cache (src/cli/cli-cache.ts): `cacheCliModules` runs `deno cache` in the
// foreground and records a marker, `warmCliModules` does it once per version in a detached child.
// The URLs are tiny modules a loopback server in the test serves (a missing one is a 404); the
// markers go to a scratch cache directory, and `deno cache` runs without the project's config and
// lock, so the test never writes this repository's deno.lock.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { exited, spawnsOf } from "./helpers/spawns.ts";
import {
  cacheCliModules,
  type CliCacheOptions,
  isRemoteCli,
  warmCliModules,
} from "../src/cli/cli-cache.ts";

/** The scratch cache directory, and `deno cache` kept off the project's config and lock. */
const scratch = (cacheDir: string): CliCacheOptions => ({
  cacheDir,
  configArgs: ["--no-config", "--no-lock"],
});

/** This repository's lockfile (the test must leave it as it found it). */
const LOCK = new URL("../deno.lock", import.meta.url);

/** A loopback server for tiny modules; `url(tag)` is a module of its own per tag. */
function moduleServer() {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (req) => {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/missing/")) return new Response("not found", { status: 404 });
      return new Response(`export const tag = ${JSON.stringify(path)};\n`, {
        headers: { "content-type": "application/typescript" },
      });
    },
  );
  const { port } = server.addr as Deno.NetAddr;
  return {
    url: (tag: string) => `http://127.0.0.1:${port}/${tag}-${crypto.randomUUID()}.ts`,
    /** A module the server doesn't have: `deno cache` fails on the 404 at once. */
    missing: () => `http://127.0.0.1:${port}/missing/${crypto.randomUUID()}.ts`,
    close: () => server.shutdown(),
  };
}

/** The marker files under `<cacheDir>/denext-cli/`. */
function markers(cacheDir: string): string[] {
  try {
    return [...Deno.readDirSync(join(cacheDir, "denext-cli"))].map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** Poll until `fn` holds (the detached child runs on its own schedule), or fail after `ms`. */
async function until(fn: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test("cli cache: a checkout and a compiled binary are not remote; a URL is", () => {
  assertEquals(isRemoteCli("file:///repo/src/cli/lazy-modules.generated.ts"), false);
  assertEquals(isRemoteCli("https://jsr.io/@denext/denext/4.5.0/src/cli/x.ts"), true);
  // This test process is a checkout run, so the default URL is not remote.
  assertEquals(isRemoteCli(), false);
});

Deno.test("cli cache: nothing to do for a checkout (no cache, no marker)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-cli-cache-" });
  try {
    assertEquals(await cacheCliModules("file:///repo/x.ts", scratch(dir)), true);
    await warmCliModules("file:///repo/x.ts", scratch(dir));
    assertEquals(markers(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cli cache: cacheCliModules caches a remote graph and records it; a failure records nothing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-cli-cache-" });
  const modules = moduleServer();
  const lock = await Deno.readTextFile(LOCK);
  try {
    assertEquals(await cacheCliModules(modules.url("fg"), scratch(dir)), true);
    const [marker] = markers(dir);
    assert(marker?.endsWith(".cached"), `marker: ${marker}`);
    assert(!Number.isNaN(Date.parse(Deno.readTextFileSync(join(dir, "denext-cli", marker)))));
    // A module the server doesn't have: `deno cache` fails, no marker is written.
    assertEquals(
      await cacheCliModules(modules.missing(), { ...scratch(dir), log: () => {} }),
      false,
    );
    assertEquals(markers(dir), [marker]);
    // Off the project's config: the repository's lockfile did not gain the modules.
    assertEquals(await Deno.readTextFile(LOCK), lock);
  } finally {
    await modules.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cli cache: warmCliModules caches once in a detached child, then stays quiet", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-cli-cache-" });
  const modules = moduleServer();
  const url = modules.url("bg");
  try {
    const warm = await spawnsOf(() => warmCliModules(url, scratch(dir)));
    // The attempt is recorded at once; the marker when the background cache succeeded.
    const attempt = markers(dir).find((m) => m.endsWith(".cached.attempt"));
    assert(attempt, `markers: ${markers(dir)}`);
    await until(() => markers(dir).some((m) => m.endsWith(".cached")));
    // The detached child writes the marker, then exits: wait for that too (it is unref'd).
    await exited(warm);
    // A cached version is never warmed again: the attempt marker is not rewritten.
    const before = Deno.statSync(join(dir, "denext-cli", attempt)).mtime?.getTime();
    await new Promise((r) => setTimeout(r, 20));
    await warmCliModules(url, scratch(dir));
    assertEquals(Deno.statSync(join(dir, "denext-cli", attempt)).mtime?.getTime(), before);
  } finally {
    await modules.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cli cache: a recent failed attempt is not retried; a warm-up that can't start is silent", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-cli-cache-" });
  const modules = moduleServer();
  try {
    const url = modules.missing();
    const warm = await spawnsOf(() => warmCliModules(url, scratch(dir)));
    assertEquals(warm.length, 1, "one detached warm-up");
    // Its `deno cache` fails on the 404 at once: wait for it to go (it is unref'd, so ref it).
    await exited(warm);
    const [attempt] = markers(dir);
    assert(attempt?.endsWith(".cached.attempt"), `markers: ${markers(dir)}`);
    const stamp = Deno.readTextFileSync(join(dir, "denext-cli", attempt));
    await new Promise((r) => setTimeout(r, 20));
    await warmCliModules(url, scratch(dir)); // within the retry window: nothing new
    assertEquals(Deno.readTextFileSync(join(dir, "denext-cli", attempt)), stamp);
    // A cache directory that can't be created (a file is in the way): no throw, nothing written.
    const blocked = join(dir, "blocked");
    Deno.writeTextFileSync(blocked, "");
    await warmCliModules("https://example.invalid/blocked.ts", scratch(blocked));
    assertEquals(Deno.statSync(blocked).isFile, true);
  } finally {
    await modules.close();
    await Deno.remove(dir, { recursive: true });
  }
});

/** A TCP listener that accepts every connection, reads the request and never answers. */
function silentServer() {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const conns: Deno.Conn[] = [];
  const accepting = (async () => {
    for await (const conn of listener) {
      conns.push(conn);
      conn.read(new Uint8Array(4096)).catch(() => {});
    }
  })();
  const { port } = listener.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${port}/stalled-${crypto.randomUUID()}.ts`,
    close: async () => {
      listener.close();
      for (const c of conns) {
        try {
          c.close();
        } catch { /* closed already */ }
      }
      await accepting.catch(() => {});
    },
  };
}

/** `p`, or a rejection after `ms` (a hang fails the test instead of the run). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

Deno.test("cli cache: a stalled `deno cache` is stopped at its deadline and says so", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-cli-cache-" });
  const server = silentServer();
  try {
    const lines: string[] = [];
    const ok = await within(
      cacheCliModules(server.url, {
        ...scratch(dir),
        deadlineMs: 1_500,
        log: (l) => lines.push(l),
      }),
      30_000,
    );
    assertEquals(ok, false);
    assertEquals(markers(dir), []);
    assertEquals(lines.length, 1);
    assertStringIncludes(lines[0], "still running after 1.5 s and was stopped");
    assertStringIncludes(lines[0], "DENEXT_CHILD_DEADLINE_MS");
  } finally {
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cli cache: a failed `deno cache` reports its exit code and what it printed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-cli-cache-" });
  const modules = moduleServer();
  try {
    const lines: string[] = [];
    const missing = modules.missing();
    assertEquals(
      await cacheCliModules(missing, { ...scratch(dir), log: (l) => lines.push(l) }),
      false,
    );
    assertEquals(lines.length, 1);
    assertStringIncludes(lines[0], "`deno cache` exited with code 1; it printed:");
    assertStringIncludes(lines[0], new URL(missing).pathname);
  } finally {
    await modules.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cli cache: a background warm-up that failed leaves its stderr, reported once on the retry", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-cli-cache-" });
  const modules = moduleServer();
  try {
    const url = modules.missing();
    const lines: string[] = [];
    const options = { ...scratch(dir), log: (l: string) => lines.push(l) };
    await warmCliModules(url, options);
    await until(() => markers(dir).some((m) => m.endsWith(".cached.log")));
    const log = markers(dir).find((m) => m.endsWith(".cached.log"))!;
    const saved = JSON.parse(Deno.readTextFileSync(join(dir, "denext-cli", log)));
    assertEquals([saved.code, saved.timedOut], [1, false]);
    assertStringIncludes(saved.stderr, new URL(url).pathname);
    assertEquals(lines, [], "nothing is printed while the retry window is open");
    // Past the retry window: the next run reports the failure once, and tries again.
    const attempt = join(dir, "denext-cli", log.replace(/\.log$/, ".attempt"));
    const old = new Date(Date.now() - 3_600_000);
    Deno.utimeSync(attempt, old, old);
    await warmCliModules(url, options);
    assertEquals(lines.length, 1);
    assertStringIncludes(lines[0], "in the background failed last time");
    assertStringIncludes(lines[0], "exited with code 1");
    // The retry fails the same way; wait for it, so nothing runs past the test.
    await until(() => markers(dir).some((m) => m.endsWith(".cached.log")));
  } finally {
    await modules.close();
    await Deno.remove(dir, { recursive: true });
  }
});
