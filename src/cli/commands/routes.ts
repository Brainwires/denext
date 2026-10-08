// `denext routes` — the app's pages and API route handlers as a table (or `--json`), read
// from `app/` without running project code. The same listing backs the MCP
// `denext_list_routes` tool (`src/build/route-list.ts`).

import type { CommandSpec } from "../command.ts";
import { collectRoutes, formatRouteTable } from "../../build/route-list.ts";
import { projectDir } from "../shared.ts";

/** `denext routes [dir]`. */
export const routesCommand: CommandSpec = {
  name: "routes",
  summary: "List the app's pages and API routes (a table, or --json)",
  usage: "Scans app/ (or src/app/) without importing any route module: each route's kind,\n" +
    "path, HTTP methods (an API route's exported handlers, read from its source), dynamic\n" +
    "params and file. --json prints { pages, api } for scripts.",
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  run: async (ctx) => {
    const list = await collectRoutes(projectDir(ctx));
    if (ctx.global.json) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    console.log(formatRouteTable(list));
  },
};
