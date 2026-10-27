// `denext toolchain uninstall <version> | uninstall --all | prune`: the removal plan (what is in
// use is kept), the cache listing and deletion under the cache lock, the project's pinned denext,
// and the real CLI against a temp DENO_DIR — never the machine's own cache.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  diskUsage,
  formatBytes,
  listToolchainCache,
  planToolchainRemoval,
  removeToolchainEntries,
  type ToolchainCacheEntry,
  type ToolchainCacheRoots,
  type ToolchainVersionsInUse,
} from "../src/build/toolchain-prune.ts";
import { projectDenextVersion, toolchainRemove } from "../src/cli/commands/toolchain-prune.ts";
import type { CommandContext } from "../src/cli/command.ts";
import { DENO_TOOLCHAIN } from "../src/build/deno-toolchain.ts";
import { DESKTOP_RUNTIME_PIN } from "../src/build/desktop-runtime.ts";
import { GLEAM_TOOLCHAIN } from "../src/build/gleam-toolchain.ts";
import { FASTLANE_TOOLCHAIN } from "../src/build/fastlane-toolchain.ts";
import { denoCacheDir } from "../src/build/deno-cache-dir.ts";
import { boundedOutput } from "./helpers/bounded-command.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
// The CLI child runs on Deno's real module cache through links (see isolatedDenoDir); POSIX only.
const POSIX = Deno.build.os !== "windows";
const CLI = join(ROOT, "cli.ts");

/** A fake cache under `dir`: each `[kind dir, version, bytes]` gets a file of that size. */
async function fakeCache(
  dir: string,
  items: [string, string, number][],
): Promise<ToolchainCacheRoots> {
  const roots = { deno: join(dir, "denext-deno"), desktop: join(dir, "denext-desktop-runtime") };
  for (const [where, version, bytes] of items) {
    const base = where === "desktop"
      ? roots.desktop
      : where === "deno"
      ? roots.deno
      : join(roots.deno, where);
    const vdir = join(base, version, "x86_64-target");
    await Deno.mkdir(vdir, { recursive: true });
    await Deno.writeFile(join(vdir, "bin"), new Uint8Array(bytes));
  }
  // Things that are not versions: never listed, never removed.
  await Deno.mkdir(join(roots.deno, "path-shims"), { recursive: true });
  await Deno.writeTextFile(join(roots.deno, ".package-cache-mutate"), "");
  return roots;
}

const exists = (p: string) => Deno.lstat(p).then(() => true, () => false);

const NONE: ToolchainVersionsInUse = { deno: [], desktopRuntime: [], gleam: [], fastlane: [] };

function entry(kind: ToolchainCacheEntry["kind"], version: string, bytes = 1): ToolchainCacheEntry {
  return { kind, version, path: `/c/${kind}/${version}`, bytes };
}

Deno.test("planToolchainRemoval: prune keeps what is in use, whatever --force says", () => {
  const entries = [
    entry("deno", "2.9.7-denext.15", 10),
    entry("deno", "2.9.7-denext.22", 20),
    entry("deno", "3.0.0-rc.1", 30),
    entry("desktop-runtime", "2.9.7-denext.13", 40),
    entry("desktop-runtime", "2.9.7-denext.22", 50),
    entry("gleam", "1.17.0", 1),
    entry("gleam", "1.18.1", 2),
    entry("fastlane", "2.240.1", 3),
  ];
  const inUse = {
    deno: ["2.9.7-denext.22", "3.0.0-rc.1"],
    desktopRuntime: [],
    gleam: ["1.18.1"],
    fastlane: ["2.240.1"],
  };
  for (const force of [false, true]) {
    const plan = planToolchainRemoval(entries, { action: "prune" }, inUse, force);
    assertEquals(
      plan.remove.map((e) => `${e.kind} ${e.version}`),
      ["deno 2.9.7-denext.15", "desktop-runtime 2.9.7-denext.13", "gleam 1.17.0"],
    );
    // A desktop runtime of a Deno version in use counts as in use.
    assert(plan.inUse.some((e) => e.kind === "desktop-runtime" && e.version === "2.9.7-denext.22"));
    assertEquals(plan.bytes, 10 + 40 + 1);
  }
});

