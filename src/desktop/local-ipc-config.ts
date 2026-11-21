/**
 * Local IPC's names and `desktop.capabilities.localIpc`'s shape, without the transport: the config
 * validator, the packaging flags and `local-ipc.ts` share them.
 *
 * Pure; nothing runs at import.
 *
 * @module
 */

/** A channel or user name: 1 to 64 of `[A-Za-z0-9._-]`, starting with a letter or digit. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The folder (inside the app's data folder) the default socket paths are in. */
export const LOCAL_IPC_FOLDER = "ipc";

/**
 * Why `name` cannot be a channel name, or `null`.
 *
 * @param name The name.
 * @param what What it names, for the message.
 * @returns The message, or `null`.
 */
export function localIpcNameError(name: unknown, what = "channel name"): string | null {
  if (typeof name !== "string" || !NAME.test(name)) {
    return `local IPC ${what} ${JSON.stringify(name)} must be 1 to 64 of [A-Za-z0-9._-], ` +
      "starting with a letter or digit";
  }
  return null;
}

/**
 * What is wrong with `desktop.capabilities.localIpc`, as `[path, message]`, or `null`: a boolean,
 * or `{ channels?: string[] }` of channel names.
 *
 * @param value `desktop.capabilities.localIpc`.
 * @returns The problem, or `null`.
 */
export function localIpcConfigProblem(value: unknown): [string, string] | null {
  if (value === undefined || typeof value === "boolean") return null;
  const at = "desktop.capabilities.localIpc";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [at, "must be a boolean or { channels?: string[] }"];
  }
  for (const key of Object.keys(value)) {
    if (key !== "channels") return [`${at}.${key}`, "is not an option (channels)"];
  }
  const channels = (value as { channels?: unknown }).channels;
  if (channels === undefined) return null;
  if (!Array.isArray(channels)) return [`${at}.channels`, "must be an array of channel names"];
  for (const name of channels) {
    const error = localIpcNameError(name);
    if (error) return [`${at}.channels`, error];
  }
  return null;
}

/**
 * The channel names `desktop.capabilities.localIpc` lists (`[]` for `true` or none), unique.
 *
 * @param value `desktop.capabilities.localIpc`.
 * @returns The names; throws on an invalid value (the package scripts read the config unvalidated).
 */
export function localIpcChannels(value: unknown): string[] {
  const problem = localIpcConfigProblem(value);
  if (problem) throw new Error(`denext: ${problem[0]} ${problem[1]}`);
  const channels = (value as { channels?: string[] } | undefined)?.channels;
  return typeof value === "object" && value !== null ? [...new Set(channels ?? [])] : [];
}
