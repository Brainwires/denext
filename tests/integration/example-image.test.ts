// Smoke test for examples/image: build it and serve it with the real prod server,
// then exercise the image optimizer end to end — a successful WebP re-encode, the
// width-allowlist rejection, the page's generated srcSet, and the dynamic OG image.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { build } from "../../src/build/build.ts";
import { startProdServer } from "../../src/build/prod-server.ts";

const APP = new URL("../../examples/image", import.meta.url).pathname;

// `next/og` uses the optional `@cf-wasm/og` peer codec (not bundled — keeps the
// runtime zero-npm). The OG step self-skips when it isn't in the import map.
let ogAvailable = false;
try {
  const spec = "@cf-wasm/og";
  await import(spec);
  ogAvailable = true;
} catch { /* peer codec absent — OG step self-skips */ }

Deno.test({
  name: "examples/image: optimizer, width allowlist, srcSet, and OG image",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const controller = new AbortController();
  let server: Deno.HttpServer | undefined;
  try {
    await build(APP);

    const { promise, resolve } = Promise.withResolvers<
      { hostname: string; port: number }
    >();
    server = await startProdServer({
      projectDir: APP,
      port: 0,
      hostname: "127.0.0.1",
      signal: controller.signal,
      onListen: (info) => resolve(info),
    });
    const { hostname, port } = await promise;
    const origin = `http://${hostname}:${port}`;

    await t.step(
      "optimizer resizes + re-encodes a local PNG to WebP",
      async () => {
        const res = await fetch(
          `${origin}/_denext/image?url=${encodeURIComponent("/photo.png")}&w=128&q=80`,
        );
        assertEquals(res.status, 200);
        assertStringIncludes(
          res.headers.get("content-type") ?? "",
          "image/webp",
        );
        const bytes = new Uint8Array(await res.arrayBuffer());
        assert(bytes.length > 0, "a non-empty optimized image is returned");
        // WebP files begin with "RIFF"...."WEBP".
        const tag = new TextDecoder().decode(bytes.slice(0, 4));
        assertEquals(tag, "RIFF");
        assertEquals(new TextDecoder().decode(bytes.slice(8, 12)), "WEBP");
      },
    );

    await t.step("a width outside the allowlist is refused (400)", async () => {
      const res = await fetch(
        `${origin}/_denext/image?url=${encodeURIComponent("/photo.png")}&w=4001`,
      );
      assertEquals(res.status, 400);
      assertStringIncludes((await res.text()).toLowerCase(), "not allowed");
    });

    await t.step(
      "the page renders <img> pointing at the optimizer with a srcSet",
      async () => {
        const res = await fetch(`${origin}/`);
        const html = await res.text();
        assertEquals(res.status, 200);
        assertStringIncludes(html, "/_denext/image?url=");
        assertStringIncludes(html, "srcset=");
        assertStringIncludes(html, "128w");
      },
    );

    await t.step({
      name: "the dynamic OG image renders to a PNG",
      ignore: !ogAvailable, // opt-in `@cf-wasm/og` peer codec
      fn: async () => {
        const res = await fetch(`${origin}/opengraph-image`);
        assertEquals(res.status, 200);
        const bytes = new Uint8Array(await res.arrayBuffer());
        // PNG magic number.
        assertEquals(Array.from(bytes.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
      },
    });
  } finally {
    controller.abort();
    await server?.finished;
  }
});