Deno.test("planToolchainRemoval: uninstall <version> takes that version's toolchain + runtime; refuses the pinned", () => {
  const entries = [
    entry("deno", "2.9.7-denext.15"),
    entry("desktop-runtime", "2.9.7-denext.15"),
    entry("deno", "2.9.7-denext.22"),
    entry("desktop-runtime", "2.9.7-denext.22"),
  ];
  const inUse = { ...NONE, deno: ["2.9.7-denext.22"] };
  const one = planToolchainRemoval(entries, {
    action: "uninstall",
    versions: ["2.9.7-denext.15", "9.9.9"],
  }, inUse);
  assertEquals(one.remove.map((e) => e.kind), ["deno", "desktop-runtime"]);
  assertEquals(one.notCached, ["9.9.9"]);
  const pinned = planToolchainRemoval(entries, {
    action: "uninstall",
    versions: ["2.9.7-denext.22"],
  }, inUse);
  assertEquals(pinned.remove, []);
  assertEquals(pinned.inUse.length, 2);
  const forced = planToolchainRemoval(
    entries,
    { action: "uninstall", versions: ["2.9.7-denext.22"] },
    inUse,
    true,
  );
  assertEquals(forced.remove.length, 2);
  const all = planToolchainRemoval(entries, { action: "all" }, inUse);
  assertEquals(all.remove.map((e) => e.version), ["2.9.7-denext.15", "2.9.7-denext.15"]);
  assertEquals(planToolchainRemoval(entries, { action: "all" }, inUse, true).remove.length, 4);
});

