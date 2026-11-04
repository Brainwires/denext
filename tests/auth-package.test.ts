// Where @denext/auth sits beside the framework (src/build/auth-package.ts): the workspace member
// of a checkout, the same-version JSR sibling of a published denext. The compat build resolves
// `next-auth` and `denext/auth` through it, and `denext migrate` maps the `next-auth` subpaths
// it lists.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  authModuleUrl,
  authPackageExports,
  authPackageRootUrl,
  NEXT_AUTH_SUBPATHS,
  usesNextAuth,
} from "../src/build/auth-package.ts";

const ROOT = new URL("../", import.meta.url).href;

Deno.test("authPackageRootUrl: the JSR sibling at the same version, else packages/auth/", () => {
  assertEquals(
    authPackageRootUrl("https://jsr.io/@denext/denext/5.0.0/"),
    "https://jsr.io/@denext/auth/5.0.0/",
  );
  assertEquals(
    authPackageRootUrl("https://jsr.io/@denext/denext/5.0.0-rc.1"),
    "https://jsr.io/@denext/auth/5.0.0-rc.1/",
  );
  assertEquals(authPackageRootUrl("file:///repo/"), "file:///repo/packages/auth/");
  assertEquals(authPackageRootUrl(ROOT), `${ROOT}packages/auth/`);
});

Deno.test("NEXT_AUTH_SUBPATHS: exactly @denext/auth's next-auth exports, in order", async () => {
  const exports = await authPackageExports(ROOT);
  const fromPackage = Object.keys(exports).filter((k) => k !== ".").map((k) => k.slice(2));
  assertEquals([...NEXT_AUTH_SUBPATHS], fromPackage);
});

Deno.test("authModuleUrl: denext/auth and denext/next-auth[/…] name @denext/auth modules", async () => {
  const exports = await authPackageExports(ROOT);
  assertEquals(authModuleUrl("denext/auth", exports, ROOT), `${ROOT}packages/auth/mod.ts`);
  assertEquals(
    authModuleUrl("denext/next-auth", exports, ROOT),
    `${ROOT}packages/auth/next-auth/index.ts`,
  );
  assertEquals(
    authModuleUrl("denext/next-auth/providers/github", exports, ROOT),
    `${ROOT}packages/auth/next-auth/providers/github.ts`,
  );
  assertEquals(authModuleUrl("denext/server", exports, ROOT), undefined);
  assertEquals(authModuleUrl("denext/next-auth/nope", exports, ROOT), undefined);
  for (const url of [authModuleUrl("denext/next-auth/react", exports, ROOT)!]) {
    assert((await Deno.stat(new URL(url))).isFile, url);
  }
});

Deno.test("authPackageExports: an unreadable package names it and where it looked", async () => {
  const err = await assertRejects(() => authPackageExports("file:///no/such/denext/"), Error);
  assert(err.message.includes("@denext/auth's deno.json"), err.message);
});

Deno.test("usesNextAuth: the import map or package.json names next-auth", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_uses_next_auth_" });
  try {
    assertEquals(await usesNextAuth(dir), false);
    await Deno.writeTextFile(join(dir, "deno.json"), '{ "imports": { "next": "x" } }');
    assertEquals(await usesNextAuth(dir), false);
    await Deno.writeTextFile(join(dir, "package.json"), '{ "dependencies": { "next-auth": "5" } }');
    assertEquals(await usesNextAuth(dir), true);
    await Deno.remove(join(dir, "package.json"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      '{ "imports": { "next-auth/react": "jsr:@denext/auth@^5.0.0/next-auth/react" } }',
    );
    assertEquals(await usesNextAuth(dir), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
