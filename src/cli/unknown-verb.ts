// Whether a name nothing else claims is worth importing the project's config for. Apart from
// plugin-commands.ts because it parses the config (swc), which `denext commands` never needs.

import { readStaticConfig } from "../build/config-static.ts";
import { readCommandCache } from "./command-cache.ts";

/**
 * What to do about a name nothing else claims, decided WITHOUT importing the project:
 *
 *   - `"discover"`: import the config. The project's last `denext commands` listing still holds
 *     and names the verb, or (unless help was asked for) the config declares `commands` or
 *     `plugins`, or is written so that it could.
 *   - `"help"`: `<verb> --help` for a name not listed. Asking about a name never runs the project.
 *   - `"unknown"`: the config can't contribute a verb, so the name is unknown.
 *
 * A false "no verbs" would silently break a project's verb, so whatever the static read can't
 * see through counts as declaring them. This narrows when a typo runs a config; a config that
 * declares `commands` still runs.
 *
 * @param argv The CLI's arguments.
 * @param verb The unclaimed verb and its index in `argv`.
 * @param dir The project directory.
 * @returns The decision.
 */
export async function unknownVerbAction(
  argv: readonly string[],
  verb: { readonly name: string; readonly index: number },
  dir: string,
): Promise<"discover" | "help" | "unknown"> {
  const listed = await readCommandCache(dir);
  if (listed?.some((known) => known.name === verb.name)) return "discover";
  const after = argv.slice(verb.index + 1);
  const end = after.indexOf("--");
  if ((end < 0 ? after : after.slice(0, end)).some((tok) => tok === "--help" || tok === "-h")) {
    return "help";
  }
  const config = await readStaticConfig(dir);
  if (config.file === null) return "unknown";
  const declares = !config.readable || config.hidesKeys ||
    Object.hasOwn(config.keys, "commands") || Object.hasOwn(config.keys, "plugins");
  return declares ? "discover" : "unknown";
}

/**
 * Decide about a name only after a compiled binary has offered it to the denext the project pins:
 * a verb only that newer denext has must not be "unknown" in an older binary. The hand-off ends
 * this process when it happens, and the pinned CLI then decides for itself, so a pin to a denext
 * from before this check imports the config whatever the name.
 *
 * @param handOff Re-runs the invocation on the pinned denext, when there is one to run on.
 * @param decide The decision, as {@linkcode unknownVerbAction} makes it.
 * @returns The decision.
 */
export async function afterPinHandOff<T>(
  handOff: () => Promise<void>,
  decide: () => Promise<T>,
): Promise<T> {
  await handOff();
  return await decide();
}
