// The maintainers' side of the runtime channel (src/build/runtime-channel.ts): publishing a
// denext runtime release so machines can move to it with `denext runtime upgrade`, without a
// denext release.
//
//   deno task runtime:keygen [--slot active|backup] [--force]
//       a new ECDSA P-256 key pair for the channel (its own pair, never the revocation list's): the
//       private key goes straight into the login keychain (service `denext-runtime-channel`,
//       account = the slot), never printed or written to disk; the public key is printed, to paste
//       into its slot in src/build/runtime-channel-keys.ts
//   deno task runtime:publish <tag> [--compat-run <id>] [--security] [--released-at <rfc3339>]
//       [--with-backup] [--no-publish] [--manifest <f> --sums <f>] [--archives <dir>]
//   deno task runtime:publish <tag> --bundled --min-denext <version> [...]
//       1. build the release document from the GitHub release with the pin script's checks: every
//          archive against manifest.json and SHA256SUMS, hashed, `gh attestation verify` (the
//          fork's release workflow, this tag) — nothing is signed unless they all pass;
//       2. the compatibility proof: dispatch `runtime-compat.yml -f tag=<tag>` on Brainwires/denext
//          and wait for it once (or read the finished run `--compat-run` names); every leg (the
//          latest stable denext and the previous minor's last patch) must be green, and the oldest
//          green leg is the entry's `minDenext`. `--bundled` skips it only for a release this
//          checkout already compiles in (its pin or the pin's rollback), which shipped through
//          denext's own release gates; `--min-denext` then names the oldest denext that pins it;
//       3. the entry (release date from the GitHub release, `--security` for a security fix) is
//          added to security/runtime-channel.json, the unsigned source of every entry;
//       4. the index is signed with the keychain key (`--with-backup`: the backup key too, during a
//          rotation), verified against the public keys COMPILED INTO this checkout, written to
//          `.denext/runtime-channel/` and published unless `--no-publish`: the release document
//          first, then the index, to `$DENEXT_REVOCATIONS_RSYNC_ROOT/runtime/` (the denext.dev web
//          root, served as https://denext.dev/runtime/) and in one commit to the orphan branch
//          `denext-runtime-channel` of Brainwires/deno (the mirror; never a force push).
//       Commit security/runtime-channel.json to `development` afterwards.
//   Every signing command (publish, yank, resign) reads the index from EVERY base (denext.dev and
//   the mirror) and refuses unless both serve the same one that verifies; it starts from that
//   index's entries (yanked / security / minDenext as published), never from a checkout's
//   security/runtime-channel.json that may lag it, and rewrites that file to match. `--first`
//   signs without an agreed index: the very first publish, or a base known to be down (then above
//   the newest copy any base serves, from the entries file, which must keep every listed release).
//   deno task runtime:yank <version> --reason <text> [--no-publish]
//       mark a broken (not dangerous: that is `deno task revocations add`) release as yanked and
//       re-sign: `runtime upgrade` and the installer stop offering it
//   deno task runtime:resign [--if-due] [--with-backup] [--no-publish]
//       fresh expiry (45 days) and sequence, same entries; `--if-due` only within 15 days of expiry
//   deno task runtime:verify [<channel.json>]
//       a file, or every published copy (denext.dev and the mirror): the index against the
//       compiled-in keys, every release document it lists against its hash, and that every base
//       serves the same index
//   deno task runtime:pin <version> [--allow-yanked]
//       copy a published release document into src/build/deno-toolchain-pin.json and
//       desktop-runtime-pin.json (the bundled pin), the pins they replace kept as `rollback`
//       (never one older than MIN_RUNTIME, which denext refuses to run)
//   deno task runtime:channel expiry      warn when the published index expires within 15 days
//   deno task runtime:channel floor [--file <keys module>]
//       raise the compiled-in minimum sequence (RUNTIME_CHANNEL_MIN_SEQUENCE in
//       src/build/runtime-channel-keys.ts) to the published index's
//   deno task runtime:channel bundled-pin [--denext <version>]
//       the release gate's check: the checked-out bundled pin must be a published, un-yanked,
//       un-revoked release, not older than the newest security release that denext runs on
//   deno task runtime:channel release-doc <tag> [--out <f>] [--toolchain-pin-out <f>] [--unverified]
//       write a release's document (and its toolchain pin, for DENEXT_TOOLCHAIN_PIN_FILE); the
//       runtime-compat workflow uses `--unverified` (no download + attestation pass: the toolchain
//       install re-checks every archive's hash)
//
// Signing runs on the maintainer machine that holds the key, never in CI: a compromised fork
// workflow or a replaced release asset has no signature, so it cannot reach users.

import { fromFileUrl, join } from "@std/path";
import {
  CHANNEL_BASES,
  CHANNEL_FILE,
  CHANNEL_MIRROR_BRANCH,
  CHANNEL_REPOSITORY,
  CHANNEL_RESIGN_DAYS,
  channelKeys,
  channelResignDue,
  checkChannelRelease,
  freshRuntimeChannel,
  releaseDocumentText,
  releaseDocumentUrls,
  releaseEntryFor,
  type RuntimeChannel,
  RuntimeChannelError,
  type RuntimeChannelRelease,
  type RuntimeReleaseDocument,
  signRuntimeChannel,
  verifyReleaseDocument,
  verifyRuntimeChannel,
} from "../src/build/runtime-channel.ts";
import { compareDenoVersions, MIN_RUNTIME } from "../src/build/deno-version.ts";
import { toBase64 } from "../src/build/ota-signing.ts";
import {
  ghApi,
  keygen,
  parseArgs,
  raiseFloor,
  realRun,
  RSYNC_ROOT_ENV,
  type RunResult,
  signingKey,
} from "./runtime-revocations.ts";
import {
  type PinFile,
  readPin,
  revokedVersions,
  rollbackFor,
  runtimeRollbackOf,
  type ToolchainPinFile,
  toolchainRollbackOf,
} from "./desktop-pin-runtime.ts";
import { releaseDocument } from "./lib/runtime-release-doc.ts";
import { runtimeCompatVerdict } from "./release-ci.ts";
import { VERSION as DENEXT_VERSION } from "../src/version.ts";

