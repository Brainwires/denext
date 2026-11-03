// Hangar's settings file, `hangar-settings.json` in the app's data folder (the OS app-support
// directory the bridge hands extension methods as `ctx.appSupportDir`, and desktop.ts reads from
// `resolveDesktopCapabilities`). Read once at launch, written by the settings page.

import { join } from "@std/path/posix";
import { defaultSettings, HangarError, parseSettings } from "./hangar.ts";
import type { Host } from "./host.ts";
import type { HangarSettings } from "./types.ts";

/** The settings file's name, in the app's data folder. */
export const SETTINGS_FILE = "hangar-settings.json";

/**
 * The settings file's path in `appSupportDir`. Refuses a folder that is not absolute (an empty one
 * included): the file would land in, and be read from, whatever the working directory is.
 */
export function settingsPath(appSupportDir: string): string {
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(appSupportDir)) {
    throw new HangarError("unavailable", "no app data folder for the settings in this launch");
  }
  return join(appSupportDir, SETTINGS_FILE);
}

/** The saved settings over the defaults; a missing, unreadable or bad file gives the defaults. */
export async function loadSettings(host: Host, appSupportDir: string): Promise<HangarSettings> {
  const path = settingsPath(appSupportDir);
  const base = defaultSettings(host.home, host.os);
  let saved: unknown = {};
  try {
    saved = JSON.parse(await host.readTextFile(path));
  } catch { /* first launch, or an unreadable file: the defaults */ }
  try {
    return parseSettings(saved, base);
  } catch { /* a hand-edited bad value: the defaults */ }
  return base;
}

/** Write `settings` to the data folder, creating the folder on first save. */
export async function saveSettings(
  host: Host,
  appSupportDir: string,
  settings: HangarSettings,
): Promise<void> {
  const path = settingsPath(appSupportDir);
  await host.mkdir(appSupportDir);
  await host.writeTextFile(path, JSON.stringify(settings, null, 2) + "\n");
}
