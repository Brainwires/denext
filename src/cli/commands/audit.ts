// `denext audit` — turn the zero-npm runtime guarantee into evidence: a dependency
// inventory by registry, a proof that the app's own runtime source imports no npm
// package, a least-privilege permission suggestion, and (with `--sbom`/`--json`) a
// CycloneDX SBOM. Exits non-zero when the app's runtime source pulls in npm and
// `--strict` is set (a CI gate for the zero-npm claim).

import type { CommandSpec } from "../command.ts";
import { projectDir } from "../shared.ts";
import { auditProject, toCycloneDx } from "../../build/audit.ts";

export const auditCommand: CommandSpec = {
  name: "audit",
  summary: "Audit dependencies + prove the runtime is zero-npm",
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [
    { name: "sbom", type: "boolean", help: "Emit a CycloneDX SBOM (JSON)" },
    { name: "strict", type: "boolean", help: "Exit non-zero if runtime source imports npm" },
  ],
  run: async (ctx) => {
    const dir = projectDir(ctx);
    const report = await auditProject(dir);

    if (ctx.flags.sbom === true || ctx.global.json) {
      console.log(JSON.stringify(toCycloneDx(report), null, 2));
      if (ctx.flags.strict === true && report.runtimeNpmOffenders.length > 0) Deno.exit(1);
      return;
    }

    console.log(`\n  denext audit  ▸  ${dir}\n`);

    const byKind = new Map<string, number>();
    for (const d of report.deps) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);
    console.log(`  Dependencies (${report.deps.length}):`);
    for (const [kind, n] of [...byKind].sort()) console.log(`    ${kind.padEnd(10)} ${n}`);

    console.log("");
    if (report.runtimeNpmOffenders.length === 0) {
      console.log("  ✔ zero-npm runtime — no app source import resolves to an npm package.");
    } else {
      console.log(`  ✖ ${report.runtimeNpmOffenders.length} runtime npm import(s):`);
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
      `\n  Suggested least-privilege permissions (starting point):\n    ${
        report.permissions.join(" ")
      }\n`,
    );

    if (ctx.flags.strict === true && report.runtimeNpmOffenders.length > 0) Deno.exit(1);
  },
};
