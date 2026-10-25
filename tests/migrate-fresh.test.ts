// `denext migrate --from fresh`: detection (Fresh 2 and 1.x), Fresh's route conventions mapped
// onto `app/`, the generated files, the merged `deno.json`, and the `migrate --check` report,
// checked against golden reports (`DENEXT_UPDATE_GOLDEN=1` rewrites them).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";
import { checkMigration } from "../src/build/migrate-check.ts";
import {
  detectFresh,
  freshDenoJson,
  freshHandlerMethods,
  freshMatchOrder,
} from "../src/build/migrate-fresh.ts";
import { appFolder, freshPattern, internalFolder } from "../src/build/fresh-codegen.ts";

type Tree = Record<string, string | Record<string, unknown>>;

const REPO = fromFileUrl(new URL("..", import.meta.url));
const GOLDEN = (name: string) =>
  fromFileUrl(new URL(`./fixtures/migrate-fresh/${name}.check.json`, import.meta.url));

async function writeTree(root: string, files: Tree): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
}

async function withTree<T>(files: Tree, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_migrate_fresh_" }));
  try {
    await writeTree(dir, files);
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const read = (dir: string, rel: string) => Deno.readTextFile(join(dir, rel));
const exists = (dir: string, rel: string) =>
  Deno.stat(join(dir, rel)).then(() => true, () => false);

/** A Fresh 2 app on Vite with Tailwind (`@fresh/init --tailwind`), plus the conventions it lacks. */
const FRESH2: Tree = {
  "deno.json": {
    nodeModulesDir: "manual",
    tasks: {
      check: "deno fmt --check . && deno lint . && deno check",
      dev: "vite",
      build: "vite build",
      start: "deno serve -A _fresh/server.js",
      update: "deno run -A -r jsr:@fresh/update .",
    },
    lint: { rules: { tags: ["fresh", "recommended"] } },
    exclude: ["**/_fresh/*"],
    imports: {
      "@/": "./",
      "fresh": "jsr:@fresh/core@^2.3.3",
      "preact": "npm:preact@^10.29.1",
      "@preact/signals": "npm:@preact/signals@^2.9.0",
      "@fresh/plugin-vite": "jsr:@fresh/plugin-vite@^1.1.2",
      "vite": "npm:vite@^7.1.3",
      "@types/babel__core": "npm:@types/babel__core@^7.20.5",
      "tailwindcss": "npm:tailwindcss@^4.1.10",
      "@tailwindcss/vite": "npm:@tailwindcss/vite@^4.1.12",
    },
    compilerOptions: {
      lib: ["dom", "dom.asynciterable", "dom.iterable", "deno.ns"],
      jsx: "precompile",
      jsxImportSource: "preact",
      jsxPrecompileSkipElements: ["a", "img"],
      types: ["vite/client"],
    },
  },
  "vite.config.ts": `import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";
import tailwindcss from "@tailwindcss/vite";
import inspect from "vite-plugin-inspect";

export default defineConfig({
  plugins: [fresh(), tailwindcss(), inspect()],
});
`,
  "client.ts": `// Import CSS files here for hot module reloading to work.
import "./assets/styles.css";
import "./assets/extra.css";

document.addEventListener("click", () => {});
`,
  "assets/styles.css": `@import "tailwindcss";\n`,
  "assets/extra.css": `.x { color: red; }\n`,
  "main.ts": `import { App, staticFiles } from "fresh";
export const app = new App();
app.use(staticFiles());
app.get("/api2/:name", (ctx) => new Response(ctx.params.name));
app.notFound(() => new Response("nothing", { status: 404 }));
app.fsRoutes();
`,
  "utils.ts": `import { createDefine } from "fresh";
export const define = createDefine<{ shared: string }>();
`,
  "routes/_app.tsx": `import { define } from "../utils.ts";
export default define.page(function App({ Component }) {
  return <html><head><title>x</title></head><body><Component /></body></html>;
});
`,
  "routes/_error.tsx": `export default function ErrorPage() { return <p>error</p>; }\n`,
  "routes/_middleware.ts": `import { define } from "../utils.ts";
export default define.middleware((ctx) => { ctx.state.shared = "hi"; return ctx.next(); });
`,
  "routes/index.tsx": `import { useSignal } from "@preact/signals";
import { Head, Partial } from "fresh/runtime";
import Counter from "../islands/Counter.tsx";
export default function Home() {
  const count = useSignal(3);
  return <div f-client-nav><Head><title>Home</title></Head><Partial name="main"><Counter count={count} /></Partial></div>;
}
`,
  "routes/api/[name].tsx": `import { define } from "../../utils.ts";
export const handler = define.handlers({
  GET(ctx) { return new Response(ctx.params.name); },
  async POST(ctx) { return Response.json(await ctx.req.json()); },
});
`,
  "routes/raw.ts": `export const config = { routeOverride: "/@:version/:path*" };
export const handler = (ctx) => new Response(ctx.params.version);
`,
  "routes/(marketing)/_layout.tsx":
    `export default function L({ Component }) { return <main><Component /></main>; }\n`,
  "routes/(marketing)/about.tsx": `export default function About() { return <p>about</p>; }\n`,
  "routes/(marketing)/(_islands)/Wave.tsx": `export default function Wave() { return <i />; }\n`,
  "routes/blog/[slug].tsx": `import { page } from "fresh";
export const handler = { GET(ctx) { return page({ slug: ctx.params.slug }); } };
export default function Post({ data }) { return <p>{data.slug}</p>; }
`,
  "routes/blog/_error.tsx": `export default function BlogError() { return <p>blog error</p>; }\n`,
  "routes/docs/[...rest].tsx": `export default function Docs() { return <p>docs</p>; }\n`,
  "routes/lang/[[lang]].tsx": `export default function Lang() { return <p>lang</p>; }\n`,
  "routes/index_test.ts": `Deno.test("x", () => {});\n`,
  "islands/Counter.tsx": `import type { Signal } from "@preact/signals";
import { useErrorBoundary } from "preact/hooks";
export default function Counter(props: { count: Signal<number> }) {
  useErrorBoundary();
  return <button type="button" onClick={() => props.count.value++}>{props.count}</button>;
}
`,
  "islands/Theme.tsx": `"use client";
export default function Theme() { return <i />; }
`,
  "components/Button.tsx": `export function Button(props) { return <button {...props} />; }\n`,
  "components/Env.tsx": `// Reads Vite's env and a Fresh public variable.
export const mode = (import.meta as any).env.MODE;
export const greeting = Deno.env.get("FRESH_PUBLIC_GREETING");
`,
  "static/logo.svg": `<svg/>\n`,
  "static/img/a.txt": `a\n`,
};

/** A Fresh 1.x app (`$fresh/`, `fresh.gen.ts`, `start(manifest)`), with its Tailwind plugin. */
const FRESH1: Tree = {
  "deno.json": {
    lock: false,
    tasks: {
      start: "deno run -A --watch=static/,routes/ dev.ts",
      build: "deno run -A dev.ts build",
      preview: "deno run -A main.ts",
    },
    imports: {
      "$fresh/": "https://deno.land/x/fresh@1.7.3/",
      "preact": "https://esm.sh/preact@10.22.0",
      "preact/": "https://esm.sh/preact@10.22.0/",
      "@preact/signals": "https://esm.sh/*@preact/signals@1.2.2",
      "@preact/signals-core": "https://esm.sh/*@preact/signals-core@1.5.1",
      "$std/": "https://deno.land/std@0.216.0/",
    },
    compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
  },
  "fresh.gen.ts": `// DO NOT EDIT. This file is generated by Fresh.\nexport default {};\n`,
  "main.ts": `import { start } from "$fresh/server.ts";
import manifest from "./fresh.gen.ts";
import config from "./fresh.config.ts";
await start(manifest, config);
`,
  "dev.ts": `import dev from "$fresh/dev.ts";
import config from "./fresh.config.ts";
await dev(import.meta.url, "./main.ts", config);
`,
  "fresh.config.ts": `import { defineConfig } from "$fresh/server.ts";
import tailwind from "$fresh/plugins/tailwind.ts";
import { kvOAuthPlugin } from "./plugins/kv_oauth.ts";
export default defineConfig({ plugins: [tailwind(), kvOAuthPlugin()] });
`,
  "routes/_app.tsx": `import { type PageProps } from "$fresh/server.ts";
export default function App({ Component }: PageProps) {
  return <html><head><link rel="stylesheet" href="/styles.css" /></head><body><Component /></body></html>;
}
`,
  "routes/_404.tsx": `export default function NotFound() { return <p>nope</p>; }\n`,
  "routes/_500.tsx": `export default function Error500() { return <p>500</p>; }\n`,
  "routes/_middleware.ts": `import { FreshContext } from "$fresh/server.ts";
export async function handler(req: Request, ctx: FreshContext) { return await ctx.next(); }
`,
  "routes/index.tsx": `import { Handlers, PageProps } from "$fresh/server.ts";
import Counter from "../islands/Counter.tsx";
export const handler: Handlers = { async GET(req, ctx) { return ctx.render({ n: 1 }); } };
export default function Home({ data }: PageProps) { return <Counter start={data.n} />; }
`,
  "routes/api/joke.ts":
    `export const handler = (_req: Request): Response => new Response("joke");\n`,
  "islands/Counter.tsx": `import { useSignal } from "@preact/signals";
export default function Counter(props: { start: number }) {
  const n = useSignal(props.start);
  return <button type="button" onClick={() => n.value++}>{n}</button>;
}
`,
  "static/styles.css": `@tailwind base;\n@tailwind utilities;\n`,
  "static/favicon.ico": "ico",
};

Deno.test("detectFresh: Fresh 2 and 1.x deno configs, a fresh.gen.ts, and not-Fresh", async () => {
  await withTree({
    "deno.json": { imports: { fresh: "jsr:@fresh/core@^2.3.3" } },
    "routes/index.tsx": "",
  }, async (dir) => {
    assertEquals((await detectFresh(dir))?.version, 2);
  });
  await withTree({
    "deno.jsonc": `// c\n{ "imports": { "@fresh/core": "jsr:@fresh/core@2" } }`,
    "routes/a.tsx": "",
  }, async (dir) => {
    const d = await detectFresh(dir);
    assertEquals(d?.version, 2);
    assert(d?.configPath?.endsWith("deno.jsonc"));
  });
  await withTree({
    "deno.json": { imports: { "$fresh/": "https://deno.land/x/fresh@1.7.3/" } },
    "routes/a.tsx": "",
  }, async (dir) => {
    assertEquals((await detectFresh(dir))?.version, 1);
  });
  await withTree({
    "deno.json": { imports: { fresh: "https://deno.land/x/fresh@1.6.0/server.ts" } },
    "routes/a.tsx": "",
  }, async (dir) => {
    assertEquals((await detectFresh(dir))?.version, 1);
  });
  await withTree({ "fresh.gen.ts": "", "routes/a.tsx": "" }, async (dir) => {
    assertEquals((await detectFresh(dir))?.version, 1);
  });
  await withTree({ "deno.json": { imports: { fresh: "jsr:@fresh/core@2" } } }, async (dir) => {
    assertEquals(await detectFresh(dir), null, "no routes/ directory");
  });
  await withTree({ "deno.json": "{ not json", "routes/a.tsx": "" }, async (dir) => {
    assertEquals(await detectFresh(dir), null);
  });
});

Deno.test("freshPattern: Fresh's file-route patterns", () => {
  const cases: [string, string][] = [
    ["index", "/"],
    ["about", "/about"],
    ["blog/index", "/blog"],
    ["blog/[slug]", "/blog/:slug"],
    ["docs/[...rest]", "/docs/:rest*"],
    ["(group)/about", "/about"],
    ["(group)/index", "/"],
    ["[[lang]]", "/{:lang}?"],
    ["lang/[[lang]]", "/lang{/:lang}?"],
    ["post-[id]", "/post-:id"],
    ["[id]@[v]", "/:id@:v"],
  ];
  for (const [id, pattern] of cases) assertEquals(freshPattern(id), pattern, id);
});

Deno.test("appFolder / internalFolder: what the app/ tree can hold", () => {
  assertEquals(appFolder("blog/[slug]", true), ["blog", "[slug]"]);
  assertEquals(appFolder("blog/index", true), ["blog"]);
  assertEquals(appFolder("index", true), []);
  assertEquals(appFolder("(g)/[...rest]", true), ["(g)", "[...rest]"]);
  assertEquals(appFolder("lang/[[lang]]", true), null);
  assertEquals(appFolder("post-[id]", true), null);
  assertEquals(appFolder("_private", true), null);
  assertEquals(appFolder("@slot", true), null);
  assertEquals(appFolder("", false), []);
  assertEquals(internalFolder("lang/[[lang]]"), ["lang", "fresh-route-lang-lang"]);
  assertEquals(internalFolder("[[a]]/x-[b]/c"), ["fresh-route-a-x-b-c"]);
  assertEquals(internalFolder("raw"), ["fresh-route-raw"]);
});

Deno.test("freshHandlerMethods / freshMatchOrder", () => {
  assertEquals(freshHandlerMethods(`export const handler = { GET(ctx) {}, async POST(ctx) {} }`), [
    "GET",
    "POST",
  ]);
  assertEquals(freshHandlerMethods(`export const handler = { DELETE: (ctx) => x }`), ["DELETE"]);
  assertEquals(freshHandlerMethods(`export const handler = (ctx) => x`), [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ]);
  const sorted = ["/docs/:slug*", "/docs", "/:id", "/about", "/docs/:id", "/{:lang}?", "/"]
    .map((pattern) => ({ pattern })).sort(freshMatchOrder).map((r) => r.pattern);
  assertEquals(sorted, ["/docs/:id", "/about", "/docs", "/docs/:slug*", "/:id", "/", "/{:lang}?"]);
});

Deno.test("freshDenoJson: Fresh / Preact / Vite imports out, denext in, the author's config kept", () => {
  const merged = freshDenoJson({
    "//": "old marker",
    tasks: { dev: "vite", check: "deno check", update: "x" },
    lint: { rules: { tags: ["fresh"] } },
    imports: { fresh: "jsr:@fresh/core@2", "preact/": "x/", "@/": "./", vite: "npm:vite" },
    compilerOptions: {
      jsxImportSource: "preact",
      jsxPrecompileSkipElements: ["a"],
      types: ["vite/client"],
    },
  }, {
    marker: "M",
    imports: { denext: "jsr:@denext/denext", fresh: "jsr:@denext/denext/fresh" },
    tasks: { dev: "denext dev" },
    unstable: ["u"],
  });
  assertEquals(merged["//"], "M");
  assertEquals(merged.tasks, { check: "deno check", dev: "denext dev" });
  assertEquals(merged.imports, {
    "@/": "./",
    denext: "jsr:@denext/denext",
    fresh: "jsr:@denext/denext/fresh",
  });
  assertEquals(merged.compilerOptions, {
    jsx: "react-jsx",
    jsxImportSource: "preact",
    lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
  });
  assertEquals(merged.lint, { rules: { tags: ["fresh"] } });
  assertEquals(merged.nodeModulesDir, "auto");
});

Deno.test("migrate: a Fresh 2 app — app/ and middleware.ts around routes/, islands, static, styles", async () => {
  await withTree(FRESH2, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO });
    assertEquals(r.kind, "fresh");
    assertEquals(r.denoJsonExists, false);
    assertEquals(r.aliased.sort(), ["@preact/signals", "fresh", "preact"]);
    assertEquals(r.dropped.sort(), [
      "@fresh/plugin-vite",
      "@tailwindcss/vite",
      "@types/babel__core",
      "vite",
    ]);
    const f = r.fresh!;
    assertEquals([f.version, f.pages, f.handlers, f.layouts, f.middlewares, f.islands], [
      2,
      5,
      2,
      2,
      1,
      3,
    ]);
    assertEquals(f.tailwind, { input: "./assets/styles.css", output: "./assets/styles.gen.css" });

    // The route modules stay; the denext side is generated around them.
    assert(await exists(dir, "routes/index.tsx"));
    assertEquals(
      await read(dir, "app/page.tsx"),
      `// generated by \`denext migrate\` (from Fresh) — safe to edit; re-running may overwrite
// The Fresh route routes/index: its handler runs in middleware.ts, its page here.
import { freshPage } from "denext/fresh/server";
import * as route from "../routes/index.tsx";
import * as error from "../routes/_error.tsx";

export default freshPage(route, { id: "index", error });
`,
    );
    assertStringIncludes(
      await read(dir, "app/blog/[slug]/page.tsx"),
      `import * as error from "../../../routes/blog/_error.tsx";`,
    );
    assertStringIncludes(
      await read(dir, "app/(marketing)/about/page.tsx"),
      `freshPage(route, { id: "(marketing)/about", error })`,
    );
    assertStringIncludes(
      await read(dir, "app/(marketing)/layout.tsx"),
      `freshLayout(layout, { id: "(marketing)" })`,
    );
    assertStringIncludes(await read(dir, "app/docs/[...rest]/page.tsx"), `id: "docs/[...rest]"`);
    // An optional parameter has no folder: the page is generated at an internal path.
    assertStringIncludes(
      await read(dir, "app/lang/fresh-route-lang-lang/page.tsx"),
      `{ id: "lang/[[lang]]", error, internal: true }`,
    );
    assertEquals(
      await read(dir, "app/api/[name]/route.ts"),
      `// generated by \`denext migrate\` (from Fresh) — safe to edit; re-running may overwrite
// The Fresh route routes/api/[name] (no page component): its handler answers here.
import { freshRouteHandler } from "denext/fresh/server";
import * as route from "../../../routes/api/[name].tsx";

const handler = freshRouteHandler(route, { id: "api/[name]" });
export { handler as GET, handler as POST };
`,
    );
    assertEquals(
      await exists(dir, "app/raw/route.ts"),
      false,
      "a routeOverride is middleware-served",
    );
    const root = await read(dir, "app/layout.tsx");
    assertStringIncludes(root, `import "../assets/styles.gen.css";\nimport "../assets/extra.css";`);
    assertStringIncludes(root, `freshLayout(layout, { id: "_app", app: true, main })`);
    assertStringIncludes(root, `import * as main from "../main.ts";`);
    const notFound = await read(dir, "app/not-found.tsx");
    assertStringIncludes(notFound, `import * as page from "../routes/_error.tsx";`);
    assertStringIncludes(notFound, `freshNotFound(page, { id: "_error", main })`);
    // What main.ts registers in code renders at one generated page.
    assertStringIncludes(
      await read(dir, "app/fresh-app-route/page.tsx"),
      `export default freshAppPage();`,
    );
    // <Partial> is a client component: the app's own fresh/runtime re-exports it from a
    // "use client" module, and the import map points fresh/runtime there.
    assertStringIncludes(
      await read(dir, "app/_fresh/runtime.ts"),
      `export * from "denext/fresh/runtime";`,
    );
    assertStringIncludes(
      await read(dir, "app/_fresh/partial.ts"),
      `"use client";\nexport { Partial } from "denext/fresh/partial";`,
    );
    // import.meta.env and a Fresh public read point at denext/fresh/env.
    assertEquals(
      await read(dir, "components/Env.tsx"),
      `// Reads Vite's env and a Fresh public variable.
import { env as importMetaEnv } from "denext/fresh/env";
export const mode = importMetaEnv.MODE;
export const greeting = importMetaEnv.FRESH_PUBLIC_GREETING;
`,
    );

    const mw = await read(dir, "middleware.ts");
    assertStringIncludes(mw, `import * as main from "./main.ts";`);
    assertStringIncludes(mw, `  appRoute: "/fresh-app-route",\n`);
    assertStringIncludes(mw, `{ id: "", prefix: "/", mod: mw0 }`);
    assertStringIncludes(mw, `{ id: "(marketing)", mod: layout0 }`);
    assertStringIncludes(mw, `pattern: "/@:version/:path*", mod: route`);
    assertStringIncludes(mw, `inMiddleware: true`);
    assertStringIncludes(mw, `internal: "/lang/fresh-route-lang-lang"`);
    assert(mw.indexOf(`"/about"`) < mw.indexOf(`pattern: "/"`), "static routes match first");

    // Islands: "use client" (a types-only signals import also loads the runtime), once.
    assertEquals(
      (await read(dir, "islands/Counter.tsx")).split("\n").slice(0, 3),
      [
        `"use client";`,
        `import "@preact/signals";`,
        `import type { Signal } from "@preact/signals";`,
      ],
    );
    assertEquals((await read(dir, "islands/Theme.tsx")).match(/use client/g)?.length, 1);
    assert((await read(dir, "routes/(marketing)/(_islands)/Wave.tsx")).startsWith(`"use client";`));
    assertEquals(await exists(dir, "app/(marketing)/(_islands)"), false);

    // static/ → public/; Fresh's entry files go; client.ts's code moves.
    assertEquals(await read(dir, "public/img/a.txt"), "a\n");
    assertEquals(await exists(dir, "static"), false);
    assertEquals(await exists(dir, "vite.config.ts"), false);
    assertEquals(await exists(dir, "client.ts"), false);
    assertEquals(
      await read(dir, "instrumentation-client.ts"),
      `// Import CSS files here for hot module reloading to work.\n\ndocument.addEventListener("click", () => {});\n`,
    );
    assert(await exists(dir, "main.ts"), "Fresh 2's main.ts stays: middleware.ts runs it");

    const deno = JSON.parse(await read(dir, "deno.json"));
    assertEquals(deno.compilerOptions.jsxImportSource, "preact");
    assertEquals(deno.compilerOptions.types, undefined);
    assertEquals(deno.imports["@/"], "./");
    assertEquals(deno.imports.vite, undefined);
    assertStringIncludes(deno.imports.fresh, "src/compat/fresh/mod.ts");
    for (const k of ["fresh/runtime", "@fresh/core/runtime", "$fresh/runtime.ts"]) {
      assertEquals(deno.imports[k], "./app/_fresh/runtime.ts", k);
    }
    assertStringIncludes(deno.imports["denext/fresh/runtime"], "src/compat/fresh/runtime.ts");
    assertStringIncludes(deno.imports["@preact/signals"], "src/compat/preact/signals.ts");
    assertStringIncludes(deno.imports["preact/hooks"], "src/compat/preact/hooks.ts");
    assertStringIncludes(deno.tasks.dev, "cli.ts dev");
    assertEquals(deno.tasks.check, "deno fmt --check . && deno lint . && deno check");
    assertEquals(deno.tasks.update, undefined);
    assertStringIncludes(
      await read(dir, "denext.config.ts"),
      `tailwind: { input: "./assets/styles.css", output: "./assets/styles.gen.css" }`,
    );
    assertStringIncludes(await read(dir, ".gitignore"), "_fresh/");

    // Re-running over its own output changes nothing.
    const before = await read(dir, "middleware.ts");
    const again = await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    assertEquals(again.kind, "fresh");
    assertEquals(await read(dir, "middleware.ts"), before);
  });
});

