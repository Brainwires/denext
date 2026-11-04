// The migration beds' dependency-age rule (tests/migration-bed/_dep-age.ts): a one-day hold on
// npm with denext's own JSR packages exempt, written into the migrated app's deno.json, and no
// `DENEXT_MIN_DEP_AGE=0` that would let a minutes-old npm release (tslib 2.9.1, whose tarball
// still 404'd) into a bed's build.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { effectiveRule, heldUntil, isExcluded } from "../src/build/dep-age.ts";
import { BED_DEPENDENCY_AGE, BED_ENV, holdBedDependencies } from "./migration-bed/_dep-age.ts";

const NOW = new Date("2026-10-30T21:00:00Z");
const HOUR = 3_600_000;

Deno.test("migration beds: npm is held a day, denext's JSR packages are not", () => {
  const rule = effectiveRule({
    config: BED_DEPENDENCY_AGE,
    env: BED_ENV.DENEXT_MIN_DEP_AGE,
    now: NOW,
  });
  assertEquals(rule.source, "config", "the bed env must not replace the config's rule");
  assertEquals(rule.cutoff?.getTime(), NOW.getTime() - 24 * HOUR);
  assert(isExcluded(rule, "@denext/docs-corpus", "jsr"));
  assert(isExcluded(rule, "@denext/lightningcss", "jsr"));
  assert(!isExcluded(rule, "tslib", "npm"));
  assert(!isExcluded(rule, "@std/path", "jsr"));
  // Published 40 minutes before the build: held (until a day after publishing).
  const fresh = new Date(NOW.getTime() - 40 * 60_000).toISOString();
  assertEquals(heldUntil(rule, "tslib", fresh, NOW)?.getTime(), Date.parse(fresh) + 24 * HOUR);
  assertEquals(heldUntil(rule, "@denext/docs-corpus", fresh, NOW), null);
});

Deno.test("migration beds: the rule replaces the migrated app's own and keeps the rest", async () => {
  const app = await Deno.makeTempDir({ prefix: "denext_bed_age_" });
  try {
    const path = join(app, "deno.json");
    await Deno.writeTextFile(
      path,
      JSON.stringify({ imports: { denext: "../denext/mod.ts" }, minimumDependencyAge: 0 }),
    );
    await holdBedDependencies(app);
    const config = JSON.parse(await Deno.readTextFile(path));
    assertEquals(config.imports, { denext: "../denext/mod.ts" });
    assertEquals(config.minimumDependencyAge, { age: "P1D", exclude: ["jsr:@denext/*"] });
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("migration beds: no bed command turns the dependency-age hold off", async () => {
  const harness = await Deno.readTextFile(new URL("./migration-bed/_bed.ts", import.meta.url));
  assert(!/DENEXT_MIN_DEP_AGE["']?\s*:\s*["']0["']/.test(harness), "_bed.ts sets the hold to 0");
  assert(harness.includes("holdBedDependencies(app)"), "_bed.ts no longer writes the bed rule");
});

Deno.test("migration beds: doctor takes the bed's @denext exemption as deliberate", async () => {
  const { depAgeExemptionCheck } = await import("../src/cli/commands/doctor.ts");
  const app = await Deno.makeTempDir({ prefix: "denext_bed_age_doctor_" });
  try {
    await Deno.writeTextFile(join(app, "deno.json"), "{}");
    await holdBedDependencies(app);
    const check = await depAgeExemptionCheck(app, (name) => BED_ENV[name]);
    assertEquals([check?.ok, check?.critical], [true, false]);
    // Without the bed's environment it is an app's exemption: a failure.
    assertEquals((await depAgeExemptionCheck(app, () => undefined))?.ok, false);
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});
