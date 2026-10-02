// Cargo-style build locks (src/build/file-lock.ts + src/build/project-locks.ts): real OS locks
// in REAL processes. A second writer prints Cargo's `Blocking waiting for file lock on …` once
// and waits until the first exits; shared readers run side by side; a SIGKILLed holder's lock is
// released by the OS (no stale-lock heuristic); the plan's order is fixed; and the CLI dispatch
// takes a verb's declared locks (`denext test --coverage=<dir>`).

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, relative, resolve } from "@std/path";
import { acquireFileLock, blockingLine } from "../src/build/file-lock.ts";
import {
  BUILD_DIR_LOCK,
  buildDirLockPath,
  CACHE_DOWNLOAD_LOCK,
  CACHE_MUTATE_LOCK,
  LOCK_RANK,
  outputLockPath,
  planProjectLocks,
} from "../src/build/project-locks.ts";
import { coverageDir } from "../src/cli/commands/toolchain.ts";
import { mobileBuildLocks } from "../src/cli/commands/mobile-build.ts";
import { buildRegistry } from "../src/cli/register.ts";

const LOCKS_URL = new URL("../src/build/project-locks.ts", import.meta.url).href;
const CLI = fromFileUrl(new URL("../cli.ts", import.meta.url));
const DENO_JSON = fromFileUrl(new URL("../deno.json", import.meta.url));

// ---------------------------------------------------------------------------------------------
// A holder process: takes the locks a JSON spec names, prints `locked`, holds them until its
// stdin closes (or it is killed), prints `released`.

const HOLDER = `
import { acquireCacheLock, acquireProjectLocks } from ${JSON.stringify(LOCKS_URL)};
const spec = JSON.parse(Deno.args[0]);
const held = spec.cache
  ? await acquireCacheLock(spec.cache, spec.mode, "test cache")
  : await acquireProjectLocks(spec);
console.log("locked");
for await (const _ of Deno.stdin.readable) { /* hold until stdin closes */ }
held.release();
console.log("released");
`;

interface Holder {
  /** Resolves with the next stdout line matching `text`. */
  waitFor(text: string): Promise<void>;
  /** Whether stdout has printed `text` yet. */
  saw(text: string): boolean;
  /** Everything on stderr so far. */
  stderr(): string;
  /** Close stdin (the holder releases and exits). */
  release(): Promise<void>;
  kill(): void;
  status: Promise<Deno.CommandStatus>;
}

async function holderScript(dir: string): Promise<string> {
  const path = join(dir, "holder.ts");
  await Deno.writeTextFile(path, HOLDER);
  return path;
}

function collect(stream: ReadableStream<Uint8Array>, into: string[], wake: () => void) {
  return (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      into.push(...lines);
      wake();
    }
    if (buffered) into.push(buffered);
    wake();
  })();
}

function spawnHolder(script: string, spec: unknown): Holder {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--config",
      DENO_JSON,
      "--allow-read",
      "--allow-write",
      "--allow-env",
      script,
      JSON.stringify(spec),
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const out: string[] = [];
  const err: string[] = [];
  let waiters: (() => void)[] = [];
  const wake = () => {
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  };
  let exited = false;
  const done = Promise.all([collect(child.stdout, out, wake), collect(child.stderr, err, wake)])
    .finally(() => {
      exited = true;
      wake();
    });
  const writer = child.stdin.getWriter();
  return {
    async waitFor(text) {
      while (!out.includes(text)) {
        if (exited) throw new Error(`holder exited before "${text}":\n${err.join("\n")}`);
        await new Promise<void>((r) => waiters.push(r));
      }
    },
    saw: (text) => out.includes(text),
    stderr: () => err.join("\n"),
    async release() {
      await writer.close().catch(() => {});
    },
    kill: () => child.kill("SIGKILL"),
    status: done.then(() => child.status),
  };
}

