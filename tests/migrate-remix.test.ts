// `denext migrate --from remix` — the assisted Remix source path.
//
// Unlike the Next/Vite/CRA paths (config-only), the Remix path physically transforms
// the route tree: `app/routes/*` → denext `app/**/page.tsx`+`layout.tsx`, `app/root.tsx`
// → `app/layout.tsx`, `entry.*` deleted, and `loader`/`action` scaffolded into Server
// Components. These tests run the real transform over a fixture Remix app (copied to a
// temp dir so the committed fixture stays pristine) and assert the restructure + the
// mechanical rewrites + the assisted-migration counts, then confirm `scanRoutes` finds
// the resulting denext routes.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";
import { parseRemixStem, transformRemixSource } from "../src/build/remix-migrate.ts";
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
  assertEquals(parseRemixStem("concerts.trending"), {
    segments: ["concerts", "trending"],
    isIndex: false,
    warnings: [],
  });
  assertEquals(parseRemixStem("concerts._index"), {
    segments: ["concerts"],
    isIndex: true,
    warnings: [],
  });
  assertEquals(parseRemixStem("concerts.$city"), {
    segments: ["concerts", "[city]"],
    isIndex: false,
    warnings: [],
  });
  assertEquals(parseRemixStem("$"), { segments: ["[...splat]"], isIndex: false, warnings: [] });
  assertEquals(parseRemixStem("files.$"), {
    segments: ["files", "[...splat]"],
    isIndex: false,
    warnings: [],
  });

  // Pathless `_auth` → a `(auth)` route group (adds no URL segment), flagged.
  const auth = parseRemixStem("_auth.login");
  assertEquals(auth.segments, ["(auth)", "login"]);
  assert(auth.warnings.some((w) => w.includes("route group")));

  // Trailing `_` break-out is flattened + flagged.
  const brk = parseRemixStem("dashboard_.settings");
  assertEquals(brk.segments, ["dashboard", "settings"]);
  assert(brk.warnings.some((w) => w.includes("break-out")));

  // `[.]` escape → a literal dot in the segment.
  assertEquals(parseRemixStem("sitemap[.]xml"), {
    segments: ["sitemap.xml"],
    isIndex: false,
    warnings: [],
  });
});

