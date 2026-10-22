// Every `denext create` output is `deno fmt`- and `deno lint`-clean as written: a fresh project
// passes `deno fmt --check` and `deno lint` with the config it was given (Deno's default fmt
// options — the scaffold carries no `fmt` block), for each template and each feature, alone and
// all together, and as a `--monorepo` workspace (checked from its root, every member at once).

import { assert } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  SCAFFOLD_TEMPLATES,
  type ScaffoldOptions,
  scaffoldProject,
} from "../../src/build/scaffold.ts";
import { scaffoldMonorepo } from "../../src/build/scaffold-monorepo.ts";
import { isToolchainBuild, toolchainDeno } from "../../scripts/test-run.ts";

/** The feature switches `denext create` offers. */
const FEATURES = [
  "tailwind",
  "srcDir",
  "compiler",
  "desktop",
  "capacitor",
  "compatibilityMode",
  "fallow",
  "mcp",
] as const satisfies readonly (keyof ScaffoldOptions)[];

/** This checkout's lint plugin, so the lint run is hermetic and checks the current rules. */
const LOCAL_LINT_PLUGIN = toFileUrl(
  join(import.meta.dirname!, "../../src/lint/denext-plugin.ts"),
).href;

/** One matrix entry: its name, the create options, and whether it is `--monorepo`. */
interface Combo {
  name: string;
  opts: Omit<ScaffoldOptions, "dir">;
  monorepo?: boolean;
}

/**
 * Each template with no features, each feature alone, every feature, and no `.vscode`; and each
 * template as a monorepo, alone and with every feature.
 */
function combos(): Combo[] {
  const out: Combo[] = [];
  const all = Object.fromEntries(FEATURES.map((f) => [f, true]));
  for (const template of SCAFFOLD_TEMPLATES) {
    out.push({ name: `${template}+monorepo`, opts: { template }, monorepo: true });
    out.push({ name: `${template}+monorepo+all`, opts: { template, ...all }, monorepo: true });
  }
  for (const template of SCAFFOLD_TEMPLATES) {
    out.push({ name: `${template}`, opts: { template } });
    out.push({ name: `${template}+no-vscode`, opts: { template, vscode: false } });
    for (const feature of FEATURES) {
      out.push({ name: `${template}+${feature}`, opts: { template, [feature]: true } });
    }
    out.push({ name: `${template}+all`, opts: { template, ...all } });
  }
  return out;
}

/**
 * The Deno the children run on: denext's toolchain (what users get from `denext lint`), because
 * stock Deno 2.9.6/2.9.7 can crash on shutdown (exit 139, use-after-free; denoland/deno#37025)
 * after a JS lint plugin ran, about 2% of runs. Stock (`DENEXT_DENO=stock`, or a toolchain that
 * can't be had) is the fallback, with a retry on exit 139 only.
 */
const DENO = await toolchainDeno().catch((err) => {
  console.error(`scaffold-fmt-lint: toolchain unavailable, using stock Deno: ${err}`);
  return null;
}) ?? Deno.execPath();

/** Whether the children run on a stock Deno (no toolchain), the only build with the crash. */
const STOCK_FALLBACK = DENO === Deno.execPath() && !isToolchainBuild();

/** Run `deno <args>` in `cwd`; the combined output when it fails. */
async function deno(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  let result = await denoOnce(args, cwd);
  // Only stock Deno's known shutdown crash is retried; a toolchain crash is a real failure.
  for (let i = 0; i < 2 && STOCK_FALLBACK && result.code === 139; i++) {
    result = await denoOnce(args, cwd);
  }
  return result;
}

/** One `deno <args>` run in `cwd`. */
async function denoOnce(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; output: string; code: number }> {
  const r = await new Deno.Command(DENO, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: { NO_COLOR: "1" },
  }).output();
  const text = new TextDecoder();
  // The exit code and signal too: a run killed from outside (a loaded CI host, a timeout) prints
  // nothing of its own, and the failure should say so rather than look like a lint finding.
  const status = `[exit ${r.code}${r.signal ? `, signal ${r.signal}` : ""}]`;
  return {
    ok: r.success,
    code: r.code,
    output: `${text.decode(r.stdout)}${text.decode(r.stderr)}\n${status}`,
  };
}

/** Point the scaffold's lint plugin at this checkout's copy (the scaffold pins the JSR one). */
async function pointLintAtCheckout(dir: string): Promise<void> {
  const path = join(dir, "deno.json");
  const config = JSON.parse(await Deno.readTextFile(path));
  config.lint = { ...config.lint, plugins: [LOCAL_LINT_PLUGIN] };
  await Deno.writeTextFile(path, JSON.stringify(config, null, 2) + "\n");
}

for (const { name, opts, monorepo } of combos()) {
  Deno.test(`scaffold ${name}: deno fmt --check and deno lint pass`, async () => {
    // A temp dir outside the repository, so no parent deno.json lends the project its options.
    const root = await Deno.makeTempDir({ prefix: "denext-scaffold-fmt-" });
    try {
      const dir = join(root, "my-app");
      await (monorepo ? scaffoldMonorepo : scaffoldProject)({ ...opts, dir });
      const fmt = await deno(["fmt", "--check"], dir);
      assert(fmt.ok, `deno fmt --check failed for ${name}:\n${fmt.output}`);
      await pointLintAtCheckout(dir);
      const lint = await deno(["lint"], dir);
      assert(lint.ok, `deno lint failed for ${name}:\n${lint.output}`);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}
