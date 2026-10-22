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

/**
 * A written file's golden name: `<where>/<path with "/" as "~">.golden`, one level deep, so a path
 * through a directory the repo ignores (`out/`) is still committed.
 */
function goldenName(key: string): string {
  const [where, ...rest] = key.split("/");
  return `${where}/${rest.join("~")}.golden`;
}

/** Compare (or, with DENEXT_UPDATE_GOLDEN=1, rewrite) every written file against the golden dir. */
async function assertGolden(preset: string, files: Map<string, string>): Promise<void> {
  const dir = join(GOLDEN, preset);
  if (UPDATE) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    for (const [name, contents] of files) {
      const target = join(dir, goldenName(name));
      await Deno.mkdir(join(target, ".."), { recursive: true });
      await Deno.writeTextFile(target, contents);
    }
  }
  const expected: string[] = [];
  for await (const e of walk(dir, { includeDirs: false, exts: [".golden"] })) {
    expected.push(relative(dir, e.path).replaceAll("\\", "/"));
  }
  assertEquals(
    [...files.keys()].map(goldenName).sort(),
    expected.sort(),
    `${preset}: the files it writes`,
  );
  for (const [name, contents] of files) {
    assertEquals(contents, await Deno.readTextFile(join(dir, goldenName(name))), name);
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

Deno.test("deploy preset generic-host: the unit serves on denext's toolchain from the app's DENO_DIR", async () => {
  // Up to 4.5.0 the unit ran `/usr/local/bin/deno` (stock: no Deno.SQL) and resolved JSR from the
  // service user's home at start, which ProtectHome / ProtectSystem=strict hide or make read-only.
  const { paths, manifest } = await fixtureManifest();
  try {
    const { ctx, files } = recordingContext(manifest, paths.projectDir);
    await genericHost({ name: "shop", domain: "shop.example.com" }).prepare(ctx);
    const unit = files.get("output/shop.service") ?? "";
    assertStringIncludes(unit, "Environment=DENO_DIR=/srv/shop/.deno\n");
    assertStringIncludes(unit, "ExecStart=/srv/shop/.deno/bin/deno run ");
    const build = files.get("output/build.sh") ?? "";
    assertStringIncludes(build, "export DENO_DIR=/srv/shop/.deno\n");
    assertStringIncludes(build, "deno task build\n");
    assertStringIncludes(
      build,
      `ln -sf "$(deno run -A 'jsr:@denext/denext@^4.1.0/cli' toolchain path)" "/srv/shop/.deno/bin/deno"`,
    );
    // A compiled build embeds the toolchain's runtime: the unit runs the executable, no script.
    const compiled = recordingContext(
      { ...manifest, compile: { output: "dist/shop", permissions: [] } },
      paths.projectDir,
    );
    await genericHost({ name: "shop", domain: "shop.example.com" }).prepare(compiled.ctx);
    assertStringIncludes(
      compiled.files.get("output/shop.service") ?? "",
      "ExecStart=/srv/shop/shop --host 127.0.0.1\n",
    );
    assertEquals(compiled.files.has("output/build.sh"), false);
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy preset generic-host: no domain bakes in no example.com; env.example is filled", async () => {
  // Up to 4.5.0 a missing domain wrote DENEXT_CANONICAL_ORIGIN=https://example.com into the unit
  // and `server_name example.com` into nginx, and env.example listed only the app's own reads.
  const { paths, manifest } = await fixtureManifest();
  try {
    const { ctx, files, warnings } = recordingContext(manifest, paths.projectDir);
    await genericHost({ name: "shop" }).prepare(ctx);
    for (const [name, text] of files) assert(!text.includes("example.com"), `${name}:\n${text}`);
    const unit = files.get("output/shop.service") ?? "";
    assert(!unit.includes("Environment=DENEXT_CANONICAL_ORIGIN"), "read from the env file instead");
    assertStringIncludes(files.get("output/nginx.conf") ?? "", "server_name _;");
    assert(
      warnings.some((w) => w.includes("no domain") && w.includes("--domain")),
      warnings.join("\n"),
    );
    const env = files.get("output/env.example") ?? "";
    assertStringIncludes(env, "\nDENEXT_CANONICAL_ORIGIN=\n");
    assertStringIncludes(env, "\n# DENEXT_SHUTDOWN_DRAIN_MS=10000\n");
    // The prepare environment's canonical origin names the domain when no option does.
    const fromEnv = recordingContext(manifest, paths.projectDir, {
      vars: { DENEXT_CANONICAL_ORIGIN: "https://shop.example.org" },
    });
    await genericHost({ name: "shop" }).prepare(fromEnv.ctx);
    assertStringIncludes(
      fromEnv.files.get("output/shop.service") ?? "",
      "Environment=DENEXT_CANONICAL_ORIGIN=https://shop.example.org\n",
    );
    assertEquals(fromEnv.warnings.filter((w) => w.includes("no domain")), []);
    // A secret the app reads says how long it must be.
    const secrets = recordingContext(
      {
        ...manifest,
        env: [{
          name: "SESSION_SECRET",
          required: true,
          public: false,
          sources: ["lib/session.ts"],
        }],
      },
      paths.projectDir,
    );
    await genericHost({ name: "shop", domain: "shop.example.org" }).prepare(secrets.ctx);
    assertStringIncludes(
      secrets.files.get("output/env.example") ?? "",
      "at least 32 random characters",
    );
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy: --domain reaches the generic-host preset, and only it", () => {
  const paths = { projectDir: "/p", config: {} } as unknown as ProjectPaths;
  assertEquals(
    resolveDeployAdapter(paths, "generic-host", { domain: "shop.example.org" })?.name,
    "generic-host",
  );
  assertThrows(() => resolveDeployAdapter(paths, "docker", { domain: "x.org" }), Error, "--domain");
  assertThrows(
    () => resolveDeployAdapter(paths, undefined, { domain: "x.org" }),
    Error,
    "--domain",
  );
});

Deno.test("deploy presets generic-host / fly: per-address limits work behind the proxy they generate", async () => {
  // Up to 4.5.0 neither set the proxy trust, so every request came from the proxy's
  // loopback/private address and rateLimit(), auth's per-IP budgets and Live's per-IP cap were
  // silently skipped.
  const { paths, manifest } = await fixtureManifest();
  try {
    const host = recordingContext(manifest, paths.projectDir);
    await genericHost({ name: "shop", domain: "shop.example.org" }).prepare(host.ctx);
    const unit = host.files.get("output/shop.service") ?? "";
    assertStringIncludes(unit, "Environment=DENEXT_TRUST_PROXY=1\n");
    // Trusting the forwarded headers is safe only while clients can't reach the server directly.
    assertStringIncludes(unit, " start . --host 127.0.0.1\n");
    const nginx = host.files.get("output/nginx.conf") ?? "";
    // nginx overwrites the client's own X-Forwarded-For instead of appending to it.
    assertStringIncludes(nginx, "proxy_set_header X-Forwarded-For $remote_addr;");
    assert(!nginx.includes("$proxy_add_x_forwarded_for"), nginx);
    const flyCtx = recordingContext(manifest, paths.projectDir);
    await fly({ app: "shop", denoTag: "2.9.7" }).prepare(flyCtx.ctx);
    const flyToml = flyCtx.files.get("project/fly.toml") ?? "";
    assertStringIncludes(flyToml, 'DENEXT_TRUST_PROXY = "1"');
    assertStringIncludes(flyToml, 'DENEXT_RATE_LIMIT_HEADER = "fly-client-ip"');
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
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

Deno.test("deploy runner: an adapter name can't point its emptied output directory elsewhere", async () => {
  const { paths, manifest } = await fixtureManifest();
  try {
    await Deno.writeTextFile(join(paths.projectDir, "keep.txt"), "x");
    for (const name of ["../..", "..", "", "a/b", "a\\b", "/abs", ".hidden", "a..b"]) {
      const adapter: DeployAdapter = { name, prepare: () => {} };
      await assertRejects(
        () => runDeployPrepare({ paths, manifest, adapter, log: () => {} }),
        Error,
        "deploy adapter's name",
        name,
      );
    }
    assertEquals(await Deno.readTextFile(join(paths.projectDir, "keep.txt")), "x");
    const ok: DeployAdapter = { name: "my-host_2.0", prepare: () => {} };
    await runDeployPrepare({ paths, manifest, adapter: ok, log: () => {} });
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy preset generic-host: an option can't add a directive to the unit or proxy files", async () => {
  const { paths, manifest } = await fixtureManifest();
  try {
    const bad: Array<Parameters<typeof genericHost>[0]> = [
      { domain: "example.com;\n  location /admin { allow all; }" },
      { domain: "example.com\nimport /etc/passwd" },
      { directory: "/srv/app\nExecStartPre=/bin/sh -c id" },
      { directory: "/srv/my app" },
      { directory: "srv/app" },
      { directory: "/srv/../etc" },
      { deno: "/usr/bin/deno --allow-all" },
      { user: "root\nUser=root" },
      { port: 0 },
      { port: 3000.5 },
      { maxConnections: -1 },
    ];
    for (const options of bad) {
      const { ctx } = recordingContext(manifest, paths.projectDir);
      await assertRejects(
        () => Promise.resolve(genericHost(options).prepare(ctx)),
        Error,
        "generic-host",
        JSON.stringify(options),
      );
    }
    const { ctx, files } = recordingContext(manifest, paths.projectDir);
    await genericHost({ domain: "*.shop.example.com", directory: "/srv/shop-2", user: "_shop" })
      .prepare(ctx);
    assertStringIncludes(files.get("output/Caddyfile") ?? "", "*.shop.example.com {");
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});

Deno.test("deploy presets fly / docker: options can't add lines to fly.toml or the Dockerfile", async () => {
  const { paths, manifest } = await fixtureManifest();
  try {
    const { ctx, files } = recordingContext(manifest, paths.projectDir);
    await fly({ region: 'ams"\n[mounts]\nsource = "x', memory: "1gb", denoTag: "2.9.7" })
      .prepare(ctx);
    const flyToml = files.get("project/fly.toml") ?? "";
    assertStringIncludes(flyToml, 'primary_region = "ams\\"\\n[mounts]\\nsource = \\"x"');
    assert(!/^\[mounts\]/m.test(flyToml), flyToml);
    for (const options of [{ denoTag: "2.9.7\nRUN curl x | sh" }, { port: 0 }, { port: 70000 }]) {
      const { ctx } = recordingContext(manifest, paths.projectDir);
      await assertRejects(() => Promise.resolve(docker(options).prepare(ctx)), Error, "invalid --");
    }
    const { ctx: ctx2 } = recordingContext(manifest, paths.projectDir);
    await assertRejects(
      () => Promise.resolve(fly({ port: "8080\nx" as unknown as number }).prepare(ctx2)),
      Error,
    );
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

Deno.test("deploy preset generic-host: the toolchain's unit listens only on its port (split --allow-net)", async () => {
  // Up to 4.6.0 the unit's server ran with the unscoped --allow-net: any dependency could open a
  // listener. The toolchain (3.0.0-rc.2+) splits the grant by direction.
  const { paths, manifest } = await fixtureManifest();
  try {
    const unit = async (m: DeployManifest, options: Parameters<typeof genericHost>[0]) => {
      const { ctx, files } = recordingContext(m, paths.projectDir);
      await genericHost(options).prepare(ctx);
      return /^ExecStart=(.*)$/m.exec(files.get("output/shop.service") ?? "")?.[1] ?? "";
    };
    const port = await unit(manifest, { name: "shop", domain: "shop.example.com", port: 8080 });
    assertStringIncludes(port, " --allow-net-connect --allow-net-listen=127.0.0.1:8080 ");
    assert(!/--allow-net( |=)/.test(port), port);
    // compile.permissions' directions win (the manifest carries them).
    const scoped = await unit(
      {
        ...manifest,
        permissions: { ...manifest.permissions, net: { connect: ["db:5432"], listen: [":9000"] } },
      },
      { name: "shop", domain: "shop.example.com" },
    );
    assertStringIncludes(scoped, " --allow-net-connect=db:5432 --allow-net-listen=:9000 ");
    // A Deno of the operator's choosing may be stock: the unscoped --allow-net stays.
    const own = await unit(manifest, {
      name: "shop",
      domain: "shop.example.com",
      deno: "/usr/local/bin/deno",
    });
    assertStringIncludes(own, "/usr/local/bin/deno run --allow-net --allow-read ");
    // So does a manifest from a build before the field, or one under compile.permissions: "all".
    const old = await unit(
      { ...manifest, permissions: { ...manifest.permissions, net: null } },
      { name: "shop", domain: "shop.example.com" },
    );
    assertStringIncludes(old, " run --allow-net --allow-read ");
  } finally {
    await Deno.remove(paths.projectDir, { recursive: true });
  }
});
