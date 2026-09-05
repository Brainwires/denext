// `denext migrate` universal-repo behaviors (the PR-campaign contract):
//  - package-manager detection (pnpm/yarn/npm/bun) + Yarn PnP rejection
//  - App Router apps get a generated denext.config.ts (compat mode)
//  - unpinnable catalog:/workspace:* versions are skipped, not emitted as bogus npm: pins
//  - generated files carry the parity marker and are idempotent (re-run → identical)
//  - package.json is never modified

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
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
    await Deno.writeTextFile(
      join(dir, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
    );
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

Deno.test("next.config drop-keys carry per-key guidance, not a lumped drop", async () => {
  const dir = await tmp("mig_dropkeys");
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "19.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "package-lock.json"), "{}\n");
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    // A next.config with load-bearing drop keys (env/transpilePackages/output) plus
    // an honored passthrough (basePath) and a genuinely-inert key (webpack).
    await Deno.writeTextFile(
      join(dir, "next.config.ts"),
      `export default {\n` +
        `  basePath: "/app",\n` +
        `  env: { API_URL: "https://x.test" },\n` +
        `  transpilePackages: ["@acme/ui"],\n` +
        `  output: "export",\n` +
        `  webpack: (c) => c,\n` +
        `};\n`,
    );

    await migrateProject(dir);
    const cfg = await Deno.readTextFile(join(dir, "denext.config.ts"));
    // The honored key is copied through as a literal.
    assertStringIncludes(cfg, `basePath: "/app"`);
    // Each load-bearing drop key gets its own guidance line pointing at the equivalent.
    assertStringIncludes(cfg, "// env:");
    assertStringIncludes(cfg, "publicEnv");
    assertStringIncludes(cfg, "// transpilePackages:");
    assertStringIncludes(cfg, "// output:");
    assertStringIncludes(cfg, "deno task export");
    // The inert key is grouped on the no-equivalent-needed line, not given fake advice.
    assertStringIncludes(cfg, "Dropped (no denext equivalent needed):");
    assertStringIncludes(cfg, "webpack");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate is idempotent — a second run produces byte-identical generated files", async () => {
  const dir = await tmp("mig_idem");
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "app",
        dependencies: { react: "19.0.0", clsx: "2.1.1" },
      }),
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
    assert(
      String(JSON.parse(deno1)["//"]).includes("denext migrate"),
      "marker key present",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate enables the Deno LSP for editors (.vscode) — merged, not clobbered", async () => {
  const dir = await tmp("mig_vscode");
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "19.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "package-lock.json"), "{}\n");
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    // A pre-existing .vscode with unrelated settings + a recommendation: migrate must add
    // its keys without dropping the user's.
    await Deno.mkdir(join(dir, ".vscode"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, ".vscode", "settings.json"),
      JSON.stringify({ "editor.tabSize": 2 }, null, 2) + "\n",
    );
    await Deno.writeTextFile(
      join(dir, ".vscode", "extensions.json"),
      JSON.stringify({ recommendations: ["esbenp.prettier-vscode"] }, null, 2) + "\n",
    );

    await migrateProject(dir);

    const settings = JSON.parse(
      await Deno.readTextFile(join(dir, ".vscode", "settings.json")),
    );
    assertEquals(settings["deno.enable"], true, "Deno LSP enabled");
    assertEquals(settings["editor.tabSize"], 2, "existing setting preserved");

    const ext = JSON.parse(
      await Deno.readTextFile(join(dir, ".vscode", "extensions.json")),
    );
    assertEquals(
      ext.recommendations,
      ["esbenp.prettier-vscode", "denoland.vscode-deno"],
      "Deno extension appended, existing recommendation kept",
    );

    // Idempotent: a second run (values already present) leaves the files byte-identical.
    const s1 = await Deno.readTextFile(join(dir, ".vscode", "settings.json"));
    const e1 = await Deno.readTextFile(join(dir, ".vscode", "extensions.json"));
    await migrateProject(dir);
    assertEquals(await Deno.readTextFile(join(dir, ".vscode", "settings.json")), s1);
    assertEquals(await Deno.readTextFile(join(dir, ".vscode", "extensions.json")), e1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate creates .vscode from scratch when absent", async () => {
  const dir = await tmp("mig_vscode_fresh");
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "19.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "package-lock.json"), "{}\n");
    await Deno.mkdir(join(dir, "app"), { recursive: true });

    await migrateProject(dir);

    const settings = JSON.parse(
      await Deno.readTextFile(join(dir, ".vscode", "settings.json")),
    );
    assertEquals(settings["deno.enable"], true);
    const ext = JSON.parse(
      await Deno.readTextFile(join(dir, ".vscode", "extensions.json")),
    );
    assertEquals(ext.recommendations, ["denoland.vscode-deno"]);
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
    // A hand-authored denext.config.ts AND a hand-authored deno.json (neither carrying the
    // migrate sentinel) must both be preserved verbatim — migrate never clobbers user config.
    const handCfg = "export default { basePath: '/mine' };\n";
    const handDeno = JSON.stringify({ tasks: { dev: "echo mine" } }, null, 2) +
      "\n";
    await Deno.writeTextFile(join(dir, "denext.config.ts"), handCfg);
    await Deno.writeTextFile(join(dir, "deno.json"), handDeno);

    await migrateProject(dir);
    assertEquals(
      await Deno.readTextFile(join(dir, "denext.config.ts")),
      handCfg,
    );
    assertEquals(
      await Deno.readTextFile(join(dir, "deno.json")),
      handDeno,
      "hand-authored deno.json is left untouched",
    );
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
      JSON.stringify({
        name: "app",
        dependencies: { react: "19.0.0", "react-dom": "19.0.0" },
      }),
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
      JSON.stringify({
        name: "app",
        dependencies: { react: "19.0.0", "@next/mdx": "15.0.0" },
      }),
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
    assert(
      cfg.includes(`import { resolveNextMdx } from "denext/build/next-mdx"`),
      "helper import",
    );
    assert(
      cfg.includes(
        `mdx: await resolveNextMdx(import.meta.url, "./next.config.mjs")`,
      ),
      "mdx field wired to build-time recovery",
    );
    assert(
      cfg.includes("compatibilityMode: true"),
      "still a valid compat config",
    );

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

Deno.test("App Router: server-only/client-only and mdx/types alias to denext no-ops", async () => {
  const dir = await tmp("mig_noops");
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "app",
        dependencies: {
          react: "19.0.0",
          "server-only": "0.0.1",
          "client-only": "0.0.1",
        },
        devDependencies: { "@types/mdx": "2.0.13" },
      }),
    );
    await Deno.writeTextFile(join(dir, "package-lock.json"), "{}\n");
    await Deno.mkdir(join(dir, "app"), { recursive: true });

    await migrateProject(dir);
    const imports = (await readDenoJson(dir)).imports as Record<string, string>;
    // Poison packages point at denext's no-op shims, NOT the throwing npm packages.
    assert(
      imports["server-only"]?.includes("/server-only"),
      "server-only → denext no-op",
    );
    assert(
      imports["client-only"]?.includes("/client-only"),
      "client-only → denext no-op",
    );
    assert(
      !imports["server-only"]?.startsWith("npm:"),
      "server-only is not npm-pinned (would resurface the throwing package)",
    );
    // @types/mdx present → the type-only `mdx/types` module aliases to empty.
    assert(
      imports["mdx/types"]?.includes("/empty"),
      "mdx/types → denext empty module",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("App Router: `@/*` alias survives a tsconfig carrying a `$schema` URL (JSONC parse)", async () => {
  const dir = await tmp("mig_schema_url");
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "19.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "package-lock.json"), "{}\n");
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    // The official Next.js example tsconfigs carry a `$schema` URL and // comments.
    // A naive `//`-comment stripper corrupts the `https://` inside the URL, making the
    // file unparseable → every `paths` alias silently drops. A real JSONC parser must
    // keep `//` inside strings, so `@/*` → `./` still lands in the import map.
    await Deno.writeTextFile(
      join(dir, "tsconfig.json"),
      `{\n` +
        `  "$schema": "https://json.schemastore.org/tsconfig",\n` +
        `  "compilerOptions": {\n` +
        `    // path aliases\n` +
        `    "baseUrl": ".",\n` +
        `    "paths": { "@/*": ["./*"] }\n` +
        `  }\n` +
        `}\n`,
    );

    await migrateProject(dir);
    const imports = (await readDenoJson(dir)).imports as Record<string, string>;
    assertEquals(
      imports["@/"],
      "./",
      "`@/` alias resolved despite the $schema URL + comment",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Pages Router: maps next/router|link|head to the pages-router plugin + pins ^0.8.0", async () => {
  const dir = await tmp("mig_pages");
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "app",
        dependencies: { react: "19.0.0", next: "15.0.0" },
      }),
    );
    await Deno.writeTextFile(join(dir, "package-lock.json"), "{}\n");
    // A `pages/` tree (no `app/`) → Pages Router.
    await Deno.mkdir(join(dir, "pages"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "pages", "index.tsx"),
      "export default () => null;\n",
    );

    const r = await migrateProject(dir);
    assertEquals(r.kind, "next");
    assert(r.pagesRouter, "detected as Pages Router");

    const imports = (await readDenoJson(dir)).imports as Record<string, string>;
    // The plugin is pinned at the range the current workspace package satisfies (see the
    // PAGES_ROUTER_SPEC test below) — never an older 0.x line that predates rc.7's barrel.
    assert(
      imports["@denext/pages-router"]?.includes("pages-router@^0.9.1"),
      "pages-router pinned ^0.9.1",
    );
    // next/router|link|head resolve to the plugin (Pages Router APIs live there), so an
    // UNMODIFIED app resolves them with no codemod.
    assert(
      imports["next/router"]?.includes("pages-router@^0.9.1/router"),
      "next/router → plugin",
    );
    assert(
      imports["next/link"]?.includes("pages-router@^0.9.1/link"),
      "next/link → plugin",
    );
    assert(
      imports["next/head"]?.includes("pages-router@^0.9.1/head"),
      "next/head → plugin",
    );

    // A denext.config.ts registering the plugin was generated.
    const cfg = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assert(cfg.includes("pagesRouter()"), "config registers pagesRouter()");
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

Deno.test("migrate --denext-local-path points the config at a local checkout (file://)", async () => {
  const dir = await tmp("mig_localpath");
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "19.0.0", next: "15.0.0" } }),
    );
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    // Point at THIS repo's checkout (two levels up from tests/).
    const local = fromFileUrl(new URL("../", import.meta.url)).replace(/\/$/, "");
    await migrateProject(dir, { denextLocalPath: local });

    const deno = await readDenoJson(dir);
    const imports = deno.imports as Record<string, string>;
    const tasks = deno.tasks as Record<string, string>;
    // denext + react map to file:// under the local checkout — no jsr: pins.
    assert(imports["denext"]?.startsWith("file://"), "denext -> file://");
    assert(imports["react"]?.startsWith("file://"), "react -> file://");
    assert(
      !Object.values(imports).some((v) => v.startsWith("jsr:@denext/denext")),
      "no jsr:@denext/denext pins when a local path is given",
    );
    // A file:// denext is not a self-contained package, so its OWN deps (`@std/*`) must be
    // carried in the app config — else `deno desktop` can't resolve them at runtime.
    assert(
      imports["@std/path"]?.startsWith("jsr:@std/path"),
      "local-path config carries denext's framework deps (@std/path)",
    );
    // Tasks run the local cli.ts, not the published CLI.
    assert(
      tasks["build"]?.includes("file://") && tasks["build"]?.endsWith("cli.ts build ."),
      tasks["build"],
    );
    assert(!tasks["build"]?.includes("jsr:@denext/denext/cli"), "build task uses the local cli");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
