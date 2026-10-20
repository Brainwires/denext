// The built-in presets by name, for `denext deploy --preset <name>` (each with its default
// options; the app name comes from the project directory).

import type { DeployAdapter } from "./adapter.ts";
import { denoDeploy } from "./presets/deno-deploy.ts";
import { docker } from "./presets/docker.ts";
import { fly } from "./presets/fly.ts";
import { genericHost } from "./presets/generic-host.ts";
import { staticHost } from "./presets/static.ts";

/** What the CLI's flags set on a preset beyond its defaults (`--domain`). */
export interface PresetOverrides {
  /** The public domain (`--domain`): `generic-host` only. */
  readonly domain?: string;
}

/** Every preset's factory, by the name `--preset` takes. */
const PRESETS: Readonly<Record<string, (o: PresetOverrides) => DeployAdapter>> = {
  "docker": () => docker(),
  "fly": () => fly(),
  "deno-deploy": () => denoDeploy(),
  "generic-host": (o) => genericHost(o.domain === undefined ? {} : { domain: o.domain }),
  "static": () => staticHost(),
};

/** The presets a `--domain` applies to. */
const DOMAIN_PRESETS: ReadonlySet<string> = new Set(["generic-host"]);

/** The preset names, in the order help lists them. */
export const PRESET_NAMES: readonly string[] = Object.keys(PRESETS);

/**
 * The preset a name selects, with its default options and the CLI's overrides.
 *
 * @param name A preset name.
 * @param overrides What the CLI's flags set (`--domain`).
 * @returns The adapter, or `null` for an unknown name.
 * @throws When an override does not apply to the preset.
 */
export function presetAdapter(name: string, overrides: PresetOverrides = {}): DeployAdapter | null {
  if (!Object.hasOwn(PRESETS, name)) return null;
  if (overrides.domain !== undefined && !DOMAIN_PRESETS.has(name)) {
    throw new Error(`denext: --domain applies to --preset generic-host, not ${name}`);
  }
  return PRESETS[name](overrides);
}
