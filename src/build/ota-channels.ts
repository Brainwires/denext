// The build side of OTA channels and staged rollouts: read, validate and (atomically) write the
// channels file `createOtaHandler({ channels })` serves from, point a channel at an export
// (`denext ota channel <name> <dir>`), and promote a release from one channel (or an export
// directory) to another, fully or to a percentage of devices (`denext ota promote`). The file's
// shape, validation and the rollout bucket live in src/server/ota-rollout.ts.
//
// Promotion refuses what installed apps would refuse anyway, so a rollout never strands a
// cohort: a source without a valid manifest, an unsigned release onto a channel that serves
// signed ones (apps embedding the public key refuse it, code `signature`), and a release whose
// `sequence` is below what the target's devices may already run (code `downgrade`). `force`
// overrides the signature and sequence checks only.

import { dirname, join, relative, resolve, SEPARATOR } from "@std/path";
import { isOtaManifest, OTA_MANIFEST_PATH, type OtaManifest } from "../mobile/ota-manifest.ts";
import {
  isOtaRolloutPercent,
  OTA_CHANNEL_NAME,
  type OtaChannel,
  type OtaChannelsFile,
  otaChannelsProblem,
} from "../server/ota-rollout.ts";

/** The channels file name `denext ota promote` / `channel` use by default. */
export const DEFAULT_OTA_CHANNELS_FILE = "ota-channels.json";

/**
 * Read the channels file at `file`.
 *
 * @returns The file, or `null` when it does not exist.
 * @throws When it is not JSON or not a valid channels file.
 */
export async function readOtaChannels(file: string): Promise<OtaChannelsFile | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const problem = otaChannelsProblem(parsed);
  if (problem) throw new Error(`${file}: ${problem}`);
  return parsed as OtaChannelsFile;
}

/**
 * Write the channels file atomically (a temporary file beside it, then a rename), so a server
 * re-reading it never sees half a file.
 *
 * @throws When `doc` is not a valid channels file.
 */
export async function writeOtaChannels(file: string, doc: OtaChannelsFile): Promise<void> {
  const problem = otaChannelsProblem(doc);
  if (problem) throw new Error(`refusing to write ${file}: ${problem}`);
  const dir = dirname(resolve(file));
  await Deno.mkdir(dir, { recursive: true });
  const temp = await Deno.makeTempFile({ dir, prefix: ".ota-channels-", suffix: ".tmp" });
  try {
    await Deno.writeTextFile(temp, JSON.stringify(doc, null, 2) + "\n");
    if (Deno.build.os !== "windows") await Deno.chmod(temp, 0o644);
    await Deno.rename(temp, file);
  } catch (err) {
    await Deno.remove(temp).catch(() => {});
    throw err;
  }
}

/** A channel name, checked. */
function checkName(name: string, what: string): string {
  if (!OTA_CHANNEL_NAME.test(name)) {
    throw new Error(
      `${what} "${name}" is not a channel name (lower-case letters, digits, ".", "_" and "-", ` +
        "starting with a letter or digit, at most 64 characters)",
    );
  }
  return name;
}

