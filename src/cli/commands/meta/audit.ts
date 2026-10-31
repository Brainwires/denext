// The help text of `denext audit` (the verb's summary, usage, flags and positionals: what `--help`,
// `denext --help`, shell completions and the CLI reference print), implemented in ../audit.ts. Edit
// it here, then run `deno task gen:command-table` (or `deno task regen`). Not published:
// scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the verb's spec
// reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { DENO_AUDIT_FLAGS } from "../audit.ts";

/** `denext audit`. */
export const auditMeta: CommandMeta = {
  name: "audit",
  summary: "Audit dependencies + prove the runtime is zero-npm, then run deno audit",
  usage: "denext's checks (dependency inventory, zero-npm runtime proof, permissions; --sbom),\n" +
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
};
