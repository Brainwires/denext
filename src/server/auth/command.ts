/**
 * The `denext auth` CLI verb, contributed by the `denextAuth()` plugin through the `addCommand`
 * seam (so it exists in any project whose config lists the plugin, and runs against that
 * config's adapter and `secret`):
 *
 * - `denext auth reseal [--dry-run] [--page-size <n>] [--json]` — move every TOTP factor sealed
 *   under a retired `secret` onto the current one ({@linkcode resealTotpFactors}).
 *
 * Output is counts only; no secret is ever printed.
 *
 * @module
 */

import { resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../../cli/command.ts";
import { type ResealReport, resealTotpFactors } from "./reseal.ts";
import type { AuthConfig } from "./types.ts";

/** How the command talks to the world — injectable so tests need no process. */
export interface AuthCommandIo {
  /** Standard output. */
  log: (line: string) => void;
  /** Standard error. */
  error: (line: string) => void;
  /** Terminate with a status. */
  exit: (code: number) => void;
}

const defaultIo: AuthCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  exit: (code) => Deno.exit(code),
};

const USAGE = [
  "Usage: denext auth <action> [options]",
  "",
  "  reseal      Re-seal every TOTP factor under the current auth `secret`, so a",
  "              retired secret can be removed from the list once `remaining` is 0",
  "",
  "Options:",
  "  --dry-run         Count what would change; write nothing",
  "  --page-size <n>   Users read per page (default 200)",
  "  --json            Print the report as JSON",
].join("\n");

/**
 * Build the `denext auth` command spec for one auth config.
 *
 * @param config The config `denextAuth()` was built with.
 * @param io Output and exit (injectable for tests).
 * @returns The command spec.
 */
export function createAuthCommand(config: AuthConfig, io: AuthCommandIo = defaultIo): CommandSpec {
  return {
    name: "auth",
    summary: "Auth maintenance: re-seal TOTP factors under the current secret",
    usage: USAGE,
    positionals: [{ name: "action", help: "reseal" }],
    flags: [
      { name: "dry-run", type: "boolean", help: "Count what would change; write nothing" },
      { name: "page-size", type: "number", help: "Users read per page (default 200)" },
    ],
    loadsModules: true,
    // The positional is the action, not the project dir — derive it from --cwd like `denext job`.
    moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
    run: (ctx) => runAuthCommand(ctx, config, io),
  };
}

/** The human-readable report lines. */
function reportLines(report: ResealReport): string[] {
  const lines = [
    `auth reseal${report.dryRun ? " (dry run — nothing written)" : ""}:`,
    `  users scanned:      ${report.users}`,
    `  TOTP factors:       ${report.factors}`,
    `  already current:    ${report.current}`,
    `  re-sealed:          ${report.resealed}`,
    `  remaining:          ${report.remaining}`,
  ];
  if (report.unopenable > 0) {
    lines.push(
      `  unopenable:         ${report.unopenable} (no configured secret opens them; ` +
        "`disableTotp` lets their users enroll again)",
    );
  }
  lines.push(
    report.remaining === 0
      ? "No factor needs a retired secret: secrets after the first can be removed."
      : report.dryRun
      ? "Run without --dry-run to re-seal them."
      : "Some factors still need a retired secret: run it again.",
  );
  return lines;
}

async function runAuthCommand(
  ctx: CommandContext,
  config: AuthConfig,
  io: AuthCommandIo,
): Promise<void> {
  const action = ctx.positionals[0];
  if (action !== "reseal") {
    io.error(action ? `auth: unknown action "${action}"\n\n${USAGE}` : USAGE);
    io.exit(2);
    return;
  }
  const pageSize = ctx.flags["page-size"];
  const report = await resealTotpFactors(config, {
    dryRun: ctx.flags["dry-run"] === true,
    ...(typeof pageSize === "number" ? { pageSize } : {}),
  });
  if (ctx.global.json) io.log(JSON.stringify(report));
  else for (const line of reportLines(report)) io.log(line);
  // A real run that left work behind is a failure a scheduler should see.
  if (!report.dryRun && report.remaining > 0) io.exit(1);
}
