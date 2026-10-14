// `denext functions <new|list|serve|delete|download|deploy>`: the Supabase CLI's `functions`
// group over the Edge Functions the project serves. Contributed by `backend({ functions })`.
//
//   new <name>        functions/<name>/index.ts (what `denext generate function` writes)
//   list [--json]     each function's route, file and whether it requires a valid caller
//   serve [--port]    only the functions host (default port 54321), reloading on an edit
//   delete <name>     remove its source (--yes); it stops being served
//   download, deploy  no hosted platform: the functions ship inside the app

import { dirname, join, relative, resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "@denext/denext/cli/command";
import { edgeFunctionSource } from "@denext/denext/plugin-kit";
import { type CommandIo, consoleIo } from "./command-io.ts";
import {
  discoverFunctions,
  functionsDir,
  type ResolvedFunctions,
  serveFunctions,
} from "./functions.ts";

/** Where the command prints, and how `serve` waits (injectable for tests). */
export interface FunctionsCommandIo extends CommandIo {
  /** Wait for the server `serve` started (tests stop it at once). */
  wait?(server: Deno.HttpServer<Deno.NetAddr>): Promise<void>;
}

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

/** Why `download` / `deploy` have no meaning here. */
const NO_PLATFORM = {
  download:
    "there is no hosted platform to download from: the functions are the files in your project",
  deploy: "the functions ship inside the app: `denext build` (or `denext generate docker`) and " +
    "deploy the app; /functions/v1/<name> is served wherever it runs",
};

/** `functions new <name>`: the `denext generate function` scaffold, in the functions directory. */
async function newFunction(
  ctx: CommandContext,
  root: string,
  config: ResolvedFunctions,
  io: FunctionsCommandIo,
): Promise<void> {
  const name = ctx.positionals[1] ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new TypeError(`function name "${name}" must be a slug (letters, digits, "-" and "_")`);
  }
  const path = join(await functionsDir(root, config.dir), name, "index.ts");
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, edgeFunctionSource(name), { createNew: true });
  io.log(`Created ${relative(root, path).replaceAll("\\", "/")} (${config.basePath}/${name})`);
}

/** `functions delete <name> --yes`: remove its directory (or file). */
async function deleteFunction(
  ctx: CommandContext,
  root: string,
  config: ResolvedFunctions,
  io: FunctionsCommandIo,
): Promise<void> {
  const name = ctx.positionals[1] ?? "";
  const listed = (await listFunctions(root, config)).find((f) => f.name === name);
  if (!listed) throw new Error(`no function named ${JSON.stringify(name)}`);
  if (ctx.flags.yes !== true) throw new Error(`this deletes ${listed.path}: run it with --yes`);
  const path = join(root, listed.path);
  const owned = /[\\/]index\.[a-z]+$/.test(listed.path) ? dirname(path) : path;
  await Deno.remove(owned, { recursive: true });
  io.log(`Deleted ${relative(root, owned).replaceAll("\\", "/")}`);
}

/** `functions serve [--port n] [--hostname h]`: only the functions host. */
async function serve(
  ctx: CommandContext,
  root: string,
  config: ResolvedFunctions,
  io: FunctionsCommandIo,
): Promise<void> {
  const port = typeof ctx.flags.port === "number" ? ctx.flags.port : undefined;
  const hostname = typeof ctx.flags.hostname === "string" ? ctx.flags.hostname : undefined;
  const server = await serveFunctions(root, config, {
    ...(port !== undefined ? { port } : {}),
    ...(hostname ? { hostname } : {}),
    onListen: (addr) =>
      io.log(`Serving ${config.basePath}/<name> at http://${addr.hostname}:${addr.port}`),
  });
  await (io.wait ? io.wait(server) : server.finished);
}

/** Print the functions. */
async function list(
  ctx: CommandContext,
  root: string,
  config: ResolvedFunctions,
  io: FunctionsCommandIo,
): Promise<void> {
  const listed = await listFunctions(root, config);
  if (ctx.flags.json === true || ctx.global?.json === true) {
    io.log(JSON.stringify(listed, null, 2));
    return;
  }
  if (!listed.length) {
    io.log("No Edge Functions (add one with `denext functions new <name>`).");
    return;
  }
  for (const f of listed) {
    io.log(
      `  ${f.name.padEnd(24)} ${f.route.padEnd(36)} ${f.path}${f.verifyJwt ? "" : "  (public)"}`,
    );
  }
}

type Action = (
  ctx: CommandContext,
  root: string,
  config: ResolvedFunctions,
  io: FunctionsCommandIo,
) => Promise<void>;

const ACTIONS: Record<string, Action> = {
  new: newFunction,
  list,
  serve,
  delete: deleteFunction,
  download: () => Promise.reject(new Error(NO_PLATFORM.download)),
  deploy: () => Promise.reject(new Error(NO_PLATFORM.deploy)),
};

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
    summary: "Create, list, serve and delete the Edge Functions this app serves (@denext/backend)",
    usage: [
      "Usage: denext functions <new|list|serve|delete> [args] [flags]",
      "",
      "  new <name>      functions/<name>/index.ts, served at /functions/v1/<name>",
      "  list            Each function's name, route, file and whether it verifies the caller (--json)",
      "  serve           Only the functions host, on --port (default 54321); edits reload",
      "  delete <name>   Remove its source (--yes)",
      "  download, deploy  Nothing to do: the functions ship inside the app (denext build)",
      "",
      "`denext dev` and `denext start` serve them with the rest of the app.",
    ].join("\n"),
    positionals: [
      { name: "action", help: "new | list | serve | delete" },
      { name: "name", help: "new / delete: the function" },
    ],
    flags: [
      { name: "json", type: "boolean", help: "list: print JSON" },
      { name: "port", type: "number", help: "serve: the port (default 54321)" },
      { name: "hostname", type: "string", help: "serve: the interface (default 127.0.0.1)" },
      { name: "yes", type: "boolean", help: "delete: confirm" },
    ],
    moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
    run: (ctx) => runFunctions(ctx, config, io),
  };
}

async function runFunctions(
  ctx: CommandContext,
  config: ResolvedFunctions,
  io: FunctionsCommandIo,
): Promise<void> {
  const name = ctx.positionals[0] ?? "list";
  const action = ACTIONS[name];
  if (!action) {
    io.error(
      `denext functions: unknown action "${name}" (expected ${Object.keys(ACTIONS).join(" | ")})`,
    );
    io.exit(1);
    return;
  }
  try {
    await action(ctx, resolve(ctx.global.cwd ?? "."), config, io);
  } catch (error) {
    io.error(`denext functions ${name}: ${(error as Error)?.message ?? error}`);
    io.exit(1);
  }
}
