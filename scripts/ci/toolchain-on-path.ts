// Put denext's Deno toolchain first on a GitHub Actions job's PATH, so every later step's `deno`
// (and every `deno` a task or test starts) is the build users run, not the stock Deno that
// bootstrapped the job.
//
//   deno run -A scripts/ci/toolchain-on-path.ts
//
// The toolchain is the pinned build `resolveDenoToolchain` downloads and verifies (SHA-256) into
// `<DENO_DIR>/denext-deno/`, the same install `scripts/test-run.ts --coverage` uses, so a job that
// caches its DENO_DIR caches the toolchain too. The directory goes to `$GITHUB_PATH`, which
// applies from the NEXT step on: steps before this one (fmt, lint) keep the stock Deno.
// `DENEXT_DENO=stock` is refused: a job that asks for the toolchain must get it.

import { dirname } from "@std/path";
import { toolchainDeno } from "../test-run.ts";

if (import.meta.main) {
  const bin = await toolchainDeno();
  if (bin === null) throw new Error("DENEXT_DENO=stock: this job runs on denext's Deno toolchain");
  const githubPath = Deno.env.get("GITHUB_PATH");
  if (!githubPath) throw new Error("GITHUB_PATH is not set: run this from a GitHub Actions step");
  await Deno.writeTextFile(githubPath, `${dirname(bin)}\n`, { append: true });
  const { stdout } = await new Deno.Command(bin, { args: ["--version"], stdout: "piped" }).output();
  console.log(`denext's Deno toolchain on PATH: ${bin}\n${new TextDecoder().decode(stdout)}`);
}
