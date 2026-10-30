// `denext toolchain uninstall <version…> | uninstall --all | prune`: remove cached toolchain
// versions (src/build/toolchain-prune.ts decides and deletes). The versions in use are the ones
// this denext pins and, inside a project that pins another denext, the ones that denext pins —
// read from its published pin files on JSR, since it may not be cached.

import { dirname, join, resolve } from "@std/path";
import type { CommandContext } from "../command.ts";
import { commandCwd } from "../shared.ts";
import { pinnedDenextCli, pinnedVersion } from "../self-exec.ts";
import { VERSION } from "../../version.ts";
import {
  type DenoToolchainPin,
  loadDenoToolchainPin,
  staleToolchainLink,
} from "../../build/deno-toolchain.ts";
import { DESKTOP_RUNTIME_PIN } from "../../build/desktop-runtime.ts";
import { GLEAM_TOOLCHAIN } from "../../build/gleam-toolchain.ts";
import { FASTLANE_TOOLCHAIN } from "../../build/fastlane-toolchain.ts";
import {
  formatBytes,
  listToolchainCache,
  planToolchainRemoval,
  type RemovalOutcome,
  removeToolchainEntries,
  type ToolchainCacheEntry,
  type ToolchainCacheRoots,
  toolchainCacheRoots,
  type ToolchainRemovalPlan,
  type ToolchainRemovalRequest,
  type ToolchainVersionsInUse,
} from "../../build/toolchain-prune.ts";

/** The pins one denext version carries (what it would run on). */
interface DenextPins {
  readonly deno: string | null;
  readonly desktopRuntime: string | null;
  readonly gleam: string | null;
  readonly fastlane: string | null;
  /**
   * The pins' `rollback` versions: what runs when the revoked-runtimes list revokes the pinned
   * release (src/build/runtime-revocations.ts), so it is in use too.
   */
  readonly rollback?: { readonly deno?: string | null; readonly desktopRuntime?: string | null };
}

/** The process seams the command reads (injectable for tests). */
export interface ToolchainPruneDeps {
  /** The cache roots (default: under `DENO_DIR`). */
  readonly roots?: ToolchainCacheRoots;
  /** This denext's pins (default: its own pin files). */
  readonly ownPins?: () => DenextPins;
  /**
   * The pins of denext `version` — `null` when they can't be read (offline). Default: its
   * published pin files on jsr.io.
   */
  readonly pinsOf?: (version: string) => Promise<DenextPins | null>;
}

/** This denext's own pins. */
function ownPins(): DenextPins {
  let pin: DenoToolchainPin | null = null;
  try {
    pin = loadDenoToolchainPin();
  } catch {
    pin = null;
  }
  return {
    deno: pin?.version ?? null,
    desktopRuntime: DESKTOP_RUNTIME_PIN.version ?? null,
    gleam: GLEAM_TOOLCHAIN.version,
    fastlane: FASTLANE_TOOLCHAIN.fastlane,
    rollback: {
      deno: pin?.rollback?.version ?? null,
      desktopRuntime: DESKTOP_RUNTIME_PIN.rollback?.version ?? null,
    },
  };
}