/** The manifest of the release at `dir`, or null when it has no valid one. */
async function manifestAt(dir: string): Promise<OtaManifest | null> {
  try {
    const parsed: unknown = JSON.parse(
      await Deno.readTextFile(join(dir, ...OTA_MANIFEST_PATH.split("/"))),
    );
    return isOtaManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `dir` (absolute, or relative to the working directory) as a path relative to the file. */
function relativeToFile(file: string, dir: string): string {
  const rel = relative(dirname(resolve(file)), resolve(dir));
  return (rel === "" ? "." : rel).split(SEPARATOR).join("/");
}

/** A release path from the file, resolved against the file's directory. */
function fromFile(file: string, release: string): string {
  return resolve(dirname(resolve(file)), release);
}

/**
 * Refuse `source` onto a channel whose devices may run `targets` (its current release and any
 * rollout candidate): unsigned onto signed, or a lower `sequence`. Skipped with `force`.
 */
function checkCompatible(
  source: OtaManifest,
  sourceLabel: string,
  targets: readonly OtaManifest[],
  to: string,
  force: boolean,
): void {
  if (force) return;
  if (source.signature === undefined && targets.some((t) => t.signature !== undefined)) {
    throw new Error(
      `${sourceLabel} is unsigned but channel "${to}" serves signed releases: apps that embed ` +
        "the public key refuse it (code signature). Sign it (`denext ota manifest --sign`) or " +
        "pass --force",
    );
  }
  const highest = Math.max(-1, ...targets.map((t) => t.sequence ?? -1));
  if (highest >= 0 && (source.sequence ?? -1) < highest) {
    throw new Error(
      `${sourceLabel} has sequence ${source.sequence ?? "(none)"}, below ${highest} on channel ` +
        `"${to}": devices already on it refuse an older release (code downgrade). Re-stamp it ` +
        "with a higher --sequence or pass --force",
    );
  }
}

/** The manifests devices on `channel` may run: its release and any rollout candidate. */
async function channelManifests(file: string, channel: OtaChannel | undefined) {
  if (!channel) return [];
  const paths = [channel.release, ...(channel.rollout ? [channel.rollout.release] : [])];
  const found = await Promise.all(paths.map((p) => manifestAt(fromFile(file, p))));
  return found.filter((m): m is OtaManifest => m !== null);
}

/** Options for {@linkcode setOtaChannel}. */
export interface SetOtaChannelOptions {
  /** The channels file (created when missing). */
  readonly file: string;
  /** The channel to point. */
  readonly channel: string;
  /** The export directory (relative to the working directory, or absolute). */
  readonly release: string;
  /** Skip the signature and sequence checks. */
  readonly force?: boolean;
}

/**
 * Point `channel` at the export `release` (clearing any rollout on it), creating the channel,
 * or the file (with `default` set to this channel), when missing.
 *
 * @returns The file written.
 * @throws When the name is not a channel name, the export has no valid `_denext/ota.json`, or
 *   (without `force`) it is unsigned onto a signed channel or its sequence is lower.
 */
export async function setOtaChannel(options: SetOtaChannelOptions): Promise<OtaChannelsFile> {
  const { file } = options;
  const channel = checkName(options.channel, "channel");
  const source = await manifestAt(resolve(options.release));
  if (!source) {
    throw new Error(
      `${options.release} has no valid ${OTA_MANIFEST_PATH} (run \`denext ota manifest\`)`,
    );
  }
  const doc = await readOtaChannels(file);
  const current = doc?.channels[channel];
  checkCompatible(
    source,
    options.release,
    await channelManifests(file, current),
    channel,
    options.force === true,
  );
  const next: OtaChannelsFile = {
    default: doc?.default ?? channel,
    channels: { ...doc?.channels, [channel]: { release: relativeToFile(file, options.release) } },
  };
  await writeOtaChannels(file, next);
  return next;
}

/** Options for {@linkcode promoteOtaRelease}. */
export interface PromoteOtaReleaseOptions {
  /** The channels file. */
  readonly file: string;
  /** The source: another channel's stable release, or an export directory. */
  readonly from?: { readonly channel: string } | { readonly release: string };
  /** The target channel (created by a full promotion when missing). */
  readonly to: string;
  /**
   * The share of the target's devices that get the source: 100 or omitted makes it the stable
   * release (and clears the rollout); less starts or changes a staged rollout; 0 halts one.
   */
  readonly percent?: number;
  /** Clear the target's rollout, keeping its stable release (same as `percent: 0`). */
  readonly halt?: boolean;
  /** Skip the signature and sequence checks. */
  readonly force?: boolean;
}

/** Resolve the promotion source to an absolute export directory and the path to store. */
function sourceOf(
  file: string,
  doc: OtaChannelsFile,
  from: NonNullable<PromoteOtaReleaseOptions["from"]>,
  to: string,
): { dir: string; stored: string; label: string } {
  if ("channel" in from) {
    const name = checkName(from.channel, "source channel");
    if (name === to) throw new Error(`cannot promote channel "${name}" onto itself`);
    const channel = doc.channels[name];
    if (!channel) throw new Error(`there is no channel "${name}" in ${file}`);
    return { dir: fromFile(file, channel.release), stored: channel.release, label: `"${name}"` };
  }
  return {
    dir: resolve(from.release),
    stored: relativeToFile(file, from.release),
    label: from.release,
  };
}

/** The target channel with its rollout cleared (a halt). */
function halted(file: string, doc: OtaChannelsFile, to: string): OtaChannelsFile {
  const current = doc.channels[to];
  if (!current) throw new Error(`there is no channel "${to}" in ${file}`);
  return { ...doc, channels: { ...doc.channels, [to]: { release: current.release } } };
}

/**
 * Promote a release to channel `to`: fully (`percent` 100 or omitted), as a staged rollout
 * (`percent` below 100), or halt the target's rollout (`percent: 0` / `halt`).
 *
 * @returns The file written.
 * @throws When the file is missing or invalid, a name is not a channel name, the source is the
 *   target, the source channel does not exist, the source has no valid manifest, a staged rollout
 *   targets a channel that does not exist yet, `percent` is outside [0, 100], or (without
 *   `force`) the source is unsigned onto a signed channel or has a lower `sequence`.
 */
export async function promoteOtaRelease(
  options: PromoteOtaReleaseOptions,
): Promise<OtaChannelsFile> {
  const { file } = options;
  const to = checkName(options.to, "target channel");
  const doc = await readOtaChannels(file);
  if (!doc) throw new Error(`${file} does not exist (create it with \`denext ota channel\`)`);
  const percent = options.percent ?? 100;
  if (options.halt === true || percent === 0) {
    const next = halted(file, doc, to);
    await writeOtaChannels(file, next);
    return next;
  }
  if (!isOtaRolloutPercent(percent)) {
    throw new RangeError(`--percent must be more than 0 and at most 100, not ${percent}`);
  }
  if (!options.from) throw new Error("pass the source: --channel <name> or --release <dir>");
  const source = sourceOf(file, doc, options.from, to);
  const manifest = await manifestAt(source.dir);
  if (!manifest) {
    throw new Error(`${source.label} has no valid ${OTA_MANIFEST_PATH} at ${source.dir}`);
  }
  const target = doc.channels[to];
  checkCompatible(
    manifest,
    source.label,
    await channelManifests(file, target),
    to,
    options.force === true,
  );
  let channel: OtaChannel;
  if (percent >= 100) channel = { release: source.stored };
  else if (!target) {
    throw new Error(
      `channel "${to}" does not exist yet: a staged rollout needs a stable release to fall back ` +
        "on (promote at 100% first, or `denext ota channel`)",
    );
  } else channel = { release: target.release, rollout: { release: source.stored, percent } };
  const next: OtaChannelsFile = { ...doc, channels: { ...doc.channels, [to]: channel } };
  await writeOtaChannels(file, next);
  return next;
}
