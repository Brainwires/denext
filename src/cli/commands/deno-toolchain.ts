// `denext toolchain install | status | path | link | unlink` and `denext deno <args…>`: the verbs
// over denext's managed Deno toolchain (src/build/deno-toolchain.ts). The verbs that run project
// code switch to it on their own (src/cli/self-exec.ts `maybeReexecToolchain`); these manage it
// and run it directly.

import type { CommandContext, CommandSpec } from "../command.ts";
import { commandCwd, spawnDenoAndExit } from "../shared.ts";
import { denoExecutable } from "../../build/bundle.ts";
import { forwardedDeno } from "../deno-path.ts";
import {
  denoToolchainStatus,
  ensureDenoToolchain,
  linkDenoToolchain,
  resolveDenoToolchain,
  staleToolchainLink,
  TOOLCHAIN_ACTIVE_ENV,
  TOOLCHAIN_ENV,
  toolchainEnvValue,
  unlinkDenoToolchain,
} from "../../build/deno-toolchain.ts";
import { esbuildBinaryStatus } from "../../build/esbuild/binary.ts";

/**
 * `ensureDenoToolchain()`, or a clear refusal (exit 1) when the toolchain can't be had: `install`,
 * `path` and `link` name the toolchain itself, so there is nothing to fall back to.
 */
