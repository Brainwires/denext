// Drift guard for the react-family specifier tables. Several build flows map the
// react/react-dom/react-is family to denext with different target shapes; they must
// stay agreed on the *set* of specifiers. If you add a react subpath to one table,
// add it to `src/build/react-specifiers.ts` and these assertions keep the rest honest.

import { assertEquals } from "@std/assert";
import {
  REACT_FAMILY_CORE,
  REACT_FAMILY_SPECIFIERS,
  reactCompatImportMap,
} from "../src/build/react-specifiers.ts";
import { REACT_ALIASES } from "../src/build/next-compat.ts";
import { SPEC_REWRITE } from "../src/build/codemod.ts";

const isReactFamily = (s: string) =>
  s === "react" || s.startsWith("react-") || s.startsWith("react/");
const reactKeys = (m: Record<string, string>) => Object.keys(m).filter(isReactFamily).sort();

Deno.test("next-compat REACT_ALIASES covers exactly the full react-family set", () => {
  assertEquals(reactKeys(REACT_ALIASES), [...REACT_FAMILY_SPECIFIERS].sort());
});

Deno.test("codemod SPEC_REWRITE covers exactly the core react-family set", () => {
  assertEquals(reactKeys(SPEC_REWRITE), [...REACT_FAMILY_CORE].sort());
});

Deno.test("scaffold react import map is derived from the canonical list", () => {
  assertEquals(Object.keys(reactCompatImportMap("dep")), [...REACT_FAMILY_SPECIFIERS]);
});

Deno.test("core is a subset of the full react-family set", () => {
  const full = new Set<string>(REACT_FAMILY_SPECIFIERS);
  for (const s of REACT_FAMILY_CORE) assertEquals(full.has(s), true, s);
});
