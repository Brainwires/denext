// `denext audit` — turn the zero-npm runtime guarantee into evidence: a dependency
// inventory by registry, a proof that the app's own runtime source imports no npm
// package, a baseline permission suggestion, and (with `--sbom`/`--json`) a CycloneDX
// SBOM. Exits non-zero when the app's runtime source pulls in npm and `--strict` is set
// (a CI gate for the zero-npm claim).
//
// Then it runs Deno's own `deno audit` (known vulnerabilities in the locked npm and JSR
// dependencies) on denext's Deno toolchain, with Deno's audit flags forwarded, and the verb's
// exit status is the two combined: non-zero when either fails. `--skip-deno-audit` leaves Deno's
// half out (offline CI, no lockfile).

import type { CommandContext, CommandSpec, FlagSpec } from "../command.ts";
import { projectDir } from "../shared.ts";
import { auditProject, toCycloneDx } from "../../build/audit.ts";
import { denoExecutable } from "../../build/bundle.ts";

/**
 * Deno's `deno audit` flags, declared so help lists them and the parser keeps their values; each
 * is forwarded as written. (`--ignore` takes its CVE list as one comma-separated value.)
 */
const DENO_AUDIT_FLAGS: readonly FlagSpec[] = [
  {
    name: "level",
    type: "string",
    valueName: "<severity>",
    help: "deno audit: only advisories at or above this severity",
  },
  { name: "ignore-unfixable", type: "boolean", help: "deno audit: skip advisories with no fix" },
  {
    name: "ignore-registry-errors",
    type: "boolean",
    help: "deno audit: exit 0 when the advisory service errors",
  },
  { name: "socket", type: "boolean", help: "deno audit: also check socket.dev" },
  { name: "fix", type: "boolean", help: "deno audit: upgrade packages to fix advisories" },
  {
    name: "ignore",
    type: "string",
    repeatable: true,
    valueName: "<cve,…>",
    help: "deno audit: ignore these CVE IDs",
  },
  { name: "lock", type: "string", valueName: "<file>", help: "deno audit: the lockfile to check" },
  { name: "no-lock", type: "boolean", help: "deno audit: don't discover the lockfile" },
  {
    name: "frozen-lockfile",
    type: "boolean",
    help: "deno audit: error when the lockfile is out of date",
  },
];

/**
 * The `deno audit` argv for this invocation: every declared Deno flag that was given, then
 * anything after a literal `--`.
 *
 * @param ctx The parsed invocation.
 * @returns The arguments after `deno`.
 */
export function denoAuditArgs(ctx: CommandContext): string[] {
  const args = ["audit"];
  for (const flag of DENO_AUDIT_FLAGS) {
    const value = ctx.flags[flag.name];
    if (value === undefined || value === false) continue;
    args.push(value === true ? `--${flag.name}` : `--${flag.name}=${value}`);
  }
  if (ctx.global.config) args.push("--config", ctx.global.config);
  if (ctx.global.quiet) args.push("--quiet");
  return [...args, ...ctx.rest];
}

/**
 * Runs `deno <args>` in `cwd` and resolves its exit code. When `toStderr` is set its stdout goes
 * to this process's stderr, so a JSON document on stdout (`--json` / `--sbom`) stays parseable.
 */
export type DenoAuditRunner = (args: string[], cwd: string, toStderr: boolean) => Promise<number>;

/** The production runner: the Deno the CLI runs on (denext's toolchain, once it switched). */
async function spawnDenoAudit(args: string[], cwd: string, toStderr: boolean): Promise<number> {
  const child = new Deno.Command(denoExecutable(), {
    args,
    cwd,
    stdin: "null",
    stdout: toStderr ? "piped" : "inherit",
    stderr: "inherit",
  }).spawn();
  if (toStderr) await child.stdout.pipeTo(Deno.stderr.writable, { preventClose: true });
  return (await child.status).code;
}

/**
 * The `audit` verb, running Deno's half through `runDenoAudit` (a seam for tests).
 *
 * @param runDenoAudit How `deno audit` is run.
 * @returns The command.
 */
export function makeAuditCommand(runDenoAudit: DenoAuditRunner = spawnDenoAudit): CommandSpec {
  return {
    name: "audit",
    summary: "Audit dependencies + prove the runtime is zero-npm, then run deno audit",
    usage:
      "denext's checks (dependency inventory, zero-npm runtime proof, permissions; --sbom),\n" +
      "then Deno's `deno audit` for known vulnerabilities, with its flags below forwarded\n" +
      "(and anything after `--`). Non-zero when either fails. Deno's audit alone:\n" +
      "`denext deno audit`.",
    positionals: [{ name: "dir", help: "Project directory (default: .)" }],
    flags: [
      { name: "sbom", type: "boolean", help: "Emit a CycloneDX SBOM (JSON)" },
      {
        name: "strict",
        type: "boolean",
        help: "Exit non-zero if runtime source imports npm",
      },
      { name: "skip-deno-audit", type: "boolean", help: "Run denext's checks only" },
      ...DENO_AUDIT_FLAGS,
    ],
    run: async (ctx) => {
      const dir = projectDir(ctx);
      const report = await auditProject(dir);
      const json = ctx.flags.sbom === true || ctx.global.json;
      if (json) {
        console.log(JSON.stringify(toCycloneDx(report), null, 2));
      } else {
        printAuditReport(dir, report);
      }
      let failed = ctx.flags.strict === true && report.runtimeNpmOffenders.length > 0;
      if (ctx.flags["skip-deno-audit"] !== true) {
        if (!json) console.log("  deno audit:");
        failed = await runDenoAudit(denoAuditArgs(ctx), dir, json) !== 0 || failed;
      }
      if (failed) Deno.exit(1);
    },
  };
}

export const auditCommand: CommandSpec = makeAuditCommand();

/** The human-readable audit: dependency counts, runtime npm offenders, permissions. */
function printAuditReport(
  dir: string,
  report: Awaited<ReturnType<typeof auditProject>>,
): void {
  console.log(`\n  denext audit  ▸  ${dir}\n`);
  const byKind = new Map<string, number>();
  for (const d of report.deps) {
    byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);
  }
  console.log(`  Dependencies (${report.deps.length}):`);
  for (const [kind, n] of [...byKind].sort()) {
    console.log(`    ${kind.padEnd(10)} ${n}`);
  }
  console.log("");
  if (report.runtimeNpmOffenders.length === 0) {
    console.log(
      "  ✔ zero-npm runtime — no app source import resolves to an npm package.",
    );
  } else {
    console.log(
      `  ✖ ${report.runtimeNpmOffenders.length} runtime npm import(s):`,
    );
    for (const o of report.runtimeNpmOffenders) console.log(`      ${o}`);
  }
  if (report.npmDeps.length > 0) {
    console.log(
      `\n  Note: ${report.npmDeps.length} npm entr(y/ies) in the import map ` +
        "(build-time or unused if not imported by runtime source): " +
        report.npmDeps.map((d) => d.specifier).join(", "),
    );
  }
  console.log(
    `\n  Suggested baseline permissions (starting point):\n    ${report.permissions.join(" ")}\n`,
  );
}
