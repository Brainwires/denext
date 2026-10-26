// `denext build --compile` resolves the app's dependencies as the app's lockfile locks them, under
// its dependency-age rule (src/build/compile-lock.ts). The end-to-end cases run `compileApp` with
// its `deno compile` replaced by a `deno run` of a probe under the exact config and lockfile the
// compile wrote (the same resolver and lockfile code), against a loopback JSR registry serving
// `@fix/pkg` 1.0.0 and 1.1.0: the app locks 1.0.0, and 1.1.0 is the newest in its range.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { compileApp, neverEmbedded } from "../src/build/compile-app.ts";
import {
  carryNpmrc,
  exactJsrRequirement,
  lockAdditions,
  mergeLockAdditions,
  seedCompileLock,
  settleCompileLock,
} from "../src/build/compile-lock.ts";
import { withDenoProps } from "./helpers/deno-stub.ts";
import { type FakeJsr, startFakeJsr } from "./helpers/fake-jsr.ts";
import { removeTempDir } from "./helpers/temp.ts";
import { watchTests } from "./helpers/watchdog.ts";

// Builds in this process: a stalled one fails its test instead of holding the CI job.
watchTests();

const OWN = "jsr:@denext/denext@4.6.0/standalone";

/** A temp dir for `fn`, removed after. */
async function inTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_compile_lock_" }));
  try {
    await fn(dir);
  } finally {
    await removeTempDir(dir);
  }
}

/** Read a JSON file. */
async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(path));
}

