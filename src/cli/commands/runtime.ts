// `denext runtime version | info | list | install | upgrade | use | path | link | unlink |
// uninstall | prune`: the verbs over denext's runtime — the Deno build the commands that run project
// code switch to (src/cli/self-exec.ts), picked by src/build/runtime-select.ts from
// `DENEXT_RUNTIME`, the project pin, the user default and the bundled pins, and offered new
// releases by the signed runtime channel (src/build/runtime-channel.ts).
//
// The channel never selects at command time: only `upgrade`, `use` and `install <version>` act on
// it, and only on an index whose signature verifies. Offline, `version`, `list` (installed), `path`
// and `use <installed>` work; `upgrade` and `install <not cached>` fail with the reason.

import { join } from "@std/path";
import { cacheCliModules, isRemoteCli } from "../cli-cache.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { commandCwd } from "../shared.ts";
import { commandMeta } from "../command-meta.ts";
import { requireRuntime, runtimeBinary } from "./deno.ts";
import { runtimeRemove } from "./runtime-prune.ts";
import {
  denoToolchainCacheRoot,
  type DenoToolchainPin,
  type DenoToolchainStatus,
  denoToolchainStatus,
  denoToolchainTarget,
  ensureDenoToolchain,
  linkDenoToolchain,
  staleToolchainLink,
  TOOLCHAIN_STAMP,
  toolchainSelection,
  unlinkDenoToolchain,
} from "../../build/deno-toolchain.ts";
import {
  BUNDLED_RUNTIME,
  bundledRuntimeReleases,
  type CompatTarget,
  factsOfEntry,
  factsOfPins,
  fetchLockedReleaseDocument,
  lockOfPins,
  newestAvailableRelease,
  projectRuntimeConfigPath,
  readCachedReleaseDocument,
  readProjectRuntimePin,
  readUserRuntimeDefaultFile,
  releaseIntegrity,
  rememberRuntimeRelease,
  type ResolveRuntimeAsyncOptions,
  resolveRuntimeRelease,
  runtimeIncompatibility,
  type RuntimeLock,
  type RuntimePins,
  type RuntimeRelease,
  type UserRuntimeDefault,
  userRuntimeDefaultFile,
  writeUserRuntimeDefault,
} from "../../build/runtime-select.ts";
import {
  type ChannelAbsence,
  type ChannelMode,
  type LoadChannelOptions,
  type LoadedChannel,
  loadReleaseDocument,
  loadRuntimeChannel,
  type RuntimeChannelRelease,
} from "../../build/runtime-channel.ts";
import {
  findRevocation,
  loadRuntimeRevocations,
  revocationStatusLine,
  revokedChoiceRefusal,
  revokesVersion,
  type RuntimeRevocationList,
  type RuntimeRevocationStatus,
} from "../../build/runtime-revocations.ts";
import { compareDenoVersions, MIN_RUNTIME } from "../../build/deno-version.ts";
import { type DepAgeRule, heldUntil, holdHead, readProjectRule } from "../../build/dep-age.ts";
import { type EnvGet, processEnv } from "../../build/signed-envelope.ts";
import { setJsonValue } from "../../build/json-edit.ts";
import { type EsbuildBinaryStatus, esbuildBinaryStatus } from "../../build/esbuild/binary.ts";
import {
  ensureGleamToolchain,
  type GleamToolchainStatus,
  gleamToolchainStatus,
} from "../../build/gleam-toolchain.ts";
import {
  ensureFastlaneToolchain,
  type FastlaneToolchainStatus,
  fastlaneToolchainStatus,
} from "../../build/fastlane-toolchain.ts";

/** The extra tools `runtime install --with <tool>` fetches beside the runtime. */
const EXTRA_TOOLS = ["gleam", "fastlane"] as const;

/** The actions, as `--help` and the unknown-action error list them. */
const ACTIONS =
  "version | info | list | install | upgrade | use | path | link | unlink | uninstall | prune";

/** A verified toolchain binary ({@linkcode ensureDenoToolchain}'s answer). */
interface Installed {
  readonly deno: string;
  readonly version: string;
  readonly cached: boolean;
}

/** The process seams the verbs read (tests inject a fixture channel, cache and installer). */
export interface RuntimeCliDeps {
  readonly env?: EnvGet;
  /** The toolchain cache (default `<DENO_DIR>/denext-deno`). */
  readonly cacheRoot?: string;
  /** The user default's file (default {@linkcode userRuntimeDefaultFile}). */
  readonly defaultFile?: string;
  /** Default {@linkcode BUNDLED_RUNTIME}. */
  readonly bundled?: RuntimePins;
  /** What the compatibility checks compare against (default this denext). */
  readonly compat?: CompatTarget;
  readonly now?: () => number;
  /** Options handed to the channel loader and the release-document fetches (keys, bases, fetch). */
  readonly channel?: Partial<LoadChannelOptions>;
  /** The dependency-age rule of the project in `dir` (default {@linkcode readProjectRule}). */
  readonly rule?: (dir: string, now: Date) => Promise<Pick<DepAgeRule, "cutoff">>;
  /** Install a release's toolchain (default {@linkcode ensureDenoToolchain}). */
  readonly ensure?: (pin: DenoToolchainPin, cacheRoot: string) => Promise<Installed>;
  /** The host's toolchain pin key (default `<os>-<arch>`). */
  readonly target?: string;
  /** The cache state of the runtime's tools, for `version` (default: this machine's). */
  readonly tools?: (verify: boolean) => Promise<ToolsStatus>;
  /** Output (default `console.log` / `console.error`). */
  readonly log?: (line: string) => void;
  readonly warn?: (line: string) => void;
}

/** {@linkcode RuntimeCliDeps}, defaulted, with the command's facts. */
type Rt = Required<RuntimeCliDeps> & {
  /** What the resolver is handed: the seams a test named (production: none). */
  readonly resolve: ResolveRuntimeAsyncOptions;
  /** The project directory. */
  readonly dir: string;
  readonly json: boolean;
};

/** The seams of a real run over `env`'s toolchain cache. */
function machineDeps(env: EnvGet, cacheRoot: string, named?: string): Required<RuntimeCliDeps> {
  return {
    env,
    cacheRoot,
    defaultFile: userRuntimeDefaultFile(env, named) ?? join(cacheRoot, "default.json"),
    bundled: BUNDLED_RUNTIME,
    compat: {},
    now: Date.now,
    channel: {},
    rule: (dir, now) => readProjectRule(dir, now),
    ensure: (pin, root) => ensureDenoToolchain({ pin, cacheRoot: root }),
    target: denoToolchainTarget(),
    tools: machineTools,
    log: (line) => console.log(line),
    warn: (line) => console.error(line),
  };
}

