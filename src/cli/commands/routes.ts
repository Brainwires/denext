// `denext routes` — the app's pages and API route handlers as a table (or `--json`), read
// from `app/` without running project code. The same listing backs the MCP
// `denext_list_routes` tool (`src/build/route-list.ts`).

import type { CommandSpec } from "../command.ts";
import { collectRoutes, formatRouteTable } from "../../build/route-list.ts";
import { projectDir } from "../shared.ts";
import { commandMeta } from "../command-meta.ts";

/** `denext routes [dir]`. */
export const routesCommand: CommandSpec = {
  ...commandMeta("routes"),
  run: async (ctx) => {
    const list = await collectRoutes(projectDir(ctx));
    if (ctx.global.json) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    console.log(formatRouteTable(list));
  },
};