/** One published pin file of denext `version`, or null. */
async function fetchPin(version: string, file: string): Promise<Record<string, unknown> | null> {
  const url = `https://jsr.io/@denext/denext/${version}/src/build/${file}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

/** The pins of a published denext version, from jsr.io (null when the toolchain pin can't be read). */
async function publishedPins(version: string): Promise<DenextPins | null> {
  const [deno, desktop, gleam, fastlane] = await Promise.all([
    fetchPin(version, "deno-toolchain-pin.json"),
    fetchPin(version, "desktop-runtime-pin.json"),
    fetchPin(version, "gleam-toolchain-pin.json"),
    fetchPin(version, "fastlane-toolchain-pin.json"),
  ]);
  if (deno === null) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const rollbackOf = (pin: Record<string, unknown> | null) =>
    str((pin?.rollback as { version?: unknown } | undefined)?.version);
  return {
    deno: str(deno.version),
    desktopRuntime: str(desktop?.version),
    gleam: str(gleam?.version),
    fastlane: str(fastlane?.fastlane),
    rollback: { deno: rollbackOf(deno), desktopRuntime: rollbackOf(desktop) },
  };
}

/**
 * The exact denext version the project in `dir` runs: its pin when that is exact, else what its
 * `deno.lock` resolved the range to. `undefined` when the project pins no denext; `null` when it
 * pins one this can't resolve (unversioned, or a range with no lock entry).
 */
export function projectDenextVersion(dir: string): string | null | undefined {
  const cli = pinnedDenextCli(dir);
  if (cli === null) return undefined;
  const spec = pinnedVersion(cli);
  if (spec === null) return null;
  if (/^=?\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(spec)) return spec.replace(/^=/, "");
  for (let at = resolve(dir), i = 0; i < 8; i++) {
    try {
      const lock = JSON.parse(Deno.readTextFileSync(join(at, "deno.lock")));
      const hit = lock?.specifiers?.[`jsr:@denext/denext@${spec}`];
      if (typeof hit === "string") return hit;
    } catch {
      // No lock here.
    }
    const parent = dirname(at);
    if (parent === at) break;
    at = parent;
  }
  return null;
}

/** The versions in use, and a note when the project's could not be told. */
async function versionsInUse(
  dir: string,
  deps: ToolchainPruneDeps,
): Promise<{ inUse: ToolchainVersionsInUse; unknownProject: string | null }> {
  const own = (deps.ownPins ?? ownPins)();
  const all: DenextPins[] = [own];
  let unknownProject: string | null = null;
  const project = projectDenextVersion(dir);
  if (project === null) {
    unknownProject = "the project here pins denext without an exact version or a deno.lock entry";
  } else if (project !== undefined && project !== VERSION) {
    const pins = await (deps.pinsOf ?? publishedPins)(project);
    if (pins === null) {
      unknownProject = `could not read which toolchain denext ${project} (this project's) pins`;
    } else {
      all.push(pins);
    }
  }
  const pick = (k: "deno" | "desktopRuntime" | "gleam" | "fastlane") =>
    all.map((p) => p[k]).filter((v): v is string => typeof v === "string");
  const rollbacks = (k: "deno" | "desktopRuntime") =>
    all.map((p) => p.rollback?.[k]).filter((v): v is string => typeof v === "string");
  return {
    inUse: {
      deno: [...pick("deno"), ...rollbacks("deno")],
      desktopRuntime: [...pick("desktopRuntime"), ...rollbacks("desktopRuntime")],
      gleam: pick("gleam"),
      fastlane: pick("fastlane"),
    },
    unknownProject,
  };
}

/** What a cache entry is called in a message. */
const KIND_LABEL: Record<ToolchainCacheEntry["kind"], string> = {
  deno: "Deno toolchain",
  "desktop-runtime": "Deno Desktop runtime",
  gleam: "Gleam",
  fastlane: "fastlane",
};

/** An entry for `--json`. */
function entryJson(e: ToolchainCacheEntry, error?: string) {
  return {
    kind: e.kind,
    version: e.version,
    path: e.path,
    bytes: e.bytes,
    ...(error ? { error } : {}),
  };
}

/** The request the arguments ask for, or an error message. */
function requestOf(ctx: CommandContext): ToolchainRemovalRequest | string {
  const action = ctx.positionals[0];
  if (action === "prune") {
    return ctx.positionals.length > 1
      ? "denext: `toolchain prune` takes no version (use `toolchain uninstall <version>`)"
      : { action: "prune" };
  }
  const versions = ctx.positionals.slice(1);
  if (ctx.flags.all === true) {
    return versions.length > 0
      ? "denext: `toolchain uninstall --all` takes no version"
      : { action: "all" };
  }
  if (versions.length === 0) {
    return "denext: name a version to uninstall (`denext toolchain uninstall <version>`), or " +
      "pass --all; `denext toolchain status` and `prune --dry-run` show what is cached";
  }
  return { action: "uninstall", versions };
}

/**
 * `denext toolchain uninstall <version…> | uninstall --all | prune` (`--force`, `--dry-run`,
 * `--json`). Exits 1 when a named version is in use (without `--force`), is not cached, or could
 * not be deleted.
 *
 * @param ctx The command context.
 * @param deps Seams for tests.
 */
