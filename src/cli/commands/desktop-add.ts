// `denext desktop add sidecar …` appends a backend to desktop.sidecars instead.
// `denext desktop add <capability...>`: enable Deno Desktop capabilities in desktop.capabilities
// (./../../build/desktop-capabilities.ts). `--list` prints the table, `--dry-run` prints the
// config diff and the permissions without writing. Wired into `denext desktop` as the `add`
// action; the flags below are spread into that command's flag list.

import { resolve } from "@std/path";
import type { CommandContext, FlagSpec } from "../command.ts";
import { addDesktopSidecar } from "../../build/desktop-sidecar-add.ts";
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
  {
    name: "name",
    type: "string",
    valueName: "<name>",
    help: "add sidecar: the sidecar's name (lower-case letters, digits and -)",
  },
  {
    name: "node-modules",
    type: "string",
    valueName: "<dir>",
    help: "add sidecar: the --entry module's node_modules (a Node backend, bundled at packaging)",
  },
  {
    name: "exec",
    type: "string",
    valueName: "<program>",
    help: "add sidecar: a program to spawn instead of a module",
  },
  {
    name: "ready",
    type: "string",
    valueName: "<path>",
    help: "add sidecar: a path polled on its port until it answers 2xx (e.g. /health)",
  },
  { name: "proxy", type: "boolean", help: "add sidecar: point spa.proxy at it" },
];

/** `denext desktop add sidecar --name <n> (--entry <module> [--node-modules <dir>] | --exec <p>)`. */
async function desktopAddSidecar(ctx: CommandContext): Promise<void> {
  const dryRun = ctx.flags["dry-run"] === true;
  const str = (k: string) => ctx.flags[k] as string | undefined;
  try {
    const report = await addDesktopSidecar({
      dir: resolve(ctx.global.cwd ?? "."),
      name: str("name") ?? "",
      ...(str("entry") !== undefined ? { entry: str("entry") } : {}),
      ...(str("node-modules") !== undefined ? { nodeModules: str("node-modules") } : {}),
      ...(str("exec") !== undefined ? { exec: str("exec") } : {}),
      ...(str("ready") !== undefined ? { ready: str("ready") } : {}),
      proxy: ctx.flags.proxy === true,
      dryRun,
    });
    if (ctx.global.json) return console.log(JSON.stringify(report));
    console.log(
      `\n  denext desktop add sidecar${dryRun ? " --dry-run (nothing changed)" : ""}\n\n` +
        report.diff + "\n" + report.notes.map((n) => `  • ${n}`).join("\n") + "\n",
    );
  } catch (err) {
    console.error(
      `denext desktop add sidecar: ${err instanceof Error ? err.message : String(err)}`,
    );
    Deno.exit(1);
  }
}

/**
 * `denext desktop add <capability...> [--dry-run] [--list]`: capabilities are the positionals
 * after `add`; the project is `--cwd` (default: the current directory).
 *
 * @param ctx The parsed command line.
 */
export async function desktopAdd(ctx: CommandContext): Promise<void> {
  if (ctx.positionals[1] === "sidecar") return await desktopAddSidecar(ctx);
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
