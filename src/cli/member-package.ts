// The loader behind the CLI's same-version members — `@denext/ui` (src/cli/ui-package.ts) and
// `@denext/migrate` (src/cli/migrate-package.ts): packages published beside `@denext/denext`, at
// its exact version, so the core package stays clear of JSR's 20 MiB package cap.
//
// Each is loaded by a DYNAMIC import with a literal specifier (written in its own module, so
// `deno publish`, `deno compile` and `deno cache` all see it), which root deno.json maps to exactly
// `jsr:@denext/<name>@<denext's version>`. This module turns a load that cannot happen (offline,
// JSR unreachable) into a message that says what to do instead of Deno's loader error, and loads
// each package once per process.

import { VERSION } from "../version.ts";

/**
 * Whether `error` is Deno failing to load a module (a fetch that could not happen, a specifier
 * missing from the cache under `--cached-only`), not the package's own code throwing as it loads.
 */
export function isModuleLoadFailure(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return /\b(import|module|fetch|cached?|jsr|network|sending request|dns|connect|resolve)/i
    .test(error.message);
}

/**
 * What a verb prints when a member package could not be loaded.
 *
 * @param name The package's JSR name (`@denext/ui`).
 * @param verb The verb that needed it (`denext ui`).
 * @param error The loader's error.
 * @returns The message, prefixed `denext:` (the CLI prints it without a stack trace).
 */
export function memberUnavailableMessage(name: string, verb: string, error: unknown): string {
  // Deno's loader error spans lines (the request, then each cause): one line, bounded.
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, " ");
  const reason = text.length > 300 ? `${text.slice(0, 299)}…` : text;
  return `denext: ${verb} needs ${name}@${VERSION}, which is not in Deno's cache and ` +
    `could not be fetched from jsr.io (${reason}).\n` +
    "  Connect to the network and run it again: it is fetched once, then works offline.\n" +
    `  To fetch it ahead of time: deno cache jsr:${name}@${VERSION}`;
}

/** Loads a member package for `verb`; a test passes its own `importer`. */
export type MemberLoader<T> = (verb: string, importer?: () => Promise<T>) => Promise<T>;

/**
 * A loader for one member package. A load failure becomes an `Error` whose message is
 * {@linkcode memberUnavailableMessage} (the failure is not cached, so a later call retries); an
 * error thrown by the package's own code propagates unchanged. The real import is made once per
 * process; a test's stand-in `importer` is called every time.
 *
 * @param name The package's JSR name, for the message.
 * @param realImport The literal dynamic import of the package.
 * @returns The loader.
 */
export function memberLoader<T>(name: string, realImport: () => Promise<T>): MemberLoader<T> {
  let loaded: Promise<T> | null = null;
  return (verb, importer = realImport) => {
    const attempt = () =>
      importer().catch((error: unknown) => {
        if (!isModuleLoadFailure(error)) throw error;
        throw new Error(memberUnavailableMessage(name, verb, error), { cause: error });
      });
    if (importer !== realImport) return attempt();
    loaded ??= attempt().catch((error: unknown) => {
      loaded = null;
      throw error;
    });
    return loaded;
  };
}
