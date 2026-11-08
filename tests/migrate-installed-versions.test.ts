// `denext migrate` pins each npm dependency at the version the project has installed (its
// node_modules, else its lockfile), not the floor of its package.json range, and keeps an existing
// node_modules as the one tree (`nodeModulesDir: "manual"`) when every pin is installed there. A
// floor pin under `"auto"` made Deno install a second, older tree into `node_modules/.deno`.

import { assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  installedVersion,
  nodeModulesDirFor,
  pinInstalledVersions,
} from "../src/build/migrate-installed-versions.ts";
import { migrateProject } from "../src/build/migrate.ts";

async function withTree(
  files: Record<string, unknown>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_installed_" }));
  try {
    for (const [rel, body] of Object.entries(files)) {
      await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
      await Deno.writeTextFile(
        join(dir, rel),
        typeof body === "string" ? body : JSON.stringify(body),
      );
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const pkg = (name: string, version: string) => ({ name, version });

Deno.test("installedVersion: node_modules, then package-lock.json, then pnpm-lock.yaml", async () => {
  await withTree({
    "node_modules/openai/package.json": pkg("openai", "6.48.0"),
    "node_modules/@scope/lib/package.json": pkg("@scope/lib", "2.1.3"),
    "package-lock.json": {
      lockfileVersion: 3,
      packages: { "node_modules/zod": { version: "3.25.76" }, "node_modules/openai": {} },
    },
  }, async (dir) => {
    assertEquals(await installedVersion(dir, "openai"), "6.48.0");
    assertEquals(await installedVersion(dir, "@scope/lib"), "2.1.3");
    assertEquals(await installedVersion(dir, "zod"), "3.25.76");
    assertEquals(await installedVersion(dir, "missing"), null);
  });
  await withTree({
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n" +
      "      openai:\n        specifier: ^6.42.0\n        version: 6.48.0(zod@3.25.76)\n" +
      "    devDependencies:\n      '@types/node':\n        specifier: ^22\n        version: 22.15.3\n" +
      "      local:\n        specifier: link:../local\n        version: link:../local\n",
  }, async (dir) => {
    assertEquals(await installedVersion(dir, "openai"), "6.48.0");
    assertEquals(await installedVersion(dir, "@types/node"), "22.15.3");
    assertEquals(await installedVersion(dir, "local"), null);
  });
});

Deno.test("pinInstalledVersions rewrites floor pins; nodeModulesDirFor needs every pin installed", async () => {
  await withTree({
    "node_modules/openai/package.json": pkg("openai", "6.48.0"),
    "node_modules/zod/package.json": pkg("zod", "3.25.76"),
  }, async (dir) => {
    const imports: Record<string, string> = {
      "denext": "jsr:@denext/denext@^4",
      "openai": "npm:openai@6.42.0",
      "zod": "npm:zod@3.25.0",
    };
    await pinInstalledVersions(dir, imports);
    assertEquals(imports.openai, "npm:openai@6.48.0");
    assertEquals(imports.zod, "npm:zod@3.25.76");
    assertEquals(await nodeModulesDirFor(dir, imports), "manual");
    // A pin node_modules lacks would not resolve under "manual".
    imports.other = "npm:other@1.0.0";
    assertEquals(await nodeModulesDirFor(dir, imports), "auto");
  });
  await withTree({ "package.json": "{}" }, async (dir) => {
    assertEquals(await nodeModulesDirFor(dir, { x: "jsr:@std/path@1" }), "auto");
  });
});

Deno.test("migrate: an App Router app pins installed versions and keeps its node_modules", async () => {
  await withTree({
    "package.json": {
      name: "pins",
      dependencies: { next: "15.3.0", react: "19.1.0", openai: "^6.42.0" },
    },
    "node_modules/openai/package.json": pkg("openai", "6.48.0"),
    "app/layout.tsx": "export default function L({ children }) { return children; }\n",
    "app/page.tsx": "export default function P() { return null; }\n",
  }, async (dir) => {
    await migrateProject(dir, {});
    const denoJson = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertEquals(denoJson.imports.openai, "npm:openai@6.48.0");
    assertEquals(denoJson.nodeModulesDir, "manual");
  });
  // No node_modules (a fresh clone): the lockfile's version, and Deno installs the tree.
  await withTree({
    "package.json": { name: "pins", dependencies: { next: "15.3.0", openai: "^6.42.0" } },
    "package-lock.json": {
      lockfileVersion: 3,
      packages: { "node_modules/openai": { version: "6.48.0" } },
    },
    "app/page.tsx": "export default function P() { return null; }\n",
  }, async (dir) => {
    await migrateProject(dir, {});
    const denoJson = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertEquals(denoJson.imports.openai, "npm:openai@6.48.0");
    assertEquals(denoJson.nodeModulesDir, "auto");
  });
});
