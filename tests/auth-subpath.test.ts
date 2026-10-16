// `denext/auth` is the auth surface as its own entry point, and `denext/server` keeps
// re-exporting every one of its names — the same bindings, so either import works.

import { assert, assertStrictEquals } from "@std/assert";
import * as authEntry from "denext/auth";
import * as server from "denext/server";

Deno.test("denext/auth: the auth surface, re-exported unchanged by denext/server", () => {
  const names = Object.keys(authEntry);
  for (
    const name of ["auth", "denextAuth", "requireAuth", "requireSession", "github", "credentials"]
  ) {
    assert(names.includes(name), `denext/auth exports ${name}`);
  }
  for (const name of names) {
    assertStrictEquals(
      (server as Record<string, unknown>)[name],
      (authEntry as Record<string, unknown>)[name],
      `denext/server re-exports ${name}`,
    );
  }
});
