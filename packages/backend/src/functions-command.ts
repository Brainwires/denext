// `denext functions list [--json]`: the Edge Functions the project serves, with each one's
// route and whether it requires a valid caller. Contributed by `backend({ functions })`.

import { relative, resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "@denext/denext/cli/command";
import { type CommandIo, consoleIo } from "./command-io.ts";
import { discoverFunctions, functionsDir, type ResolvedFunctions } from "./functions.ts";

/** Where the command prints (injectable for tests). */
export type FunctionsCommandIo = CommandIo;

/** One function, as `list` reports it. */
export interface ListedFunction {
  name: string;
  path: string;
  route: string;
  verifyJwt: boolean;
}

/**
 * The project's functions, as `denext functions list` reports them.
 *
 * @param projectRoot The project.
 * @param config The resolved options.
 * @returns The functions, sorted by name.
 */
export async function listFunctions(
  projectRoot: string,
  config: ResolvedFunctions,
): Promise<ListedFunction[]> {
  const dir = await functionsDir(projectRoot, config.dir);
  const found = await discoverFunctions(dir);
  return [...found].map(([name, path]) => ({
    name,
    path: relative(projectRoot, path).replaceAll("\\", "/"),
    route: `${config.basePath}/${name}`,
    verifyJwt: config.functions[name]?.verifyJwt ?? config.verifyJwt,
  }));
}

/**
 * The `functions` verb.
 *
 * @param config The resolved options.
 * @param io Where it prints.
 * @returns The command.
 */
export function createFunctionsCommand(
  config: ResolvedFunctions,
  io: FunctionsCommandIo = consoleIo,
): CommandSpec {
  return {
    name: "functions",
    summary: "List the Edge Functions this app serves (@denext/backend)",
    usage: [
      "Usage: denext functions list [--json]",
      "",
      "  list    Each function's name, file, route and whether it verifies the caller",
      "",
      "`denext dev` and `denext start` serve them; `denext generate function <name>` adds one.",
    ].join("\n"),
    positionals: [{ name: "action", help: "list" }],
    flags: [{ name: "json", type: "boolean", help: "Print JSON" }],
    moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
    run: (ctx) => runFunctions(ctx, config, io),
  };
}

async function runFunctions(
  ctx: CommandContext,
  config: ResolvedFunctions,
  io: FunctionsCommandIo,
): Promise<void> {
  const action = ctx.positionals[0] ?? "list";
  if (action !== "list") {
    io.error(`denext functions: unknown action "${action}" (expected list)`);
    io.exit(1);
    return;
  }
  const listed = await listFunctions(resolve(ctx.global.cwd ?? "."), config);
  if (ctx.flags.json === true) {
    io.log(JSON.stringify(listed, null, 2));
    return;
  }
  if (!listed.length) {
    io.log("No Edge Functions (add one with `denext generate function <name>`).");
    return;
  }
  for (const f of listed) {
    io.log(
      `  ${f.name.padEnd(24)} ${f.route.padEnd(36)} ${f.path}${f.verifyJwt ? "" : "  (public)"}`,
    );
  }
}
