// `denext generate <kind> <name> [dir]` — scaffold a route/page/layout/component/
// api/action into an existing app. The first positional is the artifact kind, the
// second its name/path; the optional third is the project dir (so the module gate
// resolves it via `moduleDir`).

import { resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { generateArtifact, type GenerateKind } from "../../build/generate.ts";

const KINDS: GenerateKind[] = ["page", "route", "layout", "component", "api", "action"];

/** Project dir for `generate <kind> <name> [dir]` (positional[2]). */
function generateDir(ctx: CommandContext): string {
  return resolve(ctx.global.cwd ?? ctx.positionals[2] ?? ".");
}

export const generateCommand: CommandSpec = {
  name: "generate",
  summary: "Scaffold a route/component/layout/api/action into an app",
  aliases: ["g"],
  loadsModules: false, // pure codegen — no user-module load / re-exec needed
  usage: "  denext generate page dashboard/settings\n" +
    "  denext generate component UserCard\n" +
    "  denext generate api users\n" +
    "  denext generate action createPost",
  positionals: [
    { name: "kind", help: KINDS.join(" | "), required: true },
    { name: "name", help: "Route path or component/action name", required: true },
    { name: "dir", help: "Project directory (default: .)" },
  ],
  run: async (ctx) => {
    const kind = ctx.positionals[0] as GenerateKind;
    const name = ctx.positionals[1];
    if (!KINDS.includes(kind)) {
      console.error(
        `denext generate: unknown kind "${ctx.positionals[0] ?? ""}" (expected ${
          KINDS.join(" | ")
        }).`,
      );
      Deno.exit(1);
    }
    if (!name) {
      console.error(`denext generate: missing name.\n  denext generate ${kind} <name>`);
      Deno.exit(1);
    }

    const dir = generateDir(ctx);
    const { written, skipped } = await generateArtifact(dir, kind, name);
    for (const p of written) console.log(`   + ${p}`);
    for (const p of skipped) console.log(`   • exists, skipped: ${p}`);
    if (written.length === 0 && skipped.length > 0) Deno.exit(1);
  },
};
