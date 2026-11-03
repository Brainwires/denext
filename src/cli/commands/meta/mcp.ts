// The help text of `denext mcp` (the verb's summary, usage, flags and positionals: what `--help`,
// `denext --help`, shell completions and the CLI reference print), implemented in ../mcp.ts. Edit
// it here, then run `deno task gen:command-table` (or `deno task regen`). Not published:
// scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the verb's spec
// reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { DEFAULT_MCP_CLIENTS, MCP_CLIENT_FILES, MCP_CLIENTS } from "../../../build/mcp-template.ts";
import { TOOL_GROUPS } from "../../../mcp/tools.ts";

/** Group names an operator can pass to `--disable`, for the usage text. */
export const GROUP_NAMES = Object.keys(TOOL_GROUPS).join(", ");

/** The client → file lines of `denext mcp init`'s usage. */
export const CLIENT_LINES = MCP_CLIENTS.map((c) =>
  `    ${c.padEnd(7)} ${MCP_CLIENT_FILES[c]}${DEFAULT_MCP_CLIENTS.includes(c) ? "  (default)" : ""}`
).join("\n");

/** `denext mcp`. */
export const mcpMeta: CommandMeta = {
  name: "mcp",
  summary: "Run the denext MCP server (stdio) so agents/IDEs can call denext's tooling",
  usage: "  denext mcp                     # speak MCP over stdio (configure as an MCP server)\n" +
    "  denext mcp --disable rag,docs # expose fewer tools to trim the client's context\n" +
    "  denext mcp init [dir] [--clients claude,vscode,cursor] [--disable <groups>] [--dry-run] [--force]\n" +
    "\n  Tools: denext_check_snippet, denext_import_map, denext_generate, denext_doctor,\n" +
    "  denext_codemod, denext_list_routes, denext_dev_logs, denext_render, denext_route_map,\n" +
    "  denext_search_docs, denext_index_codebase, denext_query_codebase, denext_find_definition,\n" +
    "  denext_find_references, and denext_ui_* (every denext ui panel, through the UI's own\n" +
    "  loopback server: token handshake, CSRF, preview before apply; --ui-read-only refuses\n" +
    "  every change). Resources: denext://guide, denext://import-map.\n" +
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
    {
      name: "ui-read-only",
      type: "boolean",
      help: "Start the denext_ui_* tools' UI with --read-only: every change is refused",
    },
    {
      name: "ui-offline",
      type: "boolean",
      help: "Start the denext_ui_* tools' UI with --offline",
    },
    { name: "dry-run", type: "boolean", help: "init: print what would change; write nothing" },
    { name: "force", type: "boolean", help: "init: rewrite an existing denext entry and task" },
  ],
  loadsModules: false,
};