Deno.test("migrate: a Fresh 1.x app — (req, ctx) handlers, fresh.gen.ts / main.ts / dev.ts gone, Tailwind", async () => {
  await withTree(FRESH1, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO });
    const f = r.fresh!;
    assertEquals([f.version, f.pages, f.handlers, f.layouts, f.middlewares, f.islands], [
      1,
      1,
      1,
      1,
      1,
      1,
    ]);
    for (const gone of ["fresh.gen.ts", "main.ts", "dev.ts", "fresh.config.ts", "static"]) {
      assertEquals(await exists(dir, gone), false, `${gone} should be gone`);
    }
    assertEquals(await read(dir, "assets/styles.css"), "@tailwind base;\n@tailwind utilities;\n");
    assertEquals(f.tailwind, { input: "./assets/styles.css", output: "./public/styles.css" });
    assertStringIncludes(await read(dir, "app/page.tsx"), `{ id: "index", v1: true, error }`);
    assertStringIncludes(
      await read(dir, "app/not-found.tsx"),
      `import * as page from "../routes/_404.tsx";`,
    );
    assertStringIncludes(
      await read(dir, "app/api/joke/route.ts"),
      `freshRouteHandler(route, { id: "api/joke", v1: true })`,
    );
    const mw = await read(dir, "middleware.ts");
    assertStringIncludes(mw, "  v1: true,\n");
    assertEquals(mw.includes("import * as main"), false);
    const deno = JSON.parse(await read(dir, "deno.json"));
    assertEquals(Object.keys(deno.imports).filter((k) => k.startsWith("$fresh/")).sort(), [
      "$fresh/runtime.ts",
      "$fresh/server.ts",
    ]);
    assertEquals(deno.imports["preact/"], undefined);
    assertEquals(deno.imports["$std/"], "https://deno.land/std@0.216.0/");
    assertEquals(deno.tasks.preview, undefined);
    assert(f.wontMigrate.some((w) => w.item === "fresh.config.ts: kvOAuthPlugin()"));
    assert(f.review.some((w) => w.item === "./assets/styles.css"));
  });
});

