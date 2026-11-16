// The partial file a Deno Desktop `fs.download` keeps between attempts
// (src/desktop/caps/download-partial.ts), at its edges: a sidecar that is not JSON (or not ours)
// discards both files, a sidecar write that fails leaves no temp file behind, a cache-dir partial
// is moved into place, and a move that fails for any reason but a volume boundary is not hidden.
// desktop-download-resume.test.ts drives the resume end to end over HTTP.

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  finalizePartial,
  openPartial,
  partialAt,
  readPartial,
  writeSidecar,
} from "../src/desktop/caps/download-partial.ts";

async function exists(path: string): Promise<boolean> {
  return await Deno.lstat(path).then(() => true, () => false);
}

const URL_A = "https://example.com/a.bin";

Deno.test("readPartial: a sidecar that is not JSON, or not version 1, discards the partial", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dnx-partial-" });
  try {
    const at = await partialAt(join(dir, "a.bin"));
    for (
      const sidecar of [
        "{ not json",
        JSON.stringify({ v: 2, url: URL_A, validator: null, total: null, bytes: 3 }),
        JSON.stringify({ v: 1, url: URL_A, validator: 7, total: null, bytes: 3 }),
        JSON.stringify({ v: 1, url: URL_A, validator: null, total: -1, bytes: 3 }),
      ]
    ) {
      await Deno.writeTextFile(`${at.base}.part`, "abc");
      await Deno.writeTextFile(`${at.base}.part.json`, sidecar);
      assertEquals(await readPartial(at, URL_A), null, sidecar);
      assertEquals(await exists(`${at.base}.part`), false, "the bytes are dropped");
      assertEquals(await exists(`${at.base}.part.json`), false, "and the sidecar");
    }
    // A good one is kept, for its own URL only.
    await Deno.writeTextFile(`${at.base}.part`, "abc");
    await writeSidecar(at, { url: URL_A, validator: '"v1"', total: 10, bytes: 3 });
    assertEquals(await readPartial(at, URL_A), { bytes: 3, validator: '"v1"', total: 10 });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeSidecar: a write that cannot land throws and leaves no temp file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dnx-partial-" });
  try {
    const at = await partialAt(join(dir, "a.bin"));
    // A directory where the sidecar goes: the rename over it fails.
    await Deno.mkdir(`${at.base}.part.json`);
    await Deno.writeTextFile(join(`${at.base}.part.json`, "keep"), "x");
    await assertRejects(() =>
      writeSidecar(at, { url: URL_A, validator: null, total: null, bytes: 0 })
    );
    const left = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(left, ["a.bin.part.json"], "the temp file was removed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a cache-dir partial is written privately and moved onto its destination", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dnx-partial-" });
  try {
    const target = join(dir, "picked", "movie.mp4");
    await Deno.mkdir(join(dir, "picked"));
    const at = await partialAt(target, join(dir, "cache"));
    const file = await openPartial(at, false, 0);
    await file.write(new TextEncoder().encode("frames"));
    file.close();
    await writeSidecar(at, { url: URL_A, validator: null, total: 6, bytes: 6 });
    assertEquals(await exists(join(dir, "picked", "movie.mp4.part")), false, "nothing beside it");
    await finalizePartial(at);
    assertEquals(await Deno.readTextFile(target), "frames");
    assertEquals(await exists(`${at.base}.part.json`), false, "the sidecar is dropped");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("finalizePartial: a move that fails for another reason than a volume boundary is not hidden", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dnx-partial-" });
  try {
    // The destination's directory is gone (not EXDEV): no copy is attempted, the error surfaces.
    const at = await partialAt(join(dir, "gone", "a.bin"), join(dir, "cache"));
    const file = await openPartial(at, false, 0);
    file.close();
    await assertRejects(() => finalizePartial(at), Deno.errors.NotFound);
    assertEquals(await exists(`${at.base}.part`), true, "the bytes are kept for another try");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