/** The keychain item's service (one item per slot). */
export const CHANNEL_KEYCHAIN_SERVICE = "denext-runtime-channel";
/** The unsigned entries file the repository keeps as the index's source. */
export const ENTRIES_FILE = "security/runtime-channel.json";
/** The module the compiled-in floor lives in (`floor`). */
export const CHANNEL_KEYS_MODULE = "src/build/runtime-channel-keys.ts";
/** The repository the compatibility workflow runs in. */
const DENEXT_REPO = "Brainwires/denext";
const COMPAT_WORKFLOW = "runtime-compat.yml";
const DEFAULT_OUT = ".denext/runtime-channel";
const FLOOR_RE = /(export const RUNTIME_CHANNEL_MIN_SEQUENCE: number = )(\d+);/;
const PIN_FILES = {
  toolchain: fromFileUrl(new URL("../src/build/deno-toolchain-pin.json", import.meta.url)),
  desktop: fromFileUrl(new URL("../src/build/desktop-runtime-pin.json", import.meta.url)),
};

type Flags = Record<string, string | boolean>;

/** One leg of the compatibility proof: a denext release and whether it passed. */
export interface CompatLeg {
  readonly denext: string;
  readonly ok: boolean;
}

/** The process seams (tests pass fakes; nothing then reaches a keychain, GitHub or a host). */
export interface ChannelDeps {
  /** Run `cmd` with `args`, `stdin` written to it; stdout captured. */
  readonly run: (cmd: string, args: string[], stdin?: string) => Promise<RunResult>;
  /** GET `url` as text, or `null` when it does not answer 200. */
  readonly fetchText: (url: string) => Promise<string | null>;
  /** The public keys a signed index must verify with (default: the compiled-in ones). */
  readonly keys: readonly string[];
  readonly now: () => Date;
  readonly env: (name: string) => string | undefined;
  readonly log: (line: string) => void;
  /** The checked release document of `tag` (default {@linkcode releaseDocument}). */
  readonly releaseDocument: (tag: string, flags: Flags) => Promise<RuntimeReleaseDocument>;
  /** When the GitHub release of `tag` was published (default: `gh api`). */
  readonly releasedAt: (tag: string) => Promise<string>;
  /** The compatibility proof for `tag` (default: the runtime-compat workflow through `gh`). */
  readonly compat: (tag: string, flags: Flags) => Promise<CompatLeg[]>;
  /** Whether a runtime version is revoked (default: the published revoked-runtimes list). */
  readonly revoked: (version: string) => Promise<boolean>;
  /** The oldest release `pin` keeps as the rollback (default {@linkcode MIN_RUNTIME}). */
  readonly minRuntime?: string;
  /** The bundled pin files `pin` writes and `--bundled` reads (default: the checkout's). */
  readonly pinFiles?: { readonly toolchain: string; readonly desktop: string };
  /** The entries file (default {@linkcode ENTRIES_FILE}). */
  readonly entriesFile?: string;
  /** Pause `ms` (the dispatch poll; default a timer). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A refusal: printed as one line, exit 1. */
export class ChannelCommandError extends Error {
  override name = "ChannelCommandError";
}

const fail = (message: string): never => {
  throw new ChannelCommandError(message);
};

const str = (flags: Flags, name: string): string | undefined =>
  typeof flags[name] === "string" ? flags[name] as string : undefined;

// ---------------------------------------------------------------------------------------------
// The real process.

async function realFetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) return await res.text();
    await res.body?.cancel();
  } catch {
    // unreachable: null
  }
  return null;
}

/** `gh` with `args`, its stdout; a failure is a refusal naming `what`. */
async function gh(deps: Pick<ChannelDeps, "run">, args: string[], what: string): Promise<string> {
  const res = await deps.run("gh", args);
  if (res.code !== 0) fail(`${what} failed (gh ${args.slice(0, 2).join(" ")})`);
  return res.stdout;
}

/**
 * The compatibility legs a finished runtime-compat run reports: its `compat (denext <v>)` jobs and
 * whether each succeeded.
 *
 * @param jobs The run's `jobs` (`gh run view --json jobs`).
 * @returns The legs.
 */
export function compatLegs(
  jobs: readonly { name?: string; conclusion?: string | null }[],
): CompatLeg[] {
  return [...runtimeCompatVerdict(jobs).legs];
}

/** The id of the runtime-compat dispatch for `tag` made at or after `since`, polling briefly. */
async function dispatchedRun(deps: ChannelDeps, tag: string, since: number): Promise<string> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < 24; i++) {
    const out = await gh(deps, [
      "run",
      "list",
      "--repo",
      DENEXT_REPO,
      "--workflow",
      COMPAT_WORKFLOW,
      "--event",
      "workflow_dispatch",
      "--limit",
      "10",
      "--json",
      "databaseId,createdAt,displayTitle",
    ], "listing the runtime-compat runs");
    const runs = JSON.parse(out || "[]") as {
      databaseId: number;
      createdAt: string;
      displayTitle: string;
    }[];
    const run = runs.find((r) =>
      Date.parse(r.createdAt) >= since - 60_000 && r.displayTitle.includes(tag)
    );
    if (run) return String(run.databaseId);
    await sleep(5000);
  }
  return fail(`the ${COMPAT_WORKFLOW} dispatch for ${tag} never appeared`);
}

/**
 * The compatibility proof through `gh`: the run `--compat-run` names, else a fresh dispatch of
 * runtime-compat.yml for `tag`, waited for once.
 */
async function realCompat(deps: ChannelDeps, tag: string, flags: Flags): Promise<CompatLeg[]> {
  let id = str(flags, "compat-run");
  if (!id) {
    const since = deps.now().getTime();
    await gh(deps, [
      "workflow",
      "run",
      COMPAT_WORKFLOW,
      "--repo",
      DENEXT_REPO,
      "--ref",
      "development",
      "-f",
      `tag=${tag}`,
    ], `dispatching ${COMPAT_WORKFLOW}`);
    id = await dispatchedRun(deps, tag, since);
    deps.log(`waiting for ${COMPAT_WORKFLOW} run ${id}`);
    await deps.run("gh", ["run", "watch", id, "--repo", DENEXT_REPO, "--exit-status"]);
  }
  const view = JSON.parse(
    await gh(deps, [
      "run",
      "view",
      id,
      "--repo",
      DENEXT_REPO,
      "--json",
      "displayTitle,status,jobs",
    ], `reading ${COMPAT_WORKFLOW} run ${id}`),
  ) as { displayTitle?: string; status?: string; jobs?: { name?: string; conclusion?: string }[] };
  if (!view.displayTitle?.includes(tag)) {
    fail(`run ${id} is not a ${COMPAT_WORKFLOW} run for ${tag}`);
  }
  if (view.status !== "completed") fail(`run ${id} has not finished (${view.status})`);
  // The whole run must be green (scripts/release-ci.ts RUNTIME_COMPAT_JOBS), not only its legs.
  const verdict = runtimeCompatVerdict(view.jobs ?? []);
  if (!verdict.ok) {
    fail(`${COMPAT_WORKFLOW} run ${id} is not green: ${verdict.problems.join(", ")}`);
  }
  return [...verdict.legs];
}