/** `path` exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("exactJsrRequirement: an exact jsr: version only", () => {
  assertEquals(exactJsrRequirement(OWN), {
    requirement: "jsr:@denext/denext@4.6.0",
    pkg: "@denext/denext@4.6.0",
    version: "4.6.0",
  });
  assertEquals(exactJsrRequirement("jsr:@denext/denext@5.0.0-rc.1")?.version, "5.0.0-rc.1");
  assertEquals(exactJsrRequirement("jsr:@denext/denext@^4.6.0/standalone"), undefined);
  assertEquals(exactJsrRequirement("../../src/standalone/mod.ts"), undefined);
});

Deno.test("lockAdditions / mergeLockAdditions: new resolutions only, sorted", () => {
  const before = { version: "5", specifiers: { "jsr:@a/b@1": "1.0.0" }, jsr: { "@a/b@1.0.0": {} } };
  const after = {
    version: "5",
    specifiers: { "jsr:@a/b@1": "1.0.0", "jsr:@a/a@1": "1.2.0" },
    jsr: { "@a/b@1.0.0": {}, "@a/a@1.2.0": { integrity: "x" } },
    npm: { "left-pad@1.3.0": { integrity: "y" } },
    workspace: { dependencies: ["jsr:@a/a@1"] },
  };
  assertEquals(lockAdditions(before, after), [
    "jsr: @a/a@1.2.0",
    "npm: left-pad@1.3.0",
    "specifiers: jsr:@a/a@1",
  ]);
  assertEquals(lockAdditions(after, after), []);
  const app = { ...before, workspace: { dependencies: ["jsr:@a/b@1"] } };
  const merged = mergeLockAdditions(app, after);
  // The app's own workspace section stays; resolutions are added, never changed.
  assertEquals(merged.workspace, { dependencies: ["jsr:@a/b@1"] });
  assertEquals(Object.keys(merged.specifiers as object), ["jsr:@a/a@1", "jsr:@a/b@1"]);
  assertEquals(merged.npm, { "left-pad@1.3.0": { integrity: "y" } });
  const changed = mergeLockAdditions(app, { specifiers: { "jsr:@a/b@1": "9.9.9" } });
  assertEquals((changed.specifiers as Record<string, string>)["jsr:@a/b@1"], "1.0.0");
});

Deno.test("seedCompileLock: copies the app's lock without its workspace section", async () => {
  await inTemp(async (dir) => {
    const compile = join(dir, ".denext", "compile");
    await Deno.mkdir(compile, { recursive: true });
    const lock = {
      version: "5",
      specifiers: { "jsr:@denext/denext@^4.6.0": "4.6.0" },
      jsr: { "@denext/denext@4.6.0": { integrity: "abc" } },
      workspace: { dependencies: ["jsr:@denext/denext@^4.6.0"] },
    };
    await Deno.writeTextFile(join(dir, "deno.lock"), JSON.stringify(lock));
    const seeded = await seedCompileLock(join(dir, "deno.json"), undefined, compile, OWN);
    assertEquals(seeded.path, join(compile, "deno.lock"));
    assertEquals(seeded.appLock, join(dir, "deno.lock"));
    assertEquals(seeded.frozen, false);
    const copy = await readJson(join(compile, "deno.lock"));
    assertEquals(copy.workspace, undefined);
    // The framework's exact entry maps to the locked package.
    assertEquals(copy.specifiers, {
      "jsr:@denext/denext@^4.6.0": "4.6.0",
      "jsr:@denext/denext@4.6.0": "4.6.0",
    });
    // Another framework version than the locked one gets no mapping (Deno resolves it).
    await seedCompileLock(join(dir, "deno.json"), undefined, compile, "jsr:@denext/denext@4.7.0/x");
    assertEquals(Object.keys((await readJson(join(compile, "deno.lock"))).specifiers as object), [
      "jsr:@denext/denext@^4.6.0",
    ]);
  });
});

Deno.test("seedCompileLock: a named, frozen lock; none; an unreadable one", async () => {
  await inTemp(async (dir) => {
    const compile = join(dir, "c");
    await Deno.mkdir(join(dir, "locks"), { recursive: true });
    await Deno.mkdir(compile);
    await Deno.writeTextFile(join(dir, "locks", "app.lock"), '{"version":"5"}');
    const cfg = join(dir, "deno.json");
    const named = await seedCompileLock(
      cfg,
      { path: "locks/app.lock", frozen: true },
      compile,
      OWN,
    );
    assertEquals(named.appLock, join(dir, "locks", "app.lock"));
    assertEquals(named.frozen, true);
    assert(await exists(join(compile, "deno.lock")));
    // `"lock": false`: no lock, and the previous compile's copy is gone.
    assertEquals(await seedCompileLock(cfg, false, compile, OWN), { frozen: false });
    assert(!await exists(join(compile, "deno.lock")));
    // No lockfile written yet: none.
    assertEquals(await seedCompileLock(cfg, "missing.lock", compile, OWN), { frozen: false });
    await Deno.writeTextFile(join(dir, "deno.lock"), "{ not json");
    await assertRejects(
      () => seedCompileLock(cfg, undefined, compile, OWN),
      Error,
      "is not a readable lockfile",
    );
    await Deno.writeTextFile(join(dir, "deno.lock"), "[]");
    await assertRejects(
      () => seedCompileLock(cfg, undefined, compile, OWN),
      Error,
      "is not a readable lockfile",
    );
  });
});

Deno.test("settleCompileLock: records additions, refuses them under a frozen lock", async () => {
  await inTemp(async (dir) => {
    const app = join(dir, "deno.lock");
    const copy = join(dir, "copy.lock");
    const seed = { version: "5", specifiers: { "jsr:@a/b@1": "1.0.0" } };
    const appLock = { ...seed, workspace: { dependencies: ["jsr:@a/b@1"] } };
    await Deno.writeTextFile(app, JSON.stringify(appLock));
    const after = { version: "5", specifiers: { "jsr:@a/b@1": "1.0.0", "jsr:@a/c@2": "2.0.0" } };
    await Deno.writeTextFile(copy, JSON.stringify(after));
    await assertRejects(
      () => settleCompileLock({ path: copy, appLock: app, frozen: true, seed }),
      Error,
      "is frozen and does not lock what the compiled server resolves:\n  specifiers: jsr:@a/c@2",
    );
    assertEquals(await readJson(app), appLock, "a frozen lock is never written");
    await settleCompileLock({ path: copy, appLock: app, frozen: false, seed });
    const merged = await readJson(app);
    assertEquals(merged.specifiers, after.specifiers);
    assertEquals(merged.workspace, appLock.workspace);
    // Nothing to do: no lock, nothing new; unfrozen, no copy left or another lockfile version.
    await settleCompileLock({ frozen: false });
    await settleCompileLock({ path: join(dir, "gone"), appLock: app, frozen: false, seed });
    await Deno.writeTextFile(copy, JSON.stringify({ ...after, version: "4" }));
    await settleCompileLock({ path: copy, appLock: app, frozen: false, seed });
    // A frozen lock fails closed when the result can't be checked against it.
    await assertRejects(
      () => settleCompileLock({ path: copy, appLock: app, frozen: true, seed }),
      Error,
      'rewrote it as lockfile version "4"',
    );
    await assertRejects(
      () => settleCompileLock({ path: join(dir, "gone"), appLock: app, frozen: true, seed }),
      Error,
      "can't be checked against it",
    );
    assertEquals(await readJson(app), merged, "and is never written");
    await Deno.writeTextFile(copy, JSON.stringify(seed));
    await settleCompileLock({ path: copy, appLock: app, frozen: true, seed });
  });
});

Deno.test("carryNpmrc: copies the app's .npmrc, drops a stale copy; never embedded", async () => {
  await inTemp(async (dir) => {
    const compile = join(dir, "c");
    await Deno.mkdir(compile);
    await Deno.writeTextFile(join(dir, ".npmrc"), "min-release-age=7\n");
    await carryNpmrc(dir, compile);
    assertEquals(await Deno.readTextFile(join(compile, ".npmrc")), "min-release-age=7\n");
    await Deno.remove(join(dir, ".npmrc"));
    await carryNpmrc(dir, compile);
    assert(!await exists(join(compile, ".npmrc")));
    await carryNpmrc(dir, compile); // nothing to remove either
    if (Deno.build.os !== "windows") {
      // An older, world-readable copy (registry tokens) is made owner-only on the next compile:
      // Deno applies `mode` to an existing file too.
      await Deno.writeTextFile(join(dir, ".npmrc"), "//registry.example/:_authToken=t\n");
      await Deno.writeTextFile(join(compile, ".npmrc"), "old\n", { mode: 0o644 });
      await Deno.chmod(join(compile, ".npmrc"), 0o644);
      await carryNpmrc(dir, compile);
      assertEquals((await Deno.stat(join(compile, ".npmrc"))).mode! & 0o777, 0o600);
    }
  });
  assert(neverEmbedded(".npmrc"));
});

// ── end to end ──────────────────────────────────────────────────────────────────────────────

const FAKE_DENO = "fake-deno-compile";

/**
 * Run `compileApp` on `project` with `deno compile` replaced by a `deno run` of `probe.ts` (in the
 * project) under the config the compile wrote; the probe writes what it resolved to `probe.out`.
 */
