// Smoke test for examples/image: build it and serve it with the real prod server,
// then exercise the image optimizer end to end — a successful WebP re-encode, the
// width-allowlist rejection, the page's generated srcSet, and the dynamic OG image.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { build } from "../../src/build/build.ts";
import { startProdOrigin } from "../helpers/prod-origin.ts";

const APP = new URL("../../examples/image", import.meta.url).pathname;

// `next/og` renders through denext's first-party `@denext/og` codec (a workspace member
// locally, JSR when published). The OG step self-skips when it can't be resolved.
let ogAvailable = false;
try {
  await import("@denext/og");
  ogAvailable = true;
} catch { /* @denext/og unresolvable — OG step self-skips */ }

async function optimizerReencodesToWebp(origin: string) {
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
}

async function disallowedWidthIsRefused(origin: string) {
  const res = await fetch(
    `${origin}/_denext/image?url=${encodeURIComponent("/photo.png")}&w=4001`,
  );
  assertEquals(res.status, 400);
  assertStringIncludes((await res.text()).toLowerCase(), "not allowed");
}

async function pageRendersOptimizerSrcSet(origin: string) {
  const res = await fetch(`${origin}/`);
  const html = await res.text();
  assertEquals(res.status, 200);
  assertStringIncludes(html, "/_denext/image?url=");
  assertStringIncludes(html, "srcset=");
  assertStringIncludes(html, "128w");
}

async function ogImageRendersPng(origin: string) {
  const res = await fetch(`${origin}/opengraph-image`);
  assertEquals(res.status, 200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // PNG magic number.
  assertEquals(Array.from(bytes.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
}

Deno.test({
  name: "examples/image: optimizer, width allowlist, srcSet, and OG image",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const controller = new AbortController();
  let server: Deno.HttpServer | undefined;
  try {
    await build(APP);
    const started = await startProdOrigin(APP, controller.signal);
    server = started.server;
    const { origin } = started;

    await t.step(
      "optimizer resizes + re-encodes a local PNG to WebP",
      () => optimizerReencodesToWebp(origin),
    );

    await t.step(
      "a width outside the allowlist is refused (400)",
      () => disallowedWidthIsRefused(origin),
    );

    await t.step(
      "the page renders <img> pointing at the optimizer with a srcSet",
      () => pageRendersOptimizerSrcSet(origin),
    );

    await t.step({
      name: "the dynamic OG image renders to a PNG",
      ignore: !ogAvailable, // opt-in `@cf-wasm/og` peer codec
      fn: () => ogImageRendersPng(origin),
    });
  } finally {
    controller.abort();
    await server?.finished;
  }
});
