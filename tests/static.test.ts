import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { parseRanges, serveStatic } from "../src/server/static.ts";
import { FILE_SYMLINKS } from "./helpers/symlink.ts";

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

Deno.test(
  "blocks a symlink inside public/ that points outside it",
  { ignore: !FILE_SYMLINKS }, // a FILE symlink: needs the Windows symlink privilege
  async () => {
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
  },
);

Deno.test(
  "still serves a symlink that stays inside public/",
  { ignore: !FILE_SYMLINKS }, // a FILE symlink: needs the Windows symlink privilege
  async () => {
    await withPublicDir({ "real.txt": "inside" }, async (dir) => {
      await Deno.symlink(join(dir, "real.txt"), join(dir, "alias.txt"));
      const res = await serveStatic(dir, "/alias.txt");
      assertEquals(res?.status, 200);
      assertEquals(await res?.text(), "inside");
    });
  },
);

Deno.test(
  "does not serve a .gz sibling that symlinks outside public/ (falls to identity)",
  { ignore: !FILE_SYMLINKS }, // a FILE symlink: needs the Windows symlink privilege
  async () => {
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
  },
);

Deno.test("serves an in-root .gz sibling when the client accepts gzip", async () => {
  await withPublicDir({ "app.js": "console.log(1)" }, async (dir) => {
    await Deno.writeTextFile(join(dir, "app.js.gz"), "GZIPPED");
    const res = await serveStatic(dir, "/app.js", "gzip");
    assertEquals(res?.status, 200);
    assertEquals(res?.headers.get("content-encoding"), "gzip");
    assertEquals(await res?.text(), "GZIPPED");
  });
});

/** A `Range` request (plus any other headers) for `path`. */
const ranged = (path: string, range: string, extra: Record<string, string> = {}) =>
  new Request(`http://x${path}`, { headers: { range, ...extra } });

/** The parts of a `multipart/byteranges` body: each part's headers and payload. */
function partsOf(body: string, contentType: string): { headers: string; payload: string }[] {
  const boundary = /boundary=(\S+)/.exec(contentType)![1];
  assert(body.endsWith(`\r\n--${boundary}--\r\n`), "the closing delimiter ends the body");
  return body.slice(0, -`\r\n--${boundary}--\r\n`.length).split(`--${boundary}\r\n`).slice(1)
    .map((part) => {
      const [headers, payload] = part.split("\r\n\r\n");
      return { headers, payload: payload.replace(/\r\n$/, "") };
    });
}

Deno.test("multi-range: several ranges answer 206 multipart/byteranges (RFC 9110 §14.6)", async () => {
  await withPublicDir({ "d.txt": "0123456789abcdefghijklmnopqrstuvwxyz" }, async (dir) => {
    const res = (await serveStatic(dir, "/d.txt", undefined, ranged("/d.txt", "bytes=0-9,20-29")))!;
    assertEquals(res.status, 206);
    const type = res.headers.get("content-type")!;
    assert(type.startsWith("multipart/byteranges; boundary="), type);
    assertEquals(res.headers.get("content-range"), null, "only the parts carry Content-Range");
    const body = await res.text();
    assertEquals(Number(res.headers.get("content-length")), new TextEncoder().encode(body).length);
    const parts = partsOf(body, type);
    assertEquals(parts.map((p) => p.payload), ["0123456789", "klmnopqrst"]);
    assertStringIncludes(parts[0].headers, "content-range: bytes 0-9/36");
    assertStringIncludes(parts[1].headers, "content-range: bytes 20-29/36");
    assertStringIncludes(parts[1].headers, "content-type: text/plain");
  });
});

