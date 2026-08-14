// Integration test for build-time asset precompression (precompress.ts) end to
// end: build a copy of examples/hello, serve it with the real prod server, and
// assert the client bundle is served gzip-compressed when negotiated — and
// identity when not.
//
// The app is copied to a sibling dir under examples/ (so its relative
// `../../mod.ts` imports still resolve) and built there, keeping its build output
// isolated from other tests that build examples/hello in the parallel suite.

import { assert, assertEquals } from "@std/assert";
import { copy } from "@std/fs";
import { join } from "@std/path";
import { build } from "../../src/build/build.ts";
import { startProdServer } from "../../src/build/prod-server.ts";

const SOURCE = new URL("../../examples/hello", import.meta.url).pathname;
const APP = new URL("../../examples/.hello-gz-test", import.meta.url).pathname;

Deno.test({
  name: "prod server serves a precompressed .gz client asset on gzip negotiation",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  await Deno.remove(APP, { recursive: true }).catch(() => {});
  await copy(SOURCE, APP, { overwrite: true });
  // Drop any copied-over build output so we measure a fresh build.
  await Deno.remove(join(APP, ".denext"), { recursive: true }).catch(() => {});

  const controller = new AbortController();
  let server: Deno.HttpServer | undefined;
  try {
    const { outDir } = await build(APP);
    const clientDir = join(outDir, "client");

    // The shared runtime chunk is the largest bundle and always exceeds the size
    // floor, so it must have a `.gz` sibling.
    let chunk: string | undefined;
    for await (const e of Deno.readDir(clientDir)) {
      if (e.isFile && /^chunk-.*\.js$/.test(e.name)) chunk = e.name;
    }
    assert(chunk, "expected a shared chunk-*.js in the client output");

    await t.step("build emitted a .gz sibling for the chunk", async () => {
      const gz = await Deno.stat(join(clientDir, `${chunk}.gz`));
      assert(gz.isFile && gz.size > 0, "chunk should have a non-empty .gz sibling");
    });

    const { promise, resolve } = Promise.withResolvers<{ hostname: string; port: number }>();
    server = await startProdServer({
      projectDir: APP,
      port: 0,
      hostname: "127.0.0.1",
      signal: controller.signal,
      onListen: (info) => resolve(info),
    });
    const { hostname, port } = await promise;
    const url = `http://${hostname}:${port}/_denext/client/${chunk}`;
    const identity = await Deno.readTextFile(join(clientDir, chunk!));

    await t.step("gzip is negotiated: Content-Encoding set, body intact", async () => {
      const res = await fetch(url, { headers: { "accept-encoding": "gzip" } });
      assertEquals(res.headers.get("content-encoding"), "gzip");
      assertEquals(res.headers.get("vary"), "Accept-Encoding");
      // Deno's fetch transparently gunzips, so the decoded text must equal source.
      assertEquals(await res.text(), identity);
    });

    await t.step("no gzip requested: identity is served", async () => {
      const res = await fetch(url, { headers: { "accept-encoding": "identity" } });
      assertEquals(res.headers.get("content-encoding"), null);
      assertEquals(await res.text(), identity);
    });
  } finally {
    controller.abort();
    await server?.finished;
    await Deno.remove(APP, { recursive: true }).catch(() => {});
  }
});
