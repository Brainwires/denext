// denext 5.0's scaffolded packaging tasks run `denext desktop package` rather than a
// `scripts/package-*.ts` straight on `deno`: a plain `deno task desktop:package` on another Deno
// re-runs the CLI on denext's runtime instead of hitting the 5.0 refusal. The task's own extra
// arguments (`deno task desktop:package --arch universal`) still reach the script, through the
// trailing `--` and `ctx.rest`.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { CommandRegistry } from "../src/cli/command.ts";
import { desktopCommand } from "../src/cli/commands/desktop.ts";
import {
  desktopPackageTasks,
  LEGACY_DESKTOP_PACKAGE_TASKS,
  scaffoldFiles,
} from "../src/build/scaffold.ts";

const CLI = "jsr:@denext/denext@^5.0.0/cli";

Deno.test("desktopPackageTasks: the host OS, then linux and windows, each through the verb", () => {
  assertEquals(desktopPackageTasks(CLI), {
    "desktop:package": `deno run -A ${CLI} desktop package . --`,
    "desktop:package:linux": `deno run -A ${CLI} desktop package . --target-os linux --`,
    "desktop:package:windows": `deno run -A ${CLI} desktop package . --target-os windows --`,
  });
});

Deno.test("denext create --desktop writes no task that runs a packaging script on deno itself", () => {
  const config = JSON.parse(
    scaffoldFiles({ dir: ".", desktop: true }).find((f) => f.path === "deno.json")!.content,
  );
  for (const [name, legacy] of Object.entries(LEGACY_DESKTOP_PACKAGE_TASKS)) {
    const task = config.tasks[name] as string;
    assert(task.includes(" desktop package . "), `${name}: ${task}`);
    assertFalse(task.includes("scripts/package-"), `${name} runs the script itself: ${task}`);
    assert(task !== legacy);
  }
});

Deno.test("a packaging task's extra arguments reach the script through ctx.rest", () => {
  const registry = new CommandRegistry();
  registry.register(desktopCommand);
  for (const [name, task] of Object.entries(desktopPackageTasks(CLI))) {
    // `deno task <name> --arch universal --format dmg` appends the arguments to the command.
    const argv = task.split(" ").slice(task.split(" ").indexOf(CLI) + 1);
    const out = registry.parse([...argv, "--arch", "universal", "--format", "dmg"]);
    assert(out.kind === "run", `${name}: ${JSON.stringify(out)}`);
    assertEquals(out.ctx.positionals, ["package", "."]);
    assertEquals(out.ctx.rest, ["--arch", "universal", "--format", "dmg"]);
    assertEquals(
      out.ctx.flags["target-os"],
      name === "desktop:package" ? undefined : name.split(":").at(-1),
    );
  }
});
