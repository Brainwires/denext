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
import { setUiBridgeOptions, stopUiBridges } from "../../mcp/ui.ts";
import { activeTools, resolveToolNames } from "../../mcp/tools.ts";
import { VERSION } from "../../../mod.ts";
import { DENEXT_TASK_CLI_SPEC, pinnedDenextCli } from "../self-exec.ts";
import {
  addMcp,
  type AddMcpResult,
  MCP_CLIENTS,
  type McpClient,
  parseMcpClients,
} from "../../build/mcp-template.ts";
import { commandMeta } from "../command-meta.ts";

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
  // The task runs the denext this project pins; a project without a pin gets this CLI's own, and
  // so does one whose pin can't be written into a task command line (`>=…`, `*`).
  const own = `jsr:@denext/denext@^${VERSION}/cli`;
  const pinned = pinnedDenextCli(dir);
  const taskSafe = pinned !== null && DENEXT_TASK_CLI_SPEC.test(pinned);
  if (pinned !== null && !taskSafe) {
    console.error(
      `   !! WARNING: the project's denext pin ${pinned} can't run from a task; using ${own}`,
    );
  }
  const cli = taskSafe ? pinned : own;
  const result = await addMcp(dir, cli, {
    ...initOptions(ctx),
    dryRun,
    force: ctx.flags.force === true,
  });
  printInit(result, dryRun);
  if (result.errors.length > 0) Deno.exit(1);
}

/** What `denext mcp init` did, one line per file. */
function printInit(
  { written, skipped, errors, warnings = [] }: AddMcpResult,
  dryRun: boolean,
): void {
  const verb = dryRun ? "would write" : "+";
  for (const p of written) console.log(`   ${verb} ${p}`);
  for (const p of skipped) console.log(`   • already present: ${p}`);
  for (const w of warnings) console.error(`   !! WARNING: ${w}`);
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
  ...commandMeta("mcp"),
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
    setUiBridgeOptions({
      readOnly: ctx.flags["ui-read-only"] === true,
      offline: ctx.flags["ui-offline"] === true,
    });
    try {
      await runStdioServer({ tools });
    } finally {
      // The denext_ui_* tools' UI children end with the server.
      stopUiBridges();
    }
  },
};