/** The seams a caller set (an `undefined` one keeps its default). */
function setDeps(deps: RuntimeCliDeps): RuntimeCliDeps {
  return Object.fromEntries(Object.entries(deps).filter(([, v]) => v !== undefined));
}

/** What the resolver is handed: only the seams a caller named, so a real run resolves as usual. */
function resolveOptions(rt: Required<RuntimeCliDeps>, set: RuntimeCliDeps, dir: string) {
  return {
    env: rt.env,
    projectDir: dir,
    ...(set.cacheRoot ? { cacheRoot: set.cacheRoot } : {}),
    ...(set.bundled ? { bundled: set.bundled } : {}),
    ...(set.compat ? { compat: set.compat } : {}),
    ...(set.channel ? resolverSeams(rt.env, rt.cacheRoot, set.channel) : {}),
  };
}

function rtOf(ctx: CommandContext, deps: RuntimeCliDeps): Rt {
  const set = setDeps(deps);
  const env = set.env ?? processEnv;
  const cacheRoot = set.cacheRoot ?? denoToolchainCacheRoot(env);
  const merged = { ...machineDeps(env, cacheRoot, set.cacheRoot), ...set };
  const dir = commandCwd(ctx);
  return {
    ...merged,
    resolve: resolveOptions(merged, set, dir),
    dir,
    json: ctx.global.json === true,
  };
}

/** The resolver's channel and document seams over a test's channel options. */
function resolverSeams(
  env: EnvGet,
  cacheRoot: string,
  channel: Partial<LoadChannelOptions>,
): Pick<ResolveRuntimeAsyncOptions, "loadChannel" | "fetchLocked" | "fetchListed"> {
  const net = {
    ...(channel.bases ? { bases: channel.bases } : {}),
    ...(channel.fetch ? { fetch: channel.fetch } : {}),
  };
  return {
    loadChannel: (mode) => loadRuntimeChannel({ mode, env, cacheRoot, ...channel }),
    fetchLocked: (lock) => fetchLockedReleaseDocument(lock, { cacheRoot, ...net }),
    fetchListed: (entry) => loadReleaseDocument(entry, { env, cacheRoot, ...net }),
  };
}

/** A failure a verb reports as one `denext:` line and exit code 1. */
class RuntimeCliError extends Error {
  override name = "RuntimeCliError";
}

const errText = (err: unknown) => err instanceof Error ? err.message : String(err);