Deno.test("migrate: main.ts with a root _layout and no _app — the root layout runs main.ts's wrapper", async () => {
  await withTree({
    "deno.json": { imports: { "fresh": "jsr:@fresh/core@^2.3.3" } },
    "main.ts": `import { App } from "fresh";
export const app = new App().appWrapper(({ Component }) => Component()).fsRoutes();
`,
    "routes/_layout.tsx":
      `export default function L({ Component }) { return <main><Component /></main>; }\n`,
    "routes/index.tsx": `export default function Home() { return <p>home</p>; }\n`,
  }, async (dir) => {
    await migrateProject(dir, { denextLocalPath: REPO });
    const root = await read(dir, "app/layout.tsx");
    assertStringIncludes(root, `import * as main from "../main.ts";`);
    assertStringIncludes(root, `const App = freshLayout({}, { id: "_app", app: true, main });`);
    assertStringIncludes(root, "return await App({ children: await Layout({ children }) });");
    // No _404 / _error and no app.notFound(): no not-found page.
    assertEquals(await exists(dir, "app/not-found.tsx"), false);
  });
});

/** The check report without what varies per run (the temp directory, the version). */
function stable(report: Record<string, unknown>): Record<string, unknown> {
  const { target: _t, denext: _d, ...rest } = report;
  // The checkout as it appears inside the JSON text (Windows' backslashes are escaped there).
  return JSON.parse(JSON.stringify(rest).replaceAll(JSON.stringify(REPO).slice(1, -1), "<repo>/"));
}

