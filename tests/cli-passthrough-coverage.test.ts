// Coverage for the passthrough verbs in `src/cli/commands/toolchain.ts`
// (`test`/`lint`/`fmt`/`check`) and `src/cli/commands/deps.ts`
// (`add`/`remove`/`update`). Each forwards to a `deno` subcommand and exits with its
// status. We forward `--help` (fast, offline, exit 0) and assert the child status was
// propagated to Deno.exit — with Deno.exit stubbed so the test process survives.

import { assert, assertEquals } from "@std/assert";
import { addCommand, removeCommand, updateCommand } from "../src/cli/commands/deps.ts";
import {
  checkCommand,
  fmtCommand,
  lintCommand,
  testCommand,
} from "../src/cli/commands/toolchain.ts";
import type { CommandSpec } from "../src/cli/command.ts";
import { makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

/** Drive a passthrough command with `rest`, expecting it to exit via the stub. */
async function drive(cmd: CommandSpec, rest: string[]): Promise<number[]> {
  const exit = stubExit();
  try {
    await cmd.run(makeCtx({ rest }));
    throw new Error("expected the command to exit via spawnDenoAndExit");
  } catch (e) {
    assert(String(e).includes("__exit__"), `unexpected error: ${e}`);
  } finally {
    exit.restore();
  }
  return exit.calls;
}

Deno.test("toolchain verbs forward to their deno subcommand and propagate exit code", async () => {
  // `deno <sub> --help` is offline and exits 0; the wrapper must forward + exit with it.
  assertEquals(await drive(testCommand, ["--help"]), [0]);
  assertEquals(await drive(lintCommand, ["--help"]), [0]);
  assertEquals(await drive(fmtCommand, ["--help"]), [0]);
  assertEquals(await drive(checkCommand, ["--help"]), [0]);
});

Deno.test("dependency verbs forward to their deno subcommand and propagate exit code", async () => {
  assertEquals(await drive(addCommand, ["--help"]), [0]);
  assertEquals(await drive(removeCommand, ["--help"]), [0]);
  assertEquals(await drive(updateCommand, ["--help"]), [0]);
});
