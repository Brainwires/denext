// `denext toolchain install | status | path | link | unlink` and `denext deno <args…>`: the verbs
// over denext's managed Deno toolchain (src/build/deno-toolchain.ts). The verbs that run project
// code switch to it on their own (src/cli/self-exec.ts `maybeReexecToolchain`); these manage it
// and run it directly.

import type { CommandContext, CommandSpec } from "../command.ts";
import { commandCwd, spawnDenoAndExit } from "../shared.ts";
import { denoExecutable } from "../../build/bundle.ts";
import { denoPathEnv } from "../deno-path.ts";
import {
  denoToolchainStatus,
  ensureDenoToolchain,
  linkDenoToolchain,
  resolveDenoToolchain,
  TOOLCHAIN_ACTIVE_ENV,
  TOOLCHAIN_ENV,
  unlinkDenoToolchain,
} from "../../build/deno-toolchain.ts";

/** The binary `denext deno` / `toolchain path` run: the pinned one (installed), or a failure. */
async function toolchainBinary(): Promise<{ deno: string; marker: string }> {
  const raw = (Deno.env.get(TOOLCHAIN_ENV) ?? "").trim();
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
  const rt = await ensureDenoToolchain();
  return { deno: rt.deno, marker: rt.version };
}

/**
 * The binary a forwarded Deno verb runs on — the automatic switch's choice: denext's toolchain,
 * a `DENEXT_DENO=<path>` binary, or stock Deno (after the choice's one warning) whenever the
 * toolchain can't be had. Never fails.
 */
async function forwardedBinary(): Promise<{ deno: string; marker: string }> {
  const choice = await resolveDenoToolchain();
  if (choice.warning) console.error(choice.warning);
  return choice.kind === "toolchain"
    ? { deno: choice.deno, marker: choice.version }
    : { deno: denoExecutable(), marker: "" };
}

/**
 * Run the toolchain's `deno` with `args` verbatim in `cwd` and exit with its code — `denext deno
 * …`, and (with `forwarded`) every Deno verb denext forwards (`denext compile …`, `denext
 * main.ts`) and `denext task`. The child's PATH starts with that same binary as `deno`
 * ({@linkcode denoPathEnv}), so a `deno` a task's script or tool spawns runs on it too.
 *
 * `denext deno` asks for the toolchain by name, so a toolchain that can't be had is an error
 * there (exit 1). A forwarded verb takes the automatic switch's choice instead, stock fallback
 * included ({@linkcode forwardedBinary}): `denext compile` works wherever `deno compile` does.
 * Never returns.
 *
 * @param args The arguments for `deno`.
 * @param cwd The directory to run in.
 * @param forwarded Whether a Deno verb is being forwarded (stock fallback) rather than `denext deno`.
 */
export async function runDenoPassthrough(
  args: string[],
  cwd = Deno.cwd(),
  forwarded = false,
): Promise<never> {
  const { deno, marker } = forwarded ? await forwardedBinary() : await toolchainBinary();
  return await spawnDenoAndExit(
    args,
    cwd,
    { ...await denoPathEnv(deno), ...(marker ? { [TOOLCHAIN_ACTIVE_ENV]: marker } : {}) },
    deno,
  );
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
  if (ctx.global.json) {
    console.log(JSON.stringify(s, null, 2));
  } else {
    console.log(`\n  ${s.ok ? "✔" : "✖"} deno toolchain  ${s.detail}`);
    if (s.path) console.log(`    path  ${s.path}`);
    console.log("");
  }
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
  const made = await linkDenoToolchain(deno);
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
      const rt = await ensureDenoToolchain();
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