Deno.test("multi-range: suffix and open ranges, overlaps coalesced, larger-than-chunk parts", async () => {
  const big = "x".repeat(70_000) + "END" + "y".repeat(70_000);
  await withPublicDir({ "d.txt": "0123456789", "big.txt": big }, async (dir) => {
    const mixed = (await serveStatic(dir, "/d.txt", undefined, ranged("/d.txt", "bytes=-2, 1-2")))!;
    const parts = partsOf(await mixed.text(), mixed.headers.get("content-type")!);
    assertEquals(parts.map((p) => p.payload), ["12", "89"], "sorted by offset");
    // Overlapping / adjacent ranges coalesce; a single result is a plain 206.
    const merged =
      (await serveStatic(dir, "/d.txt", undefined, ranged("/d.txt", "bytes=2-4,3-6,7-7")))!;
    assertEquals([merged.status, merged.headers.get("content-range")], [206, "bytes 2-7/10"]);
    assertEquals(await merged.text(), "234567");
    // An unsatisfiable spec beside a satisfiable one is dropped.
    const dropped =
      (await serveStatic(dir, "/d.txt", undefined, ranged("/d.txt", "bytes=50-60,0-0")))!;
    assertEquals([dropped.status, await dropped.text()], [206, "0"]);
    const range = "bytes=0-69998,70000-70002,140000-";
    const large = (await serveStatic(dir, "/big.txt", undefined, ranged("/big.txt", range)))!;
    const body = await large.text();
    assertEquals(Number(large.headers.get("content-length")), body.length);
    const payloads = partsOf(body, large.headers.get("content-type")!).map((p) => p.payload);
    assertEquals(payloads, ["x".repeat(69_999), "END", "y".repeat(3)]);
  });
});

Deno.test("multi-range: all unsatisfiable → 416; malformed or too many → the whole file", async () => {
  await withPublicDir({ "d.txt": "0123456789" }, async (dir) => {
    const none =
      (await serveStatic(dir, "/d.txt", undefined, ranged("/d.txt", "bytes=20-30,40-")))!;
    assertEquals([none.status, none.headers.get("content-range")], [416, "bytes */10"]);
    for (const bad of ["bytes=0-1,x-2", "items=0-1,2-3", "bytes=", "bytes=,"]) {
      const res = (await serveStatic(dir, "/d.txt", undefined, ranged("/d.txt", bad)))!;
      assertEquals([res.status, await res.text()], [200, "0123456789"], bad);
    }
    const many = Array.from({ length: 65 }, (_, i) => `${i % 10}-${i % 10}`).join(",");
    const res = (await serveStatic(dir, "/d.txt", undefined, ranged("/d.txt", `bytes=${many}`)))!;
    assertEquals([res.status, await res.text()], [200, "0123456789"], "past 64 specs: ignored");
  });
  assertEquals(parseRanges("bytes = 0-1 , 4-5", 10), [{ start: 0, end: 1 }, { start: 4, end: 5 }]);
  assertEquals(parseRanges("Bytes=-0", 10), null);
});

Deno.test("If-Range: a matching Last-Modified keeps the range; a stale date or any ETag sends it all", async () => {
  await withPublicDir({ "d.txt": "0123456789" }, async (dir) => {
    const first = (await serveStatic(dir, "/d.txt", undefined, new Request("http://x/d.txt")))!;
    await first.body?.cancel();
    const lastModified = first.headers.get("last-modified")!;
    const etag = first.headers.get("etag")!;
    const same = (await serveStatic(
      dir,
      "/d.txt",
      undefined,
      ranged("/d.txt", "bytes=0-1,4-5", { "if-range": lastModified }),
    ))!;
    assertEquals(same.status, 206);
    await same.body?.cancel();
    const stale = new Date(Date.parse(lastModified) - 60_000).toUTCString();
    const cases = [stale, etag, etag.replace(/^W\//, ""), "not a date"];
    for (const ifRange of cases) {
      const res = (await serveStatic(
        dir,
        "/d.txt",
        undefined,
        ranged("/d.txt", "bytes=0-1", { "if-range": ifRange }),
      ))!;
      assertEquals([res.status, await res.text()], [200, "0123456789"], ifRange);
    }
  });
});

Deno.test("multi-range: a cancelled body closes the file", async () => {
  await withPublicDir({ "d.txt": "0123456789".repeat(10_000) }, async (dir) => {
    const res =
      (await serveStatic(dir, "/d.txt", undefined, ranged("/d.txt", "bytes=0-1,50000-")))!;
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
  });
});

Deno.test("multi-range: a file cut short while its parts stream errors the body", async () => {
  await withPublicDir({ "d.txt": "0123456789".repeat(10) }, async (dir) => {
    const res = (await serveStatic(dir, "/d.txt", undefined, ranged("/d.txt", "bytes=0-1,90-99")))!;
    await Deno.truncate(join(dir, "d.txt"), 50);
    let failed = false;
    try {
      await res.text();
    } catch {
      failed = true;
    }
    assert(failed, "the second part's bytes are gone");
  });
});
