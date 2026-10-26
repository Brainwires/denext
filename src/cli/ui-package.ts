// `@denext/ui` (packages/ui): the web UI behind `denext ui` and `denext dashboard`, published as
// its own JSR package so `@denext/denext` stays clear of JSR's 20 MiB package cap.
//
// It is loaded the way `@denext/docs-corpus` is (src/mcp/rag/corpus.ts): a DYNAMIC import with a
// literal specifier, which root deno.json maps to exactly `jsr:@denext/ui@<denext's version>`
// (`deno task bump` moves the pin with the version; the workspace member satisfies it locally,
// so a checkout and the tests never fetch it). The specifier stays in denext's module graph —
// `deno publish` writes the exact pin into the published source, `deno compile` embeds the
// package in the `denext` binary, and `deno cache` of the CLI (src/cli/cli-cache.ts) caches it —
// yet no other verb loads it. A CLI run from JSR whose cache lacks it fetches it on the first
// `denext ui`; after that it works offline. When that first fetch cannot happen (offline, JSR
// unreachable), the verb stops with what to do instead of Deno's loader error.
//
// The release publishes `@denext/ui` <version> before it tags `v<version>` (scripts/release.ts),
// so the version denext pins is always older than denext itself: Deno's minimum dependency age
// never holds it back from a denext the age hold already let in.

import { VERSION } from "../version.ts";

/** The `@denext/ui` module: the servers and the defaults the verbs start them with. */
export type UiPackage = typeof import("@denext/ui");

/** Imports `@denext/ui` (the real dynamic import, or a test's stand-in). */
export type UiImporter = () => Promise<UiPackage>;

/** The package's JSR name. */
export const UI_PACKAGE = "@denext/ui";

/** The real import: literal, so publish, compile and cache all see it. */
const importUi: UiImporter = () => import("@denext/ui");

let loaded: Promise<UiPackage> | null = null;

/**
 * Whether `error` is Deno failing to load a module (a fetch that could not happen, a specifier
 * missing from the cache under `--cached-only`), not the UI's own code throwing as it loads.
 */
export function isModuleLoadFailure(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return /\b(import|module|fetch|cached?|jsr|network|sending request|dns|connect|resolve)/i
    .test(error.message);
}

/**
 * What a verb prints when `@denext/ui` could not be loaded.
 *
 * @param verb The verb that needed it (`denext ui`).
 * @param error The loader's error.
 * @returns The message, prefixed `denext:` (the CLI prints it without a stack trace).
 */
export function uiUnavailableMessage(verb: string, error: unknown): string {
  // Deno's loader error spans lines (the request, then each cause): one line, bounded.
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, " ");
  const reason = text.length > 300 ? `${text.slice(0, 299)}…` : text;
  return `denext: ${verb} needs ${UI_PACKAGE}@${VERSION}, which is not in Deno's cache and ` +
    `could not be fetched from jsr.io (${reason}).\n` +
    "  Connect to the network and run it again: it is fetched once, then works offline.\n" +
    `  To fetch it ahead of time: deno cache jsr:${UI_PACKAGE}@${VERSION}`;
}

/**
 * Load `@denext/ui` (once per process). A load failure becomes an `Error` whose message is
 * {@linkcode uiUnavailableMessage} (the failure is not cached, so a later call retries); an error
 * thrown by the UI's own code propagates unchanged.
 *
 * @param verb The verb that needs it, for the message.
 * @param importer The import (tests pass a stand-in; the default is the literal import).
 * @returns The package.
 */
export function loadUiPackage(
  verb: string,
  importer: UiImporter = importUi,
): Promise<UiPackage> {
  const attempt = () =>
    importer().catch((error: unknown) => {
      if (!isModuleLoadFailure(error)) throw error;
      throw new Error(uiUnavailableMessage(verb, error), { cause: error });
    });
  if (importer !== importUi) return attempt();
  loaded ??= attempt().catch((error: unknown) => {
    loaded = null;
    throw error;
  });
  return loaded;
}
