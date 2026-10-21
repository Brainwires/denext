// The remote CLI's module cache (src/cli/cli-cache.ts): `cacheCliModules` runs `deno cache` in the
// foreground and records a marker, `warmCliModules` does it once per version in a detached child.
// The URLs are tiny modules a loopback server in the test serves (a missing one is a 404); the
// markers go to a scratch cache directory, and `deno cache` runs without the project's config and
// lock, so the test never writes this repository's deno.lock.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
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
    assertEquals(await cacheCliModules(modules.missing(), scratch(dir)), false);
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
    await warmCliModules(url, scratch(dir));
    // The attempt is recorded at once; the marker when the background cache succeeded.
    const attempt = markers(dir).find((m) => m.endsWith(".cached.attempt"));
    assert(attempt, `markers: ${markers(dir)}`);
    await until(() => markers(dir).some((m) => m.endsWith(".cached")));
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
    await warmCliModules(url, scratch(dir));
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
