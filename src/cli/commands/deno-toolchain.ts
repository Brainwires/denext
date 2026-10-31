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
  TOOLCHAIN_ENV,
  toolchainEnvValue,
  toolchainSelection,
  unlinkDenoToolchain,
} from "../../build/deno-toolchain.ts";
import {
  type RevocationMode,
  revocationStatusLine,
  type RuntimeRevocationStatus,
} from "../../build/runtime-revocations.ts";
import { esbuildBinaryStatus } from "../../build/esbuild/binary.ts";
import { toolchainRemove } from "./toolchain-prune.ts";
import { ensureGleamToolchain, gleamToolchainStatus } from "../../build/gleam-toolchain.ts";
import { warnStockDeprecation } from "../../build/stock-deprecation.ts";
import {
  ensureFastlaneToolchain,
  fastlaneToolchainStatus,
} from "../../build/fastlane-toolchain.ts";

/** The extra tools `toolchain install --with <tool>` fetches beside the Deno toolchain. */
const EXTRA_TOOLS = ["gleam", "fastlane"] as const;

/**
 * The toolchain {@linkcode toolchainSelection} picks, installed and verified, or a clear
 * refusal (exit 1) when it can't be had: `install`, `path` and `link` name the toolchain itself,
 * so there is nothing to fall back to.
 */
async function requireToolchain(
  mode: RevocationMode = "fetch",
): Promise<
  { deno: string; version: string; cached: boolean; revocation?: RuntimeRevocationStatus }