async function requireToolchain(): Promise<{ deno: string; version: string; cached: boolean }> {
  try {
    return await ensureDenoToolchain();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}

/** The binary `toolchain path` / `link` name: the pinned one (installed), or a refusal. */
async function toolchainBinary(): Promise<{ deno: string; marker: string }> {
  const raw = toolchainEnvValue();
  if (raw.toLowerCase() === "stock") {
    console.error(`denext: ${TOOLCHAIN_ENV}=stock — running stock Deno.`);
    return { deno: denoExecutable(), marker: "" };
  }
  if (raw !== "" && raw.toLowerCase() !== "pinned") {
    const choice = await resolveDenoToolchain();
    if (choice.warning) console.error(choice.warning);
    if (choice.kind === "stock") Deno.exit(1);
    return { deno: choice.deno, marker: choice.version };
  }
  const rt = await requireToolchain();
  return { deno: rt.deno, marker: rt.version };
}

/**
 * Run the toolchain's `deno` with `args` verbatim in `cwd` and exit with its code — `denext deno
 * …`, and (with `forwarded`) every Deno verb denext forwards (`denext compile …`, `denext
 * main.ts`) and `denext task`. Both take {@linkcode forwardedDeno}'s choice (its PATH rule and the
 * toolchain marker included), falling back to stock Deno with the choice's one warning when the
 * toolchain can't be had: `denext compile` works wherever `deno compile` does. `denext deno` also
 * says `DENEXT_DENO=stock` once, and treats a `DENEXT_DENO=<path>` that isn't a file as an error
 * (exit 1): that binary was asked for by name. Never returns.
 *
 * @param args The arguments for `deno`.
 * @param cwd The directory to run in.
 * @param forwarded Whether a Deno verb is being forwarded rather than `denext deno`.
 */
export async function runDenoPassthrough(
  args: string[],
  cwd = Deno.cwd(),
  forwarded = false,
): Promise<never> {
  const raw = toolchainEnvValue().toLowerCase();
  if (!forwarded && raw === "stock") {
    console.error(`denext: ${TOOLCHAIN_ENV}=stock — running stock Deno.`);
  }
  const chosen = await forwardedDeno();
  if (chosen.warning) console.error(chosen.warning);
  const onToolchain = TOOLCHAIN_ACTIVE_ENV in chosen.env;
  if (!forwarded && !onToolchain && raw !== "" && raw !== "stock" && raw !== "pinned") Deno.exit(1);
  return await spawnDenoAndExit(args, cwd, chosen.env, chosen.deno);
}

/** `denext deno …` (the CLI intercepts a leading `deno` verb so every flag passes verbatim). */
export const denoCommand: CommandSpec = {
  name: "deno",
  summary: "Run denext's Deno toolchain with the given arguments",
  passthrough: true,
  usage: "Runs denext's pinned Deno (downloaded and verified on first use) with the arguments\n" +
    "verbatim, and exits with its code:\n" +
    "  denext deno test              deno test on the toolchain (Vitest/Jest compat)\n" +
    "  denext deno task check        a deno task whose `deno …` steps run on it too\n" +
    "  denext deno --version",
  positionals: [{ name: "args", help: "Arguments for deno", variadic: true }],
  run: (ctx) => runDenoPassthrough(ctx.rest, commandCwd(ctx)),
};

/** `toolchain status`. */
async function status(ctx: CommandContext): Promise<void> {
  const s = await denoToolchainStatus({ verify: ctx.flags.verify === true });
  const esbuild = await esbuildBinaryStatus();
  if (ctx.global.json) {
    console.log(JSON.stringify({ ...s, esbuildBinary: esbuild }, null, 2));
  } else {
    console.log(`\n  ${s.ok ? "✔" : "✖"} deno toolchain  ${s.detail}`);
    if (s.path) console.log(`    path  ${s.path}`);
    console.log(`  ${esbuild.ok ? "✔" : "✖"} esbuild         ${esbuild.detail}`);
    if (esbuild.path) console.log(`    path  ${esbuild.path}`);
    console.log("");
  }
  const stale = await staleToolchainLink().catch(() => null);
  if (stale) console.error(stale);
  if (!s.ok) Deno.exit(1);
}

/** `toolchain link` / `unlink`. */
async function link(unlink: boolean): Promise<void> {
  if (unlink) {
    const removed = await unlinkDenoToolchain();
    console.log(removed ? `  removed ${removed}` : "  nothing to unlink");
    return;
  }
  const { deno } = await toolchainBinary();
  const stale = await staleToolchainLink().catch(() => null);
  const made = await linkDenoToolchain(deno);
  if (stale) console.log(`  replaced a stale link (${stale.replace(/^denext: /, "")})`);
  console.log(`  linked ${made.link} → ${deno}\n  Put it on PATH (once):\n    ${made.pathLine}`);
}

export const toolchainCommand: CommandSpec = {
  name: "toolchain",
  summary: "Manage denext's Deno toolchain (install | status | path | link | unlink)",
  usage: "denext runs the commands that execute project code on its own pinned Deno build\n" +
    "(stock Deno plus Deno.SQL and Vitest/Jest compat in deno test), downloaded and SHA-256\n" +
    "verified on first use. Your own `deno` is never replaced. DENEXT_DENO=stock opts out.\n" +
    "  denext toolchain install      Download + verify it now (fails when it can't)\n" +
    "  denext toolchain status       Pinned version, cache state, active or not (--json)\n" +
    "  denext toolchain path         Print the binary's path (installs it first)\n" +
    "  denext toolchain link         Put it on PATH as ~/.denext/bin/deno (opt-in)\n" +
    "  denext toolchain unlink       Remove that link (only what link created)",
  positionals: [{
    name: "action",
    help: "install | status | path | link | unlink",
    required: true,
  }],
  flags: [{
    name: "verify",
    type: "boolean",
    help: "status: re-hash the cached binary instead of the size + mtime check",
  }],
  run: async (ctx) => {
    const action = ctx.positionals[0];
    if (action === "status") return await status(ctx);
    if (action === "install") {
      const rt = await requireToolchain();
      console.log(
        `  denext's Deno toolchain ${rt.version}: ${rt.deno}${rt.cached ? " (cached)" : ""}`,
      );
      return;
    }
    if (action === "path") {
      console.log((await toolchainBinary()).deno);
      return;
    }
    if (action === "link" || action === "unlink") return await link(action === "unlink");
    console.error(
      `denext: unknown toolchain action ${JSON.stringify(action ?? "")} ` +
        "(install | status | path | link | unlink)",
    );
    Deno.exit(1);
  },
};
