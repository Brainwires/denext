// The CLI's verb descriptions ship once: written in src/cli/commands/meta/*.ts (not published),
// packed into src/cli/command-meta.packed.ts by scripts/gen-command-table.ts, and read back by
// each verb's spec through `commandMeta()` (src/cli/command-meta.ts). These tests keep the packed
// table covering every registered verb and the readable copy out of the command modules.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { buildRegistry } from "../src/cli/register.ts";
import { commandMeta, commandMetas } from "../src/cli/command-meta.ts";
import { COMMAND_META_KEYS } from "../src/cli/lazy-command.ts";
import { buildLazyRegistry } from "../src/cli/lazy-registry.ts";
import { commandMetaSources, META_DIR, metaOf } from "../scripts/gen-command-table.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** The registered verbs' canonical names (aliases left out), in registry order. */
const verbs = (): string[] => buildRegistry().list().map((spec) => spec.name);

Deno.test("the packed verb table describes every registered verb, in registry order", () => {
  const names = verbs();
  assert(names.length > 40, `only ${names.length} verbs registered`);
  assertEquals(commandMetas().map((meta) => meta.name), names);
  for (const meta of commandMetas()) {
    assert(meta.summary.length > 0, `${meta.name}: the packed table has no summary for it`);
  }
  // The registry the entrypoint dispatches from is built from the same table.
  assertEquals(buildLazyRegistry().list().map((spec) => spec.name), names);
});

Deno.test("every registered verb's spec carries its packed description", () => {
  for (const spec of buildRegistry().list()) {
    const packed = commandMeta(spec.name);
    for (const key of COMMAND_META_KEYS) {
      assertEquals(spec[key], packed[key], `${spec.name}.${key}`);
    }
  }
});

Deno.test("commandMeta: a verb the table does not list yet gets its name alone", () => {
  assertEquals(commandMeta("no-such-verb"), { name: "no-such-verb", summary: "" });
  // A listed verb comes back from one decode: the same object each time.
  assert(commandMeta("dev") === commandMeta("dev"));
});

Deno.test("src/cli/commands/meta describes exactly the registered verbs", async () => {
  const described = await commandMetaSources();
  const names = verbs();
  assertEquals([...described.keys()].sort(), [...names].sort());
  // What the generator packs is what each meta module exports, key for key.
  for (const meta of commandMetas()) {
    assertEquals(meta, metaOf(described.get(meta.name)!), meta.name);
  }
});

Deno.test("the readable help text is not published, and the command modules carry none", async () => {
  const { publish } = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json"))) as {
    publish: { exclude: string[] };
  };
  assert(publish.exclude.includes("src/cli/commands/meta/"), "src/cli/commands/meta/ is published");
  assertEquals(META_DIR, join(ROOT, "src/cli/commands/meta"));
  // Every verb's spec spreads its packed description instead of spelling it out.
  const dir = join(ROOT, "src/cli/commands");
  let spreads = 0;
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const source = await Deno.readTextFile(join(dir, entry.name));
    spreads += [...source.matchAll(/\.\.\.commandMeta\("[^"]+"\)/g)].length;
    assert(
      !/^\s*(?:summary|usage|positionals):\s*["`[]/m.test(source),
      `src/cli/commands/${entry.name} spells out a verb's help text: move it to meta/${entry.name}`,
    );
  }
  assertEquals(spreads, verbs().length, "one commandMeta() spread per verb");
});
