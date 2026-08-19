// Path-based useId scheme (src/jsx/tree-id.ts) — the shared primitive every
// renderer and the client fiber reconciler build ids from. Its determinism and
// position-encoding are what make useId() match across server render → hydration,
// PPR holes, and independently-hydrated islands, so the scheme itself is tested
// directly here.

import { assert, assertEquals } from "@std/assert";
import { enterScope, ID_PATH_PROP, nextId, rootScope, scopePrefix } from "../src/jsx/tree-id.ts";

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
  assertEquals(nextId(comp), ":d0_0:", "first useId in the component");
  assertEquals(nextId(comp), ":d0_1:", "second useId increments only the local index");
  // A sibling has its own slot and its own local counter.
  const sibling = enterScope(root);
  assertEquals(nextId(sibling), ":d1_0:");
});

Deno.test("nested components build a dotted position path", () => {
  const root = rootScope();
  const parent = enterScope(root); // slot 0
  const child = enterScope(parent); // 0.0
  const grandchild = enterScope(child); // 0.0.0
  assertEquals(scopePrefix(grandchild), "0.0.0");
  assertEquals(nextId(grandchild), ":d0.0.0_0:");
});

Deno.test("an island is seeded with its full tree path so ids match the in-place render", () => {
  // rootScope(prefix) seeds an independently-hydrated subtree at its known position.
  const island = rootScope("2.1");
  const comp = enterScope(island); // 2.1.0
  assertEquals(scopePrefix(comp), "2.1.0");
  assertEquals(
    nextId(comp),
    ":d2.1.0_0:",
    "the island's ids match the same subtree rendered in place",
  );
});

Deno.test("the '.' (child path) and '_' (local useId) namespaces stay disjoint", () => {
  const root = rootScope();
  const parent = enterScope(root); // prefix "0"
  const ownId = nextId(parent); // ":d0_0:"
  const child = enterScope(parent); // prefix "0.0"
  const childPrefix = scopePrefix(child);
  assert(ownId.includes("0_0"), "a component's own useId uses '_'");
  assertEquals(childPrefix, "0.0", "a child's path uses '.'");
  assert(ownId !== `:d${childPrefix}:`, "the two namespaces cannot collide");
});

Deno.test("scopePrefix is cached (stable across repeated reads)", () => {
  const root = rootScope();
  const comp = enterScope(root);
  assertEquals(scopePrefix(comp), scopePrefix(comp), "same scope → same prefix");
  assertEquals(ID_PATH_PROP, "__dnxIdPath", "the island id-path prop is stable");
});
