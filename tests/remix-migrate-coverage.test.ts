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
  // A trailing `_` layout break-out is honored (recorded, not flagged).
  const b = parseRemixStem("app_.admin");
  assertEquals(b.segments, ["app", "admin"]);
  assertEquals(b.breakOuts, ["app"]);
  assertEquals(b.warnings, []);
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

type TransformInfo = Awaited<ReturnType<typeof transformRemixApp>>;

function writeIn(dir: string, rel: string, src: string | string[]): Promise<void> {
  return Deno.writeTextFile(join(dir, rel), Array.isArray(src) ? src.join("\n") : src);
}

/** A root that NEEDS a client boundary (a hook + meta/links exports). */
function writeClientRoot(tmp: string): Promise<void> {
  return writeIn(join(tmp, "app"), "root.tsx", [
    `import { useState } from "@remix-run/react";`,
    `import { Outlet } from "@remix-run/react";`,
    `export const meta = () => [{ title: "Site" }];`,
    `export const links = () => [];`,
    `export default function Root() {`,
    `  const [n] = useState(0);`,
    `  return <html><head></head><body><Outlet />{n}</body></html>;`,
    `}`,
  ]);
}

/** A resource route, a co-located non-route module, and the `export default` shapes. */
async function writeResourceAndDefaultShapes(routes: string): Promise<void> {
  // A resource route: loader + action, no default component → a route.ts (GET + POST).
  await writeIn(routes, "api.feed.ts", [
    `import { json } from "@remix-run/node";`,
    `export function loader() { return json({ items: [] }); }`,
    `export async function action() { return json({ ok: true }); }`,
  ]);

  // A co-located non-route module (skipped by the collector).
  await writeIn(routes, "styles.css", ".x{}");

  // An anonymous default export.
  await writeIn(routes, "anon.tsx", `export default function () { return <p>anon</p>; }`);

  // `export default Name;` (component declared above the default).
  await writeIn(
    routes,
    "named.tsx",
    `function Named() { return <p>named</p>; }\nexport default Named;`,
  );

  // An expression default (a HOC call).
  await writeIn(routes, "hoc.tsx", [
    `import { memo } from "@remix-run/react";`,
    `export default memo(function H() { return <p>hoc</p>; });`,
  ]);

  // A named class default export.
  await writeIn(routes, "klass.tsx", `export default class Klass { render() { return null; } }`);
}

/** A v1 CatchBoundary route, a folder-form route, and an Outlet-less parent layout. */
async function writeBoundaryAndLayoutRoutes(routes: string): Promise<void> {
  // A v1 CatchBoundary (no ErrorBoundary) → an error.tsx + a migration warning.
  await writeIn(routes, "legacy.tsx", [
    `import { useCatch } from "@remix-run/react";`,
    `export default function Legacy() { return <p>legacy</p>; }`,
    `export function CatchBoundary() { const c = useCatch(); return <p>{c?.status}</p>; }`,
  ]);

  // A folder-form route (route.tsx) with a loader + a handle.
  await Deno.mkdir(join(routes, "dash"), { recursive: true });
  await writeIn(routes, "dash/route.tsx", [
    `import { json } from "@remix-run/node";`,
    `export function loader() { return json({ hi: 1 }); }`,
    `export const handle = { title: "Dash" };`,
    `export function shouldRevalidate() { return false; }`,
    `export default function Dash() { return <p>dash</p>; }`,
  ]);

  // A parent LAYOUT that renders no <Outlet/> (a child nests under it) → a warning.
  await writeIn(
    routes,
    "settings.tsx",
    `export default function Settings() { return <p>settings</p>; }`,
  );
  await writeIn(
    routes,
    "settings.profile.tsx",
    `export default function Profile() { return <p>profile</p>; }`,
  );
}

/** The client-root boundary + the resource route's `route.ts`. */
async function assertRootAndResourceRoute(app: string, info: TransformInfo): Promise<void> {
  const read = (rel: string) => Deno.readTextFile(join(app, rel));

  // Root went through the client boundary (a hook is present) — client + data + wrapper.
  assert(info.rootConverted);
  assert(await exists(join(app, "layout.client.tsx")), "client-root boundary written");
  assert(await exists(join(app, "layout.data.tsx")), "root data module (meta/links) written");
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
}

