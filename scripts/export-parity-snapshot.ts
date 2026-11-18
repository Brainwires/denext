// Regenerate the `output: "export"` parity snapshots: for each variant of
// tests/fixtures/export-parity/app.ts, install the pinned Next.js in a temp dir, run
// `next build` with `output: "export"`, and record the files it wrote to `out/` (outside
// `_next/`) in tests/fixtures/export-parity/next-<variant>.json. The parity test
// (tests/e2e/next-compat-export-parity.test.ts) compares `denext export` against these, so CI
// needs no Node or Next.
//
//   deno run -A scripts/export-parity-snapshot.ts
//
// Needs Node and npm on PATH. Runs niced; each variant installs into its own temp dir.

import { fromFileUrl, join } from "@std/path";
import {
  comparableFiles,
  listFiles,
  NEXT_VERSION,
  REACT_VERSION,
  VARIANTS,
  writeParityApp,
} from "../tests/fixtures/export-parity/app.ts";

const FIXTURE_DIR = fromFileUrl(new URL("../tests/fixtures/export-parity/", import.meta.url));

/** Run `cmd args` in `cwd` (niced where `nice` exists), throwing with its output on failure. */
async function run(cwd: string, cmd: string, args: string[]): Promise<void> {
  const nice = Deno.build.os !== "windows";
  const out = await new Deno.Command(nice ? "nice" : cmd, {
    args: nice ? ["-n", "10", cmd, ...args] : args,
    cwd,
    env: { NEXT_TELEMETRY_DISABLED: "1", CI: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    const dec = new TextDecoder();
    throw new Error(
      `${cmd} ${args.join(" ")} failed:\n${dec.decode(out.stdout)}\n${dec.decode(out.stderr)}`,
    );
  }
}

for (const variant of VARIANTS) {
  const dir = await Deno.makeTempDir({ prefix: `denext_next_export_${variant.name}_` });
  try {
    await writeParityApp(dir, variant, "next");
    await run(dir, "npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"]);
    await run(dir, "npx", ["--no-install", "next", "build"]);
    const files = comparableFiles(await listFiles(join(dir, "out")));
    const snapshot = { next: NEXT_VERSION, react: REACT_VERSION, variant, files };
    const file = join(FIXTURE_DIR, `next-${variant.name}.json`);
    await Deno.writeTextFile(file, JSON.stringify(snapshot, null, 2) + "\n");
    console.log(`${variant.name}: ${files.length} files -> ${file}`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
