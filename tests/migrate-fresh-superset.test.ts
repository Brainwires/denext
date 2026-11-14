// `denext migrate --from fresh` for what used to be left to the user: files that already exist
// (merged where that is safe), `main.ts`'s island registrations, the `fresh({ … })` options of a
// Vite config, Fresh plugins, other Vite plugins and `new App({ basePath })`. The reference is
// Fresh's own behaviour (packages/fresh and packages/plugin-vite at the 2.3.3 tag).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";
import { appendMissingLines, appendModule } from "../src/build/migrate-fresh.ts";
import {
  islandRegistrations,
  packageExportNames,
  resolveBare,
} from "../src/build/fresh-islands.ts";
import {
  literalValue,
  readFresh1Config,
  readFreshViteOptions,
} from "../src/build/fresh-config-read.ts";

type Tree = Record<string, string | Record<string, unknown>>;

const REPO = fromFileUrl(new URL("..", import.meta.url));

async function withTree<T>(files: Tree, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_fresh_superset_" }));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const path = join(dir, rel);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body));
    }
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const read = (dir: string, rel: string) => Deno.readTextFile(join(dir, rel));
const exists = (dir: string, rel: string) =>
  Deno.stat(join(dir, rel)).then(() => true, () => false);

/** The smallest Fresh 2 app. */
const BASE: Tree = {
  "deno.json": { imports: { fresh: "jsr:@fresh/core@^2.3.3", preact: "npm:preact@^10.27.2" } },
  "routes/index.tsx": "export default function Home() { return <p>home</p>; }\n",
};

Deno.test("appendMissingLines / appendModule: what can merge safely", () => {
  assertEquals(appendMissingLines("User-agent: *\n", "User-agent: *\n"), null);
  assertEquals(
    appendMissingLines("User-agent: *\nDisallow: /a\n", "User-agent: *\nDisallow: /b\n"),
    "User-agent: *\nDisallow: /a\n\nDisallow: /b\n",
  );
  assertEquals(
    appendModule('import "./a.ts";\nconst x = 1;\n', "document.title = 'y';\n"),
    "import \"./a.ts\";\nconst x = 1;\n\n// From client.ts (the Fresh app's Vite client entry):\ndocument.title = 'y';\n",
  );
  assertEquals(appendModule("const x = 1;\n", "const x = 2;\n"), null, "a clashing name");
  assertEquals(appendModule('import { y } from "./y.ts";\n', 'import y from "./z.ts";\n'), null);
  assertEquals(appendModule("same();\n", "same();\n"), "same();\n", "already there");
});

Deno.test("migrate: static/ files over existing public/ files — identical dropped, robots.txt merged, a real conflict kept", async () => {
  await withTree({
    ...BASE,
    "static/logo.svg": "<svg/>",
    "public/logo.svg": "<svg/>",
    "static/robots.txt": "User-agent: *\nDisallow: /admin\n",
    "public/robots.txt": "User-agent: *\nSitemap: /sitemap.xml\n",
    "static/styles.css": ".a { color: red; }\n",
    "public/styles.css": ".a { color: blue; }\n",
  }, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    const f = r.fresh!;
    assertEquals(await exists(dir, "static/logo.svg"), false, "an identical copy is dropped");
    assertEquals(
      await read(dir, "public/robots.txt"),
      "User-agent: *\nSitemap: /sitemap.xml\n\nDisallow: /admin\n",
    );
    assertEquals(await exists(dir, "static/robots.txt"), false);
    assert(f.review.some((x) => x.item === "static/robots.txt"));
    // The real conflict: left in static/, both kept, reported.
    assertEquals(await read(dir, "public/styles.css"), ".a { color: blue; }\n");
    assertEquals(await read(dir, "static/styles.css"), ".a { color: red; }\n");
    assertEquals(f.wontMigrate.filter((x) => x.item.startsWith("static/")).map((x) => x.item), [
      "static/styles.css",
    ]);
  });
});