/** Default-export shapes, the CatchBoundary route, folder-form wiring, warnings, and cleanup. */
async function assertShapesAndWarnings(
  app: string,
  routes: string,
  info: TransformInfo,
): Promise<void> {
  const read = (rel: string) => Deno.readTextFile(join(app, rel));

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
}

Deno.test("transformRemixApp: resource routes, folder form, default-export shapes, client root, warnings", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "remix_xform_" });
  const routes = join(tmp, "app", "routes");
  try {
    await Deno.mkdir(routes, { recursive: true });
    await writeClientRoot(tmp);
    await writeResourceAndDefaultShapes(routes);
    await writeBoundaryAndLayoutRoutes(routes);

    const info = await transformRemixApp(tmp);
    const app = join(tmp, "app");
    await assertRootAndResourceRoute(app, info);
    await assertShapesAndWarnings(app, routes, info);
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

// ── remix-flat-routes (`+` folders) ──────────────────────────────────────────

const PAGE = (name: string) =>
  `export default function ${name}() { return <main>${name}</main>; }\n`;
const LAYOUT = (name: string) =>
  `import { Outlet } from "@remix-run/react";\nexport default function ${name}() { return <section>${name}<Outlet/></section>; }\n`;
const LOADER = `export async function loader() { return new Response("ok"); }\n`;

/** The Epic Stack's shape: `+` folders, `_layout`/`index`, break-outs, colocated + ignored files. */
async function writeFlatRoutesApp(routes: string): Promise<void> {
  const files: Record<string, string> = {
    "_marketing+/index.tsx": PAGE("Home"),
    "_marketing+/about.tsx": PAGE("About"),
    "_marketing+/logos/logos.ts": "export const logos = [];\n",
    "users+/index.tsx": PAGE("Users"),
    "users+/$username.tsx": PAGE("Profile") + LOADER,
    "users+/$username.test.tsx": "test('x', () => {});\n",
    "users+/$username_+/notes.tsx": LAYOUT("Notes") + LOADER,
    "users+/$username_+/notes.index.tsx": PAGE("NotesIndex"),
    "users+/$username_+/notes.$noteId.tsx": PAGE("Note") + LOADER,
    "users+/$username_+/notes.$noteId_.edit.tsx": PAGE("Edit") + LOADER,
    "users+/$username_+/__note-editor.tsx": PAGE("Editor"),
    "users+/$username_+/__note-editor.server.tsx": "export const x = 1;\n",
    "settings+/profile.password.tsx": PAGE("Password"),
    "settings+/profile.password_.create.tsx": PAGE("CreatePassword"),
    "admin+/cache.tsx": PAGE("Cache") + LOADER,
    "admin+/cache_.sqlite.$cacheKey.ts": LOADER,
    // Colocated server helpers + re-exported server exports (the Epic Stack's shape).
    "_auth+/login.tsx": `import { handleNewSession } from "./login.server.ts";\n` +
      `import { helper } from "../../utils/helper.ts";\n` +
      `export { action } from "./login.server.ts";\n` +
      `export async function loader() { return handleNewSession(helper()); }\n` + PAGE("Login"),
    // `logout` is referenced ONLY by the action; the component merely mentions "/logout" in
    // a string — a textual check would keep the server import in the client module.
    "_auth+/logout-form.tsx": `import { logout } from "./login.server.ts";\n` +
      `export async function action() { return logout(); }\n` +
      `export default function LogoutForm() { return <form action="/logout">out</form>; }\n`,
    // `typeof profileUpdateAction` in the component's generics must not pull the helper
    // (and the server module it uses) into the client module — it gets a `declare` stub.
    "settings+/profile.index.tsx": `import { useFetcher } from "@remix-run/react";\n` +
      `import { prisma } from "./db.server.ts";\n` +
      `async function profileUpdateAction(id: string) { return prisma.update(id); }\n` +
      `export async function action() { return profileUpdateAction("1"); }\n` +
      `export default function Profile() { const f = useFetcher<typeof profileUpdateAction>(); return <b>{String(!!f)}</b>; }\n`,
    "settings+/db.server.ts": `export const prisma = { update: (id: string) => id };\n`,
    // Source order is semantic: the non-exported helper reads the exported const declared
    // BEFORE it (a hoisted helper would hit the const's TDZ at module evaluation).
    "settings+/profile.tsx": `import { Outlet } from "@remix-run/react";\n` +
      `export const BreadcrumbHandle = { parse: (x: unknown) => x };\n` +
      `const BreadcrumbHandleMatch = { handle: BreadcrumbHandle };\n` +
      `export default function Layout() { return <section>{String(!!BreadcrumbHandleMatch)}<Outlet/></section>; }\n`,
    "_auth+/login.server.ts": `export const handleNewSession = (x: unknown) => x;\n` +
      `export const logout = () => new Response("bye");\n` +
      `export async function action() { return new Response("posted"); }\n`,
    "admin+/cache_.sqlite.tsx": `export { action } from "./cache_.sqlite.server.ts";\n`,
    "admin+/cache_.sqlite.server.ts":
      `export async function action() { return new Response("ok"); }\n`,
    "_seo+/robots[.]txt.ts": LOADER,
    "docs+/_layout.tsx": LAYOUT("Docs"),
    "docs+/intro.tsx": PAGE("Intro"),
    "legacy/route.tsx": PAGE("Legacy"),
    "$.tsx": PAGE("Splat"),
    "_marketing+/tailwind-preset.ts": "export const marketingPreset = {};\n",
    // Cross-route imports (the Epic Stack): a colocated server helper reads a constant
    // and a type from ROUTE modules; a resource route exports a component the root uses.
    "settings+/profile.two-factor.tsx": `export const twoFAVerificationType = "2fa";\n` +
      `export type VerificationTypes = "2fa" | "onboarding";\n` + LOADER + PAGE("TwoFactor"),
    "_auth+/verify.server.ts":
      `import { twoFAVerificationType } from "#app/routes/settings+/profile.two-factor.tsx";\n` +
      `import { type VerificationTypes } from "../settings+/profile.two-factor.tsx";\n` +
      `import { loader as twoFactorLoader } from "#app/routes/settings+/profile.two-factor.tsx";\n` +
      `export const isCodeValid = (t: VerificationTypes) => t === twoFAVerificationType && !!twoFactorLoader;\n`,
    "resources+/theme-switch.tsx": `import { useFetcher } from "@remix-run/react";\n` +
      `export async function action() { return new Response("ok"); }\n` +
      `export function ThemeSwitch() { const f = useFetcher(); return <button>{String(!!f)}</button>; }\n`,
  };
  for (const [rel, src] of Object.entries(files)) {
    const full = join(routes, rel);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, src);
  }
}