async function realReleasedAt(deps: ChannelDeps, tag: string): Promise<string> {
  const out = await gh(deps, [
    "api",
    `repos/${CHANNEL_REPOSITORY}/releases/tags/${tag}`,
    "--jq",
    ".published_at",
  ], `reading the release date of ${tag}`);
  return out.trim();
}

/** The real process. */
export function realDeps(): ChannelDeps {
  let revoked: ((v: string) => Promise<boolean>) | null = null;
  const deps: ChannelDeps = {
    run: realRun,
    fetchText: realFetchText,
    keys: channelKeys(),
    now: () => new Date(),
    env: (name) => Deno.env.get(name),
    log: (line) => console.log(line),
    releaseDocument: (tag, flags) =>
      releaseDocument(tag, {
        manifest: str(flags, "manifest"),
        sums: str(flags, "sums"),
        archives: str(flags, "archives"),
        unverified: flags.unverified === true,
      }),
    releasedAt: (tag) => realReleasedAt(deps, tag),
    compat: (tag, flags) => realCompat(deps, tag, flags),
    revoked: async (version) => (revoked ??= await revokedVersions())(version),
  };
  return deps;
}

// ---------------------------------------------------------------------------------------------
// The published index and the entries file.

/**
 * The index `text` holds, verified against `keys` — an expired one too (re-signing it is how it
 * comes back), never one with a bad signature or an unknown schema.
 *
 * @param text The document.
 * @param keys The public keys.
 * @param now The clock.
 * @returns The index.
 */
export async function readSignedChannel(
  text: string,
  keys: readonly string[],
  now: Date,
): Promise<RuntimeChannel> {
  try {
    const channel = await verifyRuntimeChannel(text, keys, { now: now.getTime() });
    return channel ?? fail("the index has a schema this denext does not know");
  } catch (err) {
    if (err instanceof RuntimeChannelError && err.code === "expired") return err.channel!;
    throw err;
  }
}

/** The published index's text: the first base that answers. */
async function publishedText(deps: ChannelDeps): Promise<string | null> {
  for (const base of CHANNEL_BASES) {
    const text = await deps.fetchText(new URL(CHANNEL_FILE, base).href);
    if (text !== null) return text;
  }
  return null;
}

/** The published index, verified (expired allowed); `null` when none can be read. */
async function publishedChannel(deps: ChannelDeps): Promise<RuntimeChannel | null> {
  const text = await publishedText(deps);
  return text === null ? null : await readSignedChannel(text, deps.keys, deps.now());
}

/** What one base serves: its index (verified, expired allowed), or why it can't be used. */
export interface BaseCopy {
  readonly base: string;
  readonly channel: RuntimeChannel | null;
  readonly problem?: string;
}

async function readBase(deps: ChannelDeps, base: string): Promise<BaseCopy> {
  const text = await deps.fetchText(new URL(CHANNEL_FILE, base).href);
  if (text === null) return { base, channel: null, problem: "no index served" };
  try {
    return { base, channel: await readSignedChannel(text, deps.keys, deps.now()) };
  } catch (err) {
    return { base, channel: null, problem: (err as Error).message };
  }
}

/** Whether two indexes publish the same thing: the same sequence and the same entries. */
function sameIndex(a: RuntimeChannel, b: RuntimeChannel): boolean {
  return a.sequence === b.sequence && JSON.stringify(a.releases) === JSON.stringify(b.releases);
}

/**
 * Why the bases don't serve one agreed index (empty when they do): a base that serves none or
 * one that does not verify, and bases that serve different ones.
 *
 * @param copies Every base's copy.
 * @returns The problems, one line each.
 */
export function baseDisagreements(copies: readonly BaseCopy[]): string[] {
  const problems = copies.filter((c) => !c.channel).map((c) => `${c.base}: ${c.problem}`);
  const read = copies.filter((c) => c.channel);
  if (read.some((c) => !sameIndex(c.channel!, read[0].channel!))) {
    problems.push(
      "the bases serve different indexes (" +
        read.map((c) => `${c.base} #${c.channel!.sequence}`).join(", ") + ")",
    );
  }
  return problems;
}

/**
 * The published index a signing command (`publish`, `yank`, `resign`) builds on: every base must
 * serve one that verifies, and the same one, else the command refuses, since signing above a
 * stale or partial copy would undo what the other base published. `--first` (the very first
 * publish, or a base known to be down) signs anyway, above the highest sequence any base serves
 * (`null`: none).
 *
 * @param deps Seams.
 * @param flags The command's flags.
 * @returns The agreed index; with `--first`, the newest one read, or `null`.
 */
async function agreedPublishedChannel(
  deps: ChannelDeps,
  flags: Flags,
): Promise<RuntimeChannel | null> {
  const copies = await Promise.all(CHANNEL_BASES.map((b) => readBase(deps, b)));
  const problems = baseDisagreements(copies);
  const read = copies.map((c) => c.channel).filter((c): c is RuntimeChannel => c !== null);
  if (problems.length === 0) return read[0];
  if (flags.first !== true) {
    fail(
      `no agreed published index: ${problems.join("; ")}. Signing now could undo what a base ` +
        "already published: re-publish the stale copy (`runtime:resign` once both serve the " +
        "newest), or pass --first (the first publish, or a base known to be down)",
    );
  }
  deps.log(`--first: signing without an agreed published index (${problems.join("; ")})`);
  return read.sort((a, b) => b.sequence - a.sequence)[0] ?? null;
}

/**
 * The entries a signing command starts from: the published index's (its `yanked`, `security`
 * and `minDenext` as published), never a checkout's copy that may lag it. Without a published
 * index (`--first`), the entries file, which must keep every release a base lists.
 */
