// `@denext/migrate` (packages/migrate): the migrators behind `denext migrate` (and
// `migrate --check`), published as its own JSR package so `@denext/denext` stays clear of JSR's
// 20 MiB package cap.
//
// It is loaded the way `@denext/ui` is (src/cli/ui-package.ts): a DYNAMIC import with a literal
// specifier, which root deno.json maps to exactly `jsr:@denext/migrate@<denext's version>`
// (`deno task bump` moves the pin with the version; the workspace member satisfies it locally,
// so a checkout and the tests never fetch it). `deno publish` writes the exact pin into the
// published source, `deno compile` embeds the package in the `denext` binary, and `deno cache`
// of the CLI caches it — yet no other verb loads it (`denext codemod` and `migrate --codemod`'s
// source rewrite stay in denext). A CLI run from JSR whose cache lacks it fetches it on the first
// `denext migrate`; when that fetch cannot happen, the verb stops with what to do instead of
// Deno's loader error (src/cli/member-package.ts).
//
// The release publishes `@denext/migrate` <version> before it tags `v<version>`
// (scripts/release.ts), so Deno's minimum dependency age never holds it back from a denext the
// age hold already let in.

import { memberLoader, memberUnavailableMessage } from "./member-package.ts";

/** The `@denext/migrate` module: the migration, its dry-run check and the Capacitor steps. */
export type MigratePackage = typeof import("@denext/migrate");

/** Imports `@denext/migrate` (the real dynamic import, or a test's stand-in). */
export type MigrateImporter = () => Promise<MigratePackage>;

/** The package's JSR name. */
export const MIGRATE_PACKAGE = "@denext/migrate";

/**
 * What `denext migrate` prints when `@denext/migrate` could not be loaded.
 *
 * @param verb The verb that needed it (`denext migrate`).
 * @param error The loader's error.
 * @returns The message, prefixed `denext:` (the CLI prints it without a stack trace).
 */
export function migrateUnavailableMessage(verb: string, error: unknown): string {
  return memberUnavailableMessage(MIGRATE_PACKAGE, verb, error);
}

/**
 * Load `@denext/migrate` (once per process). A load failure becomes an `Error` whose message is
 * {@linkcode migrateUnavailableMessage} (not cached, so a later call retries); an error thrown by
 * the migrators' own code propagates unchanged.
 *
 * @param verb The verb that needs it, for the message.
 * @param importer The import (tests pass a stand-in; the default is the literal import).
 * @returns The package.
 */
export const loadMigratePackage: (
  verb: string,
  importer?: MigrateImporter,
) => Promise<MigratePackage> = memberLoader(MIGRATE_PACKAGE, () => import("@denext/migrate"));
