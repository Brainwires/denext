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

export const mcpCommand: CommandSpec = {
  name: "mcp",
  summary: "Run the denext MCP server (stdio) so agents/IDEs can call denext's tooling",
  usage: "  denext mcp        # speak MCP over stdio (configure this as an MCP server command)\n" +
    "\n  Tools: denext_check_snippet, denext_import_map, denext_generate, denext_doctor,\n" +
    "  denext_codemod. Resources: denext://guide, denext://import-map.",
  loadsModules: false,
  run: async () => {
    await runStdioServer();
  },
};