/** Print `value` as indented JSON. */
function printJson(rt: Rt, value: unknown): void {
  rt.log(JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------------------------
// The channel and the releases it names.

/** The channel index, loaded in `mode` with the seams. */
function loadChannel(rt: Rt, mode: ChannelMode): Promise<LoadedChannel> {
  return loadRuntimeChannel({ mode, env: rt.env, cacheRoot: rt.cacheRoot, ...rt.channel });
}

/** Why the channel is absent, in words. */
const ABSENCE_TEXT: Record<ChannelAbsence, string> = {
  off: "the runtime channel is turned off (DENEXT_RUNTIME_CHANNEL=0)",
  "no-key": "this denext carries no runtime channel key",
  "revoked-key": "the runtime channel's key was withdrawn (the revoked-runtimes list names it)",
  "no-revocations":
    "the revoked-runtimes list can't be had (offline, or no current copy verifies), so the " +
    "runtime channel's keys can't be checked",
  unavailable: "the runtime channel is unavailable (offline, or no copy verifies)",
  expired: "the runtime channel's index has expired (nothing newer could be fetched)",
};

/** The text for an absent channel. */
function absenceText(loaded: LoadedChannel): string {
  return ABSENCE_TEXT[loaded.absent ?? "unavailable"];
}

/** The release document `entry` names (cached, else fetched; verified by its hash). */
function documentOf(rt: Rt, entry: RuntimeChannelRelease): Promise<RuntimePins> {
  return loadReleaseDocument(entry, {
    env: rt.env,
    cacheRoot: rt.cacheRoot,
    ...(rt.channel.bases ? { bases: rt.channel.bases } : {}),
    ...(rt.channel.fetch ? { fetch: rt.channel.fetch } : {}),
  });
}

/** A release named by a version, found: its lock, its pins and its channel entry when known. */
interface FoundRelease {
  readonly lock: RuntimeLock;
  readonly pins: RuntimePins;
  readonly entry: RuntimeChannelRelease | null;
  /** Whether it is the bundled release itself. */
  readonly bundled: boolean;
}

/** The bundled release or its rollback, when `version` names one. */
function bundledFound(rt: Rt, version: string): FoundRelease | null {
  const releases = bundledRuntimeReleases(rt.bundled);
  const pins = version === "bundled"
    ? releases[0]
    : releases.find((p) => p.toolchain.version === version);
  const lock = pins ? lockOfPins(pins) : null;
  return pins && lock ? { lock, pins, entry: null, bundled: pins === releases[0] } : null;
}

/** The locks this machine already holds for `version`: the project pin's and the user default's. */
function knownLocks(rt: Rt, version: string): RuntimeLock[] {
  const out: RuntimeLock[] = [];
  try {
    const pin = readProjectRuntimePin(rt.dir);
    if (pin?.lock.version === version) out.push(pin.lock);
  } catch {
    // A malformed project pin names no lock.
  }
  const d = readUserRuntimeDefaultFile(rt.defaultFile);
  if (d?.version === version) out.push(d);
  return out;
}

/** The release a known lock names: its cached document, else fetched (by the lock's hash). */
async function fromKnownLock(rt: Rt, version: string): Promise<FoundRelease | null> {
  for (const lock of knownLocks(rt, version)) {
    const cached = readCachedReleaseDocument(rt.cacheRoot, lock);
    const pins = cached ?? await fetchLockedReleaseDocument(lock, {
      cacheRoot: rt.cacheRoot,
      ...(rt.channel.bases ? { bases: rt.channel.bases } : {}),
      ...(rt.channel.fetch ? { fetch: rt.channel.fetch } : {}),
    }).catch(() => null);
    if (pins) return { lock, pins, entry: null, bundled: false };
  }
  return null;
}

/** The channel's entry for `version`: the held index first, then a fresh fetch. */
async function channelEntry(
  rt: Rt,
  version: string,
): Promise<{ entry: RuntimeChannelRelease | null; loaded: LoadedChannel }> {
  const held = await loadChannel(rt, "cache-only");
  const cached = (held.channel ?? held.expired)?.releases.find((r) => r.version === version);
  if (cached) return { entry: cached, loaded: held };
  const loaded = await loadChannel(rt, "force");
  return { entry: loaded.channel?.releases.find((r) => r.version === version) ?? null, loaded };
}

/**
 * The release `version` names: the bundled one (or its rollback), a release the project pin or
 * the user default locks, else the channel's entry and its verified document.
 *
 * @throws {RuntimeCliError} When it can't be found or fetched (offline included).
 */
async function findRelease(rt: Rt, version: string): Promise<FoundRelease> {
  const own = bundledFound(rt, version);
  if (own) return own;
  const known = await fromKnownLock(rt, version);
  if (known) return known;
  const { entry, loaded } = await channelEntry(rt, version);
  if (!entry) {
    const why = loaded.channel ? "the runtime channel does not list it" : absenceText(loaded);
    throw new RuntimeCliError(`denext: runtime ${version} can't be found: ${why}.`);
  }
  try {
    const pins = await documentOf(rt, entry);
    const lock = { version, integrity: releaseIntegrity(entry.doc.sha256) };
    return { lock, pins, entry, bundled: false };
  } catch (err) {
    throw new RuntimeCliError(
      `denext: runtime ${version}'s release document can't be had: ${errText(err)}`,
    );
  }
}

/**
 * The revoked-runtimes list in force, read the way the channel's loader reads it (the same cache
 * and seams; the network only when the cached copy is stale). `null`: none can be had, or the
 * check is off.
 */
async function revokedList(rt: Rt): Promise<RuntimeRevocationList | null> {
  const { load = loadRuntimeRevocations, ...over } = rt.channel.revocations ?? {};
  const { list } = await load({
    mode: "fetch",
    env: rt.env,
    cacheRoot: rt.cacheRoot,
    now: rt.now,
    ...(rt.channel.fetch ? { fetch: rt.channel.fetch } : {}),
    ...(rt.channel.netGranted ? { netGranted: rt.channel.netGranted } : {}),
    ...over,
  });
  return list;
}

/**
 * Refuse a release the revoked-runtimes list revokes for this host (unless
 * `DENEXT_ALLOW_REVOKED_RUNTIME` names it); warn about one it revokes for other targets only.
 */
async function checkNotRevoked(rt: Rt, version: string): Promise<void> {
  const list = await revokedList(rt);
  if (!revokesVersion(list, version)) return;
  const triple = Deno.build.target;
  const hit = findRevocation(list, "cli", version, triple) ??
    findRevocation(list, "desktop", version, triple);
  const refusal = hit ? revokedChoiceRefusal(hit, triple, rt.env) : null;
  if (refusal) throw new RuntimeCliError(refusal);
  rt.warn(
    hit
      ? `denext: runtime ${version} is revoked for ${triple} (${hit.reason}); taking it anyway.`
      : `denext: runtime ${version} is revoked for other targets; \`denext runtime upgrade\` ` +
        "moves to a release that is not revoked.",
  );
}

/** Refuse a release this denext does not run on or that is revoked; warn about a withdrawn one. */
async function checkRunnable(rt: Rt, found: FoundRelease): Promise<void> {
  if (found.bundled) return;
  const facts = found.entry ? factsOfEntry(found.entry) : factsOfPins(found.pins);
  const bad = runtimeIncompatibility(facts, rt.compat);
  if (bad) throw new RuntimeCliError(`denext: ${bad.message}.`);
  await checkNotRevoked(rt, found.lock.version);
  if (found.entry?.yanked) {
    rt.warn(
      `denext: runtime ${found.lock.version} was withdrawn (${found.entry.yanked.reason}); ` +
        "`denext runtime upgrade` moves to a current release.",
    );
  }
}

/** Install a found release's toolchain for this host. */
async function installFound(rt: Rt, found: FoundRelease): Promise<Installed> {
  try {
    return await rt.ensure(found.pins.toolchain, rt.cacheRoot);
  } catch (err) {
    throw new RuntimeCliError(errText(err));
  }
}

// ---------------------------------------------------------------------------------------------
// Where a selection is written: the user default or the project pin.

/** Write the project pin (`"denext": { "runtime": { version, integrity } }`); its config's path. */
async function writeProjectPin(rt: Rt, lock: RuntimeLock): Promise<string> {
  const path = projectRuntimeConfigPath(rt.dir);
  if (!path) {
    throw new RuntimeCliError(
      `denext: no deno.json in ${rt.dir} or above: --project writes the runtime pin into the ` +
        "project's deno.json.",
    );
  }
  const text = await Deno.readTextFile(path);
  const edited = await setJsonValue(text, ["denext", "runtime"], {
    version: lock.version,
    integrity: lock.integrity,
  });
  if (!edited.ok) {
    throw new RuntimeCliError(
      `denext: could not write the runtime pin in ${path}: ${edited.reason}`,
    );
  }
  await Deno.writeTextFile(path, edited.source);
  return path;
}

/** Write the user default. */
async function writeDefault(rt: Rt, value: UserRuntimeDefault): Promise<void> {
  await writeUserRuntimeDefault(rt.cacheRoot, value, rt.defaultFile);
}

/** Remove the user default (`use bundled`); whether there was one. */
async function removeDefault(rt: Rt): Promise<boolean> {
  try {
    await Deno.remove(rt.defaultFile);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** The version an unpinned project runs for the user: the default when in force, else bundled. */
function userVersion(rt: Rt): string | null {
  const bundled = rt.bundled.toolchain.version;
  const d = readUserRuntimeDefaultFile(rt.defaultFile);
  if (!d) return bundled;
  if (d.held || bundled === null || compareDenoVersions(d.version, bundled) >= 0) return d.version;
  return bundled;
}

/** The project pin's version, or `null` (a malformed pin counts as none: it is rewritten). */
function projectVersion(rt: Rt): string | null {
  try {
    return readProjectRuntimePin(rt.dir)?.lock.version ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// `runtime upgrade` (and `use latest`): the newest compatible release past the hold.

/** What a floating pick found in the channel. */
interface FloatingPick {
  readonly pick: RuntimeChannelRelease | null;
  /** The newest compatible release the hold keeps out. */
  readonly held: RuntimeChannelRelease | null;
  /** The newest listed release newer than the pick that needs a newer denext. */
  readonly needsDenext: RuntimeChannelRelease | null;
  readonly rule: Pick<DepAgeRule, "cutoff">;
}

/** The newest un-yanked release newer than `than` that this denext is too old for. */
function needsNewerDenext(
  rt: Rt,
  releases: readonly RuntimeChannelRelease[],
  than: string | null,
): RuntimeChannelRelease | null {
  for (const e of releases) {
    if (than !== null && compareDenoVersions(e.version, than) <= 0) return null;
    if (!e.yanked && runtimeIncompatibility(factsOfEntry(e), rt.compat)?.kind === "needs-denext") {
      return e;
    }
  }
  return null;
}

/** The floating pick over the channel's entries (newest first). */
async function floatingPick(
  rt: Rt,
  releases: readonly RuntimeChannelRelease[],
): Promise<FloatingPick> {
  const rule = await rt.rule(rt.dir, new Date(rt.now()));
  const list = await revokedList(rt);
  const { pick, held } = newestAvailableRelease(releases, {
    rule,
    compat: rt.compat,
    revoked: (version) => revokesVersion(list, version),
  });
  return { pick, held, needsDenext: needsNewerDenext(rt, releases, pick?.version ?? null), rule };
}

/** The verified channel index, or a failure naming why it is absent. */
async function requireChannel(rt: Rt, verb: string): Promise<readonly RuntimeChannelRelease[]> {
  const loaded = await loadChannel(rt, "force");
  if (!loaded.channel) {
    throw new RuntimeCliError(`denext: ${verb} needs the runtime channel: ${absenceText(loaded)}.`);
  }
  return loaded.channel.releases;
}

/** When the hold lets `held` in, as an ISO date (`null`: no rule holds it). */
function holdUntil(rt: Rt, p: FloatingPick, held: RuntimeChannelRelease): Date | null {
  const rule = { cutoff: p.rule.cutoff, exclude: [], source: "default" as const };
  return heldUntil(rule, "runtime", held.releasedAt, new Date(rt.now()));
}

/** The line explaining a held release and what stays or was taken instead. */
function holdLine(rt: Rt, p: FloatingPick, staying: string | null, took: boolean): string | null {
  if (!p.held) return null;
  const until = holdUntil(rt, p, p.held);
  if (!until) return null;
  const now = new Date(rt.now());
  const head = holdHead(
    { name: "runtime", version: p.held.version, publishedAt: p.held.releasedAt, until },
    now,
  );
  const instead = staying === null
    ? " No older runtime release is old enough to take instead — run this again after that."
    : ` ${took ? "Took" : "Staying on"} ${staying} for now — run "denext runtime upgrade" after ` +
      "that.";
  return `denext: ${head}${instead}`;
}

/** The scope `upgrade` / `use` writes, and the version it holds now. */
interface Scope {
  readonly project: boolean;
  readonly current: string | null;
}

function scopeOf(rt: Rt, ctx: CommandContext): Scope {
  const project = ctx.flags.project === true;
  return { project, current: project ? projectVersion(rt) ?? null : userVersion(rt) };
}

/** Whether `pick` moves the scope forward (a project with no pin always takes one). */
function moves(scope: Scope, pick: string, rt: Rt): boolean {
  if (scope.project && projectVersion(rt) === null) return true;
  return scope.current === null || compareDenoVersions(pick, scope.current) > 0;
}

/** Install a channel release and write it where `scope` says; the config path for a project. */
async function adopt(
  rt: Rt,
  entry: RuntimeChannelRelease,
  scope: Scope,
  held: boolean,
): Promise<{ installed: Installed; configPath: string | null; lock: RuntimeLock }> {
  const found = await findRelease(rt, entry.version);
  await checkRunnable(rt, found);
  const installed = await installFound(rt, found);
  const configPath = scope.project ? await writeProjectPin(rt, found.lock) : null;
  if (!scope.project) await writeDefault(rt, { ...found.lock, held });
  return { installed, configPath, lock: found.lock };
}

/** The `--json` record of an upgrade. */
function upgradeJson(
  scope: Scope,
  p: FloatingPick,
  to: string | null,
  changed: boolean,
  dryRun: boolean,
  extra: Record<string, unknown> = {},
) {
  return {
    scope: scope.project ? "project" : "user",
    from: scope.current,
    to,
    changed,
    dryRun,
    held: p.held ? { version: p.held.version, releasedAt: p.held.releasedAt } : null,
    needsDenext: p.needsDenext
      ? { version: p.needsDenext.version, minDenext: p.needsDenext.minDenext }
      : null,
    ...extra,
  };
}

/** The lines every upgrade outcome adds: the hold, a release that needs a newer denext. */
function upgradeNotes(rt: Rt, p: FloatingPick, staying: string | null, took: boolean): string[] {
  const out: string[] = [];
  const hold = holdLine(rt, p, staying, took);
  if (hold) out.push(hold);
  if (p.needsDenext) {
    out.push(
      `denext: runtime ${p.needsDenext.version} needs denext ${p.needsDenext.minDenext} or ` +
        'newer: run "denext upgrade".',
    );
  }
  return out;
}

/** The sentence for an adopted release. */
function adoptedLine(scope: Scope, version: string, configPath: string | null): string {
  const was = scope.current ? ` (was ${scope.current})` : "";
  return scope.project
    ? `denext: pinned runtime ${version} in ${configPath}${was}`
    : `denext: runtime ${version} is now your default${was}`;
}

/**
 * `denext runtime upgrade [--project] [--dry-run]`: the newest compatible release whose signed
 * `releasedAt` is past the dependency-age hold (no exemption), installed and made the user
 * default (unheld: a newer denext's bundled pin still wins) or the project pin.
 */
async function upgrade(rt: Rt, ctx: CommandContext): Promise<number> {
  const releases = await requireChannel(rt, "runtime upgrade");
  const p = await floatingPick(rt, releases);
  const scope = scopeOf(rt, ctx);
  const dryRun = ctx.flags["dry-run"] === true;
  if (!p.pick) return upgradeNothing(rt, scope, p, dryRun);
  if (!moves(scope, p.pick.version, rt)) {
    return report(rt, upgradeJson(scope, p, scope.current, false, dryRun), [
      `denext: runtime ${scope.current} is the newest release this denext takes; nothing to do.`,
      ...upgradeNotes(rt, p, scope.current, false),
    ]);
  }
  if (dryRun) {
    return report(rt, upgradeJson(scope, p, p.pick.version, true, true), [
      `denext: would install runtime ${p.pick.version} and make it ${
        scope.project ? "the project pin" : "your default"
      }${scope.current ? ` (now ${scope.current})` : ""}.`,
      ...upgradeNotes(rt, p, p.pick.version, true),
    ]);
  }
  const done = await adopt(rt, p.pick, scope, false);
  return report(
    rt,
    upgradeJson(scope, p, p.pick.version, true, false, {
      deno: done.installed.deno,
      integrity: done.lock.integrity,
      ...(done.configPath ? { configPath: done.configPath } : {}),
    }),
    [
      adoptedLine(scope, p.pick.version, done.configPath),
      ...upgradeNotes(rt, p, p.pick.version, true),
    ],
  );
}

/** No release to take: held back (exit 0, nothing to do yet) or none at all (exit 1). */
function upgradeNothing(rt: Rt, scope: Scope, p: FloatingPick, dryRun: boolean): number {
  const lines = upgradeNotes(rt, p, scope.current, false);
  const none = !p.held;
  if (none) lines.unshift("denext: the runtime channel lists no release this denext runs on.");
  report(rt, upgradeJson(scope, p, null, false, dryRun), lines);
  return none && !p.needsDenext ? 1 : 0;
}

/** Print `lines` (or `json` with `--json`); exit code 0. */
function report(rt: Rt, json: unknown, lines: string[]): number {
  if (rt.json) printJson(rt, json);
  else for (const line of lines) rt.log(line);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// `runtime use <version | latest | bundled> [--project]`.

/** `use bundled`: drop the user default, or pin the bundled release in the project. */
async function pinBundled(rt: Rt, scope: Scope): Promise<number> {
  const version = rt.bundled.toolchain.version;
  if (scope.project) {
    const lock = lockOfPins(rt.bundled);
    if (!lock) throw new RuntimeCliError("denext: this denext bundles no runtime release.");
    const configPath = await writeProjectPin(rt, lock);
    return report(rt, pinJson(scope, version, lock, configPath), [
      adoptedLine(scope, version!, configPath),
    ]);
  }
  const removed = await removeDefault(rt);
  return report(rt, { ...pinJson(scope, version, null, null), removedDefault: removed }, [
    removed
      ? `denext: removed your default runtime; the bundled ${version} runs (and a newer denext's ` +
        "bundled release after an upgrade)."
      : `denext: no default runtime is set; the bundled ${version} runs.`,
  ]);
}

/** The `--json` record of a `use`. */
function pinJson(
  scope: Scope,
  version: string | null,
  lock: RuntimeLock | null,
  configPath: string | null,
) {
  return {
    scope: scope.project ? "project" : "user",
    from: scope.current,
    to: version,
    integrity: lock?.integrity ?? null,
    ...(configPath ? { configPath } : {}),
  };
}

/** `use latest`: the floating pick, held (`--project`: pinned). */
async function pinLatest(rt: Rt, scope: Scope): Promise<number> {
  const releases = await requireChannel(rt, "runtime use latest");
  const p = await floatingPick(rt, releases);
  if (!p.pick) return upgradeNothing(rt, scope, p, false);
  const done = await adopt(rt, p.pick, scope, true);
  return report(rt, pinJson(scope, p.pick.version, done.lock, done.configPath), [
    adoptedLine(scope, p.pick.version, done.configPath),
    ...upgradeNotes(rt, p, p.pick.version, true),
  ]);
}

/**
 * `denext runtime use <version | latest | bundled> [--project]`: install the release and make it
 * the user default — held, so it runs even under a newer denext's bundled pin — or the project pin
 * (`version` + `integrity`). `bundled` removes the default (or pins the bundled release). An
 * installed release needs no network.
 */
async function chooseRelease(rt: Rt, ctx: CommandContext): Promise<number> {
  const wanted = ctx.positionals[1];
  if (!wanted || ctx.positionals.length > 2) {
    throw new RuntimeCliError(
      "denext: name one release: `denext runtime use <version | latest | bundled> [--project]`",
    );
  }
  const scope = scopeOf(rt, ctx);
  if (wanted === "bundled") return await pinBundled(rt, scope);
  if (wanted === "latest") return await pinLatest(rt, scope);
  const found = await findRelease(rt, wanted);
  await checkRunnable(rt, found);
  await installFound(rt, found);
  const configPath = scope.project ? await writeProjectPin(rt, found.lock) : null;
  if (!scope.project) await writeDefault(rt, { ...found.lock, held: true });
  return report(rt, pinJson(scope, wanted, found.lock, configPath), [
    adoptedLine(scope, wanted, configPath),
  ]);
}

// ---------------------------------------------------------------------------------------------
// `runtime install [<version>] [--with gleam,fastlane]`.

/** The `--with` tools, checked. */
function withTools(ctx: CommandContext): string[] {
  const raw = typeof ctx.flags.with === "string" ? ctx.flags.with : "";
  const tools = raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const unknown = tools.filter((t) => !(EXTRA_TOOLS as readonly string[]).includes(t));
  if (unknown.length > 0) {
    throw new RuntimeCliError(
      `denext: unknown --with tool ${unknown.join(", ")} (known: ${EXTRA_TOOLS.join(", ")})`,
    );
  }
  return tools;
}

/** Fetch and verify the pinned Gleam. */
async function installGleam(rt: Rt): Promise<void> {
  const g = await ensureGleamToolchain().catch((err) => {
    throw new RuntimeCliError(errText(err));
  });
  rt.log(`  denext's Gleam ${g.version}: ${g.gleam}${g.cached ? " (cached)" : ""}`);
}

/** Install the managed fastlane (fails on Windows, without a C compiler, offline). */
async function installFastlane(rt: Rt): Promise<void> {
  const f = await ensureFastlaneToolchain().catch((err) => {
    throw new RuntimeCliError(errText(err));
  });
  rt.log(`  denext's fastlane ${f.version}: ${f.dir}${f.cached ? " (cached)" : ""}`);
}

/** A revocation status (a not-configured one when the list was not consulted). */
function revocationOf(
  given: RuntimeRevocationStatus | undefined,
  pinned: string | null,
): RuntimeRevocationStatus {
  return given ?? {
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

/** `install` with no version: the selected release (the bundled pins' rollback logic applied). */
async function installSelected(rt: Rt): Promise<void> {
  const installed = await requireRuntime("force");
  rt.log(
    `  denext's runtime ${installed.version}: ${installed.deno}${
      installed.cached ? " (cached)" : ""
    }`,
  );
  const r = revocationStatusLine(revocationOf(installed.revocation, installed.version));
  rt.log(`  revocations: ${r.detail}`);
}

/** `install <version>`: that release (an explicit choice: no hold). */
async function installVersion(rt: Rt, version: string): Promise<void> {
  const found = await findRelease(rt, version);
  await checkRunnable(rt, found);
  const installed = await installFound(rt, found);
  rt.log(
    `  denext's runtime ${installed.version}: ${installed.deno}${
      installed.cached ? " (cached)" : ""
    }`,
  );
}

/**
 * `denext runtime install [<version>]`: download and verify a release (default: the one selected
 * here), and — for a CLI run from JSR, which loads each verb on first use — cache every verb now,
 * so all of them work offline after this post-install step. `--with gleam` also fetches the pinned
 * Gleam compiler, and `--with fastlane` installs the managed fastlane.
 */
async function install(rt: Rt, ctx: CommandContext): Promise<number> {
  const extras = withTools(ctx);
  const versions = ctx.positionals.slice(1);
  if (versions.length > 1) throw new RuntimeCliError("denext: `runtime install` takes one release");
  if (versions[0]) await installVersion(rt, versions[0]);
  else await installSelected(rt);
  if (extras.includes("gleam")) await installGleam(rt);
  if (extras.includes("fastlane")) await installFastlane(rt);
  if (!isRemoteCli()) return 0;
  if (!await cacheCliModules()) {
    throw new RuntimeCliError(
      "denext: could not cache the CLI's verbs; they load on first use instead",
    );
  }
  rt.log("  every denext verb is cached for offline use");
  return 0;
}

// ---------------------------------------------------------------------------------------------
// `runtime version` / `info`: what runs here and why.

/** Where a release came from, in words. */
const SOURCE_TEXT: Record<RuntimeRelease["source"], string> = {
  override: "DENEXT_TOOLCHAIN_PIN_FILE (development override)",
  env: "DENEXT_RUNTIME",
  project: "the project pin",
  default: "your default",
  inherited: "the release the parent command chose",
  bundled: "bundled with this denext",
};

/** The selection, or why it can't run. */
async function selection(rt: Rt): Promise<RuntimeRelease | { error: string }> {
  try {
    const release = await resolveRuntimeRelease(rt.resolve);
    rememberRuntimeRelease(release);
    return release;
  } catch (err) {
    return { error: errText(err) };
  }
}

/** The channel's state for `version` / `list`. */
interface ChannelState {
  readonly state: "current" | "expired" | "absent";
  readonly reason: string | null;
  readonly sequence: number | null;
  readonly expiresAt: string | null;
  readonly releases: readonly RuntimeChannelRelease[];
}

function channelState(loaded: LoadedChannel): ChannelState {
  if (loaded.channel) return indexState("current", null, loaded.channel);
  const reason = absenceText(loaded);
  if (loaded.expired) return indexState("expired", reason, loaded.expired);
  return { state: "absent", reason, sequence: null, expiresAt: null, releases: [] };
}

/** The state of a verified index (current, or expired). */
function indexState(
  state: ChannelState["state"],
  reason: string | null,
  index: { sequence: number; expiresAt: string; releases: readonly RuntimeChannelRelease[] },
): ChannelState {
  return {
    state,
    reason,
    sequence: index.sequence,
    expiresAt: index.expiresAt,
    releases: index.releases,
  };
}

/** The newest release a floating upgrade would take, when newer than `current`. */
async function available(
  rt: Rt,
  ch: ChannelState,
  current: string | null,
): Promise<string | null> {
  if (ch.releases.length === 0) return null;
  const p = await floatingPick(rt, ch.releases);
  if (!p.pick) return null;
  return current === null || compareDenoVersions(p.pick.version, current) > 0
    ? p.pick.version
    : null;
}

/** The selection's `--json` record. */
function releaseJson(release: RuntimeRelease | { error: string }, configPath: string | null) {
  if ("error" in release) return { error: release.error };
  return {
    version: release.version,
    source: release.source,
    integrity: release.integrity,
    ...(release.source === "project" && configPath ? { configPath } : {}),
    notices: release.notices,
  };
}

/** One report line, and its path line when there is one. */
function statusLine(
  rt: Rt,
  ok: boolean,
  label: string,
  detail: string,
  path: string | null = null,
): void {
  rt.log(`  ${ok ? "✔" : "✖"} ${label.padEnd(15)} ${detail}`);
  if (path) rt.log(`    path  ${path}`);
}

/** The cache state of the runtime's Deno and the tools beside it. */
export interface ToolsStatus {
  readonly toolchain: DenoToolchainStatus;
  readonly revocation: RuntimeRevocationStatus;
  readonly esbuildBinary: EsbuildBinaryStatus;
  readonly gleam: GleamToolchainStatus;
  readonly fastlane: FastlaneToolchainStatus;
}

/** This machine's {@linkcode ToolsStatus} (the revoked-runtimes list fetched now). */
async function machineTools(verify: boolean): Promise<ToolsStatus> {
  const toolchain = await denoToolchainStatus({ verify });
  const [esbuildBinary, gleam, fastlane] = await Promise.all([
    esbuildBinaryStatus(),
    gleamToolchainStatus({ verify }),
    fastlaneToolchainStatus({ verify }),
  ]);
  const selected = toolchain.mode === "pinned"
    ? await toolchainSelection("force").catch(() => null)
    : null;
  const revocation = revocationOf(selected?.revocation, toolchain.version);
  return { toolchain, revocation, esbuildBinary, gleam, fastlane };
}

/** Everything `version` reports. */
interface VersionReport {
  readonly release: RuntimeRelease | { error: string };
  readonly configPath: string | null;
  readonly userDefault: UserRuntimeDefault | null;
  readonly channel: ChannelState;
  readonly available: string | null;
}

/** The selection's lines: the release and why, its integrity, its notices (or why it can't run). */
function printSelection(rt: Rt, v: VersionReport): void {
  const r = v.release;
  if ("error" in r) {
    statusLine(rt, false, "runtime", r.error.replace(/^denext: /, ""));
    return;
  }
  const where = r.source === "project" && v.configPath ? ` (${v.configPath})` : "";
  statusLine(rt, true, "runtime", `${r.version ?? "none"}: ${SOURCE_TEXT[r.source]}${where}`);
  if (r.integrity) rt.log(`    integrity  ${r.integrity}`);
  for (const n of r.notices) rt.log(`    ${n}`);
}

/** The channel's line: its index, and the newer release it offers (or why there is none). */
function channelLine(v: VersionReport): { ok: boolean; detail: string } {
  const ch = v.channel;
  const seq = ch.sequence === null ? "" : `sequence ${ch.sequence}, expires ${ch.expiresAt}; `;
  const fallback = ch.state === "current" ? "nothing newer" : ch.reason;
  const news = v.available
    ? `runtime ${v.available} is available: denext runtime upgrade`
    : fallback;
  return { ok: ch.state !== "expired", detail: `${seq}${news}` };
}

/** The runtime lines: the selection, the bundled pin, the default, the channel. */
function printRuntimeLines(rt: Rt, v: VersionReport): void {
  printSelection(rt, v);
  const b = rt.bundled.toolchain;
  const rollback = b.rollback ? ` (rollback ${b.rollback.version})` : "";
  statusLine(
    rt,
    true,
    "bundled",
    `${b.version}${rollback}; oldest this denext runs: ${MIN_RUNTIME}`,
  );
  const d = v.userDefault;
  statusLine(rt, true, "your default", d ? `${d.version}${d.held ? " (held)" : ""}` : "none");
  const ch = channelLine(v);
  statusLine(rt, ch.ok, "channel", ch.detail);
}

/**
 * `denext runtime version` (alias `info`, `--json`, `--verify`): the release that runs here and
 * why (its source and integrity), the bundled pin, {@linkcode MIN_RUNTIME}, the user default, the
 * channel (cached, no network) and the newer release it offers, the revoked-runtimes list, and the
 * cache state of the runtime's Deno, esbuild, TypeScript, Gleam and fastlane. Exits 1 when
 * something needs fixing (a selection that can't run, a cache that failed verification).
 */
async function version(rt: Rt, ctx: CommandContext): Promise<number> {
  const verify = ctx.flags.verify === true;
  const release = await selection(rt);
  const tools = await rt.tools(verify);
  const channel = channelState(await loadChannel(rt, "cache-only"));
  const current = "error" in release ? null : release.version;
  const v: VersionReport = {
    release,
    configPath: projectRuntimeConfigPath(rt.dir),
    userDefault: readUserRuntimeDefaultFile(rt.defaultFile),
    channel,
    available: await available(rt, channel, current),
  };
  if (rt.json) printJson(rt, versionJson(rt, v, tools));
  else printVersion(rt, v, tools);
  const stale = await staleToolchainLink().catch(() => null);
  if (stale) rt.warn(stale);
  const broken = !tools.toolchain.ok || !tools.gleam.ok || !tools.fastlane.ok;
  return "error" in release || broken ? 1 : 0;
}

/** `version --json`. */
function versionJson(rt: Rt, v: VersionReport, tools: ToolsStatus) {
  return {
    runtime: releaseJson(v.release, v.configPath),
    bundled: {
      version: rt.bundled.toolchain.version,
      rollback: rt.bundled.toolchain.rollback?.version ?? null,
    },
    minRuntime: MIN_RUNTIME,
    default: v.userDefault,
    channel: {
      state: v.channel.state,
      reason: v.channel.reason,
      sequence: v.channel.sequence,
      expiresAt: v.channel.expiresAt,
      available: v.available,
    },
    ...tools,
  };
}

/** `version`'s report. */
function printVersion(rt: Rt, v: VersionReport, tools: ToolsStatus): void {
  const { toolchain: s, esbuildBinary: esbuild, gleam, fastlane } = tools;
  rt.log("");
  printRuntimeLines(rt, v);
  statusLine(rt, s.ok, "deno", s.detail, s.path);
  const r = revocationStatusLine(tools.revocation);
  statusLine(rt, r.ok, "revocations", r.detail);
  statusLine(rt, esbuild.ok, "esbuild", esbuild.detail, esbuild.path);
  statusLine(rt, s.tsgo.state !== "refused", "typescript", s.tsgo.detail, s.tsgo.path);
  statusLine(rt, s.tsgoLsp.state !== "refused", "typescript lsp", s.tsgoLsp.detail, s.tsgoLsp.path);
  statusLine(rt, gleam.ok, "gleam", gleam.detail, gleam.state === "missing" ? null : gleam.path);
  const fastlanePath = fastlane.state === "missing" ? null : fastlane.path;
  statusLine(rt, fastlane.ok, "fastlane", fastlane.detail, fastlanePath);
  rt.log("");
}

// ---------------------------------------------------------------------------------------------
// `runtime list [--all]`.

/** The releases installed for this host (a verified binary's stamp in `<cache>/<version>/<target>`). */
async function installedVersions(rt: Rt): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(rt.cacheRoot)) {
      if (!e.isDirectory || !/^\d+\.\d+\.\d+/.test(e.name)) continue;
      const stamp = join(rt.cacheRoot, e.name, rt.target, TOOLCHAIN_STAMP);
      if (await Deno.stat(stamp).then((s) => s.isFile, () => false)) out.push(e.name);
    }
  } catch {
    // No cache yet.
  }
  return out;
}

/** One row of `list`. */
interface ListRow {
  readonly version: string;
  readonly installed: boolean;
  /** `selected`, `default`, `project`, `bundled`, `rollback`. */
  readonly roles: string[];
  /** What the channel says: available | held | yanked | incompatible | unlisted (`null`: no channel). */
  readonly channel: "available" | "held" | "yanked" | "incompatible" | "unlisted" | null;
  readonly reason?: string;
  readonly releasedAt?: string;
}

/** What the channel says about `entry`. */
function channelVerdict(
  rt: Rt,
  entry: RuntimeChannelRelease,
  rule: Pick<DepAgeRule, "cutoff">,
): Pick<ListRow, "channel" | "reason"> {
  if (entry.yanked) return { channel: "yanked", reason: entry.yanked.reason };
  const bad = runtimeIncompatibility(factsOfEntry(entry), rt.compat);
  if (bad) return { channel: "incompatible", reason: bad.message };
  const past = rule.cutoff === null || Date.parse(entry.releasedAt) < rule.cutoff.getTime();
  return { channel: past ? "available" : "held" };
}

/** The roles each version plays here. */
function rolesOf(rt: Rt, selected: string | null): Map<string, string[]> {
  const roles = new Map<string, string[]>();
  const add = (v: string | null | undefined, role: string) => {
    if (v) roles.set(v, [...(roles.get(v) ?? []), role]);
  };
  add(selected, "selected");
  add(readUserRuntimeDefaultFile(rt.defaultFile)?.version, "default");
  add(projectVersion(rt), "project");
  add(rt.bundled.toolchain.version, "bundled");
  add(rt.bundled.toolchain.rollback?.version, "rollback");
  return roles;
}

/** The versions `list` shows: installed and in use, the floating pick and the held one (or all). */
function listedVersions(
  installed: string[],
  roles: Map<string, string[]>,
  ch: ChannelState,
  p: FloatingPick | null,
  all: boolean,
): string[] {
  const set = new Set([...installed, ...roles.keys()]);
  if (p?.pick) set.add(p.pick.version);
  if (p?.held) set.add(p.held.version);
  if (all) { for (const e of ch.releases) set.add(e.version); }
  return [...set].sort((a, b) => compareDenoVersions(b, a));
}

/** One row. */
function rowOf(
  rt: Rt,
  version: string,
  ctx: {
    installed: Set<string>;
    roles: Map<string, string[]>;
    ch: ChannelState;
    p: FloatingPick | null;
  },
): ListRow {
  const entry = ctx.ch.releases.find((e) => e.version === version);
  const base = {
    version,
    installed: ctx.installed.has(version),
    roles: ctx.roles.get(version) ?? [],
  };
  if (ctx.ch.releases.length === 0) return { ...base, channel: null };
  if (!entry) return { ...base, channel: "unlisted" };
  return { ...base, ...channelVerdict(rt, entry, ctx.p!.rule), releasedAt: entry.releasedAt };
}

/** A row's human line. */
function rowLine(row: ListRow): string {
  const mark = row.roles.includes("selected") ? "*" : " ";
  const state = [row.installed ? "installed" : "", row.channel ?? ""].filter(Boolean).join(", ");
  const roles = row.roles.filter((r) => r !== "selected").join(", ");
  const why = row.reason ? ` (${row.reason})` : "";
  return `${mark} ${row.version.padEnd(20)} ${state.padEnd(24)} ${roles}${why}`.trimEnd();
}

/**
 * `denext runtime list [--all]` (`--json`): the releases installed here and the ones in use (the
 * selected one starred), and — with the channel (the network at most every 12 hours) — the release
 * an upgrade would take, the one the hold keeps out, and each listed release's verdict: available,
 * held, yanked or incompatible. `--all` lists every release the channel names. Offline, the
 * channel is reported unavailable and the installed releases are still listed.
 */
async function list(rt: Rt, ctx: CommandContext): Promise<number> {
  const release = await selection(rt);
  const selected = "error" in release ? null : release.version;
  const ch = channelState(await loadChannel(rt, "fetch"));
  const p = ch.releases.length > 0 ? await floatingPick(rt, ch.releases) : null;
  const installed = await installedVersions(rt);
  const roles = rolesOf(rt, selected);
  const versions = listedVersions(installed, roles, ch, p, ctx.flags.all === true);
  const rowCtx = { installed: new Set(installed), roles, ch, p };
  const rows = versions.map((v) => rowOf(rt, v, rowCtx));
  if (rt.json) printJson(rt, listJson(ch, p, rows));
  else printList(rt, ch, rows);
  return 0;
}

/** `list --json`. */
function listJson(ch: ChannelState, p: FloatingPick | null, rows: ListRow[]) {
  return {
    channel: { state: ch.state, reason: ch.reason, sequence: ch.sequence },
    upgrade: p?.pick?.version ?? null,
    held: p?.held?.version ?? null,
    releases: rows,
  };
}

/** `list`'s report: the channel's line, then a row per release. */
function printList(rt: Rt, ch: ChannelState, rows: ListRow[]): void {
  rt.log("");
  rt.log(
    ch.state === "current"
      ? `  channel: sequence ${ch.sequence}, expires ${ch.expiresAt}`
      : `  channel: unavailable (${ch.reason})`,
  );
  for (const row of rows) rt.log(`  ${rowLine(row)}`);
  rt.log("");
}

// ---------------------------------------------------------------------------------------------
// `runtime path | link | unlink`.

/** `runtime link` / `unlink`. */
async function link(rt: Rt, unlink: boolean): Promise<number> {
  if (unlink) {
    const removed = await unlinkDenoToolchain();
    rt.log(removed ? `  removed ${removed}` : "  nothing to unlink");
    return 0;
  }
  const { deno } = await runtimeBinary();
  const stale = await staleToolchainLink().catch(() => null);
  const made = await linkDenoToolchain(deno);
  if (stale) rt.log(`  replaced a stale link (${stale.replace(/^denext: /, "")})`);
  rt.log(`  linked ${made.link} → ${deno}\n  Put it on PATH (once):\n    ${made.pathLine}`);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// The verb.

/** The actions that take an exit code back; the rest (uninstall, prune, path) exit themselves. */
const ACTION_RUNNERS: Record<string, (rt: Rt, ctx: CommandContext) => Promise<number>> = {
  version,
  info: version,
  list,
  install,
  upgrade,
  use: chooseRelease,
  link: (rt) => link(rt, false),
  unlink: (rt) => link(rt, true),
  path: async (rt) => {
    rt.log((await runtimeBinary()).deno);
    return 0;
  },
};

/**
 * Run one `denext runtime` action: its exit code (a {@linkcode RuntimeCliError} is reported as one
 * line and 1). `uninstall` and `prune` exit on their own.
 *
 * @param ctx The command context.
 * @param deps Seams for tests.
 * @returns The exit code.
 */
export async function runtimeAction(
  ctx: CommandContext,
  deps: RuntimeCliDeps = {},
): Promise<number> {
  const action = ctx.positionals[0] ?? "";
  const rt = rtOf(ctx, deps);
  if (action === "uninstall" || action === "prune") {
    await runtimeRemove(ctx);
    return 0;
  }
  const run = ACTION_RUNNERS[action];
  if (!run) {
    rt.warn(`denext: unknown runtime action ${JSON.stringify(action)} (${ACTIONS})`);
    return 1;
  }
  try {
    return await run(rt, ctx);
  } catch (err) {
    if (!(err instanceof RuntimeCliError)) throw err;
    rt.warn(err.message);
    return 1;
  }
}

export const runtimeCommand: CommandSpec = {
  ...commandMeta("runtime"),
  run: async (ctx) => {
    const code = await runtimeAction(ctx);
    if (code !== 0) Deno.exit(code);
  },
};
