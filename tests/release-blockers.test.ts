// Regression tests for the pre-2.0.0 blockers found by the release audit: the CSS re-exec
// from a JSR install, version-pinned generated tasks, `/_denext/@fs` containment, the
// soft-navigation body cap, the pages-router range, the bundle failure hint, and the
// stable-release changelog fold.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { entrypointArg, isStandaloneBinary } from "../src/cli/self-exec.ts";
import { scaffoldFiles } from "../src/build/scaffold.ts";
import { PAGES_ROUTER_SPEC } from "../src/build/migrate.ts";
import { bundleFailureMessage, minDepAgeArgs } from "../src/build/bundle.ts";
import { fsPathAllowed } from "../src/build/dev-unbundled/handler.ts";
import { createUnbundledState } from "../src/build/dev-unbundled/state.ts";
import { createApp } from "../src/server/app.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { foldPrereleases, isStable, withLinkRef } from "../scripts/release.ts";
import { VERSION } from "../mod.ts";

Deno.test("self-exec: a JSR/https CLI re-execs its module URL; only a file URL becomes a path", () => {
  assertEquals(
    entrypointArg("https://jsr.io/@denext/denext/2.0.0/cli.ts"),
    "https://jsr.io/@denext/denext/2.0.0/cli.ts",
  );
  assertEquals(entrypointArg("jsr:@denext/denext/cli"), "jsr:@denext/denext/cli");
  assert(entrypointArg("file:///tmp/denext/cli.ts").endsWith("/tmp/denext/cli.ts"));
  // Tests never run inside a compiled binary.
  assertEquals(isStandaloneBinary(), false);
});

Deno.test("scaffold: generated tasks pin the CLI to the same range as the `denext` import", () => {
  const files = scaffoldFiles({ name: "app", dir: "/tmp/app" } as never);
  const denoJson = JSON.parse(files.find((f) => f.path === "deno.json")!.content) as {
    tasks: Record<string, string>;
    imports: Record<string, string>;
  };
  const pin = `jsr:@denext/denext@^${VERSION}`;
  assertEquals(denoJson.imports["denext"], pin);
  for (const task of ["dev", "build", "start"]) {
    assertStringIncludes(denoJson.tasks[task], `${pin}/cli`);
    assert(!/ jsr:@denext\/denext\/cli /.test(denoJson.tasks[task]), `${task} is unversioned`);
  }
});

Deno.test("migrate: the pages-router range admits the workspace package's current version", async () => {
  const pkg = JSON.parse(await Deno.readTextFile("packages/pages-router/deno.json")) as {
    version: string;
  };
  const range = PAGES_ROUTER_SPEC.split("@^")[1];
  const [rMajor, rMinor] = range.split(".").map(Number);
  const [pMajor, pMinor] = pkg.version.split(".").map(Number);
  // ^0.x.y admits only 0.x.*, so for a 0.x package the minor must match; ≥1.x needs the major.
  if (rMajor === 0) assertEquals(pMinor, rMinor, `^${range} excludes pages-router ${pkg.version}`);
  else assertEquals(pMajor, rMajor);
});

