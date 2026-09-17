// Which view of `denext.config.ts` each key belongs to, and the filter that cuts across them.
//
// The grouping is what keeps `/config` from rendering all ~30 sections at once, so the property
// that matters is TOTALITY: every key the schema describes lands in exactly one view, and a key
// it does not describe still lands somewhere rather than disappearing from the editor.

import { assert, assertEquals } from "@std/assert";
import { loadConfigSchema } from "../src/ui/form/schema.ts";
import {
  CONFIG_GROUPS,
  type ConfigGroup,
  configMatchNote,
  DEFAULT_GROUP,
  GROUP_LABEL,
  groupHref,
  groupOf,
  isConfigGroup,
  matchesQuery,
  visibleSections,
} from "../src/ui/features/config-groups.ts";
import { matchesTerms, matchNote } from "../src/ui/filter.ts";

/** Every top-level key the config schema describes. */
function schemaKeys(): string[] {
  return Object.keys(loadConfigSchema().properties ?? {});
}

Deno.test("every schema key lands in exactly one view, and each view is non-empty", () => {
  const keys = schemaKeys();
  assert(keys.length > 0, "the schema describes some keys");
  const seen = new Map<ConfigGroup, string[]>(CONFIG_GROUPS.map((g) => [g, []]));
  for (const key of keys) seen.get(groupOf(key))!.push(key);
  assertEquals(
    [...seen.values()].reduce((n, list) => n + list.length, 0),
    keys.length,
    "every key is placed",
  );
  for (const group of CONFIG_GROUPS) {
    assert(seen.get(group)!.length > 0, `${group} would render an empty page`);
    assert(GROUP_LABEL[group].length > 0, `${group} has a label`);
  }
});

Deno.test("a key the schema does not describe still has a home", () => {
  // A config may declare anything; the editor shows unknown keys read-only rather than dropping
  // them, so they need a view. `advanced` is the catch-all, where the escape hatch lives too.
  assertEquals(groupOf("totallyUnknownKey"), "advanced");
  assertEquals(groupOf("raw-file"), "advanced");
  assertEquals(groupOf(""), "advanced");
});

Deno.test("the default view is spelled as the panel's own address", () => {
  // `/config` and `/config/routing` would be two URLs for one page; the short one wins, so
  // a link to the panel does not rot if the default ever moves.
  assertEquals(groupHref(DEFAULT_GROUP), "/config");
  assertEquals(groupHref("security"), "/config/security");
  assert(isConfigGroup("security"));
  assert(!isConfigGroup("nope"));
  assert(!isConfigGroup(null));
});

Deno.test("search matches key and description, and every term has to match", () => {
  assert(matchesQuery("cacheComponents", "Opt into cached components.", "cache"));
  assert(matchesQuery("experimental", "Unstable options, including the cache.", "cache"));
  assert(matchesQuery("basePath", "Serve the app under a sub-path.", "base path"));
  // AND semantics: a second term that matches nothing rules the section out.
  assert(!matchesQuery("basePath", "Serve the app under a sub-path.", "base zzz"));
  assert(matchesQuery("mode", undefined, "mode"), "a key with no description still matches");
  assertEquals(matchesQuery("mode", "Rendering mode.", "MODE"), true, "case-insensitive");
});

Deno.test("a query ignores the view; a view ignores the query", () => {
  const sections = [
    { key: "basePath", description: "Serve under a sub-path." }, // routing
    { key: "cache", description: "Cache store." }, // data
    { key: "cacheComponents", description: "Cached components." }, // rendering
  ];
  const byView = visibleSections(sections, "routing", "");
  assertEquals(byView.shown.map((s) => s.key), ["basePath"]);
  assertEquals(byView.rawHere, false, "the escape hatch is not on routing");

  // The same query returns the same set whichever view it is asked from.
  for (const group of ["routing", "data", "advanced"] as const) {
    const found = visibleSections(sections, group, "cache");
    assertEquals(found.shown.map((s) => s.key), ["cache", "cacheComponents"]);
  }
  assertEquals(visibleSections(sections, "advanced", "").rawHere, true);
});

Deno.test("the config match note counts what it found, and says when it found nothing", () => {
  // The "across every group" clause is load-bearing: the search ignores whichever view you are
  // on, so a count without it would look like it was counting the current page.
  assertEquals(configMatchNote(0, "zzz"), 'No config key matches "zzz".');
  assertEquals(configMatchNote(1, "cache"), '1 config key matches "cache" — across every group.');
  assertEquals(configMatchNote(3, "cache"), '3 config keys match "cache" — across every group.');
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
