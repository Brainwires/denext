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
// unreachable), the verb stops with what to do instead of Deno's loader error
// (src/cli/member-package.ts).
//
// The release publishes `@denext/ui` <version> before it tags `v<version>` (scripts/release.ts),
// so the version denext pins is always older than denext itself: Deno's minimum dependency age
// never holds it back from a denext the age hold already let in.

import { memberLoader, memberUnavailableMessage } from "./member-package.ts";

export { isModuleLoadFailure } from "./member-package.ts";

/** The `@denext/ui` module: the servers and the defaults the verbs start them with. */
export type UiPackage = typeof import("@denext/ui");

/** Imports `@denext/ui` (the real dynamic import, or a test's stand-in). */
export type UiImporter = () => Promise<UiPackage>;

/** The package's JSR name. */
export const UI_PACKAGE = "@denext/ui";

/**
 * What a verb prints when `@denext/ui` could not be loaded.
 *
 * @param verb The verb that needed it (`denext ui`).
 * @param error The loader's error.
 * @returns The message, prefixed `denext:` (the CLI prints it without a stack trace).
 */
export function uiUnavailableMessage(verb: string, error: unknown): string {
  return memberUnavailableMessage(UI_PACKAGE, verb, error);
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
export const loadUiPackage: (verb: string, importer?: UiImporter) => Promise<UiPackage> =
  memberLoader(UI_PACKAGE, () => import("@denext/ui"));