Deno.test("dev @fs: only project files (real paths) or graph-known modules are served", async () => {
  const dir = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  try {
    const realDir = await Deno.realPath(dir);
    await Deno.writeTextFile(join(realDir, "a.ts"), "export const a = 1;");
    await Deno.writeTextFile(join(outside, "secret.json"), "{}");
    await Deno.symlink(join(outside, "secret.json"), join(realDir, "link.json"));
    const st = createUnbundledState({
      projectDir: realDir,
      appDir: realDir,
      configPath: join(realDir, "deno.json"),
      outDir: join(realDir, ".denext"),
    });
    assert(fsPathAllowed(st, join(realDir, "a.ts")), "in-project file");
    assert(!fsPathAllowed(st, "/etc/passwd"), "arbitrary absolute path");
    assert(!fsPathAllowed(st, join(realDir, "..", "..", "etc", "passwd")), "dot-dot escape");
    assert(!fsPathAllowed(st, join(realDir, "link.json")), "symlink pointing outside");
    assert(!fsPathAllowed(st, realDir), "the directory itself");
    // A module the dev graph imported (e.g. a workspace package) is allowed by registration.
    const pkg = join(outside, "secret.json");
    st.importers.set(pkg, new Set([join(realDir, "a.ts")]));
    assert(fsPathAllowed(st, pkg), "graph-known module outside the project");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("soft-nav POST: the echo body is capped (413) instead of buffered unbounded", async () => {
  const app = createApp({
    getManifest: (): RouteManifest => ({
      pages: [],
      api: [],
      rootLayout: null,
      rootNotFound: null,
      rootGlobalError: null,
    }),
    load: () => Promise.resolve({ default: () => null }),
  });
  const big = new Uint8Array(2 * 1024 * 1024);
  const declared = await app(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "x-denext-nav": "1", "content-length": String(big.byteLength) },
      body: big,
    }),
  );
  await declared.body?.cancel();
  assertEquals(declared.status, 413);
  // Chunked (no content-length): the streamed cap still fires.
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(64 * 1024));
      c.close();
    },
  });
  const chunked = await app(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "x-denext-nav": "1" },
      body: stream,
    }),
  );
  await chunked.body?.cancel();
  assertEquals(chunked.status, 413);
});

Deno.test("bundle: DENEXT_MIN_DEP_AGE is forwarded and the new-release failure is explained", () => {
  assertEquals(minDepAgeArgs(undefined), []);
  assertEquals(minDepAgeArgs("0"), ["--min-dep-age=0"]);
  const msg = bundleFailureMessage(
    1,
    "error: Do not know how to load path: deno:jsr:@denext/denext@^2.0.0\n",
  );
  assertStringIncludes(msg, "DENEXT_MIN_DEP_AGE=0");
  assert(!bundleFailureMessage(1, "some other error").includes("minimum-dependency-age"));
});

Deno.test("release: a stable version folds its rc sections into one grouped [X.Y.Z] entry", () => {
  const text = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Changed",
    "",
    "- **Docs.** roadmap tidy.",
    "",
    "## [2.0.0-rc.2] - 2026-09-02",
    "",
    "### Fixed",
    "",
    "- fixed b.",
    "- **Breaking for rc.2.** trailingSlash default flipped.",
    "",
    "## [2.0.0-rc.1] - 2026-09-01",
    "",
    "### Added",
    "",
    "- added a.",
    "  continued line.",
    "- fixed b.",
    "",
    "## [1.4.0] - 2026-08-23",
    "",
    "- old.",
    "",
    "[1.4.0]: https://jsr.io/@denext/denext@1.4.0",
    "",
  ].join("\n");
  assert(isStable("2.0.0") && !isStable("2.0.0-rc.7"));
  const out = withLinkRef(foldPrereleases(text, "2.0.0", "2026-09-05"), "2.0.0");
  assert(!out.includes("## [2.0.0-rc."), "rc headers folded away");
  assertStringIncludes(out, "## [Unreleased]\n\n## [2.0.0] - 2026-09-05");
  const release = out.slice(out.indexOf("## [2.0.0]"), out.indexOf("## [1.4.0]"));
  const order = ["### Breaking", "### Added", "### Changed", "### Fixed"].map((h) =>
    release.indexOf(h)
  );
  assert(order.every((i, n) => i !== -1 && (n === 0 || i > order[n - 1])), `group order: ${order}`);
  assertEquals(release.match(/^- fixed b\./gm)?.length, 1, "identical bullets deduped");
  assertStringIncludes(release, "- added a.\n  continued line.");
  assertStringIncludes(out, "- old.");
  assertStringIncludes(out, "[2.0.0]: https://jsr.io/@denext/denext@2.0.0\n[1.4.0]:");
});