Deno.test("migrate: client.ts's code appends to an existing instrumentation-client.ts unless a name clashes", async () => {
  await withTree({
    ...BASE,
    "vite.config.ts":
      'import { fresh } from "@fresh/plugin-vite";\nexport default { plugins: [fresh()] };\n',
    "client.ts": 'import "./assets/a.css";\nconsole.log("client");\n',
    "assets/a.css": ".a{}\n",
    "instrumentation-client.ts": 'console.log("mine");\n',
  }, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    const merged = await read(dir, "instrumentation-client.ts");
    assertStringIncludes(merged, 'console.log("mine");');
    assertStringIncludes(merged, 'console.log("client");');
    assertEquals(await exists(dir, "client.ts"), false);
    assert(!r.fresh!.wontMigrate.some((x) => x.item === "client.ts"));
  });
  await withTree({
    ...BASE,
    "vite.config.ts":
      'import { fresh } from "@fresh/plugin-vite";\nexport default { plugins: [fresh()] };\n',
    "client.ts": "const boot = 1;\nconsole.log(boot);\n",
    "instrumentation-client.ts": "const boot = 2;\n",
  }, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    assert(r.fresh!.wontMigrate.some((x) => x.item === "client.ts"));
    assertEquals(await read(dir, "instrumentation-client.ts"), "const boot = 2;\n");
  });
});

Deno.test("migrate: a generated file the user already wrote identically is not reported", async () => {
  await withTree(BASE, async (dir) => {
    await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    // The user takes over the page, keeping its content but dropping the generated header.
    const page = await read(dir, "app/page.tsx");
    await Deno.writeTextFile(
      join(dir, "app/page.tsx"),
      page.replace(/^\/\/ generated[^\n]*\n/, ""),
    );
    const again = await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    assertEquals(again.fresh!.wontMigrate.filter((x) => x.item === "app/page.tsx"), []);
    await Deno.writeTextFile(join(dir, "app/page.tsx"), "export default () => null;\n");
    const third = await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    assert(third.fresh!.wontMigrate.some((x) => x.item === "app/page.tsx"));
  });
});

Deno.test("migrate: fresh({ … }) options move the routes, islands, static dirs and entries; ignore skips files", async () => {
  await withTree({
    "deno.json": {
      imports: {
        fresh: "jsr:@fresh/core@^2.3.3",
        preact: "npm:preact@^10.27.2",
        "@acme/ui/": "./vendor/acme/",
      },
    },
    "vite.config.ts": `import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";
export default defineConfig({
  plugins: [fresh({
    serverEntry: "server.ts",
    clientEntry: "src/client.ts",
    routeDir: "./src/routes",
    islandsDir: "src/islands/",
    staticDir: ["static", "assets/public"],
    ignore: [/\\.draft\\.tsx$/],
    islandSpecifiers: ["@acme/ui/Badge.tsx"],
    checkImports: [() => undefined],
  })],
});
`,
    "server.ts": `import { App } from "fresh";\nexport const app = new App();\napp.fsRoutes();\n`,
    "src/client.ts": 'import "./styles.css";\n',
    "src/styles.css": ".x{}\n",
    "src/routes/index.tsx": "export default function Home() { return <p>home</p>; }\n",
    "src/routes/wip.draft.tsx": "export default function Wip() { return <p>wip</p>; }\n",
    "src/islands/Counter.tsx": "export default function Counter() { return <button>1</button>; }\n",
    "src/islands/Old.draft.tsx": "export default function Old() { return null; }\n",
    "vendor/acme/Badge.tsx": "export default function Badge() { return <b>badge</b>; }\n",
    "static/a.txt": "a\n",
    "static/same.txt": "first\n",
    "assets/public/b.txt": "b\n",
    "assets/public/same.txt": "second\n",
  }, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    const f = r.fresh!;
    assertEquals(f.pages, 1, "the draft route is ignored");
    assert(await exists(dir, "app/page.tsx"));
    assertStringIncludes(await read(dir, "app/page.tsx"), "../src/routes/index.tsx");
    assertStringIncludes(await read(dir, "middleware.ts"), 'import * as main from "./server.ts";');
    assertStringIncludes(await read(dir, "app/layout.tsx"), "../src/styles.css");
    assertEquals(await exists(dir, "src/client.ts"), false);
    assert((await read(dir, "src/islands/Counter.tsx")).startsWith('"use client";'));
    assert(!(await read(dir, "src/islands/Old.draft.tsx")).startsWith('"use client";'));
    // An islandSpecifiers module the import map maps into the project: marked in place.
    assert((await read(dir, "vendor/acme/Badge.tsx")).startsWith('"use client";'));
    assertEquals(f.islands, 2);
    // Both static dirs land in public/; the earlier one wins a shared path (as Fresh serves it).
    assertEquals(await read(dir, "public/a.txt"), "a\n");
    assertEquals(await read(dir, "public/b.txt"), "b\n");
    assertEquals(await read(dir, "public/same.txt"), "first\n");
    assert(f.review.some((x) => x.item === "assets/public/same.txt"));
    assert(f.review.some((x) => x.item === "fresh({ checkImports })"));
    assert(!f.review.some((x) => x.item.includes("fresh({ … })")));
  });
});

