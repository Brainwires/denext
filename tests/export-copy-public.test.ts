// `denext export` copies public/ into the export: no public/ is nothing to copy, and a copy that
// fails (here: a file it cannot read) fails the export instead of reading as "no public/".

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { copyPublic } from "../src/build/export-pipeline/render.ts";

Deno.test("copyPublic: copies public/, accepts none, and surfaces a failed copy", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_copy_public_" });
  try {
    const pub = join(dir, "public");
    const out = join(dir, "out");
    await Deno.mkdir(out);
    await copyPublic(join(dir, "missing"), out); // no public/: nothing to do
    await Deno.mkdir(join(pub, "img"), { recursive: true });
    await Deno.writeTextFile(join(pub, "img", "a.txt"), "a");
    await copyPublic(pub, out);
    assertEquals(await Deno.readTextFile(join(out, "img", "a.txt")), "a");
    if (Deno.build.os !== "windows" && Deno.uid() !== 0) { // root reads a 000 file
      // An unreadable file (as a full disk or an I/O error would) is an error, not "no public/".
      await Deno.writeTextFile(join(pub, "secret.txt"), "s");
      await Deno.chmod(join(pub, "secret.txt"), 0o000);
      try {
        await assertRejects(() => copyPublic(pub, join(dir, "out2")));
      } finally {
        await Deno.chmod(join(pub, "secret.txt"), 0o600);
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
