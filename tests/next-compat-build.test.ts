// The next-compat runtime prebuild: framework entrypoints must resolve from a REMOTE root
// (JSR) as well as a checkout — the run-from-JSR production case.

import { assert, assertEquals } from "@std/assert";
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

Deno.test("min-dep-age policy: env override > the app's own config > nothing", async () => {
  const { minDepAgeConfig, loaderConfigPath } = await import("../src/build/bundle.ts");
  assertEquals(minDepAgeConfig(undefined, undefined), {});
  assertEquals(minDepAgeConfig("P2D", undefined), { minimumDependencyAge: "P2D" });
  assertEquals(minDepAgeConfig("P2D", "0"), { minimumDependencyAge: "0" });
  // loaderConfigPath: with no policy the original path is returned untouched…
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_mda_" }));
  try {
    const cfg = `${dir}/deno.json`;
    await Deno.writeTextFile(
      cfg,
      JSON.stringify({ imports: { "denext": "./mod.ts", "x/": "./src/" } }),
    );
    const prev = Deno.env.get("DENEXT_MIN_DEP_AGE");
    try {
      Deno.env.delete("DENEXT_MIN_DEP_AGE");
      assertEquals(await loaderConfigPath(cfg, dir), cfg);
      // …with the env set, a temp copy carries the policy and absolutized relative imports.
      Deno.env.set("DENEXT_MIN_DEP_AGE", "0");
      const wrapped = await loaderConfigPath(cfg, dir);
      assert(wrapped !== cfg && wrapped.startsWith(dir));
      const json = JSON.parse(await Deno.readTextFile(wrapped));
      assertEquals(json.minimumDependencyAge, "0");
      assertEquals(json.imports["denext"], `file://${dir}/mod.ts`);
      assertEquals(json.imports["x/"], `file://${dir}/src/`);
      // A config that already declares a policy is handed over as-is (the user's choice wins).
      const own = `${dir}/own.json`;
      await Deno.writeTextFile(own, JSON.stringify({ minimumDependencyAge: "P1D", imports: {} }));
      assertEquals(await loaderConfigPath(own, dir), own);
    } finally {
      if (prev === undefined) Deno.env.delete("DENEXT_MIN_DEP_AGE");
      else Deno.env.set("DENEXT_MIN_DEP_AGE", prev);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
