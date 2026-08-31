// `denext migrate --from remix` — the assisted Remix source path.
//
// The Remix path physically transforms the route tree AND splits each route into a client
// component + a server data module wired by a generated denext wrapper (so the app runs on
// the `denext/remix` runtime with its loaders/actions intact). These tests exercise the
// route-name parser, the import remap, the module splitter, and a full end-to-end migration
// over a fixture Remix app (copied to temp so the committed fixture stays pristine).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";
import {
  analyzeModule,
  parseRemixStem,
  rewriteRemixImports,
  selectHelpers,
} from "../src/build/remix-migrate.ts";
import { scanRoutes } from "../src/router/manifest.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/remix-app", import.meta.url));

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

Deno.test("parseRemixStem: dot-nesting, params, splat, index, pathless, break-out", () => {
  assertEquals(parseRemixStem("_index"), { segments: [], isIndex: true, warnings: [] });
  assertEquals(parseRemixStem("about"), { segments: ["about"], isIndex: false, warnings: [] });
  assertEquals(parseRemixStem("concerts.trending").segments, ["concerts", "trending"]);
  assertEquals(parseRemixStem("concerts._index"), {
    segments: ["concerts"],
    isIndex: true,
    warnings: [],
  });
  assertEquals(parseRemixStem("concerts.$city").segments, ["concerts", "[city]"]);
  assertEquals(parseRemixStem("$").segments, ["[...splat]"]);
  assertEquals(parseRemixStem("files.$").segments, ["files", "[...splat]"]);

  const auth = parseRemixStem("_auth.login");
  assertEquals(auth.segments, ["(auth)", "login"]);
  assert(auth.warnings.some((w) => w.includes("route group")));

  const brk = parseRemixStem("dashboard_.settings");
  assertEquals(brk.segments, ["dashboard", "settings"]);
  assert(brk.warnings.some((w) => w.includes("break-out")));

  assertEquals(parseRemixStem("sitemap[.]xml").segments, ["sitemap.xml"]);
});

Deno.test("rewriteRemixImports: @remix-run/* → denext/remix (client) and /server", () => {
  assertEquals(
    rewriteRemixImports(`import { Link } from "@remix-run/react";`),
    `import { Link } from "denext/remix";`,
  );
  assertEquals(
    rewriteRemixImports(`import { json, redirect } from "@remix-run/node";`),
    `import { json, redirect } from "denext/remix/server";`,
  );
  assertEquals(
    rewriteRemixImports(`import { useLoaderData } from "@remix-run/cloudflare";`),
    `import { useLoaderData } from "denext/remix/server";`,
  );
  // A substring must not be rewritten — only a full quoted specifier.
  assertEquals(
    rewriteRemixImports(`const s = "@remix-run/react-helper";`),
    `const s = "@remix-run/react-helper";`,
  );
});

Deno.test("analyzeModule (AST): partition server exports, the component, and helpers", async () => {
  const src = [
    `import { json } from "@remix-run/node";`,
    `import { useLoaderData } from "@remix-run/react";`,
    `const HELPER = 1;`,
    `export function loader() { return json({ n: HELPER }); }`,
    `export function meta() { return [{ title: "T" }]; }`,
    `export default function P() {`,
    `  const data = useLoaderData<typeof loader>();`,
    `  return <p>{data.n}</p>;`,
    `}`,
    `export function ErrorBoundary() { return <p>err</p>; }`,
  ].join("\n");

  const parts = await analyzeModule(src);
  assert(parts.hasLoader && parts.hasMeta && parts.hasDefault && parts.hasErrorBoundary);
  assert(!parts.hasAction);
  // loader + meta are server; the default component + ErrorBoundary are client.
  assertEquals(parts.serverStatements.length, 2);
  assertEquals(parts.clientStatements.length, 2);
  // HELPER is a helper referenced (free) by the loader but NOT by the component.
  const helper = parts.helpers.find((h) => h.names.includes("HELPER"));
  assert(helper, "HELPER recognized as a helper");
  assert(parts.serverFree.has("HELPER"), "loader references HELPER");
  assert(!parts.clientFree.has("HELPER"), "component does not reference HELPER");
});

Deno.test("analyzeModule: a v1 CatchBoundary is detected and kept client-side", async () => {
  const src = [
    `import { useCatch } from "@remix-run/react";`,
    `export default function P() { return <p>ok</p>; }`,
    `export function CatchBoundary() { const c = useCatch(); return <p>{c.status}</p>; }`,
  ].join("\n");
  const parts = await analyzeModule(src);
  assert(parts.hasCatchBoundary, "CatchBoundary export recognized");
  assert(!parts.hasErrorBoundary);
  // The default component + CatchBoundary both stay on the client side.
  assertEquals(parts.clientStatements.length, 2);
  assertEquals(parts.serverStatements.length, 0);
});

