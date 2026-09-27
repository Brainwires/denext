// Response compression on the SPA prod server (`denext start` in `mode: "spa"` — the path
// Capacitor/mobile and T3 serve through): the HTML shell and uncompressed `public/` files are
// encoded per `Accept-Encoding`, precompressed client bundles are served as built, and
// `compress: false` turns it off. Deno's fetch() decodes bodies transparently but keeps the
// `Content-Encoding` header, so each check asserts the header and the decoded content.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startSpaProdServer } from "../src/build/spa.ts";

const SHELL = `<!doctype html><html><head><title>spa</title></head><body>` +
  `<div id="root">${"<p>boot placeholder row</p>".repeat(100)}</div>` +
  `<script type="module" src="/_denext/client/index.js"></script></body></html>`;
const BUNDLE = `console.log(${JSON.stringify("x".repeat(4096))});`;
const DATA = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ i })) });

/** A fake built SPA project (config + shell + client bundle with a .gz sibling + public/). */
async function spaProject(config: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_compress_" });
  await Deno.writeTextFile(join(dir, "denext.config.ts"), `export default ${config};\n`);
  const client = join(dir, ".denext", "client");
  await Deno.mkdir(client, { recursive: true });
  await Deno.mkdir(join(dir, "public"));
  await Deno.writeTextFile(join(client, "index.html"), SHELL);
  await Deno.writeTextFile(join(client, "index.js"), BUNDLE);
  const gz = await new Response(
    new Blob([BUNDLE]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  await Deno.writeFile(join(client, "index.js.gz"), new Uint8Array(gz));
  await Deno.writeTextFile(join(dir, "public", "data.json"), DATA);
  await Deno.writeFile(join(dir, "public", "pixel.png"), new Uint8Array(4096));
  return dir;
}

/** Start the SPA prod server for `dir` on an ephemeral port; run `fn`; always shut down. */
async function withServer(dir: string, fn: (origin: string) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const { promise, resolve } = Promise.withResolvers<{ hostname: string; port: number }>();
  const server = await startSpaProdServer({
    projectDir: dir,
    port: 0,
    hostname: "127.0.0.1",
    signal: controller.signal,
    onListen: resolve,
  });
  const { hostname, port } = await promise;
  try {
    await fn(`http://${hostname}:${port}`);
  } finally {
    controller.abort();
    await server.finished;
    await Deno.remove(dir, { recursive: true });
  }
}

const get = (url: string, encoding: string) =>
  fetch(url, { headers: { "accept-encoding": encoding, accept: "text/html" } });

Deno.test("SPA prod server: the shell, public files and bundles under compression", async () => {
  const dir = await spaProject(`{ mode: "spa", spa: { entry: "./main.tsx" } }`);
  await withServer(dir, async (origin) => {
    const br = await get(origin + "/deep/link", "gzip, br");
    assertEquals(br.headers.get("content-encoding"), "br", "the history-fallback shell");
    assertStringIncludes(br.headers.get("vary") ?? "", "Accept-Encoding");
    assertEquals(br.headers.get("x-content-type-options"), "nosniff", "hardening kept");
    assertEquals(await br.text(), SHELL);

    const gz = await get(origin + "/", "gzip");
    assertEquals(gz.headers.get("content-encoding"), "gzip");
    assertEquals(await gz.text(), SHELL);

    const identity = await get(origin + "/", "identity");
    assertEquals(identity.headers.get("content-encoding"), null);
    assertEquals(await identity.text(), SHELL);

    const json = await get(origin + "/data.json", "gzip");
    assertEquals(json.headers.get("content-encoding"), "gzip", "a public/ file with no .gz");
    assertEquals(json.headers.get("content-length"), null);
    assertEquals(await json.text(), DATA);

    const png = await get(origin + "/pixel.png", "gzip, br");
    assertEquals(png.headers.get("content-encoding"), null, "images are not re-encoded");
    await png.body?.cancel();

    // The precompressed bundle is the build's .gz sibling, never re-encoded (brotli is
    // preferred by the header, but the stored gzip goes out as-is).
    const js = await get(origin + "/_denext/client/index.js", "gzip, br");
    assertEquals(js.headers.get("content-encoding"), "gzip");
    assertEquals(await js.text(), BUNDLE);

    const head = await fetch(origin + "/", { method: "HEAD", headers: { accept: "text/html" } });
    assertEquals(head.headers.get("content-encoding"), null, "HEAD is never encoded");
    await head.body?.cancel();
  });
});

Deno.test("SPA prod server: compress:false serves identity", async () => {
  const dir = await spaProject(`{ mode: "spa", spa: { entry: "./main.tsx" }, compress: false }`);
  await withServer(dir, async (origin) => {
    const shell = await get(origin + "/", "gzip, br");
    assertEquals(shell.headers.get("content-encoding"), null);
    assert(!(shell.headers.get("vary") ?? "").includes("Accept-Encoding"));
    assertEquals(await shell.text(), SHELL);
    const json = await get(origin + "/data.json", "gzip");
    assertEquals(json.headers.get("content-encoding"), null);
    assertEquals(await json.text(), DATA);
  });
});
