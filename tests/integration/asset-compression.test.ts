// Integration test for build-time asset precompression (precompress.ts) end to
// end: build a copy of examples/hello, serve it with the real prod server, and
// assert the client bundle is served gzip-compressed when negotiated — and
// identity when not.
//
// The app SOURCE is copied to a sibling dir under examples/ (so its relative
// `../../mod.ts` imports still resolve) and built there, keeping its build output
// isolated from other tests that build examples/hello in the parallel suite. The
// copy skips the SOURCE's own `.denext`/`out` build dirs — `.denext` holds a live
// SQLite `cache.db` those parallel tests rotate, which otherwise races the copy.

import { assert, assertEquals } from "@std/assert";
import { copy } from "@std/fs";
import { join } from "@std/path";
import { build } from "../../src/build/build.ts";
import { startProdOrigin } from "../helpers/prod-origin.ts";

const SOURCE = new URL("../../examples/hello", import.meta.url).pathname;
const APP = new URL("../../examples/.hello-gz-test", import.meta.url).pathname;

type Ctx = { origin: string; url: string; identity: string };

async function copyAppSource(): Promise<void> {
  await Deno.remove(APP, { recursive: true }).catch(() => {});
  await Deno.mkdir(APP, { recursive: true });
  // Copy the app SOURCE but SKIP volatile build output (`.denext`/`out`): `.denext`
  // holds a live SQLite `cache.db` that other parallel tests building examples/hello
  // rotate mid-run, so copying that directory races (`NotFound` when a file vanishes
  // between enumerate and copy). We measure a fresh build below anyway, so the build
  // output is never needed here.
  const VOLATILE = new Set([".denext", "out", "node_modules"]);
  for await (const entry of Deno.readDir(SOURCE)) {
    if (VOLATILE.has(entry.name)) continue;
    await copy(join(SOURCE, entry.name), join(APP, entry.name), { overwrite: true });
  }
}

async function findSharedChunk(clientDir: string): Promise<string> {
  // The shared runtime chunk is the largest bundle and always exceeds the size
  // floor, so it must have a `.gz` sibling.
  let chunk: string | undefined;
  for await (const e of Deno.readDir(clientDir)) {
    if (e.isFile && /^chunk-.*\.js$/.test(e.name)) chunk = e.name;
  }
  assert(chunk, "expected a shared chunk-*.js in the client output");
  return chunk;
}

async function stepGzSibling(clientDir: string, chunk: string): Promise<void> {
  const gz = await Deno.stat(join(clientDir, `${chunk}.gz`));
  assert(gz.isFile && gz.size > 0, "chunk should have a non-empty .gz sibling");
}

async function stepGzipNegotiated(ctx: Ctx): Promise<void> {
  const res = await fetch(ctx.url, { headers: { "accept-encoding": "gzip" } });
  assertEquals(res.headers.get("content-encoding"), "gzip");
  assertEquals(res.headers.get("vary"), "Accept-Encoding");
  // Deno's fetch transparently gunzips, so the decoded text must equal source.
  assertEquals(await res.text(), ctx.identity);
}

async function stepIdentityServed(ctx: Ctx): Promise<void> {
  const res = await fetch(ctx.url, { headers: { "accept-encoding": "identity" } });
  assertEquals(res.headers.get("content-encoding"), null);
  assertEquals(await res.text(), ctx.identity);
}

async function stepHardeningHeaders(ctx: Ctx): Promise<void> {
  // Client assets, the health probe, and the image endpoint bypass createApp's
  // finalize(), so prod-server applies the defaults itself. Assert nosniff on the
  // client asset (its build-time Vary: Accept-Encoding must survive untouched)
  // and on the health probe.
  const asset = await fetch(ctx.url, { headers: { "accept-encoding": "gzip" } });
  assertEquals(asset.headers.get("x-content-type-options"), "nosniff");
  assertEquals(asset.headers.get("vary"), "Accept-Encoding"); // not clobbered
  await asset.body?.cancel();

  const health = await fetch(`${ctx.origin}/_denext/health`);
  assertEquals(health.headers.get("x-content-type-options"), "nosniff");
  assertEquals((await health.json()).status, "ok");
}

Deno.test({
  name: "prod server serves a precompressed .gz client asset on gzip negotiation",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  await copyAppSource();

  const controller = new AbortController();
  let server: Deno.HttpServer | undefined;
  try {
    const { outDir } = await build(APP);
    const clientDir = join(outDir, "client");
    const chunk = await findSharedChunk(clientDir);

    await t.step(
      "build emitted a .gz sibling for the chunk",
      () => stepGzSibling(clientDir, chunk),
    );

    const started = await startProdOrigin(APP, controller.signal);
    server = started.server;
    const ctx: Ctx = {
      origin: started.origin,
      url: `${started.origin}/_denext/client/${chunk}`,
      identity: await Deno.readTextFile(join(clientDir, chunk)),
    };

    await t.step(
      "gzip is negotiated: Content-Encoding set, body intact",
      () => stepGzipNegotiated(ctx),
    );

    await t.step("no gzip requested: identity is served", () => stepIdentityServed(ctx));

    await t.step(
      "L5: framework responses carry the default hardening headers",
      () => stepHardeningHeaders(ctx),
    );
  } finally {
    controller.abort();
    await server?.finished;
    await Deno.remove(APP, { recursive: true }).catch(() => {});
  }
});
