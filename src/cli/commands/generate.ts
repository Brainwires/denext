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
  OPTIONAL_NAME_KINDS,
} from "../../build/generate.ts";

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
  name: "generate",
  summary:
    "Scaffold a route, boundary, component, API route, action, middleware, task, test, Docker setup, migration, seed or CI workflow",
  aliases: ["g"],
  loadsModules: false, // pure codegen — no user-module load / re-exec needed
  usage: "  denext generate page dashboard/settings\n" +
    "  denext generate layout dashboard\n" +
    "  denext generate loading dashboard # app/dashboard/loading.tsx (root if no path)\n" +
    "  denext generate error dashboard   # app/dashboard/error.tsx (Client Component)\n" +
    "  denext generate not-found         # app/not-found.tsx\n" +
    "  denext generate component UserCard\n" +
    "  denext generate api users\n" +
    "  denext generate action createPost\n" +
    "  denext generate middleware        # middleware.ts (beside app/)\n" +
    "  denext generate task cleanup      # tasks/cleanup.ts (defineTask)\n" +
    "  denext generate test UserCard     # tests/UserCard.test.tsx (denext/testing)\n" +
    "  denext generate docker            # Dockerfile + docker-compose.yml + .dockerignore\n" +
    "  denext generate docker spa        # force the static/SPA image (else auto-detected)\n" +
    "  denext generate migration add_users # migrations/<UTC stamp>_add_users.sql (+ tasks/migrate.ts)\n" +
    "  denext generate seed              # tasks/seed.ts (node:sqlite, or Prisma when detected)\n" +
    "  denext generate ci                # .github/workflows/ci.yml (check + build)",
  positionals: [
    { name: "kind", help: GENERATE_KINDS.join(" | "), required: true },
    {
      name: "name",
      help: "Route/component/action/migration name (docker: server|spa; seed: sqlite|prisma; " +
        "ci: github — each optional)",
    },
    { name: "dir", help: "Project directory (default: .)" },
  ],
  run: async (ctx) => {
    const { kind, name } = generateTarget(ctx);
    const dir = generateDir(ctx);
    const { written, skipped } = await generateArtifact(dir, kind, name);
    for (const p of written) console.log(`   + ${p}`);
    for (const p of skipped) console.log(`   • exists, skipped: ${p}`);
    if (written.length === 0 && skipped.length > 0) Deno.exit(1);
  },
};
