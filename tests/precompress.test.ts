// Unit coverage for build-time asset precompression (precompress.ts): gzip round
// trips, the compressible-extension + size filters, the no-win skip, recursion,
// and resilience to unreadable entries.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { gzipBytes, precompressDir } from "../src/build/precompress.ts";

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

Deno.test("gzipBytes round-trips through gunzip", async () => {
  const original = new TextEncoder().encode("hello ".repeat(500));
  const gz = await gzipBytes(original);
  assert(gz.length < original.length, "gzip should shrink repetitive input");
  assertEquals(await gunzip(gz), original);
});

Deno.test("precompressDir writes .gz siblings for compressible files above the floor", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_precompress_" });
  try {
    const big = "console.log('x');".repeat(200); // > 512 bytes, compressible
    await Deno.writeTextFile(join(dir, "app.js"), big);
    await Deno.writeTextFile(join(dir, "styles.css"), "a{color:red}".repeat(200));
    // Below the size floor → skipped.
    await Deno.writeTextFile(join(dir, "tiny.js"), "let a=1;");
    // Non-compressible extension → skipped.
    await Deno.writeTextFile(join(dir, "logo.png"), "x".repeat(1000));

    const count = await precompressDir(dir);
    assertEquals(count, 2, "only the two large compressible files get a .gz");

    const gz = await Deno.readFile(join(dir, "app.js.gz"));
    assertEquals(await gunzip(gz), await Deno.readFile(join(dir, "app.js")));
    await Deno.stat(join(dir, "styles.css.gz"));

    // Skipped ones have no sibling.
    await assertMissing(join(dir, "tiny.js.gz"));
    await assertMissing(join(dir, "logo.png.gz"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("precompressDir recurses into subdirectories", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_precompress_rec_" });
  try {
    const sub = join(dir, "client");
    await Deno.mkdir(sub);
    await Deno.writeTextFile(join(sub, "chunk.js"), "const x=1;".repeat(200));
    const count = await precompressDir(dir);
    assertEquals(count, 1);
    await Deno.stat(join(sub, "chunk.js.gz"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("precompressDir skips a file whose gzip is not smaller", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_precompress_nowin_" });
  try {
    // Incompressible (random) bytes above the floor: gzip grows it → no sibling.
    const random = crypto.getRandomValues(new Uint8Array(2048));
    await Deno.writeFile(join(dir, "noise.json"), random);
    const count = await precompressDir(dir);
    assertEquals(count, 0, "no win → no .gz written");
    await assertMissing(join(dir, "noise.json.gz"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function assertMissing(path: string): Promise<void> {
  let exists = true;
  try {
    await Deno.stat(path);
  } catch {
    exists = false;
  }
  assert(!exists, `expected ${path} to not exist`);
}
