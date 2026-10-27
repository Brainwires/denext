// The workflows that build with denext's pinned Gleam cache its download, keyed on the pin's version
// and the SHA-256 of the archive for the runner's target (src/build/gleam-toolchain-pin.json), at
// the directory the CLI installs it into (src/build/gleam-toolchain.ts). The cache only saves the
// download: the CLI verifies what it finds there before running it.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { parse } from "@std/yaml";
import pin from "../src/build/gleam-toolchain-pin.json" with { type: "json" };
import { gleamToolchainStatus } from "../src/build/gleam-toolchain.ts";

const DIR = fromFileUrl(new URL("../.github/workflows/", import.meta.url));

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}
interface Job {
  "runs-on"?: string;
  steps?: Step[];
}

/** Whether a step runs the suites that build with the pinned Gleam (the Lustre e2e tests). */
function buildsWithGleam(step: Step): boolean {
  return /test:e2e|lustre\.e2e|DENEXT_TEST_GLEAM_DOWNLOAD=1/.test(step.run ?? "");
}

/** Every job, by `<workflow>#<job>`, of the workflows. */
async function jobs(): Promise<[string, Job][]> {
  const out: [string, Job][] = [];
  for await (const entry of Deno.readDir(DIR)) {
    if (!entry.isFile || !/\.ya?ml$/.test(entry.name)) continue;
    const wf = parse(await Deno.readTextFile(join(DIR, entry.name))) as {
      jobs?: Record<string, Job>;
    };
    for (const [name, job] of Object.entries(wf.jobs ?? {})) {
      out.push([`${entry.name}#${name}`, job]);
    }
  }
  return out;
}

/** Whether `cmd` runs here (the pin step's script needs bash and jq). */
async function has(cmd: string): Promise<boolean> {
  try {
    return (await new Deno.Command(cmd, { args: ["--version"], stdout: "null", stderr: "null" })
      .output()).success;
  } catch {
    return false;
  }
}

Deno.test("every job that builds with the pinned Gleam caches it before the build", async () => {
  const gleamJobs = (await jobs()).filter(([, job]) => (job.steps ?? []).some(buildsWithGleam));
  assert(gleamJobs.length > 0, "no workflow job builds with the pinned Gleam");
  for (const [name, job] of gleamJobs) {
    const steps = job.steps ?? [];
    const pinAt = steps.findIndex((s) => s.id === "gleam-pin");
    const cacheAt = steps.findIndex((s) =>
      s.uses?.startsWith("actions/cache@") && s.with?.path?.includes("steps.gleam-pin.outputs.path")
    );
    const buildAt = steps.findIndex(buildsWithGleam);
    assert(pinAt >= 0, `${name}: no gleam-pin step`);
    assert(
      cacheAt > pinAt && cacheAt < buildAt,
      `${name}: the Gleam cache is not before the build`,
    );
    assertEquals(steps[cacheAt].with?.key, "${{ steps.gleam-pin.outputs.key }}", name);
    assert(!steps[cacheAt].with?.["restore-keys"], `${name}: a stale pin must never be restored`);
    assert(steps[pinAt].run?.includes("src/build/gleam-toolchain-pin.json"), name);
  }
});

Deno.test({
  name: "the gleam-pin step names the CLI's install directory and the pin's version and SHA-256",
  ignore: !(await has("bash")) || !(await has("jq")) || Deno.build.os === "windows",
}, async () => {
  const [[name, job]] = (await jobs()).filter(([, j]) => (j.steps ?? []).some(buildsWithGleam));
  const script = job.steps!.find((s) => s.id === "gleam-pin")!.run!;
  const home = await Deno.makeTempDir({ prefix: "denext-gleam-pin-" });
  try {
    const out = join(home, "github-output");
    const run = await new Deno.Command("bash", {
      args: ["-e", "-c", script],
      cwd: fromFileUrl(new URL("..", import.meta.url)),
      env: { HOME: home, RUNNER_ARCH: "X64", GITHUB_OUTPUT: out, PATH: Deno.env.get("PATH") ?? "" },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(run.success, `${name}: ${new TextDecoder().decode(run.stderr)}`);
    const outputs = Object.fromEntries(
      (await Deno.readTextFile(out)).trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)),
    );
    const target = "linux-x86_64";
    const sha = (pin.targets as Record<string, { sha256: string }>)[target].sha256;
    assertEquals(outputs.key, `gleam-${target}-${pin.version}-${sha}`);
    // the directory the CLI installs into under the default Linux DENO_DIR
    const status = await gleamToolchainStatus({
      target,
      os: "linux",
      cacheRoot: join(home, ".cache", "deno", "denext-deno"),
      env: () => undefined,
    });
    assertEquals(outputs.path, dirname(status.path!));
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