Deno.test("transformRemixApp: remix-flat-routes `+` folders, _layout/index, break-outs, ignored files", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "remix_flat_" });
  const routes = join(tmp, "app", "routes");
  try {
    await Deno.mkdir(routes, { recursive: true });
    await writeClientRoot(tmp);
    await writeFlatRoutesApp(routes);
    // Node subpath imports, the way the Epic Stack spells `#app/…`.
    await Deno.writeTextFile(
      join(tmp, "package.json"),
      JSON.stringify({ name: "flat", imports: { "#app/*": "./app/*" } }),
    );
    const info = await transformRemixApp(tmp);
    const app = join(tmp, "app");
    const has = (rel: string) => exists(join(app, rel));

    // `+` folders prefix their files; `index` is the index route; pathless → route group.
    assert(await has("(marketing)/page.tsx"), "_marketing+/index.tsx → (marketing)/page.tsx");
    assert(await has("(marketing)/about/page.tsx"));
    assert(!(await has("(marketing)/logos")), "a colocated non-route folder is ignored");
    assert(await has("users/page.tsx"), "users+/index.tsx");
    // Break-outs: $username stays a PAGE (not a layout) and the param loses its `_`.
    assert(await has("users/[username]/page.tsx"));
    assert(!(await has("users/[username]/layout.tsx")), "$username must not become a layout");
    assert(!(await has("users/[username_]")), "the break-out underscore is not a param char");
    assert(await has("users/[username]/notes/layout.tsx"), "notes.tsx is a real layout");
    assert(await has("users/[username]/notes/page.tsx"), "notes.index.tsx");
    assert(await has("users/[username]/notes/[noteId]/page.tsx"));
    assert(!(await has("users/[username]/notes/[noteId]/layout.tsx")), "$noteId_ break-out");
    assert(await has("users/[username]/notes/[noteId]/edit/page.tsx"));
    // `__x` files (and their .server twins) and `.test` files are never routes.
    assert(!(await has("users/[username]/__note-editor")));
    // A resource-route child does not make its parent a layout.
    assert(await has("admin/cache/page.tsx"));
    assert(!(await has("admin/cache/layout.tsx")));
    assert(await has("admin/cache/sqlite/[cacheKey]/route.ts"));
    // Escaped dots, `_layout.tsx` in a `+` folder, the v2 folder form, the root splat.
    assert(await has("(seo)/robots.txt/route.ts"));
    assert(await has("docs/layout.tsx"), "docs+/_layout.tsx → docs/layout.tsx");
    assert(await has("docs/intro/page.tsx"));
    assert(await has("legacy/page.tsx"));
    assert(await has("[...splat]/page.tsx"));
    assert(await has("settings/profile/layout.tsx"));
    assert(await has("settings/profile/password/page.tsx"));
    assert(!(await has("settings/profile/password/layout.tsx")), "password_ break-out");
    assert(await has("settings/profile/password/create/page.tsx"));
    // Route ids are the module paths remix-flat-routes gives them.
    const notes = await Deno.readTextFile(join(app, "users/[username]/notes/layout.tsx"));
    assertStringIncludes(notes, '"routes/users+/$username_+/notes"');
    const home = await Deno.readTextFile(join(app, "(marketing)/page.tsx"));
    assertStringIncludes(home, '"routes/_marketing+/index"');
    assert(!info.warnings.some((w) => w.includes("break-out")), "break-outs are not flagged");
    assertEquals(info.routesConverted, 24);

    // Colocated modules moved to the private app/_routes/ mirror; imports re-based.
    assert(await has("_routes/_auth+/login.server.ts"), "login.server.ts relocated");
    assert(await has("_routes/_marketing+/logos/logos.ts"), "colocated folder relocated");
    assert(await has("_routes/users+/$username_+/__note-editor.tsx"), "__ files relocated");
    assert(!(await has("routes")), "app/routes removed");
    const loginData = await Deno.readTextFile(join(app, "(auth)/login/page.data.tsx"));
    assertStringIncludes(loginData, '"../../_routes/_auth+/login.server.ts"');
    assertStringIncludes(
      loginData,
      '"../../utils/helper.ts"',
      "an import outside routes/ is re-based too",
    );
    // A re-exported `action` is a server export: it lands in the data module (with its
    // POST route), never in the "use client" module.
    assertStringIncludes(
      loginData,
      'export { action } from "../../_routes/_auth+/login.server.ts"',
    );
    const loginClient = await Deno.readTextFile(join(app, "(auth)/login/page.client.tsx"));
    assert(!loginClient.includes("login.server"), "server re-export kept out of the client module");
    const logoutClient = await Deno.readTextFile(join(app, "(auth)/logout-form/page.client.tsx"));
    assert(!logoutClient.includes("login.server"), "import pruning is AST-based, not textual");
    const logoutData = await Deno.readTextFile(join(app, "(auth)/logout-form/page.data.tsx"));
    assertStringIncludes(
      logoutData,
      "login.server.ts",
      "the action's import stays in the data module",
    );
    const profileClient = await Deno.readTextFile(join(app, "settings/profile/page.client.tsx"));
    assert(
      !profileClient.includes("db.server"),
      "a typeof-only reference must not pull server code",
    );
    assertStringIncludes(profileClient, "declare const profileUpdateAction:");
    assert(!profileClient.includes("async function profileUpdateAction"));
    const profileLayout = await Deno.readTextFile(join(app, "settings/profile/layout.client.tsx"));
    assert(
      profileLayout.indexOf("export const BreadcrumbHandle") <
        profileLayout.indexOf("const BreadcrumbHandleMatch"),
      "helpers keep their source order relative to exported statements",
    );
    const profileData = await Deno.readTextFile(join(app, "settings/profile/page.data.tsx"));
    assertStringIncludes(profileData, "async function profileUpdateAction");
    assertStringIncludes(profileData, "db.server.ts");
    assert(await has("(auth)/login/route.ts"), "the re-exported action gets its POST handler");
    // A module that is ONLY a re-exported action is an action-only resource route.
    const sqlite = await Deno.readTextFile(join(app, "admin/cache/sqlite/route.ts"));
    assertStringIncludes(sqlite, "POST");
    assertStringIncludes(sqlite, 'from "./page.data.tsx"', "generated siblings are not re-based");
    const loginWrapper = await Deno.readTextFile(join(app, "(auth)/login/page.tsx"));
    assertStringIncludes(loginWrapper, 'from "./page.client.tsx"');
    // A module with no loader/action/component is colocated, not a route.
    assert(!(await has("(marketing)/tailwind-preset")), "tailwind-preset.ts is not a route");
    assert(await has("_routes/_marketing+/tailwind-preset.ts"), "…it is relocated instead");

    // Cross-route imports are re-pointed at the generated modules by imported name.
    const verifyServer = await Deno.readTextFile(join(app, "_routes/_auth+/verify.server.ts"));
    assertStringIncludes(verifyServer, '"../../settings/profile/two-factor/page.client.tsx"');
    assertStringIncludes(
      verifyServer,
      'loader as twoFactorLoader } from "../../settings/profile/two-factor/page.data.tsx"',
    );
    assert(!verifyServer.includes("#app/routes/"), "alias imports of route modules re-pointed");
    // The exported type + constant live in the client module (the type always, not by reference).
    const twoFactorClient = await Deno.readTextFile(
      join(app, "settings/profile/two-factor/page.client.tsx"),
    );
    assertStringIncludes(twoFactorClient, "export type VerificationTypes");
    assertStringIncludes(twoFactorClient, "export const twoFAVerificationType");
    // A resource route with client-side exports gets a client module beside its route.ts.
    assert(await has("resources/theme-switch/route.ts"));
    const themeClient = await Deno.readTextFile(
      join(app, "resources/theme-switch/page.client.tsx"),
    );
    assertStringIncludes(themeClient, '"use client"');
    assertStringIncludes(themeClient, "export function ThemeSwitch");
    assert(!themeClient.includes("export async function action"), "server export stays out");
    assertStringIncludes(themeClient, 'from "denext/remix"');
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("transformRemixApp: a root `Layout` export wraps the app + ErrorBoundary; its document tags become denext's", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "remix_layoutexport_" });
  const app = join(tmp, "app");
  try {
    await Deno.mkdir(join(app, "routes"), { recursive: true });
    await Deno.writeTextFile(
      join(app, "root.tsx"),
      `import { Outlet, useLoaderData } from "@remix-run/react";\n` +
        `export async function loader() { return { theme: "dark" }; }\n` +
        // The shell lives in a NON-exported helper, as the Epic Stack does (\`Document\`).
        `function Document({ children, theme }: { children: React.ReactNode; theme?: string }) {\n` +
        `  return (<html lang="en" className={\`\${theme} h-full\`}><head><meta charSet="utf-8" /></head>` +
        `<body className="bg-background"><header>chrome</header>{children}</body></html>);\n}\n` +
        `export function Layout({ children }: { children: React.ReactNode }) {\n` +
        `  const data = useLoaderData<typeof loader | null>();\n` +
        `  return <Document theme={data?.theme}>{children}</Document>;\n}\n` +
        `export default function App() { return <Outlet />; }\n` +
        `export function ErrorBoundary() { return <p>oops</p>; }\n`,
    );
    await Deno.writeTextFile(join(app, "routes", "_index.tsx"), PAGE("Home"));
    // The server entry: Remix rendering hooks (dropped) + startup effects (kept).
    await Deno.writeTextFile(
      join(app, "entry.server.tsx"),
      `import { renderToPipeableStream } from "react-dom/server";\n` +
        `import { getEnv, init } from "./utils/env.server.ts";\n` +
        `const ABORT_DELAY = 5000;\n` +
        `init();\n` +
        `global.ENV = getEnv();\n` +
        `if (process.env.SENTRY_DSN) { void import("./utils/monitoring.server.ts"); }\n` +
        `export default function handleRequest() { return renderToPipeableStream(null, { timeout: ABORT_DELAY }); }\n` +
        `export function handleError() {}\n`,
    );
    const info = await transformRemixApp(tmp);
    const instrumentation = await Deno.readTextFile(join(tmp, "instrumentation.ts"));
    assertStringIncludes(instrumentation, "export function register(): void");
    assertStringIncludes(instrumentation, "init();");
    assertStringIncludes(instrumentation, "global.ENV = getEnv();");
    assertStringIncludes(
      instrumentation,
      'from "./app/utils/env.server.ts"',
      "imports re-based to the root",
    );
    assertStringIncludes(instrumentation, 'import("./app/utils/monitoring.server.ts")');
    assert(
      !instrumentation.includes("function handleRequest"),
      "Remix's rendering hook is dropped",
    );
    assert(!instrumentation.includes("react-dom/server"), "its imports go with it");
    assert(!instrumentation.includes("ABORT_DELAY"), "an unreferenced declaration is left out");
    assert(info.warnings.some((w) => w.includes("instrumentation.ts")));
    const client = await Deno.readTextFile(join(app, "layout.client.tsx"));
    assertStringIncludes(client, '<DocumentHtml lang="en" className={`${theme} h-full`}>');
    assertStringIncludes(client, "<DocumentHead>");
    assertStringIncludes(client, '<DocumentBody className="bg-background">');
    assert(!/<html\b|<body\b|<\/head>/.test(client), "no raw document tags remain");
    assertStringIncludes(client, "<Layout><App /></Layout>");
    assertStringIncludes(client, "<Layout><ErrorBoundary /></Layout>");
    assert(/import \{[^}]*DocumentHtml[^}]*\} from "denext\/remix"/.test(client), "runtime import");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("transformRemixApp: getLoadContext → load-context.ts, entry.client → instrumentation-client, route markers", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "remix_loadctx_" });
  const app = join(tmp, "app");
  try {
    await Deno.mkdir(join(app, "routes"), { recursive: true });
    await Deno.mkdir(join(app, "utils"), { recursive: true });
    await Deno.mkdir(join(tmp, "server"), { recursive: true });
    await Deno.writeTextFile(join(app, "root.tsx"), LAYOUT("Root"));
    await Deno.writeTextFile(join(app, "routes", "_index.tsx"), PAGE("Home"));
    await Deno.writeTextFile(
      join(app, "routes", "users.$username.tsx"),
      `export const handle = { getSitemapEntries: () => null };\n` + PAGE("User"),
    );
    // The Epic Stack's sitemap: a resource route reading the server build from `context`,
    // with TYPE-ONLY imports from @remix-run/node.
    await Deno.writeTextFile(
      join(app, "routes", "sitemap[.]xml.ts"),
      `import { type ServerBuild, type LoaderFunctionArgs } from "@remix-run/node";\n` +
        `export async function loader({ request, context }: LoaderFunctionArgs) {\n` +
        `  const serverBuild = (await context.serverBuild) as { build: ServerBuild };\n` +
        `  return new Response(Object.keys(serverBuild.build.routes).join(","));\n}\n`,
    );
    // The custom Express server: what `getLoadContext` gave loaders as `context`.
    await Deno.writeTextFile(
      join(tmp, "server", "index.ts"),
      `import express from "express";\nconst app = express();\n` +
        `app.all("*", createRequestHandler({\n` +
        `  getLoadContext: (req: any, res: any) => ({\n` +
        `    cspNonce: res.locals.cspNonce,\n    serverBuild: getBuild(),\n    ip: req.ip,\n  }),\n` +
        `  build: () => getBuild(),\n}));\n`,
    );
    // The client entry: Remix's hydration (dropped) + a startup effect (kept).
    await Deno.writeTextFile(
      join(app, "entry.client.tsx"),
      `import { RemixBrowser } from "@remix-run/react";\nimport { startTransition } from "react";\n` +
        `import { hydrateRoot } from "react-dom/client";\n` +
        `if (ENV.MODE === "production" && ENV.SENTRY_DSN) {\n` +
        `  void import("./utils/monitoring.client.tsx").then(({ init }) => init());\n}\n` +
        `startTransition(() => {\n  hydrateRoot(document, <RemixBrowser />);\n});\n`,
    );
    const info = await transformRemixApp(tmp);

    const loadContext = await Deno.readTextFile(join(tmp, "load-context.ts"));
    assertStringIncludes(
      loadContext,
      'import { defineLoadContext, remixServerBuild } from "denext/remix/server";',
    );
    assertStringIncludes(loadContext, "export default defineLoadContext(() => ({");
    assertStringIncludes(loadContext, "get serverBuild() {\n    return remixServerBuild();\n  },");
    assertStringIncludes(loadContext, "// was: getBuild() —");
    assert(
      !loadContext.includes("serverBuild: remixServerBuild()"),
      "lazy getter, not an eager promise",
    );
    assertStringIncludes(loadContext, "cspNonce: undefined,");
    assertStringIncludes(loadContext, "// was: res.locals.cspNonce — denext's CSP is hash-based");
    assertStringIncludes(loadContext, "// TODO: was `req.ip` — provide it here\n  ip: undefined,");
    assert(info.warnings.some((w) => w.includes("getLoadContext → load-context.ts")));
    // No entry.server here — instrumentation.ts still exists to register the load context.
    const instrumentation = await Deno.readTextFile(join(tmp, "instrumentation.ts"));
    assertStringIncludes(instrumentation, 'import "./load-context.ts";');
    assertStringIncludes(instrumentation, "export function register(): void {");

    const client = await Deno.readTextFile(join(tmp, "instrumentation-client.ts"));
    assertStringIncludes(client, 'if (ENV.MODE === "production" && ENV.SENTRY_DSN)');
    assertStringIncludes(client, 'import("./app/utils/monitoring.client.tsx")', "re-based");
    assert(!client.includes("hydrateRoot"), "Remix's hydration is dropped");
    assert(!client.includes("RemixBrowser") && !client.includes("react-dom/client"));
    assert(!client.includes("startTransition"), "its imports go with it");
    assert(info.entriesDeleted.includes("app/entry.client.tsx"));
    assert(info.warnings.some((w) => w.includes("instrumentation-client.ts")));

    // Type-only imports survive the AST-based pruning (rewritten to the runtime).
    const sitemapData = await Deno.readTextFile(join(app, "sitemap.xml", "page.data.tsx"));
    assertStringIncludes(
      sitemapData,
      'import { type ServerBuild, type LoaderFunctionArgs } from "denext/remix/server";',
    );
    // Every wrapper exports the marker `remixServerBuild()` maps routes back with.
    const sitemapRoute = await Deno.readTextFile(join(app, "sitemap.xml", "route.ts"));
    assertStringIncludes(
      sitemapRoute,
      'export const remixRoute = { id: "routes/sitemap[.]xml", module: data };',
    );
    const userPage = await Deno.readTextFile(join(app, "users", "[username]", "page.tsx"));
    assertStringIncludes(
      userPage,
      'export const remixRoute = { id: "routes/users.$username", module: data };',
    );
    const home = await Deno.readTextFile(join(app, "page.tsx"));
    assertStringIncludes(home, 'export const remixRoute = { id: "routes/_index", module: {} };');
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("transformRemixApp: nothing is destroyed before the generated files exist; 220 colocated files survive; a route named `routes` keeps its generated page", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "remix_nodataloss_" });
  const app = join(tmp, "app");
  try {
    await Deno.mkdir(join(app, "routes", "_marketing+", "assets"), { recursive: true });
    await Deno.writeTextFile(join(app, "root.tsx"), LAYOUT("Root"));
    await Deno.writeTextFile(join(app, "routes", "_index.tsx"), PAGE("Home"));
    await Deno.writeTextFile(join(app, "routes", "routes.tsx"), PAGE("RoutesPage"));
    // Colocated (non-route) modules: the kind a readDir-while-renaming walk used to skip.
    for (let i = 0; i < 220; i++) {
      await Deno.writeTextFile(
        join(app, "routes", "_marketing+", "assets", `__asset-${i}.ts`),
        `export const n = ${i};\n`,
      );
    }
    const info = await transformRemixApp(tmp);
    let colocated = 0;
    for await (const _ of Deno.readDir(join(app, "_routes", "_marketing+", "assets"))) colocated++;
    assertEquals(colocated, 220, "every colocated module relocated, none lost");
    assertEquals(info.routesConverted, 2);
    // `routes.tsx` → app/routes/page.tsx lands INSIDE the old routes dir and must survive it.
    assertStringIncludes(await Deno.readTextFile(join(app, "routes", "page.tsx")), "RemixRoute");
    assert(!(await exists(join(app, "routes", "routes.tsx"))), "the converted original is gone");
    assert(!(await exists(join(app, "routes", "_index.tsx"))));
    assert(!(await exists(join(app, "routes", "_marketing+"))), "emptied dirs are pruned");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("analyzeModule: JSX tag and attribute names are not free identifiers (a server `action` import stays out of the client split)", async () => {
  const parts = await analyzeModule(
    `import { Form } from "@remix-run/react";\n` +
      `import { action } from "./login.server.ts";\nimport * as Icons from "./icons.tsx";\n` +
      `export { action };\n` +
      `export default function Login() {\n` +
      `  return (<form action="/login" className="x"><Form method="post" /><Icons.Lock size={1} /><svg:path d="" /></form>);\n}\n`,
  );
  const free = [...parts.clientFree].sort();
  assert(!free.includes("action"), `action leaked: ${free}`);
  assert(!free.includes("form") && !free.includes("className") && !free.includes("method"));
  assert(!free.includes("path") && !free.includes("d") && !free.includes("size"));
  assert(free.includes("Form") && free.includes("Icons"), `component refs kept: ${free}`);
});

Deno.test("transformRemixApp: head-only routes get a passthrough component; nested plain folders nest; strings survive the document rename", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "remix_a5_" });
  const app = join(tmp, "app");
  try {
    await Deno.mkdir(join(app, "routes", "users", "$id"), { recursive: true });
    await Deno.mkdir(join(app, "routes", "docs", "api+"), { recursive: true });
    // A root whose helper holds "<body>" inside a STRING (a dangerouslySetInnerHTML payload).
    await Deno.writeTextFile(
      join(app, "root.tsx"),
      `import { Outlet, useLoaderData } from "@remix-run/react";\n` +
        `export async function loader() { return { theme: "dark" }; }\n` +
        `const RAW = "<body>literal</body>";\n` +
        `function Document({ children }: { children: React.ReactNode }) {\n` +
        `  return (<html lang="en"><head /><body><div dangerouslySetInnerHTML={{ __html: RAW }} />{children}</body></html>);\n}\n` +
        `export default function App() { const d = useLoaderData<typeof loader>(); return <Document>{d.theme}<Outlet /></Document>; }\n`,
    );
    await Deno.writeTextFile(join(app, "routes", "_index.tsx"), PAGE("Home"));
    // meta-only module: a route, not a colocated file.
    await Deno.writeTextFile(
      join(app, "routes", "about.tsx"),
      `export const meta = () => [{ title: "About" }];\n`,
    );
    // links+handle-only LAYOUT (has children) → passthrough renders <Outlet />.
    await Deno.writeTextFile(
      join(app, "routes", "docs.tsx"),
      `export const links = () => [{ rel: "stylesheet", href: "/docs.css" }];\nexport const handle = { docs: true };\n`,
    );
    await Deno.writeTextFile(join(app, "routes", "docs", "api+", "index.tsx"), PAGE("DocsApi"));
    // Nested PLAIN folders (no `+`): users/$id/route.tsx → users.$id
    await Deno.writeTextFile(join(app, "routes", "users", "$id", "route.tsx"), PAGE("User"));
    const info = await transformRemixApp(tmp);
    const has = (rel: string) => exists(join(app, rel));
    assert(await has("about/page.tsx"), "meta-only route converted");
    assertStringIncludes(
      await Deno.readTextFile(join(app, "about", "page.client.tsx")),
      "__RemixHeadOnly",
    );
    assertStringIncludes(
      await Deno.readTextFile(join(app, "about", "page.tsx")),
      "remixMeta(data.meta",
    );
    const docsLayout = await Deno.readTextFile(join(app, "docs", "layout.client.tsx"));
    assertStringIncludes(docsLayout, "<Outlet />");
    assert(/import \{[^}]*Outlet[^}]*\} from "denext\/remix"/.test(docsLayout), "Outlet imported");
    assert(await has("docs/api/page.tsx"), "the + folder under docs nests");
    assert(await has("users/[id]/page.tsx"), "nested plain folders nest as dot segments");
    assert(!info.warnings.some((w) => w.includes("about") && w.includes("colocated")));
    const root = await Deno.readTextFile(join(app, "layout.client.tsx"));
    assertStringIncludes(root, '"<body>literal</body>"', "the string literal is untouched");
    assertStringIncludes(root, "<DocumentBody>");
    assertStringIncludes(root, "</DocumentHtml>");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("remix-migrate.ts carries no raw NUL bytes (git would treat it as binary)", async () => {
  const src = await Deno.readTextFile(new URL("../src/build/remix-migrate.ts", import.meta.url));
  assert(!src.includes(String.fromCharCode(0)));
});
