// Which view of `denext.config.ts` each key belongs to.
//
// The grouping is what keeps `/config` from rendering all ~30 sections at once, so the property
// that matters is TOTALITY: every key the schema describes lands in exactly one view, and a key
// it does not describe still lands somewhere rather than disappearing from the editor.

import { assert, assertEquals } from "@std/assert";
import { loadConfigSchema } from "../src/ui/form/schema.ts";
import {
  CONFIG_GROUPS,
  type ConfigGroup,
  DEFAULT_GROUP,
  GROUP_LABEL,
  groupHref,
  groupOf,
  isConfigGroup,
  ownedElsewhere,
  visibleSections,
} from "../src/ui/features/config-groups.ts";
import { matchesTerms, matchNote } from "../src/ui/filter.ts";

/** Every top-level key the config schema describes. */
function schemaKeys(): string[] {
  return Object.keys(loadConfigSchema().properties ?? {});
}

Deno.test("every schema key lands in one view or is owned elsewhere, and no view is empty", () => {
  const keys = schemaKeys();
  assert(keys.length > 0, "the schema describes some keys");
  const placed = keys.filter((key) => ownedElsewhere(key) === null);
  const seen = new Map<ConfigGroup, string[]>(CONFIG_GROUPS.map((g) => [g, []]));
  for (const key of placed) seen.get(groupOf(key))!.push(key);
  assertEquals(
    [...seen.values()].reduce((n, list) => n + list.length, 0),
    placed.length,
    "every key the views own is placed",
  );
  for (const group of CONFIG_GROUPS) {
    assert(seen.get(group)!.length > 0, `${group} would render an empty page`);
    assert(GROUP_LABEL[group].length > 0, `${group} has a label`);
  }
});

Deno.test("the cron keys are owned by the Cron page, and no view shows them", () => {
  // Two editors for one key would mean two forms, two `_base` stamps, and two ways to disagree
  // about what the file says.
  assertEquals(ownedElsewhere("scheduledTasks"), "/config/cron");
  assertEquals(ownedElsewhere("tasks"), "/config/cron");
  assertEquals(ownedElsewhere("basePath"), null);

  const sections = [
    { key: "scheduledTasks", description: "Cron schedules for background tasks." },
    { key: "tasks", description: "Scheduled task behaviour." },
    { key: "cache", description: "Cache store." },
  ];
  // Not on any view...
  for (const group of CONFIG_GROUPS) {
    const shown = visibleSections(sections, group).shown.map((s) => s.key);
    assert(!shown.includes("scheduledTasks"), `${group} shows scheduledTasks`);
    assert(!shown.includes("tasks"), `${group} shows tasks`);
  }
});

Deno.test("cache moved to Rendering when Data retired, beside cacheComponents", () => {
  // `Data` held only `cache` once the cron keys left, and a whole view for one key is worse than
  // that key sitting with the other caching concern.
  assertEquals(groupOf("cache"), "rendering");
  assertEquals(groupOf("cacheComponents"), "rendering");
  assertEquals(groupOf("momentumSafeScroll"), "rendering");
  assert(!(CONFIG_GROUPS as readonly string[]).includes("data"));
});

Deno.test("a key the schema does not describe still has a home", () => {
  // A config may declare anything; the editor shows unknown keys read-only rather than dropping
  // them, so they need a view. `advanced` is the catch-all, where the escape hatch lives too.
  assertEquals(groupOf("totallyUnknownKey"), "advanced");
  assertEquals(groupOf("raw-file"), "advanced");
  assertEquals(groupOf(""), "advanced");
});

Deno.test("every view is spelled the same way, the default included", () => {
  // `/config` is the Configuration index — a card per view — so the default view needs a path
  // that says which view it is, exactly like the others.
  assertEquals(groupHref(DEFAULT_GROUP), "/config/routing");
  assertEquals(groupHref("security"), "/config/security");
  assert(isConfigGroup("security"));
  assert(!isConfigGroup("nope"));
  assert(!isConfigGroup(null));
});

Deno.test("a view shows its own keys, and the escape hatch has exactly one home", () => {
  const sections = [
    { key: "basePath", description: "Serve under a sub-path." }, // routing
    { key: "cache", description: "Cache store." }, // rendering
    { key: "cacheComponents", description: "Cached components." }, // rendering
  ];
  const byView = visibleSections(sections, "routing");
  assertEquals(byView.shown.map((s) => s.key), ["basePath"]);
  assertEquals(byView.rawHere, false, "the escape hatch is not on routing");

  const rendering = visibleSections(sections, "rendering");
  assertEquals(rendering.shown.map((s) => s.key), ["cache", "cacheComponents"]);
  assertEquals(visibleSections(sections, "advanced").rawHere, true);
});

Deno.test("the shared matcher is case-insensitive with AND semantics, and empty matches all", () => {
  assert(matchesTerms("denext build the app", "build"));
  assert(matchesTerms("denext build the app", "BUILD APP"), "case-insensitive, both terms");
  assert(!matchesTerms("denext build the app", "build missing"), "every term has to match");
  assert(matchesTerms("anything at all", ""), "an empty query filters nothing out");
  assert(matchesTerms("anything at all", "   "), "whitespace is not a term");
});

Deno.test("the shared match note agrees with itself on number", () => {
  // `1 verb matches` / `2 verbs match` — the noun and the verb have to move together.
  assertEquals(matchNote(0, "zzz", "verb"), 'No verb matches "zzz".');
  assertEquals(matchNote(1, "docker", "verb"), '1 verb matches "docker".');
  assertEquals(matchNote(4, "build", "verb"), '4 verbs match "build".');
  assertEquals(matchNote(1, "x", "thing", " — everywhere"), '1 thing matches "x" — everywhere.');
});
