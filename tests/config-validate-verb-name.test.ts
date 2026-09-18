// One grammar for a project verb name. `denext.config.ts`'s `commands:` validation and the
// CLI's help cache used to each carry their own copy of the regex; a drift between them would
// have let a config load a verb the cache then refused (or the reverse), with nothing to say
// which was right. Both now read `VERB_NAME`, and this pins the two agreeing on every shape.

import { assertEquals, assertThrows } from "@std/assert";
import { VERB_NAME } from "../src/cli/command.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";

/** Whether `validateDenextConfig` admits a `commands:` entry named `name`. */
function admitted(name: string): boolean {
  try {
    validateDenextConfig({ commands: [{ name, summary: "s", run: () => {} }] });
    return true;
  } catch {
    return false;
  }
}

Deno.test("config validation admits exactly the verb names the CLI's grammar does", () => {
  const names = [
    "seed",
    "warm-cache",
    "a1",
    "x",
    "seed-",
    "Seed",
    "1seed",
    "-seed",
    "seed_db",
    "seed db",
    "seed:db",
    "",
    "sé",
    "seed\n",
  ];
  for (const name of names) {
    assertEquals(admitted(name), VERB_NAME.test(name), JSON.stringify(name));
  }
});

Deno.test("a refused verb name is reported against the shared grammar", () => {
  const err = assertThrows(
    () => validateDenextConfig({ commands: [{ name: "Seed", summary: "s", run: () => {} }] }),
    Error,
  );
  assertEquals(err.message.includes("`commands[0].name`"), true, err.message);
  assertEquals(err.message.includes(String(VERB_NAME)), true, err.message);
});
