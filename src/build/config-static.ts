// A project's `denext.config.*` read as text, for the verbs that inspect a project and must not
// run it: importing the config runs it under the CLI's own permissions. Only keys written as data
// have a value here; one computed by code is known to exist and nothing more.

import { join } from "@std/path";
import { CONFIG_FILES } from "./config-files.ts";
import { type ConfigKeyInfo, readConfigModel } from "./config-edit.ts";

/** What the project's config says without being run. */
export interface StaticConfig {
  /** The config file's name; null when the project has none. */
  readonly file: string | null;
  /** Whether the file's shape could be read (a config object, or named exports). */
  readonly readable: boolean;
  /** Its top-level keys. */
  readonly keys: Readonly<Record<string, ConfigKeyInfo>>;
}

/** The first config file in `dir`, as the loader would pick it, with its text. */
async function configSource(dir: string): Promise<{ file: string; source: string | null } | null> {
  for (const file of CONFIG_FILES) {
    const info = await Deno.lstat(join(dir, file)).catch(() => null);
    if (info === null) continue;
    return { file, source: await Deno.readTextFile(join(dir, file)).catch(() => null) };
  }
  return null;
}

/**
 * The project's config as data, with nothing of it run.
 *
 * @param dir The project directory.
 * @returns The file's name and top-level keys.
 */
export async function readStaticConfig(dir: string): Promise<StaticConfig> {
  const found = await configSource(dir);
  if (found === null) return { file: null, readable: true, keys: {} };
  const model = found.source === null
    ? null
    : await readConfigModel(found.source).catch(() => null);
  if (model === null || model.form === "unsupported") {
    return { file: found.file, readable: false, keys: {} };
  }
  return { file: found.file, readable: true, keys: model.keys };
}
