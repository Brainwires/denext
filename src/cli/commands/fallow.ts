// `denext fallow init [dir]` — add the fallow code-health gate to an existing project: the
// same files and `deno task`s `denext create --fallow` writes, merged in without
// overwriting anything (see src/build/fallow-template.ts).

import { resolve } from "@std/path";
import type { CommandSpec } from "../command.ts";
import { addFallow } from "../../build/fallow-template.ts";
import { commandMeta } from "../command-meta.ts";

export const fallowCommand: CommandSpec = {
  ...commandMeta("fallow"),
  run: async (ctx) => {
    if (ctx.positionals[0] !== "init") {
      console.error(
        `denext fallow: unknown action "${
          ctx.positionals[0] ?? ""
        }". Try: denext fallow init [dir]`,
      );
      Deno.exit(1);
    }
    const dir = resolve(ctx.global.cwd ?? ctx.positionals[1] ?? ".");
    const dryRun = ctx.flags["dry-run"] === true;
    const { written, skipped } = await addFallow(dir, { dryRun });
    const verb = dryRun ? "would write" : "+";
    for (const p of written) console.log(`   ${verb} ${p}`);
    for (const p of skipped) console.log(`   • already present: ${p}`);
    if (!dryRun && written.length > 0) {
      console.log(
        "\n  Next: `denext task fallow:audit` runs the gate; `denext task hooks:install` runs it" +
          " before every commit.",
      );
    }
  },
};
