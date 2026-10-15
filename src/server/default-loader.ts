// The default module loader, apart from `src/server/mod.ts` so the CLI's project-verb discovery
// (`denext commands`, completions) can load a project's plugins without importing the server.

import { toFileUrl } from "@std/path";
import { inRootContext } from "./root-context.ts";
import type { ModuleLoader } from "./types.ts";

/**
 * Default module loader: dynamic import by absolute file path. A module is shared by every
 * request, so it is loaded outside the request that first asks for it: its top-level code, and
 * anything that code schedules, never runs as that request.
 */
export const defaultLoader: ModuleLoader = (filePath): Promise<unknown> => {
  const url = filePath.startsWith("file:") ? filePath : toFileUrl(filePath).href;
  return inRootContext(() => import(url));
};
