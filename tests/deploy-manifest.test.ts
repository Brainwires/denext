// The deploy manifest (`.denext/deploy-manifest.json`): its schema, its stability (the same tree
// writes the same bytes), and every fact it records about tests/fixtures/deploy-app — pinned by
// tests/fixtures/deploy/manifest.json.golden. Refresh the golden deliberately with
// `DENEXT_UPDATE_GOLDEN=1 deno test -A tests/deploy-manifest.test.ts`.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  collectDeployManifest,
  readDeployManifest,
  serializeDeployManifest,
  writeDeployManifest,
} from "../src/build/deploy-manifest.ts";
import {
  DEPLOY_MANIFEST_FILE,
  DEPLOY_MANIFEST_VERSION,
  type DeployManifest,
  type DeployRouteKind,
} from "../src/deploy/manifest.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { handlerMethods, jobSchedules, middlewareMatcher } from "../src/build/deploy-scan.ts";
import { fixtureProject } from "./helpers/deploy-fixture.ts";
import { applyPlugins, resetPlugins } from "../src/plugin/mod.ts";

const GOLDEN = fromFileUrl(new URL("./fixtures/deploy/manifest.json.golden", import.meta.url));

/** The manifest with the framework version normalized (it changes every release). */
function normalized(manifest: DeployManifest): string {
  return serializeDeployManifest({ ...manifest, denext: "<version>" });
}

