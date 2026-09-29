// OTA channels and staged rollouts: the channels file's shape, its validation, and the stable
// per-install bucket that decides whether a device gets a channel's rollout candidate. Shared by
// `createOtaHandler` (./ota-handler.ts), which serves a release per request, and the build side
// (`denext ota promote` / `denext ota channel`, src/build/ota-channels.ts), which edits the file.
// Every release is a full export with its own `_denext/ota.json`; nothing here reads or changes a
// manifest's signature, so signature verification stays exactly what the native plugin does.

/** The request header naming the OTA channel a device follows (absent: the file's `default`). */
export const OTA_CHANNEL_HEADER = "x-denext-ota-channel";

/** The request header carrying a device's stable install id (the rollout bucket's input). */
export const OTA_INSTALL_ID_HEADER = "x-denext-ota-install-id";

/** A channel name: lower-case letters, digits, `.`, `_` and `-`, at most 64 characters. */
export const OTA_CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** An install id: 8–128 characters of `[A-Za-z0-9_-]` (base64url, hex, a dash-less UUID). */
const OTA_INSTALL_ID = /^[A-Za-z0-9_-]{8,128}$/;

/** A staged rollout of a candidate release to a share of a channel's devices. */
export interface OtaRollout {
  /** The candidate release: an export directory holding `_denext/ota.json`. */
  readonly release: string;
  /** The share of devices (by install id) that get it: more than 0, at most 100. */
  readonly percent: number;
}

/** One channel: the release every device gets, and optionally a rollout candidate. */
export interface OtaChannel {
  /** The stable release: an export directory holding `_denext/ota.json`. */
  readonly release: string;
  /** A candidate served to `percent`% of the devices that send an install id. */
  readonly rollout?: OtaRollout;
}

/**
 * The channels file (`ota-channels.json`): which release each channel serves. Release paths
 * are relative to the file (or, for an object passed to `createOtaHandler`, to the working
 * directory).
 *
 * @example
 * ```json
 * {
 *   "default": "production",
 *   "channels": {
 *     "production": {
 *       "release": "releases/2026-09-20",
 *       "rollout": { "release": "releases/2026-09-27", "percent": 20 }
 *     },
 *     "beta": { "release": "releases/2026-09-27" }
 *   }
 * }
 * ```
 */
export interface OtaChannelsFile {
  /** The channel a request without an `x-denext-ota-channel` header follows. */
  readonly default: string;
  /** Channel name → its releases. */
  readonly channels: Readonly<Record<string, OtaChannel>>;
}

/** Whether `value` is a rollout percentage: finite, more than 0, at most 100. */
export function isOtaRolloutPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100;
}

/** A non-empty release path without control characters. */
function isReleasePath(value: unknown): value is string {
  // deno-lint-ignore no-control-regex -- refusing control characters is the point.
  return typeof value === "string" && value !== "" && !/[\u0000-\u001f\u007f]/.test(value);
}

function isRollout(value: unknown): value is OtaRollout {
  if (typeof value !== "object" || value === null) return false;
  const { release, percent } = value as Record<string, unknown>;
  return isReleasePath(release) && isOtaRolloutPercent(percent);
}

function isChannel(value: unknown): value is OtaChannel {
  if (typeof value !== "object" || value === null) return false;
  const { release, rollout } = value as Record<string, unknown>;
  return isReleasePath(release) && (rollout === undefined || isRollout(rollout));
}

/**
 * Why `value` is not a valid {@linkcode OtaChannelsFile}, or `null` when it is: every channel
 * name matches {@linkcode OTA_CHANNEL_NAME}, every channel has a `release` (and a well-formed
 * `rollout`, if any), and `default` names one of them.
 */
export function otaChannelsProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "the channels file must be a JSON object";
  }
  const { default: fallback, channels } = value as Record<string, unknown>;
  if (typeof channels !== "object" || channels === null || Array.isArray(channels)) {
    return '"channels" must be an object of channel name → { release, rollout? }';
  }
  for (const [name, channel] of Object.entries(channels)) {
    if (!OTA_CHANNEL_NAME.test(name)) return `"${name}" is not a channel name`;
    if (!isChannel(channel)) {
      return `channel "${name}" needs a "release" path, and a rollout needs a "release" and a ` +
        `"percent" in (0, 100]`;
    }
  }
  if (typeof fallback !== "string" || !Object.hasOwn(channels, fallback)) {
    return '"default" must name one of the channels';
  }
  return null;
}

/** Whether `value` is a valid {@linkcode OtaChannelsFile}. */
export function isOtaChannelsFile(value: unknown): value is OtaChannelsFile {
  return otaChannelsProblem(value) === null;
}

/**
 * The stable rollout bucket of one install for one candidate release: the first four bytes of
 * SHA-256(`denext-ota-rollout\n<channel>\n<candidateVersion>\n<installId>`) as a big-endian
 * uint32, modulo 10 000. A device is in a rollout of `percent` when the bucket is below
 * `percent * 100`. Salting with the candidate's manifest version draws a fresh cohort for each
 * release, while raising the percentage for the same candidate only ever adds devices.
 *
 * @param channel The channel name.
 * @param candidateVersion The candidate's manifest `version`.
 * @param installId The device's install id.
 * @returns A bucket in `[0, 10000)`.
 */
export async function otaRolloutBucket(
  channel: string,
  candidateVersion: string,
  installId: string,
): Promise<number> {
  const input = `denext-ota-rollout\n${channel}\n${candidateVersion}\n${installId}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new DataView(digest).getUint32(0) % 10_000;
}

/**
 * Whether an install falls inside a rollout of `percent` for `candidateVersion` on `channel`.
 * No (or an invalid) install id is never in a rollout: such a device always gets the stable
 * release.
 */
export async function inOtaRollout(
  channel: string,
  candidateVersion: string,
  installId: string | null | undefined,
  percent: number,
): Promise<boolean> {
  if (typeof installId !== "string" || !OTA_INSTALL_ID.test(installId)) return false;
  if (!isOtaRolloutPercent(percent)) return false;
  if (percent >= 100) return true;
  return await otaRolloutBucket(channel, candidateVersion, installId) < percent * 100;
}
