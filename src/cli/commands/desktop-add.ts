// `denext desktop add <capability...>`: enable Deno Desktop capabilities in desktop.capabilities
// (./../../build/desktop-capabilities.ts). `--list` prints the table, `--dry-run` prints the
// config diff and the permissions without writing. Wired into `denext desktop` as the `add`
// action; the flags below are spread into that command's flag list.

import { resolve } from "@std/path";
import type { CommandContext, FlagSpec } from "../command.ts";
import {
  addDesktopCapabilities,
  type AddDesktopCapabilitiesReport,
  DESKTOP_CAPABILITIES,
  formatDesktopAddReport,
  formatDesktopCapabilityTable,
} from "../../build/desktop-capabilities.ts";

/** The flags `desktop add` reads (declared on the `desktop` command). */
export const DESKTOP_ADD_FLAGS: readonly FlagSpec[] = [
  { name: "list", type: "boolean", help: "add: list the desktop capabilities and what they need" },
  { name: "dry-run", type: "boolean", help: "add: print the config diff and permissions only" },
];

/**
 * `denext desktop add <capability...> [--dry-run] [--list]`: capabilities are the positionals
 * after `add`; the project is `--cwd` (default: the current directory).
 *
 * @param ctx The parsed command line.
 */
export async function desktopAdd(ctx: CommandContext): Promise<void> {
  if (ctx.flags.list === true) {
    if (ctx.global.json) return console.log(JSON.stringify(DESKTOP_CAPABILITIES));
    console.log(
      "\n  denext desktop add <capability...>\n\n" +
        `  ${"name".padEnd(15)}${"config key".padEnd(15)}${"trust".padEnd(8)}what it enables\n` +
        formatDesktopCapabilityTable() + "\n",
    );
    return;
  }
  const dryRun = ctx.flags["dry-run"] === true;
  let report: AddDesktopCapabilitiesReport;
  try {
    report = await addDesktopCapabilities({
      capabilities: ctx.positionals.slice(1),
      dir: resolve(ctx.global.cwd ?? "."),
      dryRun,
    });
  } catch (err) {
    console.error(`denext desktop add: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
  if (ctx.global.json) return console.log(JSON.stringify(report));
  console.log(
    `\n  denext desktop add${dryRun ? " --dry-run (nothing changed)" : ""}\n\n` +
      formatDesktopAddReport(report, dryRun) + "\n",
  );
}