Deno.test("deploy manifest: the fixture's manifest matches the golden", async () => {
  const paths = await fixtureProject();
  try {
    const manifest = await collectDeployManifest(paths, {
      compile: {
        output: "dist/app",
        target: "x86_64-unknown-linux-gnu",
        permissions: ["--allow-net"],
      },
    });
    const actual = normalized(manifest);
    if (Deno.env.get("DENEXT_UPDATE_GOLDEN") === "1") await Deno.writeTextFile(GOLDEN, actual);
    assertEquals(actual, await Deno.readTextFile(GOLDEN));
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy manifest: two collections of one tree are byte-identical", async () => {
  const paths = await fixtureProject();
  try {
    const a = serializeDeployManifest(await collectDeployManifest(paths));
    const b = serializeDeployManifest(await collectDeployManifest(paths));
    assertEquals(a, b);
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

/** The top-level fields of version 1, in order: adding one is fine, removing one is a break. */
const V1_FIELDS = [
  "version",
  "denext",
  "mode",
  "basePath",
  "trailingSlash",
  "i18n",
  "routes",
  "assets",
  "server",
  "jobs",
  "schedules",
  "services",
  "env",
  "permissions",
  "images",
  "cache",
  "compile",
];

Deno.test("deploy manifest: the version-1 schema — fields, kinds, sorted lists", async () => {
  const paths = await fixtureProject();
  try {
    const manifest = await collectDeployManifest(paths);
    assertEquals(DEPLOY_MANIFEST_VERSION, 1);
    assertEquals(manifest.version, 1);
    assertEquals(Object.keys(manifest), V1_FIELDS);
    const kinds: DeployRouteKind[] = ["static", "isr", "dynamic", "route-handler", "middleware"];
    for (const route of manifest.routes) assert(kinds.includes(route.kind), route.path);
    const keys = manifest.routes.map((r) => r.path);
    assertEquals(keys, [...keys].sort());
    assertEquals(manifest.env.map((v) => v.name), manifest.env.map((v) => v.name).sort());
    for (const group of manifest.assets) {
      assert(!group.files.some((f) => f.endsWith(".gz")), "precompressed siblings are left out");
      assert(!group.dir.startsWith("/") && !group.dir.includes("\\"), group.dir);
    }
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy manifest: every route kind is classified from the sources", async () => {
  const paths = await fixtureProject();
  try {
    const manifest = await collectDeployManifest(paths);
    const kind = Object.fromEntries(manifest.routes.map((r) => [r.path, r.kind]));
    assertEquals(kind["/"], "static");
    assertEquals(kind["/blog/[slug]"], "static", "generateStaticParams makes it static");
    assertEquals(kind["/feed"], "isr");
    assertEquals(kind["/account"], "dynamic", "cookies()");
    assertEquals(kind["/live"], "dynamic", "force-dynamic");
    assertEquals(kind["/users/[id]"], "dynamic", "a dynamic segment without params");
    assertEquals(kind["/api/hello"], "route-handler");
    assertEquals(kind["/sitemap.xml"], "route-handler");
    assertEquals(kind["*"], "middleware");
    const feed = manifest.routes.find((r) => r.path === "/feed");
    assertEquals(feed?.revalidate, 60);
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy manifest: written atomically, read back, another version refused", async () => {
  const paths = await fixtureProject();
  try {
    const written = await writeDeployManifest(paths);
    const file = join(paths.outDir, DEPLOY_MANIFEST_FILE);
    assertEquals(await Deno.readTextFile(file), serializeDeployManifest(written));
    assertEquals(await readDeployManifest(paths.outDir), written);
    await Deno.writeTextFile(file, JSON.stringify({ ...written, version: 2 }));
    assertEquals(await readDeployManifest(paths.outDir), null, "a future version is not read");
    await Deno.remove(file);
    assertEquals(await readDeployManifest(paths.outDir), null);
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy manifest: an SPA has no routes and no image optimizer", async () => {
  const paths = await fixtureProject({ mode: "spa" } as DenextConfig);
  try {
    const manifest = await collectDeployManifest({ ...paths, middlewarePath: null });
    assertEquals(manifest.mode, "spa");
    assertEquals(manifest.routes, []);
    assertEquals(manifest.images.optimizer, false);
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy manifest: a plugin's routes (addDeployRoutes) are sorted in", async () => {
  const paths = await fixtureProject();
  resetPlugins();
  try {
    await applyPlugins({
      projectRoot: paths.projectDir,
      appDir: paths.appDir,
      config: {
        plugins: [{
          name: "router-plugin",
          setup(ctx) {
            ctx.addDeployRoutes?.(() =>
              Promise.resolve([
                { path: "/_rpc/abc", kind: "route-handler", source: "src/fns.ts", reason: "rpc" },
                { path: "/about", kind: "static", source: "src/routes/about.tsx" },
              ])
            );
          },
        }],
      },
      mode: "build",
      load: () => Promise.resolve({}),
    });
    const { routes } = await collectDeployManifest(paths);
    const plugin = routes.filter((r) => r.source.startsWith("src/"));
    assertEquals(plugin.map((r) => [r.path, r.kind]), [
      ["/_rpc/abc", "route-handler"],
      ["/about", "static"],
    ]);
    const keys = routes.map((r) => `${r.path}\0${r.kind}`);
    assertEquals(keys, [...keys].sort(), "sorted with the App Router's");
  } finally {
    resetPlugins();
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy manifest: a plugin's asset groups (addDeployAssets) are listed", async () => {
  const paths = await fixtureProject();
  resetPlugins();
  try {
    await applyPlugins({
      projectRoot: paths.projectDir,
      appDir: paths.appDir,
      config: {
        plugins: [{
          name: "asset-plugin",
          setup(ctx) {
            ctx.addDeployAssets?.(() =>
              Promise.resolve([
                {
                  urlPrefix: "/_rpc/",
                  dir: ".denext/rpc",
                  cacheControl: "no-cache",
                  immutable: false,
                  files: ["entry.js"],
                },
                // A group with no files is left out, as the core's are.
                {
                  urlPrefix: "/_none/",
                  dir: ".denext/none",
                  cacheControl: "no-cache",
                  immutable: false,
                  files: [],
                },
              ])
            );
          },
        }],
      },
      mode: "build",
      load: () => Promise.resolve({}),
    });
    const { assets } = await collectDeployManifest(paths);
    assertEquals(
      assets.filter((g) => g.urlPrefix.startsWith("/_rpc/") || g.urlPrefix === "/_none/"),
      [
        {
          urlPrefix: "/_rpc/",
          dir: ".denext/rpc",
          cacheControl: "no-cache",
          immutable: false,
          files: ["entry.js"],
        },
      ],
    );
  } finally {
    resetPlugins();
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy scans: handler methods, the middleware matcher, a job's schedules", () => {
  assertEquals(
    handlerMethods(
      "export async function GET() {}\nexport const POST = () => {};\nexport { handler as DELETE };",
    ),
    ["GET", "POST", "DELETE"],
  );
  assertEquals(middlewareMatcher('export const config = { matcher: "/admin/:path*" };'), [
    "/admin/:path*",
  ]);
  assertEquals(middlewareMatcher("export const config = { matcher: paths };"), undefined);
  assertEquals(jobSchedules('defineJob({ schedule: ["0 1 * * *", "0 2 * * *"] })'), [
    "0 1 * * *",
    "0 2 * * *",
  ]);
  assertEquals(jobSchedules("defineJob({ handler })"), []);
});
