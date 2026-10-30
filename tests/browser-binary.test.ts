// The browser the E2E harness and `denext profile` launch (src/profile/browser-binary.ts): fetched
// with denext's download deadlines and retries into astral's cache layout, so a stalled connection
// is retried on a new one rather than holding the launch until the server drops it. Nothing here
// reaches the network: a stand-in server plays Chrome for Testing.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { SUPPORTED_VERSIONS } from "@astral/astral";
import { chromePlatform, ensureBrowserBinary } from "../src/profile/browser-binary.ts";
import { downloadDeadlines } from "../src/build/verified-download.ts";
import { zip } from "./_archive-fixtures.ts";
import { standIn } from "./helpers/download-stand-in.ts";

const VERSION = SUPPORTED_VERSIONS.chrome;
const LINUX = { os: "linux", arch: "x86_64" };
/** Short deadlines, so a stall is given up on in a fraction of a second. */
const QUICK = { ...downloadDeadlines(() => undefined), connectMs: 300, idleMs: 300 };
/**
 * For a download that must stall once and then succeed: the stall is given up on at the 1 s idle
 * deadline, and the attempt that answers has 5 s for its headers and 1 s between chunks — room
 * for a loaded machine's scheduling stalls, where 300 ms was not.
 */
const STALL_ONCE = { ...QUICK, connectMs: 5_000, idleMs: 1_000 };
const NO_ENV = () => undefined;

/** A Chrome for Testing linux64 archive holding a stand-in executable. */
async function chromeZip(): Promise<Uint8Array> {
  return await zip([
    { name: "chrome-linux64/chrome", data: "#!/bin/sh\n", unixMode: 0o100755, deflate: true },
  ]);
}

/** Run `fn` with a fresh cache directory, removed after. */
async function withCache(fn: (cache: string) => Promise<void>): Promise<void> {
  const cache = await Deno.makeTempDir({ prefix: "denext_browser_bin_" });
  try {
    await fn(cache);
  } finally {
    await Deno.remove(cache, { recursive: true });
  }
}

Deno.test("browser binary: a download that stalls mid-body is retried on a new connection", async () => {
  const body = await chromeZip();
  const server = standIn(body, (n) => n === 0 ? "stall-mid-body" : "answer");
  try {
    await withCache(async (cache) => {
      const lines: string[] = [];
      const path = await ensureBrowserBinary({
        cache,
        baseUrl: server.origin,
        deadlines: STALL_ONCE,
        host: LINUX,
        env: NO_ENV,
        log: (l) => lines.push(l),
      });
      assertEquals(path, join(cache, VERSION, "chrome-linux64", "chrome"));
      assertEquals(await Deno.readTextFile(path!), "#!/bin/sh\n");
      assertEquals(server.connections(), 2, "the retry used a new connection");
      assertEquals(lines.length, 1);
      assertStringIncludes(lines[0], "no data for 1 s");
      assertStringIncludes(lines[0], "retrying on a new connection (attempt 2 of 4)");
      // Recorded where astral looks, and nothing left beside it.
      const config = JSON.parse(await Deno.readTextFile(join(cache, "cache.json")));
      assertEquals(config, { [VERSION]: join(cache, VERSION) });
      const left = [];
      for await (const e of Deno.readDir(cache)) left.push(e.name);
      assertEquals(left.sort(), [".denext-browser.lock", VERSION, "cache.json"].sort());
      // Found in the cache from then on: no further request.
      assertEquals(
        await ensureBrowserBinary({ cache, baseUrl: server.origin, host: LINUX, env: NO_ENV }),
        path,
      );
      assertEquals(server.connections(), 2);
    });
  } finally {
    await server.close();
  }
});

Deno.test("browser binary: a server that never answers fails with every attempt, leaving nothing", async () => {
  const server = standIn(await chromeZip(), () => "silent");
  try {
    await withCache(async (cache) => {
      const err = await assertRejects(() =>
        ensureBrowserBinary({
          cache,
          baseUrl: server.origin,
          deadlines: { ...QUICK, attempts: 2 },
          host: LINUX,
          env: NO_ENV,
          log: () => {},
        })
      );
      assertStringIncludes((err as Error).message, `could not download Chrome for Testing`);
      assertStringIncludes((err as Error).message, "no response within 0.3 s");
      assertEquals(server.connections(), 2);
      const left = [];
      for await (const e of Deno.readDir(cache)) left.push(e.name);
      assertEquals(left, [".denext-browser.lock"], "no archive, staging folder or cache entry");
    });
  } finally {
    await server.close();
  }
});

Deno.test("browser binary: astral's own cache and ASTRAL_BIN_PATH are used as they are", async () => {
  await withCache(async (cache) => {
    const folder = join(cache, VERSION);
    await Deno.mkdir(join(folder, "chrome-linux64"), { recursive: true });
    await Deno.writeTextFile(join(folder, "chrome-linux64", "chrome"), "");
    await Deno.writeTextFile(join(cache, "cache.json"), JSON.stringify({ [VERSION]: folder }));
    const refuse = () => Promise.reject(new Error("no download expected"));
    assertEquals(
      await ensureBrowserBinary({ cache, fetch: refuse, host: LINUX, env: NO_ENV }),
      join(folder, "chrome-linux64", "chrome"),
    );
    assertEquals(
      await ensureBrowserBinary({
        cache,
        fetch: refuse,
        host: LINUX,
        env: (n) => n === "ASTRAL_BIN_PATH" ? "/opt/chrome" : undefined,
      }),
      null,
      "astral launches the named browser",
    );
  });
});

Deno.test("browser binary: Chrome for Testing's platform for each host", () => {
  assertEquals(chromePlatform({ os: "linux", arch: "x86_64" })?.platform, "linux64");
  assertEquals(chromePlatform({ os: "darwin", arch: "aarch64" })?.platform, "mac-arm64");
  assertEquals(chromePlatform({ os: "darwin", arch: "x86_64" })?.platform, "mac-x64");
  assertEquals(
    chromePlatform({ os: "windows", arch: "x86_64" })?.executable,
    join(
      "chrome-win64",
      "chrome.exe",
    ),
  );
  assertEquals(chromePlatform({ os: "linux", arch: "aarch64" }), null, "no linux arm64 build");
});
