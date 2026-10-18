// @denext/openapi `ui: "scalar"`: Scalar's standalone bundle is vendored (the pinned upstream
// bytes, held to the SHA-256 recorded in `scalar-ui.ts`, with Scalar's MIT licence beside it),
// served from the app's own origin under a content-addressed, year-long immutable URL, and the
// page's CSP names no other origin: the bundle is `'self'` and the inline start-up script is
// admitted by its hash. An explicit `cdn` still opts back into a CDN. The browser half (zero
// third-party requests while Scalar renders) is tests/e2e/openapi-scalar.e2e.test.ts.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";
import type { DenextConfig } from "../src/server/config.ts";
import { applyPlugins, getPluginRequestHandler, resetPlugins } from "../src/plugin/mod.ts";
import {
  DOCS_CDN,
  docsCsp,
  openapi,
  type OpenApiDocument,
  type OpenApiOptions,
  readScalarBundle,
  renderDocsHtml,
  SCALAR_ASSET,
  SCALAR_BOOT,
  SCALAR_BOOT_HASH,
  SCALAR_BUNDLE_NAME,
  SCALAR_VERSION,
} from "../packages/openapi/mod.ts";
import { readVerified } from "../packages/openapi/vendored.ts";

const VENDOR = new URL("../packages/openapi/vendor/scalar/", import.meta.url);
const doc: OpenApiDocument = {
  openapi: "3.1.0",
  info: { title: "<Pets>", version: "1" },
  paths: {},
  components: { schemas: {} },
};

Deno.test("scalar: the vendored bundle is the pinned upstream bytes, with its licence", async () => {
  assertEquals(SCALAR_VERSION, "1.72.4");
  const bytes = await Deno.readFile(new URL(SCALAR_ASSET.file, VENDOR));
  assertEquals(bytes.byteLength, SCALAR_ASSET.bytes);
  assertEquals(encodeHex(await crypto.subtle.digest("SHA-256", bytes)), SCALAR_ASSET.sha256);
  assertEquals(await readScalarBundle(), bytes);
  assertEquals(SCALAR_BUNDLE_NAME, `standalone.${SCALAR_ASSET.sha256.slice(0, 16)}.js`);
  const license = await Deno.readTextFile(new URL("LICENSE", VENDOR));
  assert(license.startsWith("MIT License"), "Scalar's MIT licence ships beside the bundle");
  assertStringIncludes(license, "Scalar");
  assertStringIncludes(await Deno.readTextFile(new URL("NOTICE", VENDOR)), "1.72.4");
  // Every vendored file is published with the package.
  const published = JSON.parse(
    await Deno.readTextFile(new URL("../packages/openapi/deno.json", import.meta.url)),
  ).publish.include as string[];
  for (const f of ["scalar-ui.ts", "vendored.ts", "vendor/scalar/standalone.js"]) {
    assert(published.includes(f), `${f} is in publish.include`);
  }
  assert(published.includes("vendor/scalar/LICENSE") && published.includes("vendor/scalar/NOTICE"));
});

Deno.test("scalar: bytes that differ from the recorded digest are refused, then retried", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_scalar_vendor_" });
  try {
    const file = join(dir, "standalone.js");
    await Deno.writeTextFile(file, "tampered");
    const url = new URL(`file://${file}`);
    const asset = { ...SCALAR_ASSET, bytes: 8 };
    await assertRejects(() => readVerified(url, asset, "test"), Error, "refusing to serve it");
    // A failed read is not cached: the right bytes are accepted on the next try.
    await Deno.writeTextFile(file, "original");
    const sha256 = encodeHex(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("original")),
    );
    assertEquals(
      new TextDecoder().decode(await readVerified(url, { ...asset, sha256 }, "test")),
      "original",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scalar: the boot hash is the hash of the boot script, which calls no Scalar service", async () => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SCALAR_BOOT));
  assertEquals(SCALAR_BOOT_HASH, `'sha256-${encodeBase64(digest)}'`);
  for (const off of ["withDefaultFonts:false", "telemetry:false", "agent:{disabled:true}"]) {
    assertStringIncludes(SCALAR_BOOT, off);
  }
  assert(!/https?:/.test(SCALAR_BOOT));
});