async function compileWithProbe(
  project: string,
  registry: FakeJsr,
  denoDir: string,
): Promise<{ output: string }> {
  const RealCommand = Deno.Command;
  class ProbeCommand {
    constructor(private cmd: string | URL, private opts: Deno.CommandOptions) {}
    async output(): Promise<{ code: number }> {
      assertEquals(this.cmd, FAKE_DENO);
      const args = this.opts.args as string[];
      const at = (flag: string) => args[args.indexOf(flag) + 1];
      const r = await new RealCommand(Deno.execPath(), {
        args: ["run", "-A", "--config", at("--config"), join(project, "probe.ts")],
        cwd: this.opts.cwd,
        env: { JSR_URL: registry.url, DENO_DIR: denoDir, NO_COLOR: "1" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const err = new TextDecoder().decode(r.stderr);
      if (r.code !== 0) console.error(err);
      if (r.code === 0) await Deno.writeTextFile(at("--output"), "binary");
      return { code: r.code };
    }
  }
  return await withDenoProps(
    { Command: ProbeCommand },
    () => compileApp(project, { deno: FAKE_DENO, output: join(project, "dist", "app") }),
  );
}

/** A project importing `@fix/pkg@^1.0.0`, its lock pinning 1.0.0 (`lock` overrides it). */
async function lockedProject(
  dir: string,
  registry: FakeJsr,
  options: { lock?: unknown; integrity?: string; config?: Record<string, unknown> } = {},
): Promise<string> {
  const project = join(dir, "project");
  await Deno.mkdir(join(project, ".denext"), { recursive: true });
  await Deno.writeTextFile(
    join(project, "deno.json"),
    JSON.stringify({
      imports: { "@fix/pkg": "jsr:@fix/pkg@^1.0.0" },
      ...(options.lock !== undefined ? { lock: options.lock } : {}),
      ...options.config,
    }),
  );
  await Deno.writeTextFile(
    join(project, "deno.lock"),
    JSON.stringify({
      version: "5",
      specifiers: { "jsr:@fix/pkg@1": "1.0.0" },
      jsr: {
        "@fix/pkg@1.0.0": {
          integrity: options.integrity ?? registry.integrity("@fix/pkg", "1.0.0"),
        },
      },
      workspace: { dependencies: ["jsr:@fix/pkg@1"] },
    }),
  );
  await Deno.writeTextFile(
    join(project, "probe.ts"),
    `import { VERSION } from "@fix/pkg";
await Deno.writeTextFile(new URL("./probe.out", import.meta.url), VERSION);
`,
  );
  return project;
}

/** The fake registry and a fresh Deno cache for `fn`. */
async function withRegistry(
  fn: (dir: string, registry: FakeJsr, denoDir: string) => Promise<void>,
): Promise<void> {
  const registry = await startFakeJsr({
    "@fix/pkg": {
      "1.0.0": 'export const VERSION = "1.0.0";\n',
      "1.1.0": 'export const VERSION = "1.1.0";\n',
    },
    "@fix/other": { "2.0.0": 'export const OTHER = "2.0.0";\n' },
  });
  try {
    await inTemp((dir) => fn(dir, registry, join(dir, "deno-dir")));
  } finally {
    await registry.close();
  }
}

Deno.test({
  name: "compileApp resolves the app's locked version, not the newest in its range",
  sanitizeResources: false,
  fn: () =>
    withRegistry(async (dir, registry, denoDir) => {
      const project = await lockedProject(dir, registry);
      await compileWithProbe(project, registry, denoDir);
      assertEquals(await Deno.readTextFile(join(project, "probe.out")), "1.0.0");
      const config = await readJson(join(project, ".denext", "compile", "deno.json"));
      assertEquals(config.lock, "./deno.lock");
    }),
});

Deno.test({
  name: "compileApp refuses a package that fails the app's lockfile integrity",
  sanitizeResources: false,
  fn: () =>
    withRegistry(async (dir, registry, denoDir) => {
      const project = await lockedProject(dir, registry, { integrity: "0".repeat(64) });
      await assertRejects(
        () => compileWithProbe(project, registry, denoDir),
        Error,
        "deno compile failed",
      );
      assert(!await exists(join(project, "probe.out")));
    }),
});

Deno.test({
  name: "compileApp: a frozen lock refuses what it does not lock, an unfrozen one records it",
  sanitizeResources: false,
  fn: () =>
    withRegistry(async (dir, registry, denoDir) => {
      const project = await lockedProject(dir, registry, { lock: { frozen: true } });
      await Deno.writeTextFile(
        join(project, "probe.ts"),
        `import { VERSION } from "@fix/pkg";
import { OTHER } from "jsr:@fix/other@^2.0.0";
await Deno.writeTextFile(new URL("./probe.out", import.meta.url), VERSION + " " + OTHER);
`,
      );
      const before = await Deno.readTextFile(join(project, "deno.lock"));
      await assertRejects(
        () => compileWithProbe(project, registry, denoDir),
        Error,
        "is frozen and does not lock what the compiled server resolves",
      );
      assert(!await exists(join(project, "dist", "app")), "the binary is removed");
      assertEquals(await Deno.readTextFile(join(project, "deno.lock")), before);
      // Unfrozen: the compile records the new resolution in the app's lock.
      const cfg = await readJson(join(project, "deno.json"));
      await Deno.writeTextFile(join(project, "deno.json"), JSON.stringify({ ...cfg, lock: true }));
      await compileWithProbe(project, registry, denoDir);
      assertEquals(await Deno.readTextFile(join(project, "probe.out")), "1.0.0 2.0.0");
      const lock = await readJson(join(project, "deno.lock"));
      assertEquals((lock.specifiers as Record<string, string>)["jsr:@fix/pkg@1"], "1.0.0");
      assert(Object.hasOwn(lock.jsr as object, "@fix/other@2.0.0"), JSON.stringify(lock));
      assertEquals(lock.workspace, { dependencies: ["jsr:@fix/pkg@1"] });
    }),
});

Deno.test({
  name: "compileApp keeps the app's .npmrc min-release-age hold",
  sanitizeResources: false,
  fn: () =>
    withRegistry(async (dir, registry, denoDir) => {
      // No lock, so only the hold decides: 100 years holds back every version.
      const project = await lockedProject(dir, registry, { lock: false });
      await Deno.writeTextFile(join(project, ".npmrc"), "min-release-age=36500\n");
      await assertRejects(
        () => compileWithProbe(project, registry, denoDir),
        Error,
        "deno compile failed",
      );
      assert(!await exists(join(project, "probe.out")));
      // The deno.json rule travels too (it did before this change); without either, 1.1.0.
      await Deno.remove(join(project, ".npmrc"));
      await compileWithProbe(project, registry, denoDir);
      assertStringIncludes(await Deno.readTextFile(join(project, "probe.out")), "1.1.0");
      const config = await readJson(join(project, ".denext", "compile", "deno.json"));
      assertEquals(config.lock, false);
    }),
});
