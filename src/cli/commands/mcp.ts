// `denext mcp` — run the denext MCP server over stdio.
//
// An MCP client (an agent, an IDE) is configured to launch this so it can call denext's
// tools (check a snippet, look up an import, scaffold, doctor, codemod) and read denext's
// authoring guide as a resource. Typical client config:
//
//   { "command": "deno", "args": ["run", "-A", "jsr:@denext/denext/cli", "mcp"] }
//
// The server speaks newline-delimited JSON-RPC 2.0 on stdin/stdout, so this verb writes
// nothing else to stdout (diagnostics go to stderr).

import { resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { runStdioServer } from "../../mcp/server.ts";
import { activeTools, resolveToolNames, TOOL_GROUPS } from "../../mcp/tools.ts";
import { VERSION } from "../../../mod.ts";
import { pinnedDenextCli } from "../self-exec.ts";
import {
  addMcp,
  type AddMcpResult,
  DEFAULT_MCP_CLIENTS,
  MCP_CLIENT_FILES,
  MCP_CLIENTS,
  type McpClient,
  parseMcpClients,
} from "../../build/mcp-template.ts";

/** Group names an operator can pass to `--disable`, for the usage text. */
const GROUP_NAMES = Object.keys(TOOL_GROUPS).join(", ");

/** The client → file lines of `denext mcp init`'s usage. */
const CLIENT_LINES = MCP_CLIENTS.map((c) =>
  `    ${c.padEnd(7)} ${MCP_CLIENT_FILES[c]}${DEFAULT_MCP_CLIENTS.includes(c) ? "  (default)" : ""}`
).join("\n");

/** Exit 1 with `message` (on stderr) when `bad` names anything. */
function refuse(bad: string[], message: string, hint = ""): void {
  if (bad.length === 0) return;
  console.error(`denext mcp init: ${message}: ${bad.join(", ")}${hint}`);
  Deno.exit(1);
}

/** `--clients` and `--disable`, validated (an unknown name exits 1). */
function initOptions(ctx: CommandContext): { clients: McpClient[]; disable?: string } {
  const flag = (name: string) => typeof ctx.flags[name] === "string" ? ctx.flags[name] : undefined;
  const { clients, unknown } = parseMcpClients(flag("clients"));
  refuse(unknown, "unknown client(s)", ` (expected ${MCP_CLIENTS.join(", ")} or all)`);
  const disable = flag("disable");
  refuse(disable ? resolveToolNames(disable.split(",")).unknown : [], "unknown --disable token(s)");
  return { clients, disable };
}

/**
 * `denext mcp init [dir]`: register the MCP server in the project's client configs, running
 * the denext the project pins through a `deno task mcp`.
 */
async function runInit(ctx: CommandContext): Promise<void> {
  const dir = resolve(ctx.global.cwd ?? ctx.positionals[1] ?? ".");
  const dryRun = ctx.flags["dry-run"] === true;
  // The task runs the denext this project pins; a project without a pin gets this CLI's own.
  const cli = pinnedDenextCli(dir) ?? `jsr:@denext/denext@^${VERSION}/cli`;
  const result = await addMcp(dir, cli, {
    ...initOptions(ctx),
    dryRun,
    force: ctx.flags.force === true,
  });
  printInit(result, dryRun);
  if (result.errors.length > 0) Deno.exit(1);
}

/** What `denext mcp init` did, one line per file. */
function printInit({ written, skipped, errors }: AddMcpResult, dryRun: boolean): void {
  const verb = dryRun ? "would write" : "+";
  for (const p of written) console.log(`   ${verb} ${p}`);
  for (const p of skipped) console.log(`   • already present: ${p}`);
  for (const e of errors) console.error(`   ! ${e}`);
  if (dryRun) return;
  if (written.length > 0) {
    console.log(
      "\n  Restart your agent / editor (or reload its MCP servers) to pick up the denext server.",
    );
  } else if (skipped.length > 0) {
    console.log("  Nothing to do. `--force` rewrites the denext entries.");
  }
}

export const mcpCommand: CommandSpec = {
  name: "mcp",
  summary: "Run the denext MCP server (stdio) so agents/IDEs can call denext's tooling",
  usage: "  denext mcp                     # speak MCP over stdio (configure as an MCP server)\n" +
    "  denext mcp --disable rag,docs # expose fewer tools to trim the client's context\n" +
    "  denext mcp init [dir] [--clients claude,vscode,cursor] [--disable <groups>] [--dry-run] [--force]\n" +
    "\n  Tools: denext_check_snippet, denext_import_map, denext_generate, denext_doctor,\n" +
    "  denext_codemod, denext_list_routes, denext_dev_logs, denext_render, denext_route_map,\n" +
    "  denext_search_docs, denext_index_codebase, denext_query_codebase, denext_find_definition,\n" +
    "  denext_find_references. Resources: denext://guide, denext://import-map.\n" +
    `\n  --disable takes a comma-separated list of groups (${GROUP_NAMES}) and/or tool\n` +
    "  names (with or without the denext_ prefix), e.g. --disable rag,docs or --disable render.\n" +
    "\n  init  adds a `mcp` task to deno.json (the denext version the project pins, so the server\n" +
    "        matches the framework) and registers it as the `denext` server in each client's\n" +
    "        project-level config, beside any servers already there. --clients picks (or `all`):\n" +
    CLIENT_LINES + "\n" +
    "        --disable is baked into the task; --force rewrites an existing denext entry/task.",
  positionals: [
    { name: "action", help: "init (omit to serve MCP over stdio)" },
    { name: "dir", help: "Project directory for init (default: .)" },
  ],
  flags: [
    {
      name: "disable",
      type: "string",
      valueName: "<groups|tools>",
      help: `Comma-separated groups (${GROUP_NAMES}) and/or tool names to hide`,
    },
    {
      name: "clients",
      type: "string",
      valueName: "<list>",
      help: `init: clients to configure (${MCP_CLIENTS.join(", ")}, all; default: ${
        DEFAULT_MCP_CLIENTS.join(",")
      })`,
    },
    { name: "dry-run", type: "boolean", help: "init: print what would change; write nothing" },
    { name: "force", type: "boolean", help: "init: rewrite an existing denext entry and task" },
  ],
  loadsModules: false,
  run: async (ctx) => {
    const action = ctx.positionals[0];
    if (action === "init") return await runInit(ctx);
    if (action !== undefined) {
      console.error(`denext mcp: unknown action "${action}". Try: denext mcp init [dir]`);
      Deno.exit(1);
    }
    const spec = typeof ctx.flags.disable === "string" ? ctx.flags.disable : "";
    const { names, unknown } = resolveToolNames(spec.split(","));
    // Everything but the JSON-RPC stream goes to stderr so it never corrupts the protocol.
    if (unknown.length > 0) {
      console.error(
        `denext mcp: ignoring unknown --disable token(s): ${unknown.join(", ")}`,
      );
    }
    const tools = activeTools(names);
    if (names.size > 0) {
      console.error(
        `denext mcp: ${tools.length} tool(s) enabled, ${names.size} disabled.`,
      );
    }
    await runStdioServer({ tools });
  },
};
