// The `denext/desktop` runtime's request handler: static export assets (no-store), the
// SPA shell for navigations, the onRequest escape hatch, and 404s — no window needed.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { createDesktopHandler, resolveOutDir } from "../src/build/desktop.ts";

async function exportDir(): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "index.html"), "<!doctype html><div id=root></div>");
  await Deno.mkdir(join(dir, "_denext", "client"), { recursive: true });
  await Deno.writeTextFile(join(dir, "_denext", "client", "index.js"), "console.log(1);");
  return dir;
}

Deno.test("desktop handler: assets are served no-store, navigations get the shell, files 404", async () => {
  const dir = await exportDir();
  try {
    const handle = createDesktopHandler({}, dir, undefined);
    const get = (path: string, headers: Record<string, string> = {}) =>
      handle(
        new Request(`http://127.0.0.1${path}`, { headers }),
        new URL(`http://127.0.0.1${path}`),
      );

    const asset = await get("/_denext/client/index.js");
    assertEquals(asset.status, 200);
    assertEquals(asset.headers.get("cache-control"), "no-store, must-revalidate");
    assertEquals(asset.headers.get("etag"), null);
    assertEquals(await asset.text(), "console.log(1);");

    const nav = await get("/settings/profile", { accept: "text/html" });
    assertEquals(nav.status, 200);
    assertStringIncludes(await nav.text(), "<div id=root>");
    assertEquals(nav.headers.get("cache-control"), "no-store, must-revalidate");

    const head = await handle(
      new Request("http://127.0.0.1/", { method: "HEAD" }),
      new URL("http://127.0.0.1/"),
    );
    assertEquals(head.status, 200);
    assertEquals(await head.text(), "");

    const missing = await get("/missing.png");
    assertEquals(missing.status, 404);

    const post = await handle(
      new Request("http://127.0.0.1/route", { method: "POST" }),
      new URL("http://127.0.0.1/route"),
    );
    assertEquals(post.status, 404);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop handler: onRequest intercepts before serving; a null result falls through", async () => {
  const dir = await exportDir();
  try {
    const handle = createDesktopHandler(
      {
        onRequest: (_req, url) => url.pathname === "/api/ping" ? new Response("pong") : null,
      },
      dir,
      undefined,
    );
    const hit = await handle(
      new Request("http://127.0.0.1/api/ping"),
      new URL("http://127.0.0.1/api/ping"),
    );
    assertEquals(await hit.text(), "pong");
    const asset = await handle(
      new Request("http://127.0.0.1/_denext/client/index.js"),
      new URL("http://127.0.0.1/_denext/client/index.js"),
    );
    assertEquals(asset.status, 200);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop handler: no shell when the export has no index.html", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createDesktopHandler({}, dir, undefined);
    const res = await handle(
      new Request("http://127.0.0.1/anything", { headers: { accept: "text/html" } }),
      new URL("http://127.0.0.1/anything"),
    );
    assertEquals(res.status, 404);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveOutDir: relative to importMetaUrl when given, else cwd", () => {
  const importMetaUrl = "file:///app/src/main.ts";
  assertEquals(resolveOutDir({ importMetaUrl }), fromFileUrl("file:///app/src/out"));
  assertEquals(
    resolveOutDir({ importMetaUrl, outDir: "../dist" }),
    fromFileUrl("file:///app/dist"),
  );
  assertEquals(resolveOutDir({ outDir: "/abs/out" }), "/abs/out");
  assertEquals(resolveOutDir({}), join(Deno.cwd(), "out"));
});
