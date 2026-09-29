// The community-package manifest (src/react-native-compat/manifest.ts) against its modules and
// the docs: every runtime entry's module exists, exports something, omits what it says and
// provides its factory; every stand-in module has an entry; every capability is a real
// `denext mobile add` capability; and /docs/react-native's "Community packages" table is the
// one scripts/gen-rn-community-docs.ts generates.

import { assert, assertEquals } from "@std/assert";
import { COMMUNITY_ALIASES, type CommunityAlias } from "../src/react-native-compat/manifest.ts";
import { MOBILE_CAPABILITIES } from "../src/build/mobile-capabilities.ts";
import {
  communityPackagesTable,
  currentTable,
  DOCS_PAGE,
  tableCells,
} from "../scripts/gen-rn-community-docs.ts";

const COMPAT_DIR = new URL("../src/react-native-compat/", import.meta.url);

/** The entry's data: an exact pin, a status, docs, and real capabilities. */
function checkEntryData(pkg: string, alias: CommunityAlias): void {
  assert(/^\d+\.\d+\.\d+$/.test(alias.pinned), `${pkg}: pinned is an exact version`);
  assert(["full", "partial", "stub"].includes(alias.status), `${pkg}: status`);
  assert(alias.implementation.length > 0 && (alias.notes ?? "").length > 0, `${pkg}: docs`);
  for (const cap of alias.capabilities ?? []) {
    assert(Object.hasOwn(MOBILE_CAPABILITIES, cap), `${pkg}: ${cap} is a capability`);
  }
}

/** A runtime entry's module: it exports something, not what it omits, and its factory. */
async function checkRuntimeModule(pkg: string, alias: CommunityAlias): Promise<void> {
  const mod = await import(new URL(alias.module, COMPAT_DIR).href);
  assert(Object.keys(mod).length > 0, `${pkg}: ${alias.module} exports nothing`);
  const names = (alias.omitted ?? []).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  for (const name of names) {
    assert(!(name in mod), `${pkg}: "${name}" is listed as omitted but exported`);
  }
  if (alias.generated) {
    assertEquals(typeof mod[alias.generated.factory], "function", `${pkg}: its factory`);
  }
}

Deno.test("community manifest: every runtime entry's module exists, exports what it says", async () => {
  for (const [pkg, alias] of Object.entries(COMMUNITY_ALIASES)) {
    checkEntryData(pkg, alias);
    if (alias.kind === "runtime") await checkRuntimeModule(pkg, alias);
  }
});

Deno.test("community manifest: every stand-in module has an entry", async () => {
  const modules = new Set(Object.values(COMMUNITY_ALIASES).map((a) => a.module));
  for await (const entry of Deno.readDir(COMPAT_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts") || entry.name === "manifest.ts") continue;
    assert(modules.has(`./${entry.name}`), `src/react-native-compat/${entry.name} has no entry`);
  }
});

Deno.test("community manifest: /docs/react-native's table is generated from it", async () => {
  const page = await Deno.readTextFile(new URL(`../${DOCS_PAGE}`, import.meta.url));
  const current = currentTable(page);
  assert(current !== null, "the table's markers are in the page");
  assertEquals(
    tableCells(current),
    tableCells(communityPackagesTable()),
    "stale: run `deno run -A scripts/gen-rn-community-docs.ts`",
  );
});