Deno.test("selectHelpers: reference-based, transitive, source-ordered", () => {
  const helpers = [
    { code: "const A = B + 1;", names: ["A"], free: new Set(["B"]) },
    { code: "const B = 2;", names: ["B"], free: new Set<string>() },
    { code: "const UNUSED = 3;", names: ["UNUSED"], free: new Set<string>() },
  ];
  // Seed references A → pulls in A and, transitively, B; UNUSED is dropped; order kept.
  assertEquals(selectHelpers(helpers, new Set(["A"])), ["const A = B + 1;", "const B = 2;"]);
  // A helper referenced by nothing is omitted entirely.
  assertEquals(selectHelpers(helpers, new Set<string>()), []);
});

Deno.test("analyzeModule: a helper shadowed by a component local is NOT duplicated into the client", async () => {
  // Regression for the split's helper-partitioning: a module-level `visits` used
  // only by the loader must land in the data module, and must NOT be dragged into
  // the client split by the component's own `const { visits } = useLoaderData()`.
  const src = [
    `import { json } from "@remix-run/node";`,
    `import { useLoaderData } from "@remix-run/react";`,
    `let visits = 0;`,
    `export function loader() { visits += 1; return json({ visits }); }`,
    `export default function Page() {`,
    `  const { visits } = useLoaderData<typeof loader>();`,
    `  return <p>{visits}</p>;`,
    `}`,
  ].join("\n");

  const parts = await analyzeModule(src);
  // The loader references the module-level `visits`; the component's `visits` is a
  // local binding (destructured), so it is NOT a free reference to the helper.
  assert(parts.serverFree.has("visits"), "loader references module-level visits");
  assert(!parts.clientFree.has("visits"), "component's visits is a shadowing local, not free");
  assertEquals(
    selectHelpers(parts.helpers, parts.serverFree).length,
    1,
    "data module keeps visits",
  );
  assertEquals(selectHelpers(parts.helpers, parts.clientFree).length, 0, "client drops visits");
});

