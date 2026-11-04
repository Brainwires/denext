// From 5.0 the auth layer is its own package: `@denext/auth` exports `denextAuth()`, the
// providers, adapters and stores, while `denext/server` keeps the session readers and guards
// (`auth()`, `requireAuth()`, `requireSession()`), `getSession()` and the session types. No name
// is exported by both, and `denext/server` no longer carries the plugin's.

import { assert, assertEquals, assertFalse } from "@std/assert";
import * as authPackage from "../packages/auth/mod.ts";
import * as server from "../src/server/mod.ts";

Deno.test("@denext/auth: the plugin surface; denext/server keeps the readers and guards", () => {
  const names = Object.keys(authPackage);
  for (
    const name of ["denextAuth", "github", "credentials", "sqliteAuthAdapter", "requireBearer"]
  ) {
    assert(names.includes(name), `@denext/auth exports ${name}`);
    assertFalse(name in server, `denext/server no longer exports ${name}`);
  }
  for (const name of ["auth", "requireAuth", "requireSession", "getSession", "hashPassword"]) {
    assertEquals(typeof (server as Record<string, unknown>)[name], "function", name);
    assertFalse(names.includes(name), `@denext/auth does not re-export ${name}`);
  }
  for (const name of names) assertFalse(name in server, `${name} is exported by both`);
});
