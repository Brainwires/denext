// The static Deno verb list (src/cli/deno-verbs.ts) against what the pinned Deno's own `--help`
// prints, so a Deno bump cannot leave `denext <verb>` forwarding, help and completions on a stale
// list. The binary is denext's Deno toolchain when it is already installed (no download here), else
// this Deno when it is the version the toolchain is built from; with neither the test is skipped and
// says why.

import { assertEquals } from "@std/assert";
import { DENO_VERBS } from "../src/cli/deno-verbs.ts";
import { DENO_TOOLCHAIN, denoToolchainStatus } from "../src/build/deno-toolchain.ts";

/** The Deno to compare against, or why there is none. */
async function referenceDeno(): Promise<{ deno: string } | { skip: string }> {
  const status = await denoToolchainStatus().catch(() => null);
  if (status?.state === "cached" && status.path) return { deno: status.path };
  if (Deno.version.deno === DENO_TOOLCHAIN.deno) return { deno: Deno.execPath() };
  return {
    skip: `denext's Deno toolchain is not installed and this Deno is ${Deno.version.deno}, not ` +
      `${DENO_TOOLCHAIN.deno} — run \`denext toolchain install\` to check the Deno verb list`,
  };
}

/** The subcommand names in a `deno --help` text, in order. */
function helpVerbs(help: string): string[] {
  // deno-lint-ignore no-control-regex
  const plain = help.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = plain.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Commands:");
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    const match = line.match(/^\s{2}(\S+)\s/);
    if (match) names.push(match[1]);
  }
  return names;
}

const reference = await referenceDeno();

Deno.test({
  name: "the forwarded Deno verb list matches the pinned Deno's --help",
  ignore: "skip" in reference,
}, async () => {
  if ("skip" in reference) return;
  const { stdout } = await new Deno.Command(reference.deno, {
    args: ["--help"],
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "null",
  }).output();
  const actual = helpVerbs(new TextDecoder().decode(stdout));
  assertEquals(DENO_VERBS.map((verb) => verb.name), actual);
});

if ("skip" in reference) console.warn(`cli-deno-verbs: skipped — ${reference.skip}`);
