// The app's deno.json `"unstable"` list as `--unstable-<name>` flags (src/cli/unstable-flags.ts),
// and which of them a process still lacks given its command line and the config it resolved.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { appUnstableFlags, missingUnstableFlags } from "../src/cli/unstable-flags.ts";

Deno.test("appUnstableFlags: deno.json / deno.jsonc lists, each once; invalid entries dropped", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(appUnstableFlags(dir), []);
    await Deno.writeTextFile(
      join(dir, "deno.jsonc"),
      `// c\n{ "unstable": ["kv", "cron", "kv", 3, "--x"] }`,
    );
    assertEquals(appUnstableFlags(dir), ["--unstable-kv", "--unstable-cron"]);
    await Deno.writeTextFile(join(dir, "deno.json"), `{ "unstable": ["temporal"] }`);
    assertEquals(appUnstableFlags(dir), ["--unstable-temporal"], "deno.json first");
    await Deno.writeTextFile(join(dir, "deno.json"), `{ not json`);
    assertEquals(appUnstableFlags(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("missingUnstableFlags: the command line and the process's own config count", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const own = join(dir, "deno.json");
    await Deno.writeTextFile(own, `{ "unstable": ["cron"] }`);
    const wanted = ["--unstable-kv", "--unstable-cron"];
    assertEquals(missingUnstableFlags(wanted, [], null), wanted);
    assertEquals(missingUnstableFlags(wanted, ["--unstable-kv"], own), []);
    assertEquals(missingUnstableFlags(wanted, [], own), ["--unstable-kv"]);
    assertEquals(missingUnstableFlags(wanted, ["--unstable"], null), [], "the catch-all");
    assertEquals(missingUnstableFlags(wanted, null, null), wanted);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
