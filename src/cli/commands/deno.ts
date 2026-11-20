// `denext deno <args…>` and the binary `denext runtime path | link` and `crash-report test` name:
// the runtime release src/build/runtime-select.ts selects, installed and verified. The verbs that
// run project code switch to it on their own (src/cli/self-exec.ts `maybeReexecToolchain`); this
// runs it directly. Kept apart from `denext runtime` (./runtime.ts) so a forwarded Deno verb
// (`denext compile …`, `denext main.ts`) loads only what it needs.

import type { CommandSpec } from "../command.ts";
import { commandCwd, spawnDenoAndExit } from "../shared.ts";
import { denoExecutable } from "../../build/bundle.ts";
import { forwardedDeno } from "../deno-path.ts";
import {
  ensureDenoToolchain,
  resolveDenoToolchain,
  TOOLCHAIN_ENV,
  toolchainEnvValue,
  toolchainSelection,
} from "../../build/deno-toolchain.ts";
import type { RevocationMode, RuntimeRevocationStatus } from "../../build/runtime-revocations.ts";
import {
  rememberRuntimeRelease,
  resolveRuntimeRelease,
  type RuntimeRelease,
} from "../../build/runtime-select.ts";
import { warnStockDeprecation } from "../../build/stock-deprecation.ts";
import { commandMeta } from "../command-meta.ts";

/** The runtime release a command here runs, installed and verified. */
export interface InstalledRuntime {
  /** The `deno` binary. */
  readonly deno: string;
  readonly version: string;
  /** Whether it was already cached (nothing was downloaded). */
  readonly cached: boolean;
  /** What the revoked-runtimes list said, when it was consulted. */
  readonly revocation?: RuntimeRevocationStatus;
  /** The release in force (src/build/runtime-select.ts). */
  readonly release: RuntimeRelease;
}

/**
 * The release src/build/runtime-select.ts selects here — `DENEXT_RUNTIME`, the project pin, the
 * user default, the bundled pins, fetching the release document a lock names when it is not
 * cached — remembered for this process so the synchronous readers agree with it. Its notices
 * (a skipped default, a yanked release) are printed.
 *
 * @param mode How the revoked-runtimes list is read.
 * @returns The release.
 * @throws {Error} For a selection that cannot run (a broken project pin).
 */
async function selectRuntimeRelease(
  mode: RevocationMode = "fetch",
): Promise<RuntimeRelease> {
  const release = await resolveRuntimeRelease({ revocations: { mode } });
  for (const line of release.notices) console.error(line);
  rememberRuntimeRelease(release);
  return release;
}

/**
 * The runtime release {@linkcode selectRuntimeRelease} picks, installed and verified (the bundled
 * pins' revocation rollback applied, src/build/deno-toolchain.ts), or a clear refusal (exit 1)
 * when it can't be had: `install`, `path` and `link` name the runtime itself, so there is nothing
 * to fall back to.
 *
 * @param mode How the revoked-runtimes list is read.
 * @returns The binary and the release.
 */
export async function requireRuntime(mode: RevocationMode = "fetch"): Promise<InstalledRuntime> {
  try {
    const release = await selectRuntimeRelease(mode);
    const selected = await toolchainSelection(mode);
    if (selected.warning) console.error(selected.warning);
    const rt = await ensureDenoToolchain({ pin: selected.pin });
    return {
      deno: rt.deno,
      version: rt.version,
      cached: rt.cached,
      release,
      ...(selected.revocation ? { revocation: selected.revocation } : {}),
    };
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}

/**
 * The binary `runtime path` / `link` / `crash-report test` name: the selected release (installed),
 * a `DENEXT_DENO=<path>` binary, or stock Deno under `DENEXT_DENO=stock`; else a refusal.
 *
 * @returns The `deno` and its marker (a version, `path`, or empty for stock Deno).
 */
export async function runtimeBinary(): Promise<{ deno: string; marker: string }> {
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
  const rt = await requireRuntime();
  return { deno: rt.deno, marker: rt.version };
}

/**
 * Run the runtime's `deno` with `args` verbatim in `cwd` and exit with its code — `denext deno
 * …`, and (with `forwarded`) every Deno verb denext forwards (`denext compile …`, `denext
 * main.ts`) and `denext task`. Both take {@linkcode forwardedDeno}'s choice (its PATH rule and the
 * toolchain marker included); when the runtime can't be had that throws a `denext:` error naming
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
  ...commandMeta("deno"),
  run: (ctx) => runDenoPassthrough(ctx.rest, commandCwd(ctx)),
};