export async function toolchainRemove(
  ctx: CommandContext,
  deps: ToolchainPruneDeps = {},
): Promise<void> {
  const request = requestOf(ctx);
  if (typeof request === "string") {
    console.error(request);
    Deno.exit(1);
  }
  const r = await runRemoval(ctx, request, deps);
  if (r.json) printJson(r);
  else report(r);
  if (!r.dryRun && !r.json) {
    const stale = await staleToolchainLink().catch(() => null);
    if (stale) console.error(stale);
  }
  const failed = r.outcomes.some((o) => o.error);
  const refused = request.action === "uninstall" && !r.force && r.plan.inUse.length > 0;
  if (failed || refused || r.plan.notCached.length > 0) Deno.exit(1);
}

/** What one removal did ({@linkcode runRemoval}). */
interface RemovalRun {
  readonly request: ToolchainRemovalRequest;
  readonly plan: ToolchainRemovalPlan;
  readonly outcomes: RemovalOutcome[];
  /** A prune that kept everything because the project's pins are unknown. */
  readonly blind: boolean;
  readonly unknownProject: string | null;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  /** The bytes removed (or, dry, that would be). */
  readonly freed: number;
}

/** Plan the removal and, unless `--dry-run`, carry it out. */
async function runRemoval(
  ctx: CommandContext,
  request: ToolchainRemovalRequest,
  deps: ToolchainPruneDeps,
): Promise<RemovalRun> {
  const force = ctx.flags.force === true;
  const dryRun = ctx.flags["dry-run"] === true;
  const roots = deps.roots ?? toolchainCacheRoots();
  const { inUse, unknownProject } = await versionsInUse(commandCwd(ctx), deps);
  const plan = planToolchainRemoval(await listToolchainCache(roots), request, inUse, force);
  // A prune that can't tell what the project here needs removes nothing (unless --force).
  const blind = request.action === "prune" && unknownProject !== null && !force;
  const remove = blind ? [] : plan.remove;
  const outcomes: RemovalOutcome[] = dryRun
    ? remove.map((entry) => ({ entry }))
    : await removeToolchainEntries(remove, roots);
  const freed = outcomes.reduce((n, o) => n + (o.error ? 0 : o.entry.bytes), 0);
  return {
    request,
    plan,
    outcomes,
    blind,
    unknownProject,
    force,
    dryRun,
    json: ctx.global.json === true,
    freed,
  };
}

/** `--json`. */
function printJson(r: RemovalRun): void {
  console.log(JSON.stringify(
    {
      action: r.request.action,
      dryRun: r.dryRun,
      removed: r.outcomes.map((o) => entryJson(o.entry, o.error)),
      kept: [...r.plan.inUse, ...(r.blind ? r.plan.remove : [])].map((e) => entryJson(e)),
      notCached: r.plan.notCached,
      freedBytes: r.freed,
      ...(r.unknownProject ? { warning: r.unknownProject } : {}),
    },
    null,
    2,
  ));
}

/** An entry's name in a message. */
const nameOf = (e: ToolchainCacheEntry) => `${KIND_LABEL[e.kind]} ${e.version}`;

/** The human report of {@linkcode toolchainRemove}. */
function report(r: RemovalRun): void {
  console.log("");
  for (const o of r.outcomes) console.log(outcomeLine(o, r.dryRun));
  const why = r.request.action === "prune" ? "in use" : "in use; --force removes it";
  for (const e of r.plan.inUse) console.log(`  kept ${nameOf(e).padEnd(38)} (${why})`);
  for (const v of r.plan.notCached) console.log(`  ✖ ${v} is not cached`);
  if (r.unknownProject) {
    const kept = r.blind ? "; kept every version (--force prunes anyway)" : "";
    console.log(`  ! ${r.unknownProject}${kept}`);
  }
  console.log(totalLine(r));
  console.log("");
}

/** One removed entry's line. */
function outcomeLine(o: RemovalOutcome, dryRun: boolean): string {
  if (o.error) return `  ✖ could not remove ${nameOf(o.entry)}: ${o.error}`;
  const verb = dryRun ? "would remove" : "removed";
  return `  ${verb} ${nameOf(o.entry).padEnd(36)} ${formatBytes(o.entry.bytes).padStart(8)}`;
}

/** The closing line: the space freed, or that there was nothing to do. */
function totalLine(r: RemovalRun): string {
  if (r.outcomes.length > 0) {
    return `  ${r.dryRun ? "would free" : "freed"} ${formatBytes(r.freed)}`;
  }
  return r.plan.notCached.length === 0 ? "  nothing to remove" : "";
}