/** Resolves once `predicate` holds (polled), or rejects after `ms`. */
async function eventually(predicate: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const SUBPROCESS = { sanitizeOps: false, sanitizeResources: false };

Deno.test(
  "a second writer prints the Blocking line once, waits, and proceeds when the first releases",
  SUBPROCESS,
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      const script = await holderScript(dir);
      const spec = { projectDir: dir, buildDir: "exclusive", outputDirs: ["out"] };
      const first = spawnHolder(script, spec);
      await first.waitFor("locked");
      const second = spawnHolder(script, spec);
      await eventually(() => second.stderr().includes("Blocking"), "the Blocking line");
      assertEquals(second.stderr(), blockingLine("build directory .denext"));
      // Still waiting: nothing locked yet.
      await new Promise((r) => setTimeout(r, 300));
      assert(!second.saw("locked"), "the second writer must not get the lock while it is held");
      await first.release();
      await second.waitFor("locked");
      await second.release();
      assertEquals((await first.status).code, 0);
      assertEquals((await second.status).code, 0);
      // One Blocking line, even though two locks (build dir, out) were contended.
      assertEquals(second.stderr().match(/Blocking/g)?.length, 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "shared readers hold the build dir side by side; a writer waits for both",
  SUBPROCESS,
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      const script = await holderScript(dir);
      const a = spawnHolder(script, { projectDir: dir, buildDir: "shared" });
      const b = spawnHolder(script, { projectDir: dir, buildDir: "shared" });
      await a.waitFor("locked");
      await b.waitFor("locked");
      assertEquals(a.stderr() + b.stderr(), "", "readers never block each other");
      const writer = spawnHolder(script, { projectDir: dir, buildDir: "exclusive" });
      await eventually(() => writer.stderr().includes("Blocking"), "the writer's Blocking line");
      await a.release();
      await new Promise((r) => setTimeout(r, 200));
      assert(!writer.saw("locked"), "one reader still holds it");
      await b.release();
      await writer.waitFor("locked");
      await writer.release();
      await Promise.all([a.status, b.status, writer.status]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test("a killed holder's lock is released by the OS — no stale lock", SUBPROCESS, async () => {
  const dir = await Deno.makeTempDir();
  try {
    const script = await holderScript(dir);
    const spec = { projectDir: dir, buildDir: "exclusive" };
    const first = spawnHolder(script, spec);
    await first.waitFor("locked");
    first.kill();
    await first.status;
    // The lock file is still there; the lock is not.
    await Deno.stat(buildDirLockPath(dir));
    const second = spawnHolder(script, spec);
    await second.waitFor("locked");
    assertEquals(second.stderr(), "", "acquired without waiting");
    await second.release();
    await second.status;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  "cache locks: a download leaves readers alone; a mutation excludes them",
  SUBPROCESS,
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      const script = await holderScript(dir);
      const reader = spawnHolder(script, { cache: dir, mode: "shared" });
      await reader.waitFor("locked");
      const downloader = spawnHolder(script, { cache: dir, mode: "download" });
      await downloader.waitFor("locked");
      assertEquals(downloader.stderr(), "", "DownloadExclusive does not wait for Shared");
      const second = spawnHolder(script, { cache: dir, mode: "download" });
      await eventually(() => second.stderr().includes("Blocking"), "a second downloader waiting");
      const mutator = spawnHolder(script, { cache: dir, mode: "mutate" });
      await eventually(() => mutator.stderr().includes("Blocking"), "the mutator waiting");
      await reader.release();
      await downloader.release();
      await second.waitFor("locked");
      await second.release();
      await mutator.waitFor("locked");
      await mutator.release();
      await Promise.all([reader.status, downloader.status, second.status, mutator.status]);
      await Deno.stat(join(dir, CACHE_MUTATE_LOCK));
      await Deno.stat(join(dir, CACHE_DOWNLOAD_LOCK));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "denext test --coverage=<dir> takes the output-dir lock through the CLI dispatch",
  SUBPROCESS,
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      const script = await holderScript(dir);
      await Deno.writeTextFile(join(dir, "a.test.ts"), `Deno.test("a", () => {});\n`);
      const holder = spawnHolder(script, { projectDir: dir, outputDirs: ["cov"] });
      await holder.waitFor("locked");
      const cli = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          DENO_JSON,
          CLI,
          "--cwd",
          dir,
          "test",
          "--coverage=cov",
          "a.test.ts",
        ],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const err: string[] = [];
      const out: string[] = [];
      const pumps = Promise.all([
        collect(cli.stderr, err, () => {}),
        collect(cli.stdout, out, () => {}),
      ]);
      await eventually(
        () => err.join("\n").includes(blockingLine("output directory cov")),
        "the CLI's Blocking line",
        60_000,
      );
      assert(!out.join("\n").includes("ok |"), "the tests must not run while the lock is held");
      await holder.release();
      await holder.status;
      await pumps;
      const status = await cli.status;
      assertEquals(status.code, 0, err.join("\n"));
      assertStringIncludes(out.join("\n"), "1 passed");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------------------------
// In-process rules and the plan.

Deno.test("re-entrant in one process; never upgraded; never out of rank order", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "x.lock");
    const opts = { mode: "exclusive", description: "x", rank: 1 } as const;
    const a = await acquireFileLock(path, opts);
    const b = await acquireFileLock(path, { ...opts, mode: "shared" }); // nested: a refcount
    b.release();
    a.release();
    using shared = await acquireFileLock(path, { ...opts, mode: "shared" });
    await assertRejects(() => acquireFileLock(path, opts), Error, "not upgraded in place");
    shared.release();
    using high = await acquireFileLock(join(dir, "high.lock"), { ...opts, rank: 3 });
    await assertRejects(
      () => acquireFileLock(join(dir, "low.lock"), { ...opts, rank: 1 }),
      Error,
      "lock order violation",
    );
    high.release();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Replace one `Deno.FsFile` method for the length of `fn` (the lock's OS calls). */
async function withFsFile<K extends "tryLock" | "unlockSync">(
  method: K,
  impl: Deno.FsFile[K],
  fn: () => Promise<void>,
): Promise<void> {
  const proto = Deno.FsFile.prototype;
  const original = proto[method];
  proto[method] = impl;
  try {
    await fn();
  } finally {
    proto[method] = original;
  }
}

Deno.test("a filesystem that cannot lock proceeds unlocked (Cargo's rule)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const opts = { mode: "exclusive", description: "x", rank: 1 } as const;
    // Deno's NotSupported, and the errno names / wording a network mount answers with.
    for (
      const err of [
        new Deno.errors.NotSupported("lock"),
        new Error("ENOLCK: No locks available"),
        new Error("Operation not supported (os error 45)"),
      ]
    ) {
      await withFsFile("tryLock", () => Promise.reject(err), async () => {
        const lock = await acquireFileLock(join(dir, "nfs.lock"), opts);
        assertEquals(lock.mode, "exclusive");
        lock.release(); // nothing to unlock: the file was closed when locking failed
        lock.release(); // and a second release is a no-op
      });
    }
    // The lock is free again afterwards: a real acquire succeeds.
    (await acquireFileLock(join(dir, "nfs.lock"), opts)).release();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a lock error fails every waiter on that file and leaves nothing held", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "eio.lock");
    const opts = { mode: "shared", description: "x", rank: 1 } as const;
    await withFsFile("tryLock", () => Promise.reject(new Error("EIO: i/o error")), async () => {
      // A second acquire of the same file while the first is still locking joins it (a
      // refcount) — and so shares its failure.
      const first = acquireFileLock(path, opts);
      const second = acquireFileLock(path, opts);
      await assertRejects(() => first, Error, "EIO");
      await assertRejects(() => second, Error, "EIO");
    });
    // Nothing stayed in the held table: an exclusive acquire is not refused as an "upgrade".
    (await acquireFileLock(path, { ...opts, mode: "exclusive" })).release();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("release never throws when the OS lock is already gone", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const opts = { mode: "exclusive", description: "x", rank: 1 } as const;
    await withFsFile("unlockSync", () => {
      throw new Deno.errors.BadResource("gone");
    }, async () => {
      const lock = await acquireFileLock(join(dir, "gone.lock"), opts);
      lock.release(); // the unlock throws; closing the file releases the lock anyway
    });
    (await acquireFileLock(join(dir, "gone.lock"), opts)).release();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the plan: rank order, path order inside a rank, the build dir locked once", async () => {
  const dir = resolve("/proj");
  const lock = (suffix = "") => join(".denext", `${BUILD_DIR_LOCK}${suffix}`);
  const plan = await planProjectLocks({
    projectDir: dir,
    buildDir: "shared",
    outputDirs: ["out", "coverage", "out"],
    packageDirs: ["dist/mobile"],
  });
  assertEquals(plan.map((p) => [p.rank, relative(dir, p.path), p.mode]), [
    [LOCK_RANK.packageOutput, lock("-dist-mobile"), "exclusive"],
    [LOCK_RANK.buildDir, lock(), "shared"],
    [LOCK_RANK.outputDir, lock("-coverage"), "exclusive"],
    [LOCK_RANK.outputDir, lock("-out"), "exclusive"],
  ]);
  // An output dir that IS the build dir: one lock, exclusive (Cargo PR #16385).
  const same = await planProjectLocks({
    projectDir: dir,
    buildDir: "shared",
    outputDirs: [".denext"],
  });
  assertEquals(same.map((p) => [relative(dir, p.path), p.mode]), [[lock(), "exclusive"]]);
  assert((await outputLockPath(dir, resolve("/elsewhere/out"))).includes(`${BUILD_DIR_LOCK}-ext-`));
});

Deno.test("verbs declare their locks", () => {
  const reg = buildRegistry();
  const locksOf = (argv: string[]) => {
    const out = reg.parse(argv);
    assert(out.kind === "run");
    return out.command.locks?.(out.ctx);
  };
  const p = resolve("/p");
  assertEquals(locksOf(["build", "/p"]), { projectDir: p, buildDir: "exclusive" });
  assertEquals(locksOf(["export", "/p"]), {
    projectDir: p,
    buildDir: "exclusive",
    outputDirs: ["out"],
  });
  assertEquals(locksOf(["analyze", "/p"])?.buildDir, "exclusive");
  assertEquals(locksOf(["doctor", "/p"])?.buildDir, "shared");
  assertEquals(locksOf(["desktop", "package", "/p"]), { projectDir: p, packageDirs: ["dist"] });
  assertEquals(locksOf(["desktop", "package", "/p", "--regenerate-scripts"]), undefined);
  assertEquals(locksOf(["start", "/p"]), undefined, "a server never blocks builds");
  assertEquals(locksOf(["dev", "/p"]), undefined, "dev locks per rebuild, not per session");
  assertEquals(locksOf(["test"]), undefined);
  assertEquals(locksOf(["test", "--coverage=cov"])?.outputDirs, ["cov"]);
  assertEquals(locksOf(["mobile", "build", "ios", "--dry-run"]), undefined);
});

Deno.test("coverageDir reads deno test's --coverage[=<dir>]", () => {
  assertEquals(coverageDir([]), undefined);
  assertEquals(coverageDir(["--coverage"]), "coverage");
  assertEquals(coverageDir(["--coverage=cov/profile", "x.test.ts"]), "cov/profile");
  assertEquals(coverageDir(["--", "--coverage=x"]), undefined, "after -- it is the tests' arg");
});

Deno.test("mobile build locks its output dir as a package output", () => {
  const out = buildRegistry().parse(["mobile", "build", "ios", "--dir", "/app"]);
  assert(out.kind === "run");
  assertEquals(mobileBuildLocks(out.ctx), {
    projectDir: resolve("/app"),
    packageDirs: [resolve("/app", "dist/mobile")],
  });
});

Deno.test(
  "the desktop runtime downloader waits while another process mutates the cache",
  SUBPROCESS,
  async () => {
    const { ensureDesktopRuntime } = await import("../src/build/desktop-runtime.ts");
    const dir = await Deno.makeTempDir();
    try {
      const script = await holderScript(dir);
      const mutator = spawnHolder(script, { cache: dir, mode: "mutate" });
      await mutator.waitFor("locked");
      let settled = false;
      const run = ensureDesktopRuntime({
        target: "aarch64-apple-darwin",
        backend: "webview",
        cacheRoot: dir,
        log: () => {},
        harmonize: false,
        fetch: () => Promise.reject(new Error("offline")),
      }).then(() => null, (err: unknown) => err).finally(() => settled = true);
      await new Promise((r) => setTimeout(r, 400));
      assert(!settled, "Shared must wait for MutateExclusive");
      await mutator.release();
      await mutator.status;
      assert(await run instanceof Error, "then it proceeds (and fails offline)");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
