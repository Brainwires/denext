// The next-compat runtime prebuild: framework entrypoints must resolve from a REMOTE root
// (JSR) as well as a checkout — the run-from-JSR production case.

import { assertEquals } from "@std/assert";
Deno.test("runtimeEntryPoints accepts a remote (JSR) framework root, not just file:// or a path", async () => {
  const { runtimeEntryPoints } = await import("../src/build/next-compat.ts");
  const jsr = runtimeEntryPoints("https://jsr.io/@denext/denext/2.0.0/");
  assertEquals(jsr["react"], "https://jsr.io/@denext/denext/2.0.0/src/compat/react.ts");
  const http = runtimeEntryPoints("http://127.0.0.1:5000/");
  assertEquals(http["jsx-runtime"], "http://127.0.0.1:5000/src/jsx/jsx-runtime.ts");
  const local = runtimeEntryPoints("/tmp/denext/");
  assertEquals(local["react"], "file:///tmp/denext/src/compat/react.ts");
});

Deno.test("resolveNodeFrom resolves a package SELF-reference through its exports (pnpm workspace member)", async () => {
  const { resolveNodeFrom } = await import("../src/build/next-compat.ts");
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_selfref_" }));
  try {
    // packages/lib is a workspace package; pnpm links it into CONSUMERS' node_modules, never
    // its own — a module inside it importing "@acme/lib/util" must still resolve.
    const lib = `${root}/packages/lib`;
    await Deno.mkdir(`${lib}/src/deep`, { recursive: true });
    await Deno.writeTextFile(
      `${lib}/package.json`,
      JSON.stringify({
        name: "@acme/lib",
        exports: { "./util": "./src/util.ts", ".": "./src/index.ts" },
      }),
    );
    await Deno.writeTextFile(`${lib}/src/util.ts`, "export const u = 1;");
    await Deno.writeTextFile(`${lib}/src/index.ts`, "export const i = 1;");
    assertEquals(await resolveNodeFrom(`${lib}/src/deep`, "@acme/lib/util"), `${lib}/src/util.ts`);
    assertEquals(await resolveNodeFrom(`${lib}/src/deep`, "@acme/lib"), `${lib}/src/index.ts`);
    // Not a self-reference: an unrelated name still resolves to nothing (deno-loader's turn).
    assertEquals(await resolveNodeFrom(`${lib}/src/deep`, "@acme/other"), null);
    // A dependency's tree is not "self" for the app: stop at the node_modules boundary.
    await Deno.mkdir(`${root}/node_modules/@acme/lib`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/node_modules/@acme/lib/package.json`,
      JSON.stringify({ name: "@acme/lib", exports: { "./util": "./u.js" } }),
    );
    await Deno.writeTextFile(`${root}/node_modules/@acme/lib/u.js`, "");
    assertEquals(
      await resolveNodeFrom(`${root}/app`, "@acme/lib/util"),
      `${root}/node_modules/@acme/lib/u.js`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
