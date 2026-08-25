/**
 * The `denext htmx` CLI verb, contributed by the {@linkcode htmx | htmx plugin}
 * through the plugin `addCommand` seam. Two actions:
 *
 * - `denext htmx info` — print the vendored htmx version and where it's served.
 * - `denext htmx eject [dir]` — copy `htmx.min.js` into your project (default
 *   `public/`) to self-host or pin it without the request handler.
 *
 * @module
 */

import type { CommandContext, CommandSpec } from "@denext/denext/cli/command";
import { join } from "@std/path";
import { HTMX_RUNTIME_PATH, HTMX_VERSION } from "./constants.ts";

// Re-export the denext CLI types this entrypoint's public API references (and their
// transitively-referenced members), so the generated docs are self-contained
// (deno doc --lint). Type-only; no runtime effect.
export type {
  CommandContext,
  CommandSpec,
  FlagSpec,
  FlagType,
  GlobalFlags,
  PositionalSpec,
} from "@denext/denext/cli/command";

async function runtimeBytes(): Promise<Uint8Array> {
  const res = await fetch(new URL("./vendor/htmx.min.js", import.meta.url));
  return new Uint8Array(await res.arrayBuffer());
}

/** The `denext htmx` command specification. */
export const htmxCommand: CommandSpec = {
  name: "htmx",
  summary: `Manage the vendored htmx runtime (v${HTMX_VERSION})`,
  usage: [
    "Usage: denext htmx <action>",
    "",
    "Actions:",
    "  info           Print the vendored htmx version and runtime URL (default)",
    "  eject [dir]    Copy htmx.min.js into the project (default: public/)",
  ].join("\n"),
  positionals: [
    { name: "action", help: "info | eject" },
    { name: "dir", help: "eject target directory (default: public)" },
  ],
  async run(ctx: CommandContext): Promise<void> {
    const action = ctx.positionals[0] ?? "info";
    if (action === "info") {
      const bytes = await runtimeBytes();
      console.log(`@denext/htmx wraps htmx v${HTMX_VERSION}`);
      console.log(`  runtime path: ${HTMX_RUNTIME_PATH}`);
      console.log(`  size:         ${(bytes.byteLength / 1024).toFixed(1)} KB raw`);
      console.log(`  served from:  'self' (works under a strict script-src 'self' CSP)`);
      return;
    }
    if (action === "eject") {
      const dir = ctx.positionals[1] ?? "public";
      await Deno.mkdir(dir, { recursive: true });
      const dest = join(dir, "htmx.min.js");
      await Deno.writeFile(dest, await runtimeBytes());
      console.log(`Wrote htmx v${HTMX_VERSION} → ${dest}`);
      console.log(`Load it with <script src="/htmx.min.js" defer></script> (or keep <Htmx/>).`);
      return;
    }
    console.error(`Unknown action "${action}". Try: denext htmx info | eject [dir]`);
    throw new Error(`unknown htmx action: ${action}`);
  },
};
