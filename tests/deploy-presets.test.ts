// The deploy presets' output against golden files (tests/fixtures/deploy/golden/<preset>/), the
// static preset's refusal, the deploy steps' credential checks, and the runner's write rules
// (a hand-edited project file is never clobbered; no path leaves its root; a dry run writes
// nothing). Refresh the goldens deliberately with
// `DENEXT_UPDATE_GOLDEN=1 deno test -A tests/deploy-presets.test.ts`.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { walk } from "@std/fs";
import { fromFileUrl, join, relative } from "@std/path";
import { collectDeployManifest } from "../src/build/deploy-manifest.ts";
import {
  createDeployContext,
  resolveDeployAdapter,
  runDeployPrepare,
  runDeployPush,
} from "../src/build/deploy-run.ts";
import type { ProjectPaths } from "../src/build/paths.ts";
import type { DeployAdapter, DeployContext, DeployWriteOptions } from "../src/deploy/adapter.ts";
import type { DeployManifest } from "../src/deploy/manifest.ts";
import { denoDeploy, docker, fly, genericHost, staticHost } from "../src/deploy/mod.ts";
import { PRESET_NAMES } from "../src/deploy/presets.ts";
import { staticRefusal } from "../src/deploy/presets/static.ts";
import { fixtureProject } from "./helpers/deploy-fixture.ts";

const GOLDEN = fromFileUrl(new URL("./fixtures/deploy/golden/", import.meta.url));
const UPDATE = Deno.env.get("DENEXT_UPDATE_GOLDEN") === "1";

/** A context that records what an adapter writes, logs and runs, and touches nothing. */
function recordingContext(
  manifest: DeployManifest,
  projectDir: string,
  over: Partial<DeployContext> & { vars?: Record<string, string> } = {},
) {
  const files = new Map<string, string>();
  const warnings: string[] = [];
  const runs: string[][] = [];
  const ctx: DeployContext = {
    manifest,
    projectDir,
    outDir: join(projectDir, ".denext", "deploy", "x"),
    dryRun: false,
    writeFile: (path: string, contents: string, options: DeployWriteOptions = {}) => {
      files.set(`${options.in === "project" ? "project" : "output"}/${path}`, contents);
      return Promise.resolve(true);
    },
    log: () => {},
    warn: (m) => void warnings.push(m),
    env: (name) => over.vars?.[name],
    which: (...names) => Promise.resolve(`/usr/bin/${names[0]}`),
    run: (command) => {
      runs.push([...command]);
      return Promise.resolve(0);
    },
    exportStatic: () => Promise.resolve(join(projectDir, "out")),
    ...over,
  };
  return { ctx, files, warnings, runs };
}

/** The fixture's manifest (framework version normalized, so goldens survive a release). */
async function fixtureManifest(): Promise<{ paths: ProjectPaths; manifest: DeployManifest }> {
  const paths = await fixtureProject();
  const manifest = await collectDeployManifest(paths);
  return { paths, manifest: { ...manifest, denext: "4.1.0" } };
}

/** Compare (or, with DENEXT_UPDATE_GOLDEN=1, rewrite) every written file against the golden dir. */
async function assertGolden(preset: string, files: Map<string, string>): Promise<void> {
  const dir = join(GOLDEN, preset);
  if (UPDATE) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    for (const [name, contents] of files) {
      const target = join(dir, `${name}.golden`);
      await Deno.mkdir(join(target, ".."), { recursive: true });
      await Deno.writeTextFile(target, contents);
    }
  }
  const expected: string[] = [];
  for await (const e of walk(dir, { includeDirs: false, exts: [".golden"] })) {
    expected.push(relative(dir, e.path).replaceAll("\\", "/").replace(/\.golden$/, ""));
  }
  assertEquals([...files.keys()].sort(), expected.sort(), `${preset}: the files it writes`);
  for (const [name, contents] of files) {
    assertEquals(contents, await Deno.readTextFile(join(dir, `${name}.golden`)), name);
  }
}