async function startingEntries(
  deps: ChannelDeps,
  current: RuntimeChannel | null,
  flags: Flags,
): Promise<RuntimeChannelRelease[]> {
  const local = await loadEntries(deps);
  if (!current || flags.first === true) {
    refuseDroppedReleases(current, local);
    return local;
  }
  const published = readEntries({ releases: structuredClone(current.releases) }, "the index");
  if (entriesText(local) !== entriesText(published)) {
    deps.log(
      `${deps.entriesFile ?? ENTRIES_FILE} differs from the published index ` +
        `#${current.sequence}: starting from the published entries`,
    );
  }
  return published;
}

/**
 * The entries an entries file holds (`{ releases: [...] }`), each checked as the verifier reads
 * it, newest first; two entries for one version are refused.
 *
 * @param raw The parsed file.
 * @param source Its name, for messages.
 * @returns The entries.
 */
export function readEntries(raw: unknown, source = ENTRIES_FILE): RuntimeChannelRelease[] {
  const list = (raw as { releases?: unknown } | null)?.releases;
  if (!Array.isArray(list)) fail(`${source}: expected { "releases": [...] }`);
  let entries: RuntimeChannelRelease[];
  try {
    entries = (list as unknown[]).map(checkChannelRelease);
  } catch (err) {
    return fail(`${source}: ${(err as Error).message}`);
  }
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.version)) fail(`${source}: ${e.version} is listed twice`);
    seen.add(e.version);
  }
  return entries.sort((a, b) => compareDenoVersions(b.version, a.version));
}

/**
 * An entries file's canonical text: `{ "releases": [...] }` newest first, two-space indented, one
 * trailing newline.
 *
 * @param entries The entries.
 * @returns The text.
 */
export function entriesText(entries: readonly RuntimeChannelRelease[]): string {
  return JSON.stringify({ releases: readEntries({ releases: [...entries] }) }, null, 2) + "\n";
}

async function loadEntries(deps: ChannelDeps): Promise<RuntimeChannelRelease[]> {
  const file = deps.entriesFile ?? ENTRIES_FILE;
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  return readEntries(JSON.parse(text), file);
}

/**
 * Refuse entries that leave out a release the published index lists: an index without it would
 * stop offering it, and a project lock names its document.
 *
 * @param current The published index.
 * @param entries The entries to sign.
 */
export function refuseDroppedReleases(
  current: RuntimeChannel | null,
  entries: readonly RuntimeChannelRelease[],
): void {
  const kept = new Set(entries.map((e) => e.version));
  const dropped = (current?.releases ?? []).filter((e) => !kept.has(e.version));
  if (dropped.length > 0) {
    fail(
      `the published index #${current!.sequence} lists ${
        dropped.map((e) => e.version).join(", ")
      }, ` +
        `which ${ENTRIES_FILE} leaves out: add them back (a listed release is never removed; ` +
        "yank it instead)",
    );
  }
}

/**
 * `entries` with `entry` added. The same version again must name the same release document (a
 * published document never changes); its existing entry is kept as it is.
 *
 * @param entries The entries.
 * @param entry The new entry.
 * @returns The entries, and whether `entry` was new.
 */
export function withEntry(
  entries: readonly RuntimeChannelRelease[],
  entry: RuntimeChannelRelease,
): { entries: RuntimeChannelRelease[]; added: boolean } {
  const existing = entries.find((e) => e.version === entry.version);
  if (!existing) return { entries: [...entries, entry], added: true };
  if (existing.doc.sha256 !== entry.doc.sha256 || existing.doc.size !== entry.doc.size) {
    fail(
      `${entry.version} is already listed with another release document (sha256 ` +
        `${existing.doc.sha256}); a published release document never changes`,
    );
  }
  return { entries: [...entries], added: false };
}

// ---------------------------------------------------------------------------------------------
// Signing and publishing.

/** Sign `releases` above `previous` with the keychain key(s), then verify against the compiled-in keys. */
export async function signFreshChannel(
  deps: ChannelDeps,
  releases: readonly RuntimeChannelRelease[],
  previous: RuntimeChannel | null,
  withBackup: boolean,
): Promise<{ text: string; channel: RuntimeChannel }> {
  if (deps.keys.length === 0) {
    fail(`no runtime channel public key is compiled in (${CHANNEL_KEYS_MODULE})`);
  }
  const task = "deno task runtime:keygen";
  const keys = [await signingKey(deps, "active", CHANNEL_KEYCHAIN_SERVICE, task)];
  if (withBackup) keys.push(await signingKey(deps, "backup", CHANNEL_KEYCHAIN_SERVICE, task));
  const channel = freshRuntimeChannel(releases, deps.now(), previous ?? undefined);
  const text = JSON.stringify(await signRuntimeChannel(channel, keys)) + "\n";
  try {
    await verifyRuntimeChannel(text, deps.keys, { now: deps.now().getTime() });
  } catch (err) {
    fail(
      `the signed index does not verify against the compiled-in public keys (${
        (err as Error).message
      }): the keychain key is not one of them`,
    );
  }
  return { text, channel };
}

/** A file to publish under the channel root (`channel.json`, `releases/<v>.json`). */
interface ChannelFile {
  readonly path: string;
  readonly text: string;
}

/** The mirror branch's head commit and its tree (both `undefined` while the branch is missing). */
async function mirrorHead(deps: ChannelDeps): Promise<{ parent?: string; baseTree?: string }> {
  const ref = await ghApi(deps, "GET", `git/ref/heads/${CHANNEL_MIRROR_BRANCH}`);
  const parent = (ref?.object as { sha?: string } | undefined)?.sha;
  if (!parent) return {};
  const head = await ghApi(deps, "GET", `git/commits/${parent}`);
  const baseTree = (head?.tree as { sha?: string } | undefined)?.sha ??
    fail(`could not read ${CHANNEL_REPOSITORY}@${CHANNEL_MIRROR_BRANCH} (gh api)`);
  return { parent, baseTree };
}