Deno.test("scalar: the page loads only same-origin files, and its CSP names no other origin", () => {
  const html = renderDocsHtml(doc, {
    ui: "scalar",
    specUrl: "/app/openapi.json",
    assetBase: "/app/docs/scalar",
  });
  assert(!/https?:\/\//.test(html), "no absolute URL");
  assertStringIncludes(html, "&#60;Pets&#62;");
  assertStringIncludes(html, `<script src="/app/docs/scalar/${SCALAR_BUNDLE_NAME}"></script>`);
  assertStringIncludes(html, `<script>${SCALAR_BOOT}</script>`);
  assertStringIncludes(html, 'id="scalar-docs" data-url="/app/openapi.json"');

  const csp = docsCsp("scalar");
  assert(!/https?:|\*/.test(csp), csp);
  assertStringIncludes(csp, `script-src 'self' ${SCALAR_BOOT_HASH};`);
  assert(!/script-src[^;]*'unsafe-(inline|eval)'/.test(csp), csp);
  assertStringIncludes(csp, "connect-src 'self';");
  assertStringIncludes(csp, "frame-ancestors 'none'");
  // "Try it" may call the document's absolute servers (their origins only, canonicalized);
  // relative or templated server URLs add nothing.
  assertStringIncludes(
    docsCsp("scalar", undefined, {
      connect: [
        "https://api.example.com/v1",
        "https://api.example.com/v2",
        "/relative",
        "https://{region}.example.com",
        "https://evil.example; script-src *",
      ],
    }),
    "connect-src 'self' https://api.example.com;",
  );
});

Deno.test("scalar: an explicit cdn opts back into the CDN, and its CSP names that host", () => {
  const html = renderDocsHtml(doc, { ui: "scalar", specUrl: "/s", cdn: DOCS_CDN.scalar });
  assertStringIncludes(html, `src="${DOCS_CDN.scalar}" crossorigin`);
  assertStringIncludes(html, '<script id="api-reference" data-url="/s">');
  assertStringIncludes(
    docsCsp("scalar", DOCS_CDN.scalar),
    "script-src https://cdn.jsdelivr.net;",
  );
});

async function plugin(options: OpenApiOptions) {
  resetPlugins();
  await applyPlugins({
    projectRoot: join(Deno.cwd(), "p"),
    appDir: join(Deno.cwd(), "p", "app"),
    config: { plugins: [openapi(options)] } as DenextConfig,
    mode: "prod",
    load: () => Promise.resolve({}),
  });
  return getPluginRequestHandler()!;
}

Deno.test("openapi plugin (scalar): serves the page and the vendored bundle, immutable", async () => {
  try {
    const handle = await plugin({
      ui: "scalar",
      docs: "/reference",
      servers: [{ url: "https://api.example.com" }],
    });
    const page = (await handle(new Request("https://x/reference")))!;
    assertEquals(
      page.headers.get("content-security-policy"),
      docsCsp("scalar", undefined, { connect: ["https://api.example.com"] }),
    );
    assertEquals(page.headers.get("cache-control"), "no-cache");
    assertStringIncludes(await page.text(), `src="/reference/scalar/${SCALAR_BUNDLE_NAME}"`);

    const url = `https://x/reference/scalar/${SCALAR_BUNDLE_NAME}`;
    const js = (await handle(new Request(url)))!;
    assertEquals(js.status, 200);
    assertEquals(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    assertEquals(js.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assertEquals(js.headers.get("x-content-type-options"), "nosniff");
    assertEquals((await js.bytes()).byteLength, SCALAR_ASSET.bytes);
    const again = await handle(
      new Request(url, { headers: { "if-none-match": js.headers.get("etag")! } }),
    );
    assertEquals([again!.status, await again!.text()], [304, ""]);
    const head = (await handle(new Request(url, { method: "HEAD" })))!;
    assertEquals([head.status, await head.text()], [200, ""]);
    // Only the content-addressed name is served: no other file, no stale name, no traversal.
    for (
      const other of [
        "standalone.js",
        "standalone.0000000000000000.js",
        "LICENSE",
        "../mod.ts",
        "init.js",
      ]
    ) {
      assertEquals(await handle(new Request(`https://x/reference/scalar/${other}`)), null, other);
    }
    assertEquals(await handle(new Request(url, { method: "POST" })), null);
  } finally {
    resetPlugins();
  }
  try {
    // Not served for another renderer, nor when the app loads Scalar from a CDN.
    for (const options of [{ ui: "swagger" }, { ui: "scalar", cdn: DOCS_CDN.scalar }] as const) {
      const handle = await plugin(options);
      assertEquals(await handle(new Request(`https://x/docs/scalar/${SCALAR_BUNDLE_NAME}`)), null);
      resetPlugins();
    }
  } finally {
    resetPlugins();
  }
});
