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

import type { CommandSpec } from "../command.ts";
import { runStdioServer } from "../../mcp/server.ts";
import { activeTools, resolveToolNames, TOOL_GROUPS } from "../../mcp/tools.ts";

/** Group names an operator can pass to `--disable`, for the usage text. */
const GROUP_NAMES = Object.keys(TOOL_GROUPS).join(", ");

export const mcpCommand: CommandSpec = {
  name: "mcp",
  summary: "Run the denext MCP server (stdio) so agents/IDEs can call denext's tooling",
  usage: "  denext mcp                     # speak MCP over stdio (configure as an MCP server)\n" +
    "  denext mcp --disable rag,docs # expose fewer tools to trim the client's context\n" +
    "\n  Tools: denext_check_snippet, denext_import_map, denext_generate, denext_doctor,\n" +
    "  denext_codemod, denext_list_routes, denext_dev_logs, denext_render, denext_route_map,\n" +
    "  denext_search_docs, denext_index_codebase, denext_query_codebase, denext_find_definition,\n" +
    "  denext_find_references. Resources: denext://guide, denext://import-map.\n" +
    `\n  --disable takes a comma-separated list of groups (${GROUP_NAMES}) and/or tool\n` +
    "  names (with or without the denext_ prefix), e.g. --disable rag,docs or --disable render.",
  flags: [
    {
      name: "disable",
      type: "string",
      valueName: "<groups|tools>",
      help: `Comma-separated groups (${GROUP_NAMES}) and/or tool names to hide`,
    },
  ],
  loadsModules: false,
  run: async (ctx) => {
    const spec = typeof ctx.flags.disable === "string" ? ctx.flags.disable : "";
    const { names, unknown } = resolveToolNames(spec.split(","));
    // Everything but the JSON-RPC stream goes to stderr so it never corrupts the protocol.
    if (unknown.length > 0) {
      console.error(`denext mcp: ignoring unknown --disable token(s): ${unknown.join(", ")}`);
    }
    const tools = activeTools(names);
    if (names.size > 0) {
      console.error(`denext mcp: ${tools.length} tool(s) enabled, ${names.size} disabled.`);
    }
    await runStdioServer({ tools });
  },
};
