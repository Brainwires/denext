import { assertEquals } from "jsr:@std/assert@^1.0.0";
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