> {
  try {
    const selected = await toolchainSelection(mode);
    if (selected.warning) console.error(selected.warning);
    const rt = await ensureDenoToolchain({ pin: selected.pin });
    return { ...rt, ...(selected.revocation ? { revocation: selected.revocation } : {}) };
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}

/** A revocation status, for `toolchain status` / `install` (a not-configured one when unchecked). */
function revocationOf(
  selected: { revocation?: RuntimeRevocationStatus },
  pinned: string | null,
): RuntimeRevocationStatus {
  return selected.revocation ?? {
    configured: false,
    pinned,
    revoked: false,
    reason: null,
    advisory: null,
    fixedIn: null,
    runningRollback: false,
    running: pinned,
    listSequence: null,
    listExpiresAt: null,
    expiredAt: null,
  };
}

/**
 * The binary `toolchain path` / `link` / `crash-report test` name: the pinned one (installed), or
 * a refusal.
 *
 * @returns The `deno` and its marker (a version, `path`, or empty for stock Deno).
 */
export async function toolchainBinary(): Promise<{ deno: string; marker: string }> {
  const raw = toolchainEnvValue();
  if (raw.toLowerCase() === "stock") {
    console.error(`denext: ${TOOLCHAIN_ENV}=stock — running stock Deno.`);
    return { deno: denoExecutable(), marker: "" };
  }
  if (raw !== "" && raw.toLowerCase() !== "pinned") {
    const choice = await resolveDenoToolchain();
    if (choice.warning) console.error(choice.warning);
    if (choice.kind === "stock") Deno.exit(1); // a process without the grants to run it
    return { deno: choice.deno, marker: choice.version };
  }
  const rt = await requireToolchain();
  return { deno: rt.deno, marker: rt.version };
}

/**
 * Run the toolchain's `deno` with `args` verbatim in `cwd` and exit with its code — `denext deno
 * …`, and (with `forwarded`) every Deno verb denext forwards (`denext compile …`, `denext
 * main.ts`) and `denext task`. Both take {@linkcode forwardedDeno}'s choice (its PATH rule and the
 * toolchain marker included); when the toolchain can't be had that throws a `denext:` error naming
 * the fix and the explicit opt-outs, never running another Deno on its own. `denext deno` also
 * says `DENEXT_DENO=stock` once. Never returns.
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
  // Deprecated (5.0 refuses it); once per process tree, so a gate that said it stays quiet here.
  if (raw === "stock") warnStockDeprecation("deno-env");
  const chosen = await forwardedDeno();
  if (chosen.warning) console.error(chosen.warning);
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
  const fastlane = await fastlaneToolchainStatus({ verify });
  const revocation = s.mode === "pinned"
    ? revocationOf(await toolchainSelection("force").catch(() => ({})), s.version)
    : revocationOf({}, s.version);
  if (ctx.global.json) {
    console.log(
      JSON.stringify({ ...s, revocation, esbuildBinary: esbuild, gleam, fastlane }, null, 2),
    );
  } else {
    console.log("");
    statusLine(s.ok, "deno toolchain", s.detail, s.path);
    const r = revocationStatusLine(revocation);
    statusLine(r.ok, "revocations", r.detail, null);
    statusLine(esbuild.ok, "esbuild", esbuild.detail, esbuild.path);
    statusLine(s.tsgo.state !== "refused", "typescript", s.tsgo.detail, s.tsgo.path);
    statusLine(s.tsgoLsp.state !== "refused", "typescript lsp", s.tsgoLsp.detail, s.tsgoLsp.path);
    statusLine(gleam.ok, "gleam", gleam.detail, gleam.state === "missing" ? null : gleam.path);
    statusLine(
      fastlane.ok,
      "fastlane",
      fastlane.detail,
      fastlane.state === "missing" ? null : fastlane.path,
    );
    console.log("");
  }
  const stale = await staleToolchainLink().catch(() => null);
  if (stale) console.error(stale);
  if (!s.ok || !gleam.ok || !fastlane.ok) Deno.exit(1);
}

/**
 * `denext toolchain install`: download and verify the toolchain, and — for a CLI run from JSR,
 * which loads each verb on first use — cache every verb now, so all of them work offline after
 * this post-install step (nothing to do for a checkout or a binary). `--with gleam` also fetches
 * the pinned Gleam compiler, and `--with fastlane` installs the managed fastlane.
 */
async function install(ctx: CommandContext): Promise<void> {
  const extras = withTools(ctx);
  const rt = await requireToolchain("force");
  console.log(`  denext's Deno toolchain ${rt.version}: ${rt.deno}${rt.cached ? " (cached)" : ""}`);
  const r = revocationStatusLine(revocationOf(rt, rt.version));
  console.log(`  revocations: ${r.detail}`);
  if (extras.includes("gleam")) await installGleam();
  if (extras.includes("fastlane")) await installFastlane();
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

/** Install the managed fastlane (exit 1 when it can't be had: Windows, no compiler, offline). */
async function installFastlane(): Promise<void> {
  try {
    const f = await ensureFastlaneToolchain();
    console.log(`  denext's fastlane ${f.version}: ${f.dir}${f.cached ? " (cached)" : ""}`);
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
  summary:
    "Manage denext's Deno toolchain (install | status | path | link | unlink | uninstall | prune)",
  usage: "denext runs the commands that execute project code on its own pinned Deno build\n" +
    "(stock Deno plus Deno.SQL and Vitest/Jest compat in deno test), downloaded and SHA-256\n" +
    "verified on first use. Your own `deno` is never replaced. DENEXT_DENO=stock opts out.\n" +
    "  denext toolchain install      Download + verify it now (fails when it can't)\n" +
    "  denext toolchain install --with gleam   …and the pinned Gleam compiler\n" +
    "  denext toolchain install --with fastlane   …and the managed fastlane (Ruby + gems)\n" +
    "  denext toolchain status       Pinned versions (Deno, Gleam, fastlane), cache state (--json)\n" +
    "  denext toolchain path         Print the binary's path (installs it first)\n" +
    "  denext toolchain link         Put it on PATH as ~/.denext/bin/deno (opt-in;\n" +
    "                                $DENEXT_INSTALL/bin when that is set)\n" +
    "  denext toolchain unlink       Remove that link (only what link created)\n" +
    "  denext toolchain uninstall <version>   Remove a cached version (its Deno toolchain and\n" +
    "                                Deno Desktop runtime); the pinned one only with --force\n" +
    "  denext toolchain uninstall --all       Remove every cached version but the pinned one\n" +
    "  denext toolchain prune        Remove every version but the one this denext pins (and the\n" +
    "                                one the project here pins), Gleam and fastlane included\n" +
    "  (uninstall and prune show the space freed; --dry-run lists it, --json for scripts)",
  positionals: [{
    name: "action",
    help: "install | status | path | link | unlink | uninstall | prune",
    required: true,
  }, {
    name: "versions",
    help: "uninstall: the versions to remove",
    variadic: true,
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
    help: "install: also fetch these pinned tools (gleam, fastlane)",
  }, {
    name: "all",
    type: "boolean",
    help: "uninstall: every cached version (the pinned one too with --force)",
  }, {
    name: "force",
    type: "boolean",
    help: "uninstall: remove a version even when it is the pinned one",
  }, {
    name: "dry-run",
    type: "boolean",
    help: "uninstall, prune: list what would be removed and the space it frees; remove nothing",
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
    if (action === "uninstall" || action === "prune") return await toolchainRemove(ctx);
    console.error(
      `denext: unknown toolchain action ${JSON.stringify(action ?? "")} ` +
        "(install | status | path | link | unlink | uninstall | prune)",
    );
    Deno.exit(1);
  },
};