Deno.test("migrate: islands registered in code — app.island(), app.islands(), builder.registerIsland(), a package island", async () => {
  await withTree({
    "deno.json": {
      imports: {
        fresh: "jsr:@fresh/core@^2.3.3",
        preact: "npm:preact@^10.27.2",
        "@x/widgets": "jsr:@x/widgets@^1.2.0",
      },
    },
    "main.ts": `import { App } from "fresh";
import Counter from "./components/Counter.tsx";
import { Clock } from "@x/widgets/Clock.tsx";
export const app = new App();
app.island(import.meta.resolve("./components/Counter.tsx"), "default", Counter);
app.island("@x/widgets/Clock.tsx", "Clock", Clock);
app.islands(["./components/Menu.tsx", new URL("./components/Tabs.tsx", import.meta.url)]);
app.islands(computeSpecifier());
app.fsRoutes();
`,
    "dev.ts": `import { Builder } from "fresh/dev";
const builder = new Builder();
builder.registerIsland("components/Other.tsx");
await builder.listen(() => import("./main.ts"));
`,
    "routes/index.tsx": "export default function Home() { return <p>home</p>; }\n",
    "components/Counter.tsx": "export default function Counter() { return <button>1</button>; }\n",
    "components/Menu.tsx": "export default function Menu() { return <nav />; }\n",
    "components/Tabs.tsx": "export default function Tabs() { return <div />; }\n",
    "components/Other.tsx": "export default function Other() { return <i />; }\n",
    "components/Plain.tsx": "export default function Plain() { return <p />; }\n",
  }, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    const f = r.fresh!;
    for (const name of ["Counter", "Menu", "Tabs", "Other"]) {
      assert(
        (await read(dir, `components/${name}.tsx`)).startsWith('"use client";'),
        `${name} is an island now, in place`,
      );
    }
    assert(!(await read(dir, "components/Plain.tsx")).startsWith('"use client";'));
    assertEquals(f.islands, 4);
    // The package island: a "use client" re-export, and the import map points the app at it.
    const wrapper = await read(dir, "app/_fresh/islands/x-widgets-Clock-tsx.ts");
    assertStringIncludes(wrapper, '"use client";');
    assertStringIncludes(wrapper, 'export { Clock } from "jsr:@x/widgets@^1.2.0/Clock.tsx";');
    const deno = JSON.parse(await read(dir, "deno.json"));
    assertEquals(
      deno.imports["@x/widgets/Clock.tsx"],
      "./app/_fresh/islands/x-widgets-Clock-tsx.ts",
    );
    assertEquals(
      deno.imports["@x/widgets"],
      "jsr:@x/widgets@^1.2.0",
      "the package itself stays mapped",
    );
    // The computed specifier is reported, the rest is not.
    assertEquals(f.review.filter((x) => x.item.includes("computeSpecifier")).length, 1);
    assert(!f.wontMigrate.some((x) => /islands/.test(x.reason)));
  });
});

Deno.test("migrate: a Fresh 1.x fresh.config.ts's staticDir and router carry into denext.config.ts", async () => {
  await withTree({
    "deno.json": { imports: { "$fresh/": "https://deno.land/x/fresh@1.7.3/" } },
    "fresh.config.ts": `import { defineConfig } from "$fresh/server.ts";
export default defineConfig({ staticDir: "./assets", router: { basePath: "/app", trailingSlash: true } });
`,
    "routes/index.tsx": "export default function Home() { return <p>home</p>; }\n",
    "assets/logo.svg": "<svg/>",
  }, async (dir) => {
    await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    const config = await read(dir, "denext.config.ts");
    assertStringIncludes(config, 'basePath: "/app",');
    assertStringIncludes(config, "trailingSlash: true,");
    assertEquals(await read(dir, "public/logo.svg"), "<svg/>");
  });
});