Deno.test("transformRemixSource: loader inversion + import split + json unwrap", () => {
  const src = [
    `import { json } from "@remix-run/node";`,
    `import { Link, useLoaderData } from "@remix-run/react";`,
    `export function loader() { return json({ n: 1 }); }`,
    `export default function P() {`,
    `  const data = useLoaderData<typeof loader>();`,
    `  return <Link to="/x">{data.n}</Link>;`,
    `}`,
  ].join("\n");
  const t = transformRemixSource(src, { kind: "page" });
  assert(t.hasLoader);
  assert(!t.hasAction);
  // useLoaderData → await loader(); default component made async.
  assertStringIncludes(t.code, "export default async function P(");
  assertStringIncludes(t.code, "await loader()");
  assert(
    !/useLoaderData\s*[<(]/.test(t.code),
    "useLoaderData call removed (the word may remain in the TODO banner)",
  );
  // Clean names map to denext; usage-removed names (useLoaderData) dropped from the import.
  assertStringIncludes(t.code, `import { Link } from "denext"`);
  // Remix <Link to=> → denext <Link href=>.
  assertStringIncludes(t.code, `href="/x"`);
  // json() unwrapped (no HTTP Response in a Server Component).
  assert(!t.code.includes("json({"), "json() call unwrapped");
  // Assisted banner present.
  assertStringIncludes(t.code, "TODO(denext migrate)");
});

Deno.test("transformRemixSource: action → use server; root strips doc tags + Outlet", () => {
  const action = [
    `import { json } from "@remix-run/node";`,
    `export async function action({ request }: { request: Request }) {`,
    `  return json({ ok: true });`,
    `}`,
    `export default function Login() { return <form method="post" />; }`,
  ].join("\n");
  const a = transformRemixSource(action, { kind: "page" });
  assert(a.hasAction);
  assertStringIncludes(a.code, '"use server"');

  const root = [
    `import { Links, Meta, Outlet, Scripts } from "@remix-run/react";`,
    `export default function App() {`,
    `  return <html><head><Meta /><Links /></head><body><Outlet /><Scripts /></body></html>;`,
    `}`,
  ].join("\n");
  const r = transformRemixSource(root, { kind: "root" });
  assertStringIncludes(r.code, "{ children }: { children: React.ReactNode }");
  assertStringIncludes(r.code, "{children}");
  assert(!r.code.includes("<Meta"), "Meta stripped");
  assert(!r.code.includes("<Links"), "Links stripped");
  assert(!r.code.includes("<Scripts"), "Scripts stripped");
  assert(!r.code.includes("<Outlet"), "Outlet replaced");
});

Deno.test("migrate --from remix: restructures the route tree + writes denext config", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "denext_remix_" });
  const dir = join(tmp, "app-root");
  try {
    await copy(FIXTURE, dir);

    const r = await migrateProject(dir);
    assertEquals(r.kind, "remix");
    assert(r.remix, "remix report present");
    const m = r.remix!;

    // Route tree restructured to denext conventions.
    const app = join(dir, "app");
    for (
      const rel of [
        "page.tsx", // _index
        "layout.tsx", // root
        "about/page.tsx",
        "concerts/layout.tsx", // concerts.tsx (has children → layout)
        "concerts/page.tsx", // concerts._index
        "concerts/[city]/page.tsx", // $city → [city]
        "concerts/trending/page.tsx",
        "[...splat]/page.tsx", // $ → catch-all
        "(auth)/login/page.tsx", // _auth pathless group
      ]
    ) {
      assert(await exists(join(app, rel)), `expected ${rel}`);
    }

    // The old Remix scaffolding is gone.
    assert(!(await exists(join(app, "routes"))), "app/routes removed");
    assert(!(await exists(join(app, "root.tsx"))), "app/root.tsx removed");
    assert(!(await exists(join(app, "entry.server.tsx"))), "entry.server removed");
    assert(!(await exists(join(app, "entry.client.tsx"))), "entry.client removed");
    assertEquals(m.rootConverted, true);
    assert(m.entriesDeleted.includes("app/entry.server.tsx"));
    assert(m.entriesDeleted.includes("app/entry.client.tsx"));

    // Assisted counts: two loaders (_index, $city), one action (_auth.login).
    assertEquals(m.loaders, 2);
    assertEquals(m.actions, 1);
    assert(m.routesConverted >= 8);

    // Content spot-checks: loader inverted, action scaffolded, layout threads children.
    const cityPage = await Deno.readTextFile(join(app, "concerts/[city]/page.tsx"));
    assertStringIncludes(cityPage, "await loader()");
    assertStringIncludes(cityPage, `import { useParams } from "denext"`);
    const login = await Deno.readTextFile(join(app, "(auth)/login/page.tsx"));
    assertStringIncludes(login, '"use server"');
    const concertsLayout = await Deno.readTextFile(join(app, "concerts/layout.tsx"));
    assertStringIncludes(concertsLayout, "{children}");
    const rootLayout = await Deno.readTextFile(join(app, "layout.tsx"));
    assert(!rootLayout.includes("@remix-run"), "root layout has no Remix imports");

    // denext config written: react aliased to denext, @remix-run/* dropped.
    const deno = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    const imports = deno.imports as Record<string, string>;
    assert(imports["react"]?.includes("denext"), "react → denext");
    assert(!Object.keys(imports).some((k) => k.startsWith("@remix-run/")), "no @remix-run imports");
    assert(r.dropped.includes("@remix-run/react"), "@remix-run/react dropped");
    const cfg = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assertStringIncludes(cfg, "compatibilityMode: true");

    // scanRoutes discovers the migrated routes.
    const manifest = await scanRoutes(app);
    assert(manifest.rootLayout, "root layout discovered");
    assert(manifest.pages.length >= 7, `expected ≥7 pages, got ${manifest.pages.length}`);
    const paths = manifest.pages.map((p) => p.routePath);
    assert(paths.includes("/about"), `paths: ${paths.join(", ")}`);
    assert(paths.includes("/concerts/trending"), `paths: ${paths.join(", ")}`);
    assert(paths.some((p) => p.includes("city")), `dynamic city route: ${paths.join(", ")}`);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