/** Run one preset's prepare over the fixture and check its files against the golden. */
async function checkPreset(adapter: DeployAdapter, golden: string): Promise<string[]> {
  const { paths, manifest } = await fixtureManifest();
  try {
    const { ctx, files, warnings } = recordingContext(manifest, paths.projectDir);
    await adapter.prepare(ctx);
    await assertGolden(golden, files);
    return warnings;
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
}

Deno.test("deploy preset docker: the generate-docker files at the project root", async () => {
  await checkPreset(docker({ denoTag: "2.9.7" }), "docker");
});

Deno.test("deploy preset fly: Dockerfile + fly.toml, always-on with schedules", async () => {
  const warnings = await checkPreset(
    fly({ app: "my-app", region: "ams", denoTag: "2.9.7" }),
    "fly",
  );
  assert(warnings.some((w) => w.includes("every machine runs the schedules")), warnings.join("\n"));
});

Deno.test("deploy preset deno-deploy: the entry maps cron + KV; app settings", async () => {
  const warnings = await checkPreset(denoDeploy({ org: "acme", app: "shop" }), "deno-deploy");
  assert(warnings.some((w) => w.includes("Deno.SQL")), "DATABASE_URL → the stock-Deno warning");
  assert(warnings.some((w) => w.includes("services/")), "services → the isolate warning");
});

Deno.test("deploy preset generic-host: systemd unit, nginx, Caddy, env example", async () => {
  await checkPreset(genericHost({ name: "shop", domain: "shop.example.com" }), "generic-host");
});

Deno.test("deploy preset static: refuses an app with server routes, listing each", async () => {
  const { paths, manifest } = await fixtureManifest();
  try {
    const { ctx, files } = recordingContext(manifest, paths.projectDir);
    const err = await assertRejects(() => Promise.resolve(staticHost().prepare(ctx)), Error);
    for (const route of ["/account", "/live", "/users/[id]", "/feed", "/api/hello", "*"]) {
      assertStringIncludes(err.message, `    ${route}  `);
    }
    assert(!err.message.includes("/blog/[slug]  "), "a static route is not listed");
    assert(!err.message.includes("/sitemap.xml"), "a metadata route is a warning, not a refusal");
    assertEquals(files.size, 0, "nothing is exported or written");
    assertEquals(staticRefusal({ ...manifest, routes: [] }), null);
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy preset static: an export-only app is exported with _headers", async () => {
  const { paths, manifest } = await fixtureManifest();
  try {
    const exportOnly = { ...manifest, routes: manifest.routes.filter((r) => r.kind === "static") };
    let exported = 0;
    const { ctx, files, warnings } = recordingContext(exportOnly, paths.projectDir, {
      exportStatic: () => (exported++, Promise.resolve(join(paths.projectDir, "out"))),
    });
    await staticHost().prepare(ctx);
    assertEquals(exported, 1);
    await assertGolden("static", files);
    assert(warnings.some((w) => w.includes("jobs/ never run")));
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy steps read credentials from the environment only", async () => {
  const { paths, manifest } = await fixtureManifest();
  try {
    const bare = recordingContext(manifest, paths.projectDir);
    await assertRejects(() => Promise.resolve(fly().deploy!(bare.ctx)), Error, "FLY_API_TOKEN");
    await assertRejects(
      () => Promise.resolve(denoDeploy().deploy!(bare.ctx)),
      Error,
      "DENO_DEPLOY_TOKEN",
    );
    assertEquals(bare.runs, [], "nothing ran without credentials");
    const withToken = recordingContext(manifest, paths.projectDir, {
      vars: { FLY_API_TOKEN: "t", DENO_DEPLOY_TOKEN: "t" },
    });
    await fly().deploy!(withToken.ctx);
    await denoDeploy({ org: "acme", app: "shop" }).deploy!(withToken.ctx);
    assertEquals(withToken.runs[0], [
      "/usr/bin/flyctl",
      "deploy",
      "--config",
      "fly.toml",
      "--remote-only",
    ]);
    assertEquals(withToken.runs[1].slice(1), [
      "deploy",
      "--non-interactive",
      "--org",
      "acme",
      "--app",
      "shop",
      "--prod",
    ]);
    for (const run of withToken.runs) assert(!run.includes("t"), "a token never reaches argv");
    await docker({ image: "registry.example.com/shop", push: true }).deploy!(withToken.ctx);
    assertEquals(withToken.runs.slice(2), [
      ["/usr/bin/docker", "build", "-t", "registry.example.com/shop", "."],
      ["/usr/bin/docker", "push", "registry.example.com/shop"],
    ]);
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy runner: project files are never clobbered unless generated", async () => {
  const { paths, manifest } = await fixtureManifest();
  try {
    const lines: string[] = [];
    const adapter: DeployAdapter = { name: "t", prepare: () => {} };
    const ctx = createDeployContext({ paths, manifest, adapter, log: (l) => lines.push(l) });
    await Deno.writeTextFile(join(paths.projectDir, "fly.toml"), "# mine\n");
    assertEquals(await ctx.writeFile("fly.toml", "new", { in: "project", marker: "MARK" }), false);
    assertEquals(await Deno.readTextFile(join(paths.projectDir, "fly.toml")), "# mine\n");
    assert(lines.some((l) => l.includes("left") && l.includes("--force")), lines.join("\n"));
    await Deno.writeTextFile(join(paths.projectDir, "fly.toml"), "# MARK old\n");
    assertEquals(
      await ctx.writeFile("fly.toml", "# MARK new\n", { in: "project", marker: "MARK" }),
      true,
    );
    const forced = createDeployContext({ paths, manifest, adapter, force: true, log: () => {} });
    await Deno.writeTextFile(join(paths.projectDir, "fly.toml"), "# mine\n");
    assertEquals(await forced.writeFile("fly.toml", "x", { in: "project", marker: "MARK" }), true);
    await assertRejects(() => ctx.writeFile("x", "y", { in: "project" }), Error, "marker");
    for (const bad of ["../escape", "/abs", "a/../b", "a\\b", ""]) {
      await assertRejects(() => ctx.writeFile(bad, "x"), Error, "relative");
    }
    assert(await ctx.writeFile("nested/file.txt", "ok"));
    assertEquals(await Deno.readTextFile(join(ctx.outDir, "nested", "file.txt")), "ok");
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy runner: a dry run writes and runs nothing", async () => {
  const { paths, manifest } = await fixtureManifest();
  try {
    const lines: string[] = [];
    await runDeployPrepare({
      paths,
      manifest,
      adapter: genericHost(),
      dryRun: true,
      log: (l) => lines.push(l),
    });
    assert(lines.some((l) => l.includes("would write")), lines.join("\n"));
    await assertRejects(() => Deno.stat(join(paths.outDir, "deploy")), Deno.errors.NotFound);
    const ctx = createDeployContext({
      paths,
      manifest,
      adapter: genericHost(),
      dryRun: true,
      log: () => {},
    });
    assertEquals(await ctx.run(["false"]), 0);
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy runner: adapter resolution and a missing deploy step", async () => {
  const { paths, manifest } = await fixtureManifest();
  try {
    assertEquals(PRESET_NAMES, ["docker", "fly", "deno-deploy", "generic-host", "static"]);
    for (const name of PRESET_NAMES) assertEquals(resolveDeployAdapter(paths, name)?.name, name);
    assertThrows(() => resolveDeployAdapter(paths, "vercel"), Error, "unknown deploy preset");
    assertEquals(resolveDeployAdapter(paths), null, "nothing configured");
    const own: DeployAdapter = { name: "mine", prepare: () => {} };
    const configured = { ...paths, config: { deploy: { adapter: own } } };
    assertEquals(resolveDeployAdapter(configured), own);
    await assertRejects(
      () => runDeployPush({ paths, manifest, adapter: own, log: () => {} }),
      Error,
      "has no deploy step",
    );
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});
