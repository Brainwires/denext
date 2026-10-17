// `denext toolchain install | status | path | link | unlink` and `denext deno <args…>`: the verbs
// over denext's managed Deno toolchain (src/build/deno-toolchain.ts). The verbs that run project
// code switch to it on their own (src/cli/self-exec.ts `maybeReexecToolchain`); these manage it
// and run it directly.

import { cacheCliModules, isRemoteCli } from "../cli-cache.ts";
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
import { ensureGleamToolchain, gleamToolchainStatus } from "../../build/gleam-toolchain.ts";

/** The extra tools `toolchain install --with <tool>` fetches beside the Deno toolchain. */
const EXTRA_TOOLS = ["gleam"] as const;

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

/** One `toolchain status` line, and its path line when there is one. */
function statusLine(ok: boolean, label: string, detail: string, path: string | null): void {
  console.log(`  ${ok ? "✔" : "✖"} ${label.padEnd(15)} ${detail}`);
  if (path) console.log(`    path  ${path}`);
}

/** `toolchain status`. */
async function status(ctx: CommandContext): Promise<void> {
  const verify = ctx.flags.verify === true;
  const s = await denoToolchainStatus({ verify });
  const esbuild = await esbuildBinaryStatus();
  const gleam = await gleamToolchainStatus({ verify });
  if (ctx.global.json) {
    console.log(JSON.stringify({ ...s, esbuildBinary: esbuild, gleam }, null, 2));
  } else {
    console.log("");
    statusLine(s.ok, "deno toolchain", s.detail, s.path);
    statusLine(esbuild.ok, "esbuild", esbuild.detail, esbuild.path);
    statusLine(s.tsgo.state !== "refused", "typescript", s.tsgo.detail, s.tsgo.path);
    statusLine(gleam.ok, "gleam", gleam.detail, gleam.state === "missing" ? null : gleam.path);
    console.log("");
  }
  const stale = await staleToolchainLink().catch(() => null);
  if (stale) console.error(stale);
  if (!s.ok || !gleam.ok) Deno.exit(1);
}

/**
 * `denext toolchain install`: download and verify the toolchain, and — for a CLI run from JSR,
 * which loads each verb on first use — cache every verb now, so all of them work offline after
 * this post-install step (nothing to do for a checkout or a binary). `--with gleam` also fetches
 * the pinned Gleam compiler.
 */
async function install(ctx: CommandContext): Promise<void> {
  const extras = withTools(ctx);
  const rt = await requireToolchain();
  console.log(`  denext's Deno toolchain ${rt.version}: ${rt.deno}${rt.cached ? " (cached)" : ""}`);
  if (extras.includes("gleam")) await installGleam();
  if (!isRemoteCli()) return;
  if (!await cacheCliModules()) {
    console.error("denext: could not cache the CLI's verbs; they load on first use instead");
    Deno.exit(1);
  }
  console.log("  every denext verb is cached for offline use");
}

/** The `--with` tools, checked (exit 1 on an unknown one). */
function withTools(ctx: CommandContext): string[] {
  const raw = typeof ctx.flags.with === "string" ? ctx.flags.with : "";
  const tools = raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const unknown = tools.filter((t) => !(EXTRA_TOOLS as readonly string[]).includes(t));
  if (unknown.length > 0) {
    console.error(
      `denext: unknown --with tool ${unknown.join(", ")} (known: ${EXTRA_TOOLS.join(", ")})`,
    );
    Deno.exit(1);
  }
  return tools;
}

/** Fetch and verify the pinned Gleam (exit 1 when it can't be had). */
async function installGleam(): Promise<void> {
  try {
    const g = await ensureGleamToolchain();
    console.log(`  denext's Gleam ${g.version}: ${g.gleam}${g.cached ? " (cached)" : ""}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
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
    "  denext toolchain install --with gleam   …and the pinned Gleam compiler\n" +
    "  denext toolchain status       Pinned versions (Deno, Gleam), cache state, active (--json)\n" +
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
  }, {
    name: "with",
    type: "string",
    valueName: "<tool>",
    repeatable: true,
    help: "install: also fetch these pinned tools (gleam)",
  }],
  run: async (ctx) => {
    const action = ctx.positionals[0];
    if (action === "status") return await status(ctx);
    if (action === "install") return await install(ctx);
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
