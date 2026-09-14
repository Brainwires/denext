// The generated first-party package catalog (`src/plugin/catalog.json`): a drift check
// against `packages/*` themselves, plus the invariants everything downstream relies on —
// `denext migrate` reads its `spec` values instead of hard-coding pins, and the plugin
// panel lists its rows. A package published (version bumped) without regenerating the
// catalog, or a workspace package added without a `denext.catalog` block, fails here.

import { assert, assertEquals } from "@std/assert";
import {
  CATALOG_OUT,
  type CatalogEntry,
  generatePluginCatalog,
  type PluginCatalog,
  specFor,
  workspaceDirs,
} from "../scripts/gen-plugin-catalog.ts";
import { resolvePluginNames } from "../src/build/plugin-install.ts";
import { PAGES_ROUTER_SPEC } from "../src/build/migrate.ts";

const catalog = JSON.parse(Deno.readTextFileSync(CATALOG_OUT)) as PluginCatalog;
const entries: CatalogEntry[] = catalog.plugins;
const plugins = entries.filter((e) => e.kind === "plugin");

/** The CLI verbs the first-party plugins contribute through `addCommand`, sorted. */
const VERBS = ["content", "graphql", "htmx", "openapi"];

/**
 * Factory names a package deliberately spells differently from the camelCased last path
 * segment `denext plugin add` derives. Empty today: every first-party plugin's factory is
 * derivable, which is what makes `denext plugin add @denext/<x>` work without a lookup.
 * Adding a row here is the explicit opt-out.
 */
const FACTORY_OVERRIDES: Record<string, string> = {};

/** Each workspace member's package name, read from its own `deno.json`. */
function workspaceNames(): string[] {
  return workspaceDirs().map((dir) => {
    const cfg = JSON.parse(Deno.readTextFileSync(`${dir}/deno.json`)) as { name: string };
    return cfg.name;
  }).sort();
}

Deno.test("plugin catalog: catalog.json is regenerated from packages/*", async () => {
  // Bumping a package version, editing its README lead paragraph, or changing its
  // `denext.catalog` block without running `deno task gen:plugin-catalog` fails here.
  assertEquals(
    await Deno.readTextFile(CATALOG_OUT),
    generatePluginCatalog(),
    "src/plugin/catalog.json is stale — run `deno task gen:plugin-catalog` and commit",
  );
});

Deno.test("plugin catalog: every workspace member is catalogued, in sorted order", () => {
  assertEquals(entries.map((e) => e.name), workspaceNames(), "one row per workspace package");
  assertEquals(
    entries.map((e) => e.name),
    [...entries].map((e) => e.name).sort(),
    "rows are sorted by package name",
  );
  assert(entries.length >= 12, "the repo publishes 12+ first-party packages");
});

Deno.test("plugin catalog: each spec pins the package's current version", () => {
  for (const e of entries) {
    assertEquals(e.spec, specFor(e.name, e.version), `${e.name} spec`);
    const range = e.spec.split("@^")[1];
    const [rMajor, rMinor] = range.split(".").map(Number);
    const [pMajor, pMinor] = e.version.split(".").map(Number);
    // ^0.x.y admits only 0.x.*, so for a 0.x package the minor must match; ≥1.x needs the major.
    if (rMajor === 0) assertEquals(pMinor, rMinor, `^${range} excludes ${e.name} ${e.version}`);
    else assertEquals(pMajor, rMajor, `^${range} excludes ${e.name} ${e.version}`);
  }
});

Deno.test("plugin catalog: factory names are the ones `denext plugin add` derives", () => {
  for (const e of plugins) {
    const derived = FACTORY_OVERRIDES[e.name] ?? resolvePluginNames(e.name).factory;
    assertEquals(
      e.factory,
      derived,
      `${e.name}: factory must match \`denext plugin add\` (or be listed in FACTORY_OVERRIDES)`,
    );
  }
});

Deno.test("plugin catalog: kinds, verbs and libraries have the expected shape", () => {
  for (const e of entries) {
    assert(e.kind === "plugin" || e.kind === "library", `${e.name}: unknown kind ${e.kind}`);
    assert(e.exports.includes("."), `${e.name}: no root export`);
    if (e.kind === "library") {
      assertEquals(e.factory, undefined, `${e.name} is a library — no factory`);
      assertEquals(e.verb, undefined, `${e.name} is a library — no CLI verb`);
    } else {
      assert(e.factory, `${e.name}: a plugin declares its factory export`);
    }
  }
  assertEquals(plugins.map((e) => e.verb).filter(Boolean).sort(), VERBS, "plugin CLI verbs");
  assertEquals(entries.length - plugins.length, 5, "five packages are plain libraries");
});

Deno.test("plugin catalog: every row carries a plain-text title and blurb", () => {
  for (const e of entries) {
    assert(e.title.length > 0, `${e.name} has no title`);
    assert(e.blurb.length > 0, `${e.name} has no blurb — give its README a lead paragraph`);
    assert(e.blurb.length <= 200, `${e.name} blurb is ${e.blurb.length} chars`);
    assert(!/[`]|\*\*|\]\(/.test(e.blurb), `${e.name} blurb still carries Markdown syntax`);
  }
});

Deno.test("plugin catalog: `denext migrate` pins come from the catalog", () => {
  const pagesRouter = entries.find((e) => e.name === "@denext/pages-router");
  assertEquals(PAGES_ROUTER_SPEC, pagesRouter?.spec, "migrate's pages-router pin is the catalog's");
  assert(PAGES_ROUTER_SPEC.startsWith("jsr:@denext/pages-router@^"), "a caret jsr: range");
});
