// `denext generate <kind> <name> [dir]` — scaffold a route/page/layout/component/
// api/action into an existing app. The first positional is the artifact kind, the
// second its name/path; the optional third is the project dir (so the module gate
// resolves it via `moduleDir`).

import { resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import {
  GENERATE_KINDS,
  generateArtifact,
  type GenerateKind,
  type GenerateResult,
  OPTIONAL_NAME_KINDS,
} from "../../build/generate.ts";
import { runDocker, usesDockerFlags } from "./generate-docker.ts";
import { commandMeta } from "../command-meta.ts";

/** Project dir for `generate <kind> <name> [dir]` (positional[2]). */
function generateDir(ctx: CommandContext): string {
  return resolve(ctx.global.cwd ?? ctx.positionals[2] ?? ".");
}

/** The validated `<kind> [name]` positionals, or exit with usage. */
function generateTarget(
  ctx: CommandContext,
): { kind: GenerateKind; name: string } {
  const kind = ctx.positionals[0] as GenerateKind;
  const name = ctx.positionals[1] ?? "";
  if (!GENERATE_KINDS.includes(kind)) {
    console.error(
      `denext generate: unknown kind "${ctx.positionals[0] ?? ""}" (expected ${
        GENERATE_KINDS.join(" | ")
      }).`,
    );
    Deno.exit(1);
  }
  if (!name && !OPTIONAL_NAME_KINDS.has(kind)) {
    console.error(
      `denext generate: missing name.\n  denext generate ${kind} <name>`,
    );
    Deno.exit(1);
  }
  return { kind, name };
}

export const generateCommand: CommandSpec = {
  ...commandMeta("generate"),
  run: async (ctx) => {
    const { kind, name } = generateTarget(ctx);
    const dir = generateDir(ctx);
    const force = ctx.flags.force === true;
    const dryRun = ctx.flags["dry-run"] === true;
    if (kind === "docker") return await runDocker(ctx, dir, name, { force, dryRun });
    if (usesDockerFlags(ctx.flags)) {
      console.error(`denext generate: the --postgres/--stack/… flags only apply to \`docker\`.`);
      Deno.exit(1);
    }
    report(await generateArtifact(dir, kind, name, { force, dryRun }), dryRun);
  },
};

/** Print a run's written/skipped paths; exit 1 when it wrote nothing because all existed. */
function report({ written, skipped }: GenerateResult, dryRun: boolean): void {
  for (const p of written) console.log(`   ${dryRun ? "would write" : "+"} ${p}`);
  for (const p of skipped) console.log(`   • exists, skipped: ${p}`);
  if (written.length === 0 && skipped.length > 0) Deno.exit(1);
}
