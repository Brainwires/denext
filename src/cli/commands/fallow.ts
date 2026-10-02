// `denext fallow init [dir]` — add the fallow code-health gate to an existing project: the
// same files and `deno task`s `denext create --fallow` writes, merged in without
// overwriting anything (see src/build/fallow-template.ts).

import { resolve } from "@std/path";
import type { CommandSpec } from "../command.ts";
import { addFallow, FALLOW_VERSION } from "../../build/fallow-template.ts";

export const fallowCommand: CommandSpec = {
  name: "fallow",
  summary: "Add the fallow code-health gate to a project",
  usage: "  denext fallow init [dir] [--dry-run]\n\n" +
    `  init  writes fallow.toml, .githooks/pre-commit, scripts/coverage-to-istanbul.ts and\n` +
    `        AGENTS.md (each only when missing), adds the fallow / fallow:audit /\n` +
    `        coverage:fallow / hooks:install tasks to deno.json (npm:fallow@${FALLOW_VERSION})\n` +
    `        and coverage/ + .fallow/ to .gitignore. Run \`deno task hooks:install\` to\n` +
    `        enable the commit gate.`,
  positionals: [
    { name: "action", help: "init", required: true },
    { name: "dir", help: "Project directory (default: .)" },
  ],
  flags: [
    { name: "dry-run", type: "boolean", help: "Print what would change; write nothing" },
  ],
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
        "\n  Next: `deno task fallow:audit` runs the gate; `deno task hooks:install` runs it" +
          " before every commit.",
      );
    }
  },
};