Deno.test("listToolchainCache + removeToolchainEntries: sizes, versions only, deleted under the lock", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-prune-" });
  try {
    const roots = await fakeCache(dir, [
      ["deno", "2.9.7-denext.9", 100],
      ["deno", "2.9.7-denext.10", 200],
      ["deno", "3.0.0-rc.1", 300],
      ["desktop", "2.9.7-denext.13", 400],
      ["gleam", "1.18.1", 50],
      ["fastlane", "2.240.1", 60],
    ]);
    const listed = await listToolchainCache(roots);
    assertEquals(
      listed.map((e) => `${e.kind} ${e.version} ${e.bytes}`),
      [
        "deno 2.9.7-denext.9 100",
        "deno 2.9.7-denext.10 200", // numeric order, not string order
        "deno 3.0.0-rc.1 300",
        "desktop-runtime 2.9.7-denext.13 400",
        "gleam 1.18.1 50",
        "fastlane 2.240.1 60",
      ],
    );
    // A shim whose binary is gone is swept with the removal; a live one stays.
    const shims = join(roots.deno, "path-shims");
    await Deno.mkdir(join(shims, "dead"), { recursive: true });
    await Deno.symlink(join(listed[0].path, "x86_64-target", "bin"), join(shims, "dead", "deno"));
    await Deno.mkdir(join(shims, "live"), { recursive: true });
    await Deno.symlink(join(listed[1].path, "x86_64-target", "bin"), join(shims, "live", "deno"));
    const out = await removeToolchainEntries([listed[0], listed[3]], roots);
    assertEquals(out.map((o) => o.error), [undefined, undefined]);
    assertEquals(await exists(listed[0].path), false);
    assertEquals(await exists(listed[3].path), false);
    assert(await exists(listed[1].path));
    assertEquals(await exists(join(shims, "dead")), false);
    assert(await exists(join(shims, "live")));
    assert(await exists(join(roots.deno, ".package-cache-mutate")));
    // Already gone is not an error.
    assertEquals((await removeToolchainEntries([listed[0]], roots))[0].error, undefined);
    assertEquals(await diskUsage(join(dir, "nowhere")), 0);
    assertEquals(await listToolchainCache({ deno: join(dir, "a"), desktop: join(dir, "b") }), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("formatBytes", () => {
  assertEquals(formatBytes(512), "512 B");
  assertEquals(formatBytes(1500), "1.5 KB");
  assertEquals(formatBytes(69_551_687), "70 MB");
  assertEquals(formatBytes(1_400_000_000), "1.4 GB");
});

Deno.test("projectDenextVersion: an exact pin, a range through deno.lock, none", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-prune-proj-" });
  try {
    await Deno.mkdir(join(dir, ".git")); // stop the workspace walk here
    assertEquals(projectDenextVersion(dir), undefined);
    const config = (spec: string) =>
      Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({ imports: { denext: `jsr:@denext/denext${spec}` } }),
      );
    await config("@4.2.0");
    assertEquals(projectDenextVersion(dir), "4.2.0");
    await config("@^4.2.0");
    assertEquals(projectDenextVersion(dir), null, "a range with no lock entry");
    await Deno.writeTextFile(
      join(dir, "deno.lock"),
      JSON.stringify({ version: "5", specifiers: { "jsr:@denext/denext@^4.2.0": "4.3.1" } }),
    );
    assertEquals(projectDenextVersion(dir), "4.3.1");
    await config("");
    assertEquals(projectDenextVersion(dir), null, "unversioned");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A context for {@linkcode toolchainRemove}: `toolchain <positionals…>` in `cwd`. */
function ctxOf(
  positionals: string[],
  cwd: string,
  flags: Record<string, unknown> = {},
  json = false,
): CommandContext {
  return { positionals, flags, rest: [], global: { cwd, json } } as unknown as CommandContext;
}

/** Capture console.log while `fn` runs. */
async function captured(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

Deno.test("toolchainRemove: prune keeps the project's denext's toolchain (its published pins)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-prune-run-" });
  try {
    const roots = await fakeCache(join(dir, "cache"), [
      ["deno", "1.0.0-denext.1", 10],
      ["deno", "1.0.0-denext.2", 20],
      ["deno", "1.0.0-denext.3", 30],
      ["desktop", "1.0.0-denext.2", 5],
    ]);
    const project = join(dir, "app");
    await Deno.mkdir(join(project, ".git"), { recursive: true });
    await Deno.writeTextFile(
      join(project, "deno.json"),
      JSON.stringify({ imports: { denext: "jsr:@denext/denext@0.0.1" } }),
    );
    const asked: string[] = [];
    const deps = {
      roots,
      ownPins: () => ({
        deno: "1.0.0-denext.3",
        desktopRuntime: null,
        gleam: null,
        fastlane: null,
      }),
      pinsOf: (v: string) => {
        asked.push(v);
        return Promise.resolve({
          deno: "1.0.0-denext.2",
          desktopRuntime: "1.0.0-denext.2",
          gleam: null,
          fastlane: null,
        });
      },
    };
    const dry = await captured(() =>
      toolchainRemove(ctxOf(["prune"], project, { "dry-run": true }), deps)
    );
    assertStringIncludes(dry, "would remove Deno toolchain 1.0.0-denext.1");
    assertStringIncludes(dry, "would free 10 B");
    assert(await exists(join(roots.deno, "1.0.0-denext.1")), "a dry run removes nothing");
    assertEquals(asked, ["0.0.1"]);
    const json = JSON.parse(
      await captured(() => toolchainRemove(ctxOf(["prune"], project, {}, true), deps)),
    );
    assertEquals(json.removed.map((e: { version: string }) => e.version), ["1.0.0-denext.1"]);
    assertEquals(json.freedBytes, 10);
    assertEquals(
      json.kept.map((e: { kind: string; version: string }) => `${e.kind} ${e.version}`).sort(),
      ["deno 1.0.0-denext.2", "deno 1.0.0-denext.3", "desktop-runtime 1.0.0-denext.2"],
    );
    assertEquals(await exists(join(roots.deno, "1.0.0-denext.1")), false);
    assert(await exists(join(roots.deno, "1.0.0-denext.2")));
    // Offline (the project's pins can't be read): prune keeps everything unless --force.
    const offline = { ...deps, pinsOf: () => Promise.resolve(null) };
    const blind = await captured(() => toolchainRemove(ctxOf(["prune"], project), offline));
    assertStringIncludes(blind, "could not read which toolchain denext 0.0.1");
    assertStringIncludes(blind, "kept every version");
    assert(await exists(join(roots.deno, "1.0.0-denext.2")));
    await captured(() => toolchainRemove(ctxOf(["prune"], project, { force: true }), offline));
    assertEquals(await exists(join(roots.deno, "1.0.0-denext.2")), false);
    assert(await exists(join(roots.deno, "1.0.0-denext.3")), "the pinned one stays");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * A DENO_DIR for a CLI child whose toolchain caches are `cacheDir`'s own, while everything else
 * (the modules the CLI imports) links to the real Deno cache, so nothing is re-downloaded and the
 * machine's toolchain cache is never touched.
 */
async function isolatedDenoDir(cacheDir: string): Promise<void> {
  await Deno.mkdir(cacheDir, { recursive: true });
  const real = denoCacheDir();
  for await (const e of Deno.readDir(real)) {
    if (e.name.startsWith("denext-deno") || e.name.startsWith("denext-desktop-runtime")) continue;
    await Deno.symlink(join(real, e.name), join(cacheDir, e.name)).catch(() => {});
  }
}

Deno.test("denext toolchain uninstall / prune: the real CLI against a temp cache", {
  ignore: !POSIX,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-prune-cli-" });
  try {
    const cacheDir = join(dir, "deno-cache");
    await isolatedDenoDir(cacheDir);
    const pinned = DENO_TOOLCHAIN.version ?? "0.0.0-denext.0";
    await fakeCache(cacheDir, [
      ["deno", "1.0.0-denext.1", 1000],
      ["deno", pinned, 2000],
      ["desktop", "1.0.0-denext.1", 3000],
      ["desktop", DESKTOP_RUNTIME_PIN.version, 4000],
      ["gleam", "0.1.0", 10],
      ["gleam", GLEAM_TOOLCHAIN.version, 20],
      ["fastlane", FASTLANE_TOOLCHAIN.fastlane, 30],
    ]);
    const work = join(dir, "work");
    await Deno.mkdir(join(work, ".git"), { recursive: true });
    const run = (args: string[]) =>
      boundedOutput(Deno.execPath(), {
        args: ["run", "-A", "--config", join(ROOT, "deno.json"), CLI, ...args],
        cwd: work,
        env: { DENO_DIR: cacheDir, DENEXT_TOOLCHAIN_ACTIVE: "", NO_COLOR: "1" },
      }).then((o) => {
        const d = new TextDecoder();
        return { code: o.code, stdout: d.decode(o.stdout), stderr: d.decode(o.stderr) };
      });
    const root = join(cacheDir, "denext-deno");
    // The pinned version is refused without --force.
    const refused = await run(["toolchain", "uninstall", pinned]);
    assertEquals(refused.code, 1, refused.stderr);
    assertStringIncludes(refused.stdout, "--force removes it");
    assert(await exists(join(root, pinned)));
    // Not cached: exit 1, named.
    const missing = await run(["toolchain", "uninstall", "7.7.7"]);
    assertEquals(missing.code, 1);
    assertStringIncludes(missing.stdout, "7.7.7 is not cached");
    // One version: its toolchain and its desktop runtime.
    const one = await run(["toolchain", "uninstall", "1.0.0-denext.1"]);
    assertEquals(one.code, 0, one.stderr);
    assertStringIncludes(one.stdout, "removed Deno toolchain 1.0.0-denext.1");
    assertStringIncludes(one.stdout, "removed Deno Desktop runtime 1.0.0-denext.1");
    assertStringIncludes(one.stdout, "freed 4.0 KB");
    assertEquals(await exists(join(root, "1.0.0-denext.1")), false);
    assertEquals(await exists(join(cacheDir, "denext-desktop-runtime", "1.0.0-denext.1")), false);
    // prune: the old Gleam goes, the pinned versions stay.
    const pruned = await run(["toolchain", "prune", "--json"]);
    assertEquals(pruned.code, 0, pruned.stderr);
    const report = JSON.parse(pruned.stdout);
    assertEquals(report.removed.map((e: { kind: string }) => e.kind), ["gleam"]);
    assert(await exists(join(root, pinned)));
    assert(await exists(join(root, "gleam", GLEAM_TOOLCHAIN.version)));
    // --all --force: everything.
    const all = await run(["toolchain", "uninstall", "--all", "--force", "--dry-run"]);
    assertEquals(all.code, 0, all.stderr);
    assertStringIncludes(all.stdout, `would remove Deno toolchain ${pinned}`);
    assert(await exists(join(root, pinned)), "--dry-run");
    const gone = await run(["toolchain", "uninstall", "--all", "--force"]);
    assertEquals(gone.code, 0, gone.stderr);
    assertEquals(
      (await listToolchainCache({
        deno: root,
        desktop: join(cacheDir, "denext-desktop-runtime"),
      })).length,
      0,
    );
    // Bad usage.
    const bare = await run(["toolchain", "uninstall"]);
    assertEquals(bare.code, 1);
    assertStringIncludes(bare.stderr, "name a version to uninstall");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("toolchainRemove: the project's pins come from jsr.io; this denext's from its own pin files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-prune-jsr-" });
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  let published = true;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    if (!published) return Promise.resolve(new Response("nope", { status: 404 }));
    const file = url.slice(url.lastIndexOf("/") + 1);
    const body: Record<string, unknown> = {
      "deno-toolchain-pin.json": { version: "1.0.0-denext.2" },
      "desktop-runtime-pin.json": { version: "1.0.0-denext.2" },
      "gleam-toolchain-pin.json": { version: "0.9.0" },
      "fastlane-toolchain-pin.json": { fastlane: "2.1.0" },
    };
    return Promise.resolve(Response.json(body[file] ?? {}));
  }) as typeof fetch;
  try {
    const roots = await fakeCache(join(dir, "cache"), [
      ["deno", "1.0.0-denext.1", 10],
      ["deno", "1.0.0-denext.2", 20],
      ["gleam", "0.9.0", 1],
      ["gleam", "0.8.0", 2],
      ["fastlane", "2.1.0", 3],
    ]);
    const project = join(dir, "app");
    await Deno.mkdir(join(project, ".git"), { recursive: true });
    await Deno.writeTextFile(
      join(project, "deno.json"),
      JSON.stringify({ imports: { denext: "jsr:@denext/denext@0.0.2" } }),
    );
    const json = JSON.parse(
      await captured(() => toolchainRemove(ctxOf(["prune"], project, {}, true), { roots })),
    );
    assertEquals(
      json.removed.map((e: { kind: string; version: string }) => `${e.kind} ${e.version}`),
      ["deno 1.0.0-denext.1", "gleam 0.8.0"],
    );
    assert(urls.every((u) => u.startsWith("https://jsr.io/@denext/denext/0.0.2/src/build/")));
    assertEquals(urls.length, 4);
    // Not published (or offline): nothing is removed, and the reason is reported.
    published = false;
    const blind = JSON.parse(
      await captured(() => toolchainRemove(ctxOf(["prune"], project, {}, true), { roots })),
    );
    assertEquals(blind.removed, []);
    assertStringIncludes(blind.warning, "denext 0.0.2");
    // A project with a range and no lock: the same.
    await Deno.writeTextFile(
      join(project, "deno.json"),
      JSON.stringify({ imports: { denext: "jsr:@denext/denext@^0.0.2" } }),
    );
    const range = await captured(() => toolchainRemove(ctxOf(["prune"], project), { roots }));
    assertStringIncludes(range, "without an exact version");
    assertStringIncludes(range, "nothing to remove");
  } finally {
    globalThis.fetch = realFetch;
    await Deno.remove(dir, { recursive: true });
  }
});
