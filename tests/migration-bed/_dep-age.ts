// The dependency-age rule the migration beds run under (see `runBed` in `_bed.ts`).
//
// The beds once set `DENEXT_MIN_DEP_AGE=0` for every command, which turned Deno's minimum
// dependency age off for npm too: a build resolved an npm range to a release published minutes
// earlier, and the registry still answered 404 for its tarball (`tslib@2.9.1`, 2026-10-30), so
// the bed failed for npm's sake rather than denext's. What the beds do need unheld is denext's own
// JSR packages: the checkout pins `@denext/*` versions published by the release that just
// happened (the codecs, `@denext/docs-corpus`), which a hold would refuse for a day.
//
// `DENEXT_MIN_DEP_AGE` cannot express that: denext forwards it as `--min-dep-age`, which also
// drops a config's `exclude` list. So the beds put the rule in the migrated app's own `deno.json`
// instead, where Deno and every child denext starts (bundle, CSS, compile) read it: a one-day
// hold on everything (npm releases a day old have long reached the CDN; the default is longer)
// with `jsr:@denext/*` excluded.

import { join } from "@std/path";

/** The `minimumDependencyAge` value a migrated bed app runs under. */
export const BED_DEPENDENCY_AGE: { readonly age: string; readonly exclude: readonly string[] } = {
  age: "P1D",
  exclude: ["jsr:@denext/*"],
};

/**
 * The environment the beds' commands run with: an inherited `DENEXT_MIN_DEP_AGE` emptied, so it
 * neither lifts nor replaces {@linkcode BED_DEPENDENCY_AGE} (denext reads an empty value as unset),
 * and `DENEXT_ALLOW_DENEXT_AGE_EXEMPTION=1`, so `denext doctor` takes the `jsr:@denext/*` exclusion
 * as the bed's own deliberate rule instead of failing its dependency-age check (an app's fails).
 */
export const BED_ENV: Readonly<Record<string, string>> = {
  DENEXT_MIN_DEP_AGE: "",
  DENEXT_ALLOW_DENEXT_AGE_EXEMPTION: "1",
};

/**
 * Write {@linkcode BED_DEPENDENCY_AGE} into the migrated app's `deno.json` (replacing any rule
 * the migration carried over from the app, so every bed resolves under the same one).
 *
 * @param app The migrated app's directory.
 */
export async function holdBedDependencies(app: string): Promise<void> {
  const path = join(app, "deno.json");
  const config = JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>;
  config.minimumDependencyAge = BED_DEPENDENCY_AGE;
  await Deno.writeTextFile(path, JSON.stringify(config, null, 2) + "\n");
}
