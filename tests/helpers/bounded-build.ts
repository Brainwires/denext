// A full app build or export, run outside the test process and bounded.
//
// `deno test --parallel` runs every test file on a thread of ONE process. On Windows a process
// spawned from one thread inherits every inheritable pipe handle that exists at that moment, the
// pipes another thread just made for its own child included (Deno's Windows spawn takes no
// process-wide lock around pipe creation and `CreateProcessW`). A long-lived child (an esbuild
// service, a server) that inherits the write end of a short child's stdout keeps it open: the
// build's `await new Deno.Command(…).output()` (a `deno info`, a `deno bundle`) never sees EOF,
// and nothing in the test process can stop it, so the CI job hangs until its own timeout.
//
// Here the build runs in a child `deno run` of its own (`inChild`: denext's own import map, the
// same code path as an in-process call, coverage collected under the coverage tasks), where only
// one thread spawns. Past the deadline the child's whole tree is killed and the test fails with
// what the build printed, the phase it stalled in.

import type { BuildResult } from "../../src/build/build.ts";
import type { StaticExportOptions, StaticExportResult } from "../../src/build/export.ts";
import { CHILD_DEADLINE_MS, inChild } from "./isolated.ts";

/** Run `build(dir)` (`src/build/build.ts`) in a bounded child process. */
export async function buildInChild(
  dir: string,
  timeoutMs: number = CHILD_DEADLINE_MS,
): Promise<BuildResult> {
  const { value } = await inChild<BuildResult>({
    imports: `import { build } from "@repo/src/build/build.ts";`,
    body: `return await build(${JSON.stringify(dir)});`,
    timeoutMs,
  });
  return value;
}

/** Run `staticExport(dir, options)` (`src/build/export.ts`) in a bounded child process. */
export async function exportInChild(
  dir: string,
  options: StaticExportOptions = {},
  timeoutMs: number = CHILD_DEADLINE_MS,
): Promise<StaticExportResult> {
  const { value } = await inChild<StaticExportResult>({
    imports: `import { staticExport } from "@repo/src/build/export.ts";`,
    body: `return await staticExport(${JSON.stringify(dir)}, ${JSON.stringify(options)});`,
    timeoutMs,
  });
  return value;
}
