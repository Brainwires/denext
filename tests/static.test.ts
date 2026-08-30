import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { serveStatic } from "../src/server/static.ts";

async function withPublicDir(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_public_" });
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      await Deno.mkdir(join(full, ".."), { recursive: true });
      await Deno.writeTextFile(full, content);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("serves an existing file with a content type", async () => {
  await withPublicDir({ "styles.css": "body{color:red}" }, async (dir) => {
    const res = await serveStatic(dir, "/styles.css");
    assertEquals(res?.status, 200);
    assertEquals(res?.headers.get("content-type"), "text/css; charset=UTF-8");
    assertEquals(await res?.text(), "body{color:red}");
  });
});

Deno.test("returns null for a missing file", async () => {
  await withPublicDir({ "a.txt": "x" }, async (dir) => {
    const res = await serveStatic(dir, "/missing.txt");
    assertEquals(res, null);
  });
});

Deno.test("blocks path traversal outside the public dir", async () => {
  await withPublicDir({ "ok.txt": "safe" }, async (dir) => {
    const res = await serveStatic(dir, "/../../etc/passwd");
    // Normalized traversal must not escape the root.
    assertEquals(res, null);
  });
});

Deno.test("does not serve directories", async () => {
  await withPublicDir({ "sub/a.txt": "x" }, async (dir) => {
    const res = await serveStatic(dir, "/sub");
    assertEquals(res, null);
  });
});

Deno.test("blocks a symlink inside public/ that points outside it", async () => {
  // A secret file outside the public dir, and a symlink inside it pointing there.
  const secretDir = await Deno.makeTempDir({ prefix: "denext_secret_" });
  try {
    const secret = join(secretDir, "secret.txt");
    await Deno.writeTextFile(secret, "TOP SECRET");
    await withPublicDir({ "ok.txt": "safe" }, async (dir) => {
      await Deno.symlink(secret, join(dir, "leak.txt"));
      const res = await serveStatic(dir, "/leak.txt");
      assertEquals(res, null, "a symlink escaping public/ must not be served");
    });
  } finally {
    await Deno.remove(secretDir, { recursive: true });
  }
});

Deno.test("still serves a symlink that stays inside public/", async () => {
  await withPublicDir({ "real.txt": "inside" }, async (dir) => {
    await Deno.symlink(join(dir, "real.txt"), join(dir, "alias.txt"));
    const res = await serveStatic(dir, "/alias.txt");
    assertEquals(res?.status, 200);
    assertEquals(await res?.text(), "inside");
  });
});

Deno.test("does not serve a .gz sibling that symlinks outside public/ (falls to identity)", async () => {
  const secretDir = await Deno.makeTempDir({ prefix: "denext_secret_" });
  try {
    const secret = join(secretDir, "secret.gz");
    await Deno.writeTextFile(secret, "TOP SECRET GZ");
    await withPublicDir({ "page.html": "<h1>ok</h1>" }, async (dir) => {
      // A precompressed `.gz` sibling that escapes the root via symlink must NOT be
      // streamed as the response body — the branch now runs the same realPath recheck
      // as the identity file and falls back to it on escape.
      await Deno.symlink(secret, join(dir, "page.html.gz"));
      const res = await serveStatic(dir, "/page.html", "gzip");
      assertEquals(res?.status, 200);
      assertEquals(res?.headers.get("content-encoding"), null, "escaping .gz must not be served");
      assertEquals(await res?.text(), "<h1>ok</h1>", "falls back to the identity file");
    });
  } finally {
    await Deno.remove(secretDir, { recursive: true });
  }
});

Deno.test("serves an in-root .gz sibling when the client accepts gzip", async () => {
  await withPublicDir({ "app.js": "console.log(1)" }, async (dir) => {
    await Deno.writeTextFile(join(dir, "app.js.gz"), "GZIPPED");
    const res = await serveStatic(dir, "/app.js", "gzip");
    assertEquals(res?.status, 200);
    assertEquals(res?.headers.get("content-encoding"), "gzip");
    assertEquals(await res?.text(), "GZIPPED");
  });
});
