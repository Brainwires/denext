// The built-in presets by name, for `denext deploy --preset <name>` (each with its default
// options; the app name comes from the project directory).

import type { DeployAdapter } from "./adapter.ts";
import { denoDeploy } from "./presets/deno-deploy.ts";
import { docker } from "./presets/docker.ts";
import { fly } from "./presets/fly.ts";
import { genericHost } from "./presets/generic-host.ts";
import { staticHost } from "./presets/static.ts";

/** Every preset's factory, by the name `--preset` takes. */
const PRESETS: Readonly<Record<string, () => DeployAdapter>> = {
  "docker": () => docker(),
  "fly": () => fly(),
  "deno-deploy": () => denoDeploy(),
  "generic-host": () => genericHost(),
  "static": () => staticHost(),
};

/** The preset names, in the order help lists them. */
export const PRESET_NAMES: readonly string[] = Object.keys(PRESETS);

/**
 * The preset a name selects, with its default options.
 *
 * @param name A preset name.
 * @returns The adapter, or `null` for an unknown name.
 */
export function presetAdapter(name: string): DeployAdapter | null {
  return Object.hasOwn(PRESETS, name) ? PRESETS[name]() : null;
}
