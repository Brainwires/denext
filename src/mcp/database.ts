// The database tools of `denext mcp`: an agent can see which migrations are applied, apply or
// roll them back, and read the database's TypeScript types — the same `denext migration` /
// `denext db types` verbs, each run as a child process so the project's config, `.env` and
// plugins load there and never in the MCP server.

import type { Tool } from "./tools.ts";
import { cliInvocation, runDeno } from "../ui/proc.ts";

/** Runs the CLI in `dir` (injectable for tests); resolves the exit code and output. */
export type CliRunner = (
  args: string[],
  dir: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultRunner: CliRunner = async (args, dir) => {
  const result = await runDeno([...cliInvocation({ dir }), ...args, "--cwd", dir], { cwd: dir });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
};

/** The verb's output, or its error (flagged). */
async function run(
  runner: CliRunner,
  args: string[],
  dir: string,
): Promise<{ text: string; isError?: boolean }> {
  const out = await runner(args, dir);
  if (out.code !== 0) {
    return { text: (out.stderr || out.stdout).trim() || `exited ${out.code}`, isError: true };
  }
  return { text: out.stdout.trim() || "(no output)" };
}

const TARGET = {
  dbUrl: {
    type: "string",
    description: "Another database: a postgres:// URL or sqlite:<path> (default: the project's)",
  },
};

/**
 * The database tools.
 *
 * @param projectDir Resolves the `dir` argument to a project directory.
 * @param runner Runs the CLI (tests inject a fake).
 * @returns The tools.
 */
export function databaseTools(
  projectDir: (raw: unknown) => string,
  runner: CliRunner = defaultRunner,
): readonly Tool[] {
  const target = (args: Record<string, unknown>) =>
    typeof args.dbUrl === "string" && args.dbUrl ? ["--db-url", args.dbUrl] : [];
  return [
    {
      name: "denext_migrations",
      description:
        "The project's SQL migrations (migrations/ or supabase/migrations/) on its database " +
        "(Postgres or SQLite): `list` shows local vs applied versions as JSON; `up` applies the " +
        "pending ones (`to` stops at a version); `down` runs the newest applied ones' down " +
        "scripts (`steps`, default 1). Pass dryRun to see what would run.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "up", "down"], description: "Default list" },
          to: { type: "string", description: "up: the last version to apply; down: keep it" },
          steps: { type: "number", description: "down: how many to revert (default 1)" },
          dryRun: { type: "boolean", description: "up / down: list what would run, run nothing" },
          dir: { type: "string", description: "Project directory (default: .)" },
          ...TARGET,
        },
      },
      run: (args) => {
        const action = typeof args.action === "string" ? args.action : "list";
        if (!["list", "up", "down"].includes(action)) {
          return Promise.resolve({ text: `unknown action ${action}`, isError: true });
        }
        const argv = ["migration", action, "--json", ...target(args)];
        if (typeof args.to === "string" && args.to) argv.push("--to", args.to);
        if (typeof args.steps === "number") argv.push("--steps", String(args.steps));
        if (args.dryRun === true) argv.push("--dry-run");
        return run(runner, argv, projectDir(args.dir));
      },
    },
    {
      name: "denext_gen_types",
      description:
        "The database's TypeScript types (the `Database` type `supabase gen types typescript` " +
        "writes) for the given schemas — tables, views, functions, enums. Needs @denext/backend " +
        "with postgres.",
      inputSchema: {
        type: "object",
        properties: {
          schema: { type: "string", description: "Comma-separated schemas (default public)" },
          dir: { type: "string", description: "Project directory (default: .)" },
          ...TARGET,
        },
      },
      run: (args) => {
        const argv = ["gen", "types", ...target(args)];
        if (typeof args.schema === "string" && args.schema) argv.push("--schema", args.schema);
        return run(runner, argv, projectDir(args.dir));
      },
    },
  ];
}
