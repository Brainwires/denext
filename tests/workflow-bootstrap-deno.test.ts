// The stock Deno the workflows install with denoland/setup-deno is a bootstrap, by design: it
// starts the job and runs only what must be stock — `deno fmt --check` / `deno lint` /
// `doc-lint` (reproducible formatting, and JSR scores what stock `deno publish` uploads),
// `deno publish` itself, and scripts that run no project code (the pick steps, cargo-audit). Every
// step that runs project code puts denext's toolchain on PATH first
// (scripts/ci/toolchain-on-path.ts, or scripts/test-run.ts, which runs every pass on it). So the
// workflows pin exactly two stock versions, each for one reason, and nothing else creeps in:
//
//   - BOOTSTRAP_DENO: the fmt / lint / bootstrap Deno (bump deliberately, then re-run `deno fmt`);
//   - the toolchain pin's own `deno` (src/build/deno-toolchain-pin.json): where a step needs the
//     stock Deno the pinned Deno Desktop runtime is built from (`deno desktop`, packaging).
//
// CONTRIBUTING.md → "CI's stock Deno is a bootstrap" says why it stays in the workflows instead of
// moving to the toolchain.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { parse } from "@std/yaml";
import toolchainPin from "../src/build/deno-toolchain-pin.json" with { type: "json" };

/** The stock Deno that bootstraps the jobs and runs fmt / lint / doc-lint / publish. */
const BOOTSTRAP_DENO = "2.9.6";

const DIR = fromFileUrl(new URL("../.github/workflows/", import.meta.url));

interface Step {
  uses?: string;
  with?: Record<string, unknown>;
}
interface Workflow {
  jobs?: Record<string, { steps?: Step[] }>;
}

/** The setup-deno steps' versions in one parsed workflow. */
function versionsIn(file: string, wf: Workflow): Array<{ where: string; version: string }> {
  return Object.entries(wf.jobs ?? {}).flatMap(([job, def]) =>
    (def.steps ?? [])
      .filter((step) => step.uses?.startsWith("denoland/setup-deno"))
      .map((step) => ({ where: `${file} ${job}`, version: String(step.with?.["deno-version"]) }))
  );
}

/** Every setup-deno step's version, across the workflows. */
async function setupDenoVersions(): Promise<Array<{ where: string; version: string }>> {
  const files = [...Deno.readDirSync(DIR)].filter((e) => e.isFile && /\.ya?ml$/.test(e.name));
  const all = await Promise.all(
    files.map(async (e) =>
      versionsIn(e.name, parse(await Deno.readTextFile(join(DIR, e.name))) as Workflow)
    ),
  );
  return all.flat().toSorted((a, b) => a.where.localeCompare(b.where));
}

Deno.test("workflows: setup-deno installs only the bootstrap Deno or the pin's base Deno", async () => {
  const steps = await setupDenoVersions();
  assert(steps.length > 0, "no setup-deno step found");
  const allowed = new Set([BOOTSTRAP_DENO, toolchainPin.deno]);
  assertEquals(
    steps.filter((s) => !allowed.has(s.version)),
    [],
    `setup-deno must install ${BOOTSTRAP_DENO} (the bootstrap) or ${toolchainPin.deno} (the ` +
      "toolchain pin's base Deno); a step that runs project code puts the toolchain on PATH",
  );
  // Both are in use: a version no step needs anymore belongs out of this test too.
  assertEquals(new Set(steps.map((s) => s.version)), allowed);
});

Deno.test("workflows: ci.yml's header and CONTRIBUTING.md document the bootstrap Deno", async () => {
  const ci = await Deno.readTextFile(join(DIR, "ci.yml"));
  assert(ci.includes(`stock Deno ${BOOTSTRAP_DENO} (setup-deno)`), "ci.yml's what-runs-on-what");
  const contributing = await Deno.readTextFile(
    fromFileUrl(new URL("../CONTRIBUTING.md", import.meta.url)),
  );
  assert(contributing.includes("CI's stock Deno is a bootstrap"));
  assert(contributing.includes(`Deno ${BOOTSTRAP_DENO}`));
});
