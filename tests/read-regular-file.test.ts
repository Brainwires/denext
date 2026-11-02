// src/utils/read-regular-file.ts: a project file is read only when it is a regular file (a symlink
// to one counts) under the size cap; a directory, a FIFO or a bigger file reads as missing.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { readRegularTextFile } from "../src/utils/read-regular-file.ts";

Deno.test("readRegularTextFile: regular files and links to them, under the cap", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_read_regular_" });
  try {
    await Deno.writeTextFile(join(dir, "a.json"), "{}");
    await Deno.mkdir(join(dir, "folder"));
    assertEquals(await readRegularTextFile(join(dir, "a.json")), "{}");
    assertEquals(await readRegularTextFile(join(dir, "missing.json")), null);
    assertEquals(await readRegularTextFile(join(dir, "folder")), null);
    assertEquals(await readRegularTextFile(join(dir, "a.json"), 1), null);
    if (Deno.build.os !== "windows") {
      await Deno.symlink(join(dir, "a.json"), join(dir, "link.json"));
      await Deno.symlink(join(dir, "folder"), join(dir, "dir-link"));
      assertEquals(await readRegularTextFile(join(dir, "link.json")), "{}");
      assertEquals(await readRegularTextFile(join(dir, "dir-link")), null);
      const made = await new Deno.Command("mkfifo", {
        args: [join(dir, "fifo")],
        stdin: "null",
      }).output();
      assert(made.success, "mkfifo failed");
      await Deno.symlink(join(dir, "fifo"), join(dir, "fifo-link"));
      assertEquals(await readRegularTextFile(join(dir, "fifo")), null);
      assertEquals(await readRegularTextFile(join(dir, "fifo-link")), null);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