Deno.test("migrate --from remix: splits routes into wrapper + client + data, wires runtime", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "denext_remix_" });
  const dir = join(tmp, "app-root");
  try {
    await copy(FIXTURE, dir);
    // A shared (non-route) module — the kind of file a real app keeps outside routes/.
    // Written here (not committed as a fixture) so its Remix imports must be remapped.
    await Deno.writeTextFile(
      join(dir, "app", "session.ts"),
      `import { createCookieSessionStorage } from "@remix-run/node";\n` +
        `export const { getSession } = createCookieSessionStorage({ cookie: { name: "s" } });\n`,
    );

    const r = await migrateProject(dir);
    assertEquals(r.kind, "remix");
    assert(r.remix, "remix report present");
    const m = r.remix!;

    const app = join(dir, "app");
    // Route tree restructured to denext conventions (server wrappers).
    for (
      const rel of [
        "page.tsx", // _index
        "layout.tsx", // root
        "about/page.tsx",
        "concerts/layout.tsx",
        "concerts/page.tsx",
        "concerts/[city]/page.tsx",
        "concerts/trending/page.tsx",
        "[...splat]/page.tsx",
        "(auth)/login/page.tsx",
      ]
    ) {
      assert(await exists(join(app, rel)), `expected ${rel}`);
    }

    // Each data route is split: wrapper + client component + server data module.
    assert(await exists(join(app, "page.client.tsx")), "client component split out");
    assert(await exists(join(app, "page.data.ts")), "server data module split out");
    assert(await exists(join(app, "concerts/[city]/page.data.ts")));

    // Old Remix scaffolding removed.
    assert(!(await exists(join(app, "routes"))), "app/routes removed");
    assert(!(await exists(join(app, "root.tsx"))), "app/root.tsx removed");
    assert(!(await exists(join(app, "entry.server.tsx"))), "entry.server removed");
    assertEquals(m.rootConverted, true);
    assertEquals(m.loaders, 3);
    assertEquals(m.actions, 1);

    // The wrapper wires the runtime; the client uses denext/remix; the data uses the server split.
    const pageWrapper = await Deno.readTextFile(join(app, "page.tsx"));
    assertStringIncludes(pageWrapper, `from "denext/remix/server"`);
    assertStringIncludes(pageWrapper, "RemixRoute({");
    assertStringIncludes(pageWrapper, "loader: data.loader");

    const pageClient = await Deno.readTextFile(join(app, "page.client.tsx"));
    assertStringIncludes(pageClient, `"use client"`);
    assertStringIncludes(pageClient, `from "denext/remix"`);
    assertStringIncludes(pageClient, `import type { loader }`);
    assert(!pageClient.includes("@remix-run"), "no @remix-run imports remain");
    // The user's default component is delocalized and wrapped in a single client boundary
    // that receives loaderData as a prop (so it crosses the Flight boundary).
    assertStringIncludes(pageClient, "function Index()");
    assert(!/export\s+default\s+function\s+Index/.test(pageClient), "default delocalized");
    assertStringIncludes(pageClient, "export default function __RemixRouteBoundary");
    assertStringIncludes(pageClient, "RemixRouteProvider");
    assertStringIncludes(pageClient, "loaderData={props.loaderData}");

    const pageData = await Deno.readTextFile(join(app, "page.data.ts"));
    assertStringIncludes(pageData, `import { json } from "denext/remix/server"`);
    assertStringIncludes(pageData, "export function loader()");

    // Action route: the data module keeps the action; the wrapper wires it.
    const loginWrapper = await Deno.readTextFile(join(app, "(auth)/login/page.tsx"));
    assertStringIncludes(loginWrapper, "action: data.action");
    // The wrapper threads the Remix-CANONICAL route id (`routes/<stem>`), not a
    // denext-internal one — so an app's `useMatches`/`useRouteLoaderData("routes/…")`
    // (and `useRouteLoaderData("root")` for the root) resolve after migration.
    assertStringIncludes(loginWrapper, `id: "routes/_auth.login"`);
    const cityWrapper = await Deno.readTextFile(join(app, "concerts/[city]/page.tsx"));
    assertStringIncludes(cityWrapper, `id: "routes/concerts.$city"`);

    // A PAGE route with an action ALSO gets a `route.ts` POST handler, so a plain POST to
    // the page URL runs the action (cross-route `fetcher.submit`/`<Form action>` to a page,
    // and the no-JS post). The action's URL params are threaded from the matched pattern.
    const loginRoute = await Deno.readTextFile(join(app, "(auth)/login/route.ts"));
    assertStringIncludes(loginRoute, "export function POST(");
    assertStringIncludes(loginRoute, "runActionResponse(data.action, request, ctx.params)");
    assert(!loginRoute.includes("export function GET"), "GET stays with page.tsx");

    // Layout wrapper threads children; its client keeps <Outlet/>.
    const concertsLayout = await Deno.readTextFile(join(app, "concerts/layout.tsx"));
    assertStringIncludes(concertsLayout, "RemixLayout({");
    assertStringIncludes(concertsLayout, "children: props.children");
    const concertsLayoutClient = await Deno.readTextFile(join(app, "concerts/layout.client.tsx"));
    assertStringIncludes(concertsLayoutClient, "<Outlet");

    // Root layout: doc components stripped, children threaded.
    // A pure document-shell root becomes denext's SERVER document layout: the <html>/
    // <head>/<body> shell is stripped (denext supplies it), <Outlet/> → {children}, and
    // `meta` is bridged to generateMetadata. No client boundary is needed.
    const rootLayout = await Deno.readTextFile(join(app, "layout.tsx"));
    assert(!rootLayout.includes("<html"), "document shell stripped (denext supplies <html>)");
    assert(!rootLayout.includes("<Meta"), "Meta stripped");
    assert(!rootLayout.includes("<Scripts"), "Scripts stripped");
    assertStringIncludes(rootLayout, "{children}");
    assertStringIncludes(rootLayout, "generateMetadata");
    assert(
      !(await exists(join(app, "layout.client.tsx"))),
      "no client boundary for a document-shell root",
    );

    // A shared (non-route) module's @remix-run/* imports are remapped too — the route
    // transform alone would leave app/session.ts importing an unresolvable specifier.
    const sharedModule = await Deno.readTextFile(join(app, "session.ts"));
    assertStringIncludes(sharedModule, `from "denext/remix/server"`);
    assert(!sharedModule.includes("@remix-run"), "no @remix-run import remains in shared module");

    // denext config written: react aliased, @remix-run/* dropped.
    const deno = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    const imports = deno.imports as Record<string, string>;
    assert(imports["react"]?.includes("denext"), "react → denext");
    assert(r.dropped.includes("@remix-run/react"), "@remix-run/react dropped");

    // scanRoutes discovers the migrated routes.
    const manifest = await scanRoutes(app);
    assert(manifest.rootLayout, "root layout discovered");
    assert(manifest.pages.length >= 7, `expected ≥7 pages, got ${manifest.pages.length}`);
    const paths = manifest.pages.map((p) => p.routePath);
    assert(paths.includes("/about"), `paths: ${paths.join(", ")}`);
    assert(paths.includes("/concerts/trending"), `paths: ${paths.join(", ")}`);
    assert(paths.some((p) => p.includes("city")), `dynamic city route: ${paths.join(", ")}`);
    // The login segment is BOTH a page (GET/render) and an API route (POST action) — the
    // migration's page-action `route.ts`. denext dispatch serves each by method.
    assert(paths.includes("/login"), `login is a page: ${paths.join(", ")}`);
    assert(
      manifest.api.some((a) => a.routePath === "/login"),
      `login is also an API route: ${manifest.api.map((a) => a.routePath).join(", ")}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
