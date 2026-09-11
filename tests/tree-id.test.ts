// Path-based useId scheme (src/jsx/tree-id.ts) — the shared primitive every
// renderer and the client fiber reconciler build ids from. Its determinism and
// position-encoding are what make useId() match across server render → hydration,
// PPR holes, and independently-hydrated islands, so the scheme itself is tested
// directly here.

import { assert, assertEquals } from "@std/assert";
import {
  enterScope,
  ID_PATH_PROP,
  nextId,
  prefixFromId,
  rootScope,
  scopePrefix,
} from "../src/jsx/tree-id.ts";

Deno.test("a root's direct children get sequential slot prefixes 0,1,2", () => {
  const root = rootScope();
  const a = enterScope(root);
  const b = enterScope(root);
  const c = enterScope(root);
  assertEquals([scopePrefix(a), scopePrefix(b), scopePrefix(c)], ["0", "1", "2"]);
});

Deno.test("nextId encodes prefix + a per-component local index", () => {
  const root = rootScope();
  const comp = enterScope(root);
  assertEquals(nextId(comp), "_d0_0_", "first useId in the component");
  assertEquals(nextId(comp), "_d0_1_", "second useId increments only the local index");
  // A sibling has its own slot and its own local counter.
  const sibling = enterScope(root);
  assertEquals(nextId(sibling), "_d1_0_");
});

Deno.test("nested components build a hyphenated position path", () => {
  const root = rootScope();
  const parent = enterScope(root); // slot 0
  const child = enterScope(parent); // 0-0
  const grandchild = enterScope(child); // 0-0-0
  assertEquals(scopePrefix(grandchild), "0-0-0");
  assertEquals(nextId(grandchild), "_d0-0-0_0_");
});

Deno.test("an island is seeded with its full tree path so ids match the in-place render", () => {
  // rootScope(prefix) seeds an independently-hydrated subtree at its known position.
  const island = rootScope("2-1");
  const comp = enterScope(island); // 2-1-0
  assertEquals(scopePrefix(comp), "2-1-0");
  assertEquals(
    nextId(comp),
    "_d2-1-0_0_",
    "the island's ids match the same subtree rendered in place",
  );
});

Deno.test("the '-' (child path) and '_' (local useId) namespaces stay disjoint", () => {
  const root = rootScope();
  const parent = enterScope(root); // prefix "0"
  const ownId = nextId(parent); // "_d0_0_"
  const child = enterScope(parent); // prefix "0-0"
  const childPrefix = scopePrefix(child);
  assert(ownId.includes("0_0"), "a component's own useId uses '_'");
  assertEquals(childPrefix, "0-0", "a child's path uses '-'");
  assert(ownId !== `_d${childPrefix}_`, "the two namespaces cannot collide");
});

Deno.test("ids are CSS-selector-safe without CSS.escape (React 19.2's `_r_0_` character class)", () => {
  // A valid CSS identifier / XML 1.0 name / view-transition-name: a letter or `_` first,
  // then letters, digits, `_` or `-`. Libraries that do `querySelector("#" + id)` rely on it.
  const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
  const root = rootScope();
  const parent = enterScope(root);
  const child = enterScope(enterScope(parent));
  for (const id of [nextId(parent), nextId(parent), nextId(child)]) {
    assert(IDENT.test(id), `${id} is a plain CSS identifier`);
  }
  const seeded = enterScope(rootScope("app-3"));
  assert(IDENT.test(nextId(seeded)), "an identifierPrefix-seeded id stays selector-safe");
});

Deno.test("prefixFromId inverts nextId, including a seeded (identifierPrefix) root", () => {
  const plain = enterScope(enterScope(rootScope()));
  assertEquals(prefixFromId(nextId(plain)), scopePrefix(plain));
  const seeded = enterScope(rootScope("app"));
  assertEquals(prefixFromId(nextId(seeded)), "app-0");
  assertEquals(prefixFromId("not-an-id"), "", "unparseable input yields the empty prefix");
});

Deno.test("scopePrefix is cached (stable across repeated reads)", () => {
  const root = rootScope();
  const comp = enterScope(root);
  assertEquals(scopePrefix(comp), scopePrefix(comp), "same scope → same prefix");
  assertEquals(ID_PATH_PROP, "__dnxIdPath", "the island id-path prop is stable");
});
