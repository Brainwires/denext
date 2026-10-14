// Where `denext <name> …` goes when no built-in claims `name`, decided WITHOUT importing the
// project: discovering project verbs means importing `denext.config.ts` and running every plugin
// `setup()` under the CLI's own permissions, so that import must only happen for a name that can
// be a project verb.
//
//   - A script (`denext main.ts`, `denext https://…/x.ts`) is never a verb name: Deno runs it.
//   - A Deno verb a project may not take ({@linkcode isReservedDenoVerb}: `run`, `x`, `eval`,
//     `serve`, `compile`, …) always runs Deno's.
//   - Any other Deno verb runs the project's verb only when the project's last `denext commands`
//     listing (`.denext/commands.json`, fingerprinted against the config, `deno.json` and
//     `deno.lock`) still matches and names it. A missing or stale listing runs Deno's, with a hint
//     when the directory is a denext project.
//   - Every other name may be a project verb, so the CLI discovers them (it is "unknown" otherwise).

import { hasDenextConfig, readCommandCache } from "./command-cache.ts";
import { type DenoForward, denoForwardFor } from "./deno-forward.ts";
import { isForwardableDenoVerb, isReservedDenoVerb } from "./deno-verbs.ts";

/** What {@linkcode routeUnknownVerb} decided. */
export type VerbRoute =
  | {
    /** Run Deno's verb, or `deno run` the script. */
    readonly kind: "deno";
    /** The Deno invocation. */
    readonly forward: DenoForward;
    /**
     * True when the name is a Deno verb a project verb could take, in a denext project whose
     * verb listing is missing or stale — the caller says how to make a project verb reachable.
     */
    readonly unlisted: boolean;
  }
  | {
    /** Discover the project's verbs (importing its config), then dispatch. */
    readonly kind: "project";
  };

/**
 * Route a verb no built-in claims, reading at most the cached listing — never the config.
 *
 * @param argv The CLI's arguments.
 * @param verb The unclaimed verb and its index in `argv`.
 * @param cwd The process's directory.
 * @returns Where the invocation goes.
 */
export async function routeUnknownVerb(
  argv: readonly string[],
  verb: { readonly name: string; readonly index: number },
  cwd: string = Deno.cwd(),
): Promise<VerbRoute> {
  const forward = denoForwardFor(argv, verb, cwd);
  if (forward === null) return { kind: "project" };
  if (!isForwardableDenoVerb(verb.name) || isReservedDenoVerb(verb.name)) {
    return { kind: "deno", forward, unlisted: false };
  }
  const listed = await readCommandCache(forward.cwd);
  if (listed === null) {
    return { kind: "deno", forward, unlisted: await hasDenextConfig(forward.cwd) };
  }
  return listed.some((v) => v.name === verb.name)
    ? { kind: "project" }
    : { kind: "deno", forward, unlisted: false };
}
