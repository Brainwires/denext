// `denext generate <kind> <name> [dir]` — scaffold a route/page/layout/component/
// api/action into an existing app. The first positional is the artifact kind, the
// second its name/path; the optional third is the project dir (so the module gate
// resolves it via `moduleDir`).

import { resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { generateArtifact, type GenerateKind } from "../../build/generate.ts";

const KINDS: GenerateKind[] = [
  "page",
  "route",
  "layout",
  "loading",
  "error",
  "not-found",
  "component",
  "api",
  "action",
  "middleware",
  "task",
  "test",
  "docker",
];

/**
 * Kinds whose second positional is not a required name — `docker` and
 * `middleware` are single root files; the App Router boundaries (`loading`/
 * `error`/`not-found`) default to the root segment when no path is given.
 */
const NO_NAME: ReadonlySet<GenerateKind> = new Set([
  "docker",
  "middleware",
  "loading",
  "error",
  "not-found",
]);

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
  if (!KINDS.includes(kind)) {
    console.error(
      `denext generate: unknown kind "${ctx.positionals[0] ?? ""}" (expected ${
        KINDS.join(" | ")
      }).`,
    );
    Deno.exit(1);
  }
  if (!name && !NO_NAME.has(kind)) {
    console.error(
      `denext generate: missing name.\n  denext generate ${kind} <name>`,
    );
    Deno.exit(1);
  }
  return { kind, name };
}

export const generateCommand: CommandSpec = {
  name: "generate",
  summary: "Scaffold a route, boundary, component, api, action, middleware, or task into an app",
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
    "  denext generate docker spa        # force the static/SPA image (else auto-detected)",
  positionals: [
    { name: "kind", help: KINDS.join(" | "), required: true },
    {
      name: "name",
      help: "Route/component/action name (docker: optional server|spa)",
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
