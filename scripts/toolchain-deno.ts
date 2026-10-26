// Run `deno <args>` on denext's Deno toolchain — the running Deno when it already is one, else
// the pinned build `resolveDenoToolchain` downloads and verifies — and exit with its code. When it
// can't be had (`DENEXT_DENO=stock` included) the resolver's `denext:` error says the fix.
//
//   deno run -A scripts/toolchain-deno.ts coverage coverage/profile --include=/src/ ...
//
// The coverage gates report with it: `scripts/test-run.ts --coverage=<dir>` runs every pass on
// the toolchain, and only the toolchain's `deno coverage` (2.9.7-denext.17 on) merges a module's
// plain-run and Vitest-run profiles, from its own `DENO_DIR` emit cache.

import { toolchainDeno } from "./test-run.ts";

if (import.meta.main) {
  const bin = await toolchainDeno();
  const { code } = await new Deno.Command(bin, {
    args: Deno.args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  Deno.exit(code);
}
