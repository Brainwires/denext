// A pinned download (src/build/deno-toolchain.ts `downloadPinned`) that hangs is given up on: no
// response headers within the connect deadline, or no body bytes for the idle deadline. Both
// deadlines come from the environment, so this file runs serially.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DenoToolchainDownloadError, downloadPinned } from "../src/build/deno-toolchain.ts";

const NAMES = {
  artifact: { file: "deno.zip", url: "https://toolchain.test/deno.zip", sha256: "0".repeat(64) },
  what: "Deno toolchain",
};

/** Run `fn` with the two deadlines set to 200 ms, restoring the environment after. */
async function withShortDeadlines(fn: (dest: string) => Promise<void>): Promise<void> {
  const keys = ["DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS", "DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS"];
  const saved = keys.map((k) => [k, Deno.env.get(k)] as const);
  for (const k of keys) Deno.env.set(k, "200");
  const dir = await Deno.makeTempDir({ prefix: "denext_dl_timeout_" });
  try {
    await fn(join(dir, "deno.zip"));
    assertEquals([...Deno.readDirSync(dir)], [], "nothing is left behind");
  } finally {
    for (const [k, v] of saved) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("downloadPinned: a server that never answers is given up on at the connect deadline", async () => {
  await withShortDeadlines(async (dest) => {
    // No response headers, ever (a half-open connection): only the abort ends it.
    const silent: typeof fetch = (_url, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
      );
    const err = await assertRejects(
      () => downloadPinned(NAMES, dest, silent, () => {}),
      DenoToolchainDownloadError,
    );
    assertStringIncludes(err.message, "no response within 0.2 s");
    assertStringIncludes(err.message, "DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS");
  });
});

Deno.test("downloadPinned: a body that stops sending is given up on at the idle deadline", async () => {
  await withShortDeadlines(async (dest) => {
    // Headers and a first chunk, then nothing.
    const stalls: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array([1, 2, 3]));
            },
          }),
        ),
      );
    const err = await assertRejects(
      () => downloadPinned(NAMES, dest, stalls, () => {}),
      DenoToolchainDownloadError,
    );
    assertStringIncludes(err.message, "no data for 0.2 s");
    assertStringIncludes(err.message, "DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS");
  });
});
