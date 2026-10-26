// `denext migrate` generates a compat `deno.json` for a dropped-in Next app.
// These lock in the two things that make `deno check` clean on such an app:
// `skipLibCheck` (skip npm libs' bundled .d.ts) + aliasing react → denext.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { migrateProject } from "../packages/migrate/src/migrate.ts";

Deno.test("migrate writes a compat deno.json (skipLibCheck + react→denext aliases)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_migrate_" });
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "app",
        dependencies: { react: "^18", "react-dom": "^18", "lucide-react": "^0.4" },
      }),
    );
    await migrateProject(dir);
    const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));

    // skipLibCheck makes `deno check` validate the app's code, not npm .d.ts noise.
    assertEquals(cfg.compilerOptions.skipLibCheck, true);
    assertEquals(cfg.compilerOptions.jsxImportSource, "react");
    assertEquals(cfg.compilerOptions.strict, true);
    // react/react-dom are aliased to denext so the whole app runs on one React.
    assert(String(cfg.imports["react"]).includes("@denext/denext"), "react → denext");
    assert(String(cfg.imports["react-dom"]).includes("@denext/denext"), "react-dom → denext");
    assert(
      String(cfg.imports["react/jsx-runtime"]).includes("@denext/denext"),
      "jsx-runtime → denext",
    );
    // React-Compiler-precompiled npm libraries import `c` from here.
    assert(
      String(cfg.imports["react/compiler-runtime"]).endsWith("/react/compiler-runtime"),
      "compiler-runtime → denext",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate wires the pages-router plugin for a pages/ app", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_migrate_pages_" });
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "^18", next: "^15" } }),
    );
    await Deno.mkdir(join(dir, "pages"), { recursive: true });

    const r = await migrateProject(dir);
    assertEquals(r.pagesRouter, true);
    assertEquals(r.pagesConfigWritten, true);

    // deno.json maps the plugin specifier (+ its subpath prefix).
    const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assert(String(cfg.imports["@denext/pages-router"]).includes("@denext/pages-router"));
    assert("@denext/pages-router/" in cfg.imports, "subpath prefix mapped");

    // denext.config.ts registers the plugin.
    const config = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assert(config.includes("pagesRouter"), "config registers pagesRouter()");
    assert(config.includes("@denext/pages-router"), "config imports the plugin");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** The least-privilege `start` flags `denext create` writes. */
const LEAST_PRIVILEGE_START =
  "deno run --node-modules-dir=none --allow-net --allow-read --allow-env --allow-write=.denext ";

/** Migrate a Next app with `deps` (and the `extra` dirs/files) and read its deno.json tasks. */
async function migratedTasks(
  deps: Record<string, string>,
  extra: { dirs?: string[]; files?: Record<string, string> } = {},
): Promise<Record<string, string>> {
  const dir = await Deno.makeTempDir({ prefix: "denext_migrate_start_" });
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: deps }),
    );
    for (const d of ["app", ...(extra.dirs ?? [])]) {
      await Deno.mkdir(join(dir, d), { recursive: true });
    }
    for (const [rel, text] of Object.entries(extra.files ?? {})) {
      await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), text);
    }
    await migrateProject(dir);
    return JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))).tasks;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const NEXT_DEPS = { next: "^15", react: "^19", "react-dom": "^19" };

Deno.test("migrate: a Next.js App Router app's start task is least-privilege", async () => {
  // Up to 4.6.0 it was `-A`: start re-ran itself under the CSS import map, which takes an
  // unscoped --allow-run. The next-compat server bundle now carries the stylesheet shims.
  const tasks = await migratedTasks(NEXT_DEPS);
  assert(tasks.start.startsWith(LEAST_PRIVILEGE_START), tasks.start);
  assert(!/\s-A\s|--allow-run|--allow-all/.test(tasks.start), tasks.start);
  // Its server runs npm code: the read-only system information Node's `os` reads, scoped.
  assert(
    tasks.start.includes(
      " --allow-sys=hostname,osRelease,osUptime,loadavg,cpus,systemMemoryInfo,homedir,uid,gid," +
        "username ",
    ),
    tasks.start,
  );
  // The build verbs still need every permission (they spawn esbuild, Tailwind and the toolchain).
  for (const t of ["dev", "build", "export"]) {
    assert(tasks[t].startsWith("deno run -A --node-modules-dir=none "), tasks[t]);
  }
});

Deno.test("migrate: a Pages Router or Prisma app's start task keeps -A", async () => {
  // A Pages Router build's server render still resolves stylesheets through the CSS import map.
  const pages = await migratedTasks(NEXT_DEPS, { dirs: ["pages"] });
  assert(pages.start.startsWith("deno run -A --node-modules-dir=none "), pages.start);
  // Prisma's database lives outside .denext.
  const prisma = await migratedTasks({ ...NEXT_DEPS, "@prisma/client": "^6" }, {
    files: {
      "prisma/schema.prisma":
        'datasource db {\n  provider = "sqlite"\n  url = env("DATABASE_URL")\n}\n',
    },
  });
  assert(prisma.start.startsWith("deno run -A --node-modules-dir=none "), prisma.start);
});

Deno.test("migrate does not clobber an existing denext.config.ts", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_migrate_pages_cfg_" });
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "^18" } }),
    );
    await Deno.mkdir(join(dir, "pages"), { recursive: true });
    await Deno.writeTextFile(join(dir, "denext.config.ts"), "export default {};\n");

    const r = await migrateProject(dir);
    assertEquals(r.pagesConfigWritten, false);
    assertEquals(r.pagesConfigExists, true);
    // The existing config is left untouched.
    assertEquals(await Deno.readTextFile(join(dir, "denext.config.ts")), "export default {};\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate wires the @denext/effect bridge for an App Router app using effect", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_migrate_effect_" });
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "app",
        dependencies: { react: "^18", next: "^15", effect: "^3.22.0" },
      }),
    );
    await Deno.mkdir(join(dir, "app"), { recursive: true });

    const r = await migrateProject(dir);
    assertEquals(r.effect, true);

    // deno.json maps the bridge specifier; `effect` itself still passes through as npm.
    const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assert(String(cfg.imports["@denext/effect"]).includes("@denext/effect"), "bridge mapped");
    assert(String(cfg.imports["effect"]).startsWith("npm:effect@"), "effect stays npm passthrough");
    assert(r.passthrough.includes("effect"), "effect reported as passthrough");

    // denext.config.ts imports and registers the effect() plugin.
    const config = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assert(config.includes('from "@denext/effect"'), "config imports the bridge");
    assert(config.includes("plugins: [effect()]"), "config registers effect()");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate registers effect() alongside pagesRouter() for a pages/ app using effect", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_migrate_effect_pages_" });
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "app",
        dependencies: { react: "^18", next: "^15", effect: "^3.22.0" },
      }),
    );
    await Deno.mkdir(join(dir, "pages"), { recursive: true });

    const r = await migrateProject(dir);
    assertEquals(r.pagesRouter, true);
    assertEquals(r.effect, true);

    const config = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assert(config.includes("pagesRouter()"), "keeps pagesRouter()");
    assert(config.includes("effect()"), "adds effect()");
    assert(config.includes('from "@denext/effect"'), "imports the bridge");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate leaves effect unwired when the app does not depend on it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_migrate_noeffect_" });
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "^18", next: "^15" } }),
    );
    await Deno.mkdir(join(dir, "app"), { recursive: true });

    const r = await migrateProject(dir);
    assertEquals(r.effect, false);
    const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assert(!("@denext/effect" in cfg.imports), "no bridge entry without the dep");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
