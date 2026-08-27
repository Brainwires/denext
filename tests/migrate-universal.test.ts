// `denext migrate` universal-repo behaviors (the PR-campaign contract):
//  - package-manager detection (pnpm/yarn/npm/bun) + Yarn PnP rejection
//  - App Router apps get a generated denext.config.ts (compat mode)
//  - unpinnable catalog:/workspace:* versions are skipped, not emitted as bogus npm: pins
//  - generated files carry the parity marker and are idempotent (re-run → identical)
//  - package.json is never modified

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";

/** Read a generated deno.json (has a leading `"//"` marker key, but is valid JSON). */
async function readDenoJson(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
}

async function tmp(prefix: string): Promise<string> {
  return await Deno.makeTempDir({ prefix: `denext_${prefix}_` });
}

Deno.test("App Router (pnpm): generates denext.config.ts, no bogus catalog pin, PM untouched", async () => {
  const dir = await tmp("mig_next_pnpm");
  try {
    const pkgSource = JSON.stringify({
      name: "app",
      dependencies: {
        react: "19.0.0",
        "react-dom": "19.0.0",
        clsx: "2.1.1",
        "@acme/ui": "catalog:", // unpinnable — must be skipped, not `npm:@acme/ui@catalog:`
        "@acme/shared": "workspace:*", // unpinnable — must be skipped
      },
    });
    await Deno.writeTextFile(join(dir, "package.json"), pkgSource);
    await Deno.writeTextFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await Deno.mkdir(join(dir, "app"), { recursive: true });

    const r = await migrateProject(dir);
    assertEquals(r.kind, "next");

    // A denext.config.ts is written for an App Router app (compat mode).
    const cfg = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assert(cfg.includes("compatibilityMode: true"), "compat mode");
    assert(cfg.includes("satisfies DenextConfig"), "typed config");

    const deno = await readDenoJson(dir);
    const imports = deno.imports as Record<string, string>;
    // A concrete-version dep is pinned; catalog:/workspace:* are NOT (no invalid pin).
    assertEquals(imports["clsx"], "npm:clsx@2.1.1");
    assert(!("@acme/ui" in imports), "catalog: dep is not pinned");
    assert(!("@acme/shared" in imports), "workspace:* dep is not pinned");
    assert(
      !Object.values(imports).some((v) => v.includes("catalog:") || v.includes("workspace:")),
      "no import value carries an unresolvable catalog:/workspace: string",
    );

    // package.json is never rewritten.
    assertEquals(await Deno.readTextFile(join(dir, "package.json")), pkgSource);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate is idempotent — a second run produces byte-identical generated files", async () => {
  const dir = await tmp("mig_idem");
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "19.0.0", clsx: "2.1.1" } }),
    );
    await Deno.writeTextFile(join(dir, "package-lock.json"), "{}\n");
    await Deno.mkdir(join(dir, "app"), { recursive: true });

    await migrateProject(dir);
    const deno1 = await Deno.readTextFile(join(dir, "deno.json"));
    const cfg1 = await Deno.readTextFile(join(dir, "denext.config.ts"));
    await migrateProject(dir);
    const deno2 = await Deno.readTextFile(join(dir, "deno.json"));
    const cfg2 = await Deno.readTextFile(join(dir, "denext.config.ts"));

    assertEquals(deno2, deno1, "deno.json stable across runs");
    assertEquals(cfg2, cfg1, "denext.config.ts stable across runs");
    // The generated deno.json stays valid strict JSON (marker is a `"//"` key).
    assert(String(JSON.parse(deno1)["//"]).includes("denext migrate"), "marker key present");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate does not clobber a hand-authored deno.json (no marker)", async () => {
  const dir = await tmp("mig_handauthored");
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "19.0.0" } }),
    );
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    // A hand-authored denext.config.ts (no marker) must be preserved verbatim.
    const hand = "export default { basePath: '/mine' };\n";
    await Deno.writeTextFile(join(dir, "denext.config.ts"), hand);

    await migrateProject(dir);
    assertEquals(await Deno.readTextFile(join(dir, "denext.config.ts")), hand);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("workspace app: monorepo-root tsconfig paths become deno.json aliases (relative to app)", async () => {
  const root = await tmp("mig_ws");
  try {
    // A yarn-workspace monorepo: paths live in the ROOT tsconfig (baseUrl "."), the app
    // has no tsconfig of its own — the exact shape excalidraw uses.
    await Deno.writeTextFile(join(root, "yarn.lock"), "");
    await Deno.writeTextFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@acme/common": ["./packages/common/src/index.ts"],
            "@acme/common/*": ["./packages/common/src/*"],
          },
        },
      }),
    );
    const app = join(root, "app");
    await Deno.mkdir(join(app, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(app, "index.html"),
      "<script type=module src=./src/main.tsx></script>",
    );
    await Deno.writeTextFile(
      join(app, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "19.0.0", "react-dom": "19.0.0" } }),
    );
    await Deno.writeTextFile(join(app, "vite.config.ts"), "export default {}");

    await migrateProject(app, { from: "vite" });
    const deno = await readDenoJson(app);
    const imports = deno.imports as Record<string, string>;
    // Root `./packages/common/src` is re-relativized to the app subdir (`../packages/...`).
    assertEquals(imports["@acme/common"], "../packages/common/src/index.ts");
    assertEquals(imports["@acme/common/"], "../packages/common/src/");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("App Router with MDX plugins: config recovers them at build time (no hand-edit)", async () => {
  const dir = await tmp("mig_mdx");
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "19.0.0", "@next/mdx": "15.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "package-lock.json"), "{}\n");
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    // A createMDX config with remark/recma plugin lists — createMDX buries these, so the
    // generated config recovers them live at build time via resolveNextMdx (no hand-edit).
    await Deno.writeTextFile(
      join(dir, "next.config.mjs"),
      `import createMDX from "@next/mdx";\n` +
        `import { remarkCodeHike, recmaCodeHike } from "codehike/mdx";\n` +
        `const chConfig = { theme: "github-dark" };\n` +
        `const withMDX = createMDX({ options: { remarkPlugins: [[remarkCodeHike, chConfig]],` +
        ` recmaPlugins: [[recmaCodeHike, chConfig]] } });\n` +
        `export default withMDX({ pageExtensions: ["ts", "tsx", "md", "mdx"] });\n`,
    );

    await migrateProject(dir);
    const cfg = await Deno.readTextFile(join(dir, "denext.config.ts"));
    // The generated config imports the recovery helper and wires the mdx field to it —
    // the author writes nothing by hand.
    assert(cfg.includes(`import { resolveNextMdx } from "denext/build/next-mdx"`), "helper import");
    assert(
      cfg.includes(`mdx: await resolveNextMdx(import.meta.url, "./next.config.mjs")`),
      "mdx field wired to build-time recovery",
    );
    assert(cfg.includes("compatibilityMode: true"), "still a valid compat config");

    // The recovery helper subpath is mapped in the generated deno.json so it resolves.
    const deno = await readDenoJson(dir);
    const imports = deno.imports as Record<string, string>;
    assert(
      imports["denext/build/next-mdx"]?.includes("build/next-mdx"),
      "denext/build/next-mdx import mapped",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Yarn PnP is rejected with a clear message", async () => {
  const dir = await tmp("mig_pnp");
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "19.0.0" } }),
    );
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    await Deno.writeTextFile(join(dir, ".pnp.cjs"), "// pnp\n");

    await assertRejects(() => migrateProject(dir), Error, "Plug'n'Play");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