/** Upload `files` as blobs; their tree entries. */
async function mirrorBlobs(deps: ChannelDeps, files: readonly ChannelFile[]) {
  const tree = [];
  for (const f of files) {
    const blob = await ghApi(deps, "POST", "git/blobs", {
      content: toBase64(new TextEncoder().encode(f.text)),
      encoding: "base64",
    }) ?? fail(`could not upload ${f.path} to ${CHANNEL_REPOSITORY} (gh api)`);
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  return tree;
}

/**
 * Commit `files` to the mirror's orphan branch in one commit on top of it (the files already there
 * — earlier release documents — kept); the branch is created when missing. Never a force push.
 */
async function publishMirror(deps: ChannelDeps, files: readonly ChannelFile[], message: string) {
  const where = `${CHANNEL_REPOSITORY}@${CHANNEL_MIRROR_BRANCH}`;
  const { parent, baseTree } = await mirrorHead(deps);
  const tree = await mirrorBlobs(deps, files);
  const made = await ghApi(deps, "POST", "git/trees", {
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree,
  });
  const commit = made && await ghApi(deps, "POST", "git/commits", {
    message,
    tree: made.sha,
    parents: parent ? [parent] : [],
  });
  if (!commit) fail(`could not commit to ${where} (gh api)`);
  const ref = { ref: `refs/heads/${CHANNEL_MIRROR_BRANCH}`, sha: commit!.sha };
  const moved = parent
    ? await ghApi(deps, "PATCH", `git/refs/heads/${CHANNEL_MIRROR_BRANCH}`, { sha: commit!.sha })
    : await ghApi(deps, "POST", "git/refs", ref);
  if (!moved) fail(`could not move ${where} to the new commit (gh api)`);
}

/** rsync `files` into `<root>/runtime/` (world-readable), in the order given, one call each. */
async function publishWeb(deps: ChannelDeps, files: readonly ChannelFile[]) {
  const root = deps.env(RSYNC_ROOT_ENV) ??
    fail(`set ${RSYNC_ROOT_ENV}=<host>:<web root> (where denext.dev is served from)`);
  for (const f of files) {
    const tmp = await Deno.makeTempDir({ prefix: "denext-runtime-channel-" });
    try {
      const stage = join(tmp, "runtime");
      const path = join(stage, ...f.path.split("/"));
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, f.text);
      // The modes travel with -p: macOS's openrsync has no --chmod.
      for (let dir = join(path, ".."); dir.startsWith(stage); dir = join(dir, "..")) {
        await Deno.chmod(dir, 0o755);
      }
      await Deno.chmod(path, 0o644);
      const res = await deps.run("rsync", [
        "-rtp",
        `${stage}/`,
        `${root.replace(/\/+$/, "")}/runtime/`,
      ]);
      if (res.code !== 0) fail(`rsync of ${f.path} to ${root} failed`);
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  }
}

/**
 * Publish a signed index and the release documents it adds: verified against the compiled-in
 * keys first (and each document against its entry), then to denext.dev — documents before the
 * index, so no index ever names a document that is not there — then the mirror in one commit.
 *
 * @param deps Seams.
 * @param text The signed index.
 * @param docs The release documents to add, by version.
 */
export async function publishChannel(
  deps: ChannelDeps,
  text: string,
  docs: readonly { version: string; text: string }[] = [],
): Promise<void> {
  const channel = await verifyRuntimeChannel(text, deps.keys, { now: deps.now().getTime() }) ??
    fail("refusing to publish an index of an unknown schema");
  const files: ChannelFile[] = [];
  for (const d of docs) {
    const entry = channel.releases.find((r) => r.version === d.version) ??
      fail(`the index does not list ${d.version}`);
    await verifyReleaseDocument(d.text, entry);
    files.push({ path: `releases/${d.version}.json`, text: d.text });
  }
  files.push({ path: CHANNEL_FILE, text });
  await publishWeb(deps, files);
  await publishMirror(deps, files, `runtime channel: sequence ${channel.sequence}`);
  deps.log(`published index #${channel.sequence} (expires ${channel.expiresAt})`);
}

/** Write the signed index (and documents) under `--out`, then publish unless `--no-publish`. */
async function writeAndPublish(
  deps: ChannelDeps,
  signed: { text: string; channel: RuntimeChannel },
  docs: readonly { version: string; text: string }[],
  flags: Flags,
): Promise<void> {
  const out = str(flags, "out") ?? DEFAULT_OUT;
  await Deno.mkdir(join(out, "releases"), { recursive: true });
  await Deno.writeTextFile(join(out, CHANNEL_FILE), signed.text);
  for (const d of docs) {
    await Deno.writeTextFile(join(out, "releases", `${d.version}.json`), d.text);
  }
  deps.log(
    `wrote ${join(out, CHANNEL_FILE)}: index #${signed.channel.sequence}, ` +
      `${signed.channel.releases.length} releases, expires ${signed.channel.expiresAt}`,
  );
  if (flags["no-publish"] !== true) await publishChannel(deps, signed.text, docs);
}

// ---------------------------------------------------------------------------------------------
// The commands.

/** The checked-out bundled pins' versions: the pin and its rollback. */
async function bundledVersions(deps: ChannelDeps): Promise<Set<string>> {
  const files = deps.pinFiles ?? PIN_FILES;
  const out = new Set<string>();
  for (const file of [files.toolchain, files.desktop]) {
    const pin = JSON.parse(await Deno.readTextFile(file)) as {
      version?: string;
      rollback?: { version?: string };
    };
    if (pin.version) out.add(pin.version);
    if (pin.rollback?.version) out.add(pin.rollback.version);
  }
  return out;
}

/**
 * The entry's `minDenext`: from `--bundled --min-denext` for a release this checkout compiles in,
 * else the oldest leg of a compatibility run on which every leg (at least two) is green.
 */
async function minDenextFor(
  deps: ChannelDeps,
  tag: string,
  version: string,
  flags: Flags,
): Promise<string> {
  if (flags.bundled === true) {
    if (!(await bundledVersions(deps)).has(version)) {
      fail(`--bundled: ${version} is neither the checked-out pin nor its rollback`);
    }
    return str(flags, "min-denext") ??
      fail("--bundled needs --min-denext <oldest denext that pins it>");
  }
  if (flags["min-denext"] !== undefined) {
    fail("--min-denext is only for --bundled: the compat run decides it");
  }
  const legs = await deps.compat(tag, flags);
  const red = legs.filter((l) => !l.ok).map((l) => l.denext);
  if (legs.length < 2 || red.length > 0) {
    fail(
      `the compatibility proof for ${tag} is not green on both legs (` +
        (legs.length < 2 ? `${legs.length} leg(s) ran` : `red: ${red.join(", ")}`) +
        `); nothing is signed until ${COMPAT_WORKFLOW} passes`,
    );
  }
  return legs.map((l) => l.denext).sort(compareDenoVersions)[0];
}

/**
 * Sign `entries` above the published index, write them to the entries file, then write and
 * publish the index (and `docs`); the entries file is for the maintainer to commit.
 */
async function signSaveAndPublish(
  deps: ChannelDeps,
  change: {
    entries: readonly RuntimeChannelRelease[];
    current: RuntimeChannel | null;
    what: string;
    docs: readonly { version: string; text: string }[];
  },
  flags: Flags,
) {
  const withBackup = flags["with-backup"] === true;
  const signed = await signFreshChannel(deps, change.entries, change.current, withBackup);
  const file = deps.entriesFile ?? ENTRIES_FILE;
  await Deno.writeTextFile(file, entriesText(change.entries));
  deps.log(`${change.what} in ${file}`);
  await writeAndPublish(deps, signed, change.docs, flags);
  deps.log(`commit ${file} to development`);
}

/** `publish <tag>`: see the module header. */
async function publishRelease(deps: ChannelDeps, tag: string, flags: Flags) {
  const doc = await deps.releaseDocument(tag, flags);
  const version = doc.toolchain.version ?? fail(`${tag} pins no toolchain version`);
  if (doc.toolchain.tag !== tag) fail(`the release document is ${doc.toolchain.tag}, not ${tag}`);
  const minDenext = await minDenextFor(deps, tag, version, flags);
  const releasedAt = str(flags, "released-at") ?? await deps.releasedAt(tag);
  const { entry, text } = await releaseEntryFor(doc, {
    releasedAt,
    minDenext,
    security: flags.security === true,
  });
  const current = await agreedPublishedChannel(deps, flags);
  const { entries, added } = withEntry(await startingEntries(deps, current, flags), entry);
  const what = `${
    added ? "added" : "kept"
  } ${version} (minDenext ${minDenext}, released ${releasedAt})`;
  await signSaveAndPublish(deps, { entries, current, what, docs: [{ version, text }] }, flags);
}

/** `yank <version> --reason <text>`. */
async function yank(deps: ChannelDeps, version: string, flags: Flags) {
  const reason = str(flags, "reason")?.trim() || fail("--reason <text> is required");
  const current = await agreedPublishedChannel(deps, flags);
  const entries = await startingEntries(deps, current, flags);
  const i = entries.findIndex((e) => e.version === version);
  if (i === -1) fail(`${version} is not listed in ${deps.entriesFile ?? ENTRIES_FILE}`);
  entries[i] = { ...entries[i], yanked: { reason } };
  const what = `yanked ${version} (${reason})`;
  await signSaveAndPublish(deps, { entries, current, what, docs: [] }, flags);
}

/** `resign [--if-due]`: the published entries, fresh expiry and sequence. */
async function resign(deps: ChannelDeps, flags: Flags) {
  if (deps.keys.length === 0) {
    return deps.log("no runtime channel public key is compiled in: nothing to re-sign");
  }
  const current = await agreedPublishedChannel(deps, flags) ??
    fail("could not read the published index (offline, or none published yet: `runtime:publish`)");
  if (flags["if-due"] === true && !channelResignDue(current, deps.now().getTime())) {
    return deps.log(`index #${current.sequence} expires ${current.expiresAt}: not due yet`);
  }
  const signed = await signFreshChannel(
    deps,
    current.releases,
    current,
    flags["with-backup"] === true,
  );
  await writeAndPublish(deps, signed, [], flags);
}

/** Verify one served copy: the index, then every document it lists from the same base. */
async function verifyBase(deps: ChannelDeps, base: string): Promise<string | null> {
  const text = await deps.fetchText(new URL(CHANNEL_FILE, base).href);
  if (text === null) return `${base}: no index served`;
  let channel: RuntimeChannel | null;
  try {
    channel = await verifyRuntimeChannel(text, deps.keys, { now: deps.now().getTime() });
  } catch (err) {
    return `${base}: ${(err as Error).message}`;
  }
  if (!channel) return `${base}: an index of a schema this denext does not know`;
  for (const entry of channel.releases) {
    const [url] = releaseDocumentUrls(entry.version, [base]);
    const doc = await deps.fetchText(url);
    if (doc === null) return `${url}: not served`;
    try {
      await verifyReleaseDocument(doc, entry);
    } catch (err) {
      return `${url}: ${(err as Error).message}`;
    }
  }
  deps.log(
    `${base}: index #${channel.sequence}, expires ${channel.expiresAt}; ` +
      `${channel.releases.length} release document(s) verify`,
  );
  return null;
}

/** `verify [<file>]`. */
async function verifyFile(deps: ChannelDeps, file: string) {
  const channel = await verifyRuntimeChannel(await Deno.readTextFile(file), deps.keys, {
    now: deps.now().getTime(),
  }) ?? fail("the index has a schema this denext does not know");
  deps.log(
    `index #${channel.sequence}: issued ${channel.issuedAt}, expires ${channel.expiresAt}`,
  );
  for (const r of channel.releases) {
    const notes = [r.security ? "security" : "", r.yanked ? `yanked: ${r.yanked.reason}` : ""]
      .filter(Boolean).join("; ");
    deps.log(
      `  ${r.version} (deno ${r.deno}, denext ≥ ${r.minDenext})${notes ? ` ${notes}` : ""}`,
    );
  }
}

async function verify(deps: ChannelDeps, file: string | undefined) {
  if (deps.keys.length === 0) {
    fail(`no runtime channel public key is compiled in (${CHANNEL_KEYS_MODULE})`);
  }
  if (file) return await verifyFile(deps, file);
  const problems = (await Promise.all(CHANNEL_BASES.map((b) => verifyBase(deps, b))))
    .filter((p): p is string => p !== null);
  if (problems.length === 0) {
    // Each base verifies on its own; they must also publish the same index.
    const copies = await Promise.all(CHANNEL_BASES.map((b) => readBase(deps, b)));
    problems.push(...baseDisagreements(copies));
  }
  if (problems.length > 0) fail(problems.join("\n"));
}

/**
 * The release gate's warning about the published index's expiry: `null` while more than `days`
 * days remain (or no key is compiled in); otherwise one line. Never throws.
 *
 * @param deps The process seams.
 * @param days The margin (default {@linkcode CHANNEL_RESIGN_DAYS}).
 * @returns The warning, or `null`.
 */
export async function publishedChannelExpiryWarning(
  deps: ChannelDeps,
  days: number = CHANNEL_RESIGN_DAYS,
): Promise<string | null> {
  if (deps.keys.length === 0) return null;
  let channel: RuntimeChannel | null;
  try {
    channel = await publishedChannel(deps);
  } catch (err) {
    return `the published runtime channel index could not be verified (${
      err instanceof Error ? err.message : err
    }); check it with \`deno task runtime:verify\``;
  }
  if (!channel) {
    return "no published runtime channel index could be read (offline?), so its expiry is unchecked";
  }
  const now = deps.now().getTime();
  const left = Date.parse(channel.expiresAt) - now;
  const resignHow = "`deno task runtime:resign` on the machine that holds the key";
  if (!(left > 0)) {
    return `the published runtime channel index #${channel.sequence} EXPIRED at ${channel.expiresAt}: ` +
      `no machine can upgrade its runtime until it is re-signed — run ${resignHow} now`;
  }
  if (!channelResignDue(channel, now, days)) return null;
  const inDays = Math.ceil(left / 86_400_000);
  return `the published runtime channel index #${channel.sequence} expires ${channel.expiresAt} ` +
    `(in ${inDays} day${inDays === 1 ? "" : "s"}): run ${resignHow}`;
}

/**
 * Why a denext release must not ship with the bundled runtime `version` (the toolchain pin), given
 * the channel index in force: the pin must be a listed release, not yanked, not revoked, and not
 * older than the newest `security` release this denext runs on (the "don't ship known
 * vulnerabilities" rule, made mechanical). `null` when it may ship.
 *
 * @param channel The verified index (an expired one still says what was published).
 * @param version The bundled pin's version.
 * @param denext The denext version being released.
 * @param revoked Whether the revoked-runtimes list revokes `version`.
 * @returns The refusal, or `null`.
 */
export function bundledPinRefusal(
  channel: RuntimeChannel,
  version: string,
  denext: string,
  revoked: boolean,
): string | null {
  const entry = channel.releases.find((r) => r.version === version);
  if (!entry) {
    return `the bundled runtime ${version} is not a published channel release: publish it first ` +
      `(\`deno task runtime:publish denext-runtime-v${version} --bundled --min-denext <oldest ` +
      `denext that pins it>\`)`;
  }
  if (entry.yanked) {
    return `the bundled runtime ${version} is yanked (${entry.yanked.reason}): pin another ` +
      "(`deno task runtime:pin <version>`)";
  }
  if (revoked) {
    return `the bundled runtime ${version} is revoked: pin a fixed release ` +
      "(`deno task runtime:pin <version>`)";
  }
  const runs = (r: RuntimeChannelRelease) =>
    compareDenoVersions(r.minDenext, denext) <= 0 &&
    (r.maxDenext === undefined || compareDenoVersions(denext, r.maxDenext) <= 0);
  const fix = channel.releases
    .filter((r) => r.security && !r.yanked && runs(r))
    .filter((r) => compareDenoVersions(r.version, version) > 0)
    .sort((a, b) => compareDenoVersions(b.version, a.version))[0];
  if (fix) {
    return `the bundled runtime ${version} is older than the security release ${fix.version}: ` +
      `pin it (\`deno task runtime:pin ${fix.version}\`) — a release never ships a runtime with ` +
      "a known vulnerability";
  }
  return null;
}

/**
 * The release gate's check of the checked-out bundled pin against the published index
 * ({@linkcode bundledPinRefusal}). With no channel key compiled in there is nothing to check
 * against (a note, no refusal); an index that can't be read or verified is a refusal, since the
 * pin can't be cleared of a security release then.
 *
 * @param deps The process seams.
 * @param denext The denext version being released.
 * @returns The refusal (or `null`) and one line for the log.
 */
export async function publishedBundledPinRefusal(
  deps: ChannelDeps,
  denext: string,
): Promise<{ refusal: string | null; note: string }> {
  const files = deps.pinFiles ?? PIN_FILES;
  const pin = JSON.parse(await Deno.readTextFile(files.toolchain)) as { version?: string };
  const version = pin.version ?? fail(`${files.toolchain} names no version`);
  if (deps.keys.length === 0) {
    return {
      refusal: null,
      note: `no runtime channel key is compiled in: the bundled runtime ${version} is unchecked`,
    };
  }
  let channel: RuntimeChannel | null;
  try {
    channel = await publishedChannel(deps);
  } catch (err) {
    return {
      refusal: `the published runtime channel index could not be verified (${
        err instanceof Error ? err.message : err
      }), so the bundled runtime ${version} can't be checked: \`deno task runtime:verify\``,
      note: "",
    };
  }
  if (!channel) {
    return {
      refusal: `no published runtime channel index could be read (offline?), so the bundled ` +
        `runtime ${version} can't be checked against the security releases; retry online`,
      note: "",
    };
  }
  const refusal = bundledPinRefusal(channel, version, denext, await deps.revoked(version));
  return {
    refusal,
    note: refusal
      ? ""
      : `the bundled runtime ${version} is listed in index #${channel.sequence}, ` +
        "not yanked, revoked or behind a security release",
  };
}

/**
 * The compiled-in minimum sequence `source` (the keys module) declares.
 *
 * @param source The module's text.
 * @returns The sequence.
 */
export function channelMinSequenceIn(source: string): number {
  const m = FLOOR_RE.exec(source) ??
    fail(`${CHANNEL_KEYS_MODULE} declares no RUNTIME_CHANNEL_MIN_SEQUENCE`);
  return Number(m[2]);
}

/**
 * `source` (the keys module) with its compiled-in minimum sequence set to `sequence`.
 *
 * @param source The module's text.
 * @param sequence The new floor.
 * @returns The new text.
 */
export function withChannelMinSequence(source: string, sequence: number): string {
  channelMinSequenceIn(source);
  return source.replace(FLOOR_RE, `$1${sequence};`);
}

/** `floor`: raise the compiled-in minimum sequence to the published index's (never lower it). */
async function floor(deps: ChannelDeps, flags: Flags) {
  if (deps.keys.length === 0) {
    return deps.log("no runtime channel public key is compiled in: the floor stays");
  }
  const current = await publishedChannel(deps) ??
    fail("could not read the published index (offline, or none published yet)");
  const file = str(flags, "file") ?? CHANNEL_KEYS_MODULE;
  await raiseFloor(deps.log, current.sequence, file, channelMinSequenceIn, withChannelMinSequence);
}

/** The published index's entry for `version` (a yanked one only with `--allow-yanked`). */
async function publishedEntry(deps: ChannelDeps, version: string, flags: Flags) {
  const text = await publishedText(deps) ??
    fail("no published runtime channel index could be read");
  const channel = await verifyRuntimeChannel(text, deps.keys, { now: deps.now().getTime() }) ??
    fail("the published index has a schema this denext does not know");
  const entry = channel.releases.find((r) => r.version === version) ??
    fail(`the published index does not list ${version}`);
  if (entry.yanked && flags["allow-yanked"] !== true) {
    fail(`${version} is yanked (${entry.yanked.reason}); --allow-yanked pins it anyway`);
  }
  return entry;
}

/** The first served copy of `entry`'s release document that verifies. */
async function servedDocument(
  deps: ChannelDeps,
  entry: RuntimeChannelRelease,
): Promise<RuntimeReleaseDocument> {
  for (const url of releaseDocumentUrls(entry.version)) {
    const body = await deps.fetchText(url);
    const doc = body === null ? null : await verifyReleaseDocument(body, entry).catch(() => null);
    if (doc) return doc;
  }
  return fail(`no served copy of the ${entry.version} release document verifies`);
}

/**
 * `pin` with its `rollback` (the pin it replaces, unless that is revoked or older than
 * {@linkcode MIN_RUNTIME}), as written.
 */
async function withRollback<
  P extends { version: string; rollback?: R },
  R extends { version: string },
>(
  pin: object,
  file: string,
  version: string,
  deps: ChannelDeps,
  of: (old: P) => R,
): Promise<{ text: string; rollback?: R }> {
  const floor = deps.minRuntime ?? MIN_RUNTIME;
  const rollback = await rollbackFor(await readPin<P>(file), version, deps.revoked, of, floor);
  const text = JSON.stringify({ ...pin, ...(rollback ? { rollback } : {}) }, null, 2) + "\n";
  return { text, rollback };
}

/** `pin <version>`: the published release document becomes the bundled pin. */
async function pin(deps: ChannelDeps, version: string, flags: Flags) {
  const doc = await servedDocument(deps, await publishedEntry(deps, version, flags));
  const files = deps.pinFiles ?? PIN_FILES;
  const toolchain = await withRollback<ToolchainPinFile, ReturnType<typeof toolchainRollbackOf>>(
    doc.toolchain,
    files.toolchain,
    version,
    deps,
    toolchainRollbackOf,
  );
  const desktop = await withRollback<PinFile, ReturnType<typeof runtimeRollbackOf>>(
    doc.desktop,
    files.desktop,
    version,
    deps,
    runtimeRollbackOf,
  );
  await Deno.writeTextFile(files.toolchain, toolchain.text);
  await Deno.writeTextFile(files.desktop, desktop.text);
  const rb = toolchain.rollback ? `, rollback ${toolchain.rollback.version}` : "";
  deps.log(`pinned ${version}${rb} (${files.toolchain}, ${files.desktop})`);
}

/** `release-doc <tag>`: the document (and its toolchain pin) to files. */
async function releaseDoc(deps: ChannelDeps, tag: string, flags: Flags) {
  const doc = await deps.releaseDocument(tag, flags);
  const out = str(flags, "out");
  if (out) await Deno.writeTextFile(out, releaseDocumentText(doc));
  const pinOut = str(flags, "toolchain-pin-out");
  if (pinOut) await Deno.writeTextFile(pinOut, JSON.stringify(doc.toolchain, null, 2) + "\n");
  if (!out && !pinOut) return deps.log(releaseDocumentText(doc).trimEnd());
  deps.log(
    `wrote the ${doc.toolchain.version} release document${
      flags.unverified === true ? " (unverified)" : ""
    }`,
  );
}

/** `bundled-pin [--denext <version>]`: the release gate's check, as a command. */
async function bundledPin(deps: ChannelDeps, flags: Flags) {
  const denext = str(flags, "denext") ?? DENEXT_VERSION;
  const { refusal, note } = await publishedBundledPinRefusal(deps, denext);
  if (refusal) fail(refusal);
  deps.log(note);
}

const USAGE = "usage: deno task runtime:channel <keygen | publish | yank | resign | verify | " +
  "expiry | floor | bundled-pin | pin | release-doc> (see the header of scripts/runtime-channel.ts)";

/**
 * The CLI.
 *
 * @param args The command line.
 * @param deps Seams (default the real process).
 */
export async function main(args: string[], deps: ChannelDeps = realDeps()): Promise<void> {
  const { positionals: [command, arg], flags } = parseArgs(args);
  const need = (): string => arg ?? fail(USAGE);
  switch (command) {
    case "keygen": {
      const slot = typeof flags.slot === "string" ? flags.slot : "active";
      if (slot !== "active" && slot !== "backup") {
        fail(`--slot must be active or backup (got ${slot})`);
      }
      const pub = await keygen(deps, slot, flags.force === true, CHANNEL_KEYCHAIN_SERVICE);
      deps.log(
        `stored the ${slot} private key in the keychain (${CHANNEL_KEYCHAIN_SERVICE} / ${slot}).`,
      );
      deps.log(`public key — paste it into the ${slot} slot of ${CHANNEL_KEYS_MODULE}:`);
      return deps.log(pub);
    }
    case "publish":
      return await publishRelease(deps, need(), flags);
    case "yank":
      return await yank(deps, need(), flags);
    case "resign":
      return await resign(deps, flags);
    case "verify":
      return await verify(deps, arg);
    case "expiry": {
      const warning = await publishedChannelExpiryWarning(deps);
      return deps.log(warning ? `warning — ${warning}` : "the published index is not near expiry");
    }
    case "floor":
      return await floor(deps, flags);
    case "bundled-pin":
      return await bundledPin(deps, flags);
    case "pin":
      return await pin(deps, need(), flags);
    case "release-doc":
      return await releaseDoc(deps, need(), flags);
    default:
      fail(USAGE);
  }
}

if (import.meta.main) {
  await main(Deno.args).catch((err: unknown) => {
    console.error(`runtime:channel: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  });
}