Deno.test("fresh-config-read: literal options only; computed ones are named", () => {
  assertEquals(literalValue(`["a", 'b\\'c', /x+/g, true, 3]`), ["a", "b'c", /x+/g, true, 3]);
  assertEquals(literalValue('{ a: 1, b: ["x"] }'), { a: 1, b: ["x"] });
  assertEquals(literalValue("{ a: someVar }"), undefined);
  assertEquals(literalValue("`tpl ${x}`"), undefined);
  const v = readFreshViteOptions(`fresh({
    // a comment, then options
    routeDir: "src/routes", staticDir: "pub", islandsDir: dir, "ignore": [/a/, /b/],
  })`);
  assertEquals([v.routeDir, v.staticDir, v.ignore?.length, v.unread], ["src/routes", ["pub"], 2, [
    "islandsDir",
  ]]);
  assertEquals(readFreshViteOptions("fresh()").unread, []);
  const c = readFresh1Config(
    `export default { staticDir: "./s", router: { basePath: "/b", x: 1 }, render };`,
  );
  assertEquals([c.staticDir, c.basePath, c.unread], ["./s", "/b", ["router.x", "render"]]);
});

Deno.test("fresh-islands: registrations, import-map resolution and export names", async () => {
  const r = islandRegistrations(
    "main.ts",
    `
    app.island(new URL("./a.tsx", import.meta.url).href, "A", A);
    app.islands("./b.tsx", ["./c.tsx"]);
    builder.registerIsland(\`islands/d.tsx\`);
    app.island(spec, "E", E);
  `,
  );
  assertEquals(r.found.map((f) => [f.spec, f.relativeToFile, f.exportName]), [
    ["./a.tsx", true, "A"],
    ["./b.tsx", false, undefined],
    ["./c.tsx", false, undefined],
    ["islands/d.tsx", false, undefined],
  ]);
  assertEquals(r.unread, ["spec"]);
  const imports = { "@a/b": "jsr:@a/b@^1", "lib/": "./vendor/lib/", "@c/d": "./local.ts" };
  assertEquals(resolveBare("@a/b/X.tsx", imports), "jsr:@a/b@^1/X.tsx");
  assertEquals(resolveBare("lib/Y.tsx", imports), "./vendor/lib/Y.tsx");
  assertEquals(resolveBare("@c/d/Z.tsx", imports), null, "a file mapping has no subpaths");
  assertEquals(resolveBare("@a/b", imports), "jsr:@a/b@^1");
  await withTree({
    "deno.json": {},
    "mod.ts": "export function One() {}\nexport const two = 2;\nexport default function () {}\n",
  }, async (dir) => {
    assertEquals((await packageExportNames(dir, "./mod.ts"))?.sort(), ["One", "default", "two"]);
    assertEquals(await packageExportNames(dir, "./missing.ts"), null);
  });
});

Deno.test("migrate: a Fresh 1.x plugin's islands become client modules; a remote plugin is reviewed", async () => {
  await withTree({
    "deno.json": { imports: { "$fresh/": "https://deno.land/x/fresh@1.7.3/" } },
    "fresh.config.ts": `import { defineConfig } from "$fresh/server.ts";
import tailwind from "$fresh/plugins/tailwind.ts";
import twind from "$fresh/plugins/twind.ts";
import { chartPlugin } from "./plugins/chart/mod.ts";
import { seo } from "https://deno.land/x/fresh_seo@1.0.0/mod.ts";
export default defineConfig({ plugins: [tailwind(), twind(twindConfig), chartPlugin(), seo({ x: 1 })] });
`,
    "plugins/chart/mod.ts": `export function chartPlugin() {
  return { name: "chart", islands: { baseLocation: import.meta.url, paths: ["./islands/Chart.tsx"] } };
}
`,
    "plugins/chart/islands/Chart.tsx": "export default function Chart() { return <canvas />; }\n",
    "routes/index.tsx": "export default function Home() { return <p>home</p>; }\n",
  }, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    const f = r.fresh!;
    assert((await read(dir, "plugins/chart/islands/Chart.tsx")).startsWith('"use client";'));
    const config = await read(dir, "fresh.config.ts");
    assert(!config.includes("tailwind"), config);
    assertStringIncludes(config, "plugins: [twind(twindConfig), chartPlugin(), seo({ x: 1 })]");
    assertEquals(f.review.filter((x) => x.item.startsWith("fresh.config.ts:")).map((x) => x.item), [
      "fresh.config.ts: seo()",
    ]);
    assertEquals(f.wontMigrate.filter((x) => x.item.startsWith("fresh.config.ts")), []);
  });
});
