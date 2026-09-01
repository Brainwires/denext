// Coverage sweep of the Remix migration transform (`src/build/remix-migrate.ts`): the
// exported detection/parse/analyze/select helpers over their branch variety, plus a
// `transformRemixApp` run over a crafted temp app that exercises the wrapper generators
// (resource routes, folder-form routes, the many `export default` shapes, a client-needing
// root, a v1 CatchBoundary, and an Outlet-less layout warning).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import {
  analyzeModule,
  isRemix,
  parseRemixStem,
  rewriteRemixImports,
  selectHelpers,
  transformRemixApp,
} from "../src/build/remix-migrate.ts";
import { migrateProject } from "../src/build/migrate.ts";

const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url));
const REMIX_FIXTURE = fromFileUrl(new URL("./fixtures/remix-app", import.meta.url));

// ── isRemix detection ─────────────────────────────────────────────────────────

Deno.test("isRemix: @remix-run dep, remix.config, RRv7 framework, and the structural fallback", async () => {
  // A @remix-run/* dependency is the fast path (no fs needed).
  assertEquals(await isRemix("/nonexistent", { "@remix-run/react": "2.0.0" }), true);

  const tmp = await Deno.makeTempDir({ prefix: "isremix_" });
  try {
    // No deps, no files → not Remix.
    assertEquals(await isRemix(tmp, {}), false);

    // A remix.config.js signals Remix.
    await Deno.writeTextFile(join(tmp, "remix.config.js"), "module.exports = {};");
    assertEquals(await isRemix(tmp, {}), true);
    await Deno.remove(join(tmp, "remix.config.js"));

    // React Router v7 framework mode: react-router dep + a react-router.config.ts.
    await Deno.writeTextFile(join(tmp, "react-router.config.ts"), "export default {};");
    assertEquals(await isRemix(tmp, { "react-router": "7.0.0" }), true);
    await Deno.remove(join(tmp, "react-router.config.ts"));

    // Structural fallback: app/root.tsx + app/routes/.
    await Deno.mkdir(join(tmp, "app", "routes"), { recursive: true });
    await Deno.writeTextFile(join(tmp, "app", "root.tsx"), "export default function Root(){}");
    assertEquals(await isRemix(tmp, {}), true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// ── parseRemixStem edge cases ─────────────────────────────────────────────────

Deno.test("parseRemixStem: nested params, splat-only, escaped dots, pathless, break-out", () => {
  assertEquals(parseRemixStem("$").segments, ["[...splat]"]);
  assertEquals(parseRemixStem("notes.$noteId.edit").segments, ["notes", "[noteId]", "edit"]);
  // An escaped `[.]` survives the dot-split as a literal dot in the segment.
  assertEquals(parseRemixStem("files.report[.]2024").segments, ["files", "report.2024"]);
  // A pathless `_layout` segment → a route group, flagged.
  const p = parseRemixStem("_marketing.home");
  assertEquals(p.segments, ["(marketing)", "home"]);
  assert(p.warnings.some((w) => w.includes("route group")));
  // A trailing `_` layout break-out is flattened + flagged.
  const b = parseRemixStem("app_.admin");
  assertEquals(b.segments, ["app", "admin"]);
  assert(b.warnings.some((w) => w.includes("break-out")));
});

// ── rewriteRemixImports ───────────────────────────────────────────────────────

Deno.test("rewriteRemixImports: react-router(-dom) + css-bundle + server-runtime specifiers", () => {
  assertEquals(
    rewriteRemixImports(`import { useLoaderData } from "react-router";`),
    `import { useLoaderData } from "denext/remix";`,
  );
  assertEquals(
    rewriteRemixImports(`import { Link } from "react-router-dom";`),
    `import { Link } from "denext/remix";`,
  );
  assertEquals(
    rewriteRemixImports(`import { cssBundleHref } from "@remix-run/css-bundle";`),
    `import { cssBundleHref } from "denext/remix/server";`,
  );
  assertEquals(
    rewriteRemixImports(`export { json } from "@remix-run/server-runtime";`),
    `export { json } from "denext/remix/server";`,
  );
});

// ── analyzeModule branch variety ──────────────────────────────────────────────

Deno.test("analyzeModule: headers/links/handle are server exports; re-exports stay client", async () => {
  const src = [
    `import { json } from "@remix-run/node";`,
    `export const links = () => [{ rel: "stylesheet", href: "/a.css" }];`,
    `export const handle = { breadcrumb: "Home" };`,
    `export function headers() { return { "Cache-Control": "max-age=1" }; }`,
    `export function loader() { return json({ n: 1 }); }`,
    `export { helper } from "./util.ts";`,
    `export default function P() { return <p>ok</p>; }`,
  ].join("\n");
  const parts = await analyzeModule(src);
  assert(parts.hasLinks && parts.hasHandle && parts.hasHeaders && parts.hasLoader);
  // loader/links/handle/headers are server; the re-export + default component are client.
  assertEquals(parts.serverStatements.length, 4);
  assert(parts.clientStatements.some((s) => s.includes("export { helper }")));
  assert(parts.hasDefault);
});

Deno.test("analyzeModule: a type alias/interface export becomes a helper (no runtime value)", async () => {
  const src = [
    `export type Data = { n: number };`,
    `export interface Props { x: string }`,
    `export default function P() { return <p>ok</p>; }`,
  ].join("\n");
  const parts = await analyzeModule(src);
  assert(parts.helpers.some((h) => h.names.includes("Data")));
  assert(parts.helpers.some((h) => h.names.includes("Props")));
  assertEquals(parts.serverStatements.length, 0);
});

Deno.test("analyzeModule: an anonymous default export is recognized", async () => {
  const parts = await analyzeModule(`export default function () { return <p>x</p>; }`);
  assert(parts.hasDefault);
  assertEquals(parts.clientStatements.length, 1);
});

Deno.test("analyzeModule: a re-export-all keeps the module a client statement", async () => {
  const parts = await analyzeModule(`export * from "./shared.ts";`);
  assert(parts.clientStatements.some((s) => s.includes("export *")));
  assert(!parts.hasDefault);
});

// ── selectHelpers ─────────────────────────────────────────────────────────────

Deno.test("selectHelpers: transitive closure, source order, and no-op on an empty seed", () => {
  const helpers = [
    { code: "const A = fmt(B);", names: ["A"], free: new Set(["fmt", "B"]) },
    { code: "const B = 2;", names: ["B"], free: new Set<string>() },
    { code: "function fmt(x){ return x; }", names: ["fmt"], free: new Set<string>() },
    { code: "const UNUSED = 9;", names: ["UNUSED"], free: new Set<string>() },
  ];
  const chosen = selectHelpers(helpers, new Set(["A"]));
  assertEquals(chosen, ["const A = fmt(B);", "const B = 2;", "function fmt(x){ return x; }"]);
  assertEquals(selectHelpers(helpers, new Set<string>()), []);
});

// ── transformRemixApp over a crafted app (exercises the wrapper generators) ────

Deno.test("transformRemixApp: resource routes, folder form, default-export shapes, client root, warnings", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "remix_xform_" });
  const routes = join(tmp, "app", "routes");
  try {
    await Deno.mkdir(routes, { recursive: true });

    // A root that NEEDS a client boundary (a hook + meta/links exports).
    await Deno.writeTextFile(
      join(tmp, "app", "root.tsx"),
      [
        `import { useState } from "@remix-run/react";`,
        `import { Outlet } from "@remix-run/react";`,
        `export const meta = () => [{ title: "Site" }];`,
        `export const links = () => [];`,
        `export default function Root() {`,
        `  const [n] = useState(0);`,
        `  return <html><head></head><body><Outlet />{n}</body></html>;`,
        `}`,
      ].join("\n"),
    );

    // A resource route: loader + action, no default component → a route.ts (GET + POST).
    await Deno.writeTextFile(
      join(routes, "api.feed.ts"),
      [
        `import { json } from "@remix-run/node";`,
        `export function loader() { return json({ items: [] }); }`,
        `export async function action() { return json({ ok: true }); }`,
      ].join("\n"),
    );

    // A co-located non-route module (skipped by the collector).
    await Deno.writeTextFile(join(routes, "styles.css"), ".x{}");

    // An anonymous default export.
    await Deno.writeTextFile(
      join(routes, "anon.tsx"),
      `export default function () { return <p>anon</p>; }`,
    );

    // `export default Name;` (component declared above the default).
    await Deno.writeTextFile(
      join(routes, "named.tsx"),
      `function Named() { return <p>named</p>; }\nexport default Named;`,
    );

    // An expression default (a HOC call).
    await Deno.writeTextFile(
      join(routes, "hoc.tsx"),
      [
        `import { memo } from "@remix-run/react";`,
        `export default memo(function H() { return <p>hoc</p>; });`,
      ].join("\n"),
    );

    // A named class default export.
    await Deno.writeTextFile(
      join(routes, "klass.tsx"),
      `export default class Klass { render() { return null; } }`,
    );

    // A v1 CatchBoundary (no ErrorBoundary) → an error.tsx + a migration warning.
    await Deno.writeTextFile(
      join(routes, "legacy.tsx"),
      [
        `import { useCatch } from "@remix-run/react";`,
        `export default function Legacy() { return <p>legacy</p>; }`,
        `export function CatchBoundary() { const c = useCatch(); return <p>{c?.status}</p>; }`,
      ].join("\n"),
    );

    // A folder-form route (route.tsx) with a loader + a handle.
    await Deno.mkdir(join(routes, "dash"), { recursive: true });
    await Deno.writeTextFile(
      join(routes, "dash", "route.tsx"),
      [
        `import { json } from "@remix-run/node";`,
        `export function loader() { return json({ hi: 1 }); }`,
        `export const handle = { title: "Dash" };`,
        `export function shouldRevalidate() { return false; }`,
        `export default function Dash() { return <p>dash</p>; }`,
      ].join("\n"),
    );

    // A parent LAYOUT that renders no <Outlet/> (a child nests under it) → a warning.
    await Deno.writeTextFile(
      join(routes, "settings.tsx"),
      `export default function Settings() { return <p>settings</p>; }`,
    );
    await Deno.writeTextFile(
      join(routes, "settings.profile.tsx"),
      `export default function Profile() { return <p>profile</p>; }`,
    );

    const info = await transformRemixApp(tmp);
    const app = join(tmp, "app");
    const read = (rel: string) => Deno.readTextFile(join(app, rel));

    // Root went through the client boundary (a hook is present) — client + data + wrapper.
    assert(info.rootConverted);
    assert(await exists(join(app, "layout.client.tsx")), "client-root boundary written");
    assert(await exists(join(app, "layout.data.ts")), "root data module (meta/links) written");
    const rootWrapper = await read("layout.tsx");
    assertStringIncludes(rootWrapper, "RemixLayout({");
    assertStringIncludes(rootWrapper, `id: "root"`);

    // Resource route → a route.ts with GET + POST, no client component.
    const feedRoute = await read("api/feed/route.ts");
    assertStringIncludes(feedRoute, "export function GET");
    assertStringIncludes(feedRoute, "export function POST");
    assertStringIncludes(feedRoute, "runLoaderResponse");
    assertStringIncludes(feedRoute, "runActionResponse");
    assert(
      !(await exists(join(app, "api/feed/page.client.tsx"))),
      "resource route has no component",
    );

    // The default-export shapes each delocalize into a boundary.
    assertStringIncludes(await read("anon/page.client.tsx"), "__RemixUserComponent");
    const named = await read("named/page.client.tsx");
    assertStringIncludes(named, "function Named()");
    assert(!/export\s+default\s+Named/.test(named), "`export default Named;` delocalized");
    assertStringIncludes(await read("hoc/page.client.tsx"), "__RemixUserComponent");
    assertStringIncludes(await read("klass/page.client.tsx"), "class Klass");

    // The CatchBoundary route emits an error.tsx and a migration warning.
    assert(await exists(join(app, "legacy/error.tsx")), "CatchBoundary → error.tsx");
    assert(info.warnings.some((w) => w.includes("CatchBoundary")));

    // The folder-form route with a shouldRevalidate + handle wires both in its wrapper.
    const dashWrapper = await read("dash/page.tsx");
    assertStringIncludes(dashWrapper, "shouldRevalidate: data.shouldRevalidate");
    assertStringIncludes(dashWrapper, "handle: data.handle");

    // The Outlet-less parent layout is flagged.
    assert(
      info.warnings.some((w) => w.includes("no <Outlet/>")),
      `expected an Outlet warning: ${info.warnings.join(" | ")}`,
    );

    // Old scaffolding removed.
    assert(!(await exists(routes)), "app/routes removed");
    assert(!(await exists(join(app, "root.tsx"))), "app/root.tsx removed");
    assert(info.routesConverted > 5);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// ── migrateProject with a local denext checkout (the --denext-local-path resolver) ───

Deno.test("migrateProject(--denext-local-path): remix path maps denext/react/next to file:// URLs", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "remix_localpath_" });
  const dir = join(tmp, "app-root");
  try {
    await copy(REMIX_FIXTURE, dir);
    const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT });
    assertEquals(r.kind, "remix");
    const deno = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    const imports = deno.imports as Record<string, string>;
    // Local-path mode resolves denext (+ its subpaths) to file:// URLs under the checkout.
    assert(imports["denext"]?.startsWith("file://"), `denext: ${imports["denext"]}`);
    assert(imports["denext/remix"]?.startsWith("file://"), "denext/remix → file://");
    assert(imports["denext/remix/server"]?.startsWith("file://"), "denext/remix/server → file://");
    assert(imports["react"]?.startsWith("file://"), "react aliased to a local denext file");
    // The dev/build tasks invoke the local cli.ts (a file:// specifier), not the JSR package.
    assertStringIncludes(JSON.stringify(deno.tasks), "file://");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}