async function golden(name: string, report: Record<string, unknown>): Promise<void> {
  const actual = JSON.stringify(stable(report), null, 2) + "\n";
  if (Deno.env.get("DENEXT_UPDATE_GOLDEN") === "1") await Deno.writeTextFile(GOLDEN(name), actual);
  assertEquals(actual, await Deno.readTextFile(GOLDEN(name)));
}

Deno.test("migrate --check: Fresh 2 — golden report (source, changes, won't migrate, review)", async () => {
  await withTree(FRESH2, async (dir) => {
    const report = await checkMigration(dir, { denextLocalPath: REPO });
    assertEquals(report.source, "fresh");
    assertEquals(report.verdict, "review");
    await golden("fresh2", report as unknown as Record<string, unknown>);
  });
});

Deno.test("migrate --check: Fresh 1.x — golden report", async () => {
  await withTree(FRESH1, async (dir) => {
    const report = await checkMigration(dir, { denextLocalPath: REPO });
    assertEquals(report.source, "fresh");
    await golden("fresh1", report as unknown as Record<string, unknown>);
  });
});

Deno.test("migrate --from fresh on a non-Fresh directory is blocked with the reason", async () => {
  await withTree({ "package.json": { dependencies: { react: "19.0.0" } } }, async (dir) => {
    const report = await checkMigration(dir, { from: "fresh" });
    assertEquals(report.verdict, "blocked");
    assertStringIncludes(report.error!, "no Fresh app");
  });
});
