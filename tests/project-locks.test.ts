// Cargo-style build locks (src/build/file-lock.ts + src/build/project-locks.ts): real OS locks
// in REAL processes. A second writer prints Cargo's `Blocking waiting for file lock on …` once
// and waits until the first exits; shared readers run side by side; a SIGKILLed holder's lock is
// released by the OS (no stale-lock heuristic); the plan's order is fixed; and the CLI dispatch
// takes a verb's declared locks (`denext test --coverage=<dir>`).

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, relative, resolve } from "@std/path";
import {
  acquireFileLock,
  blockingLine,
  type FileLock,
  lockingUnsupported,
  lockTask,
  lockTimeoutMs,
} from "../src/build/file-lock.ts";
import {
  acquireCacheLock,
  BUILD_DIR_LOCK,
  buildDirLockPath,
  CACHE_DOWNLOAD_LOCK,
  CACHE_MUTATE_LOCK,
  LOCK_RANK,
  outputLockPath,
  planProjectLocks,
  withBuildDirLock,
  withProjectLocks,
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

/** How long {@linkcode Holder.waitFor} waits by default. */
const HOLDER_WAIT_MS = 60_000;

interface Holder {
  /**
   * Resolves once stdout has printed `text`; rejects when the holder exits first, or after `ms`
   * (so a lock that never comes fails the test with what the holder said, not a hung CI job).
   */
  waitFor(text: string, ms?: number): Promise<void>;
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
    async waitFor(text, ms = HOLDER_WAIT_MS) {
      const deadline = Date.now() + ms;
      while (!out.includes(text)) {
        if (exited) throw new Error(`holder exited before "${text}":\n${err.join("\n")}`);
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new Error(
            `timed out after ${ms} ms waiting for the holder to print "${text}" ` +
              `(spec ${JSON.stringify(spec)}); stderr:\n${err.join("\n")}`,
          );
        }
        await new Promise<void>((r) => {
          const timer = setTimeout(r, left);
          waiters.push(() => {
            clearTimeout(timer);
            r();
          });
        });
      }
    },
    saw: (text) => out.includes(text),
    stderr: () => err.join("\n"),
    async release() {
      await writer.close().catch(() => {});
    },
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
    },
    // A killed holder never had its stdin closed: once it is gone, let the pipe go too.
    status: done.then(async () => {
      const status = await child.status;
      await writer.close().catch(() => writer.abort().catch(() => {}));
      return status;
    }),
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

Deno.test(
  "a second writer prints the Blocking line once, waits, and proceeds when the first releases",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      const script = await holderScript(dir);
      const spec = { projectDir: dir, buildDir: "exclusive", outputDirs: ["out"] };
      const first = spawnHolder(script, spec);
      await first.waitFor("locked");
      const second = spawnHolder(script, spec);
      await eventually(() => second.stderr().includes("Blocking"), "the Blocking line");
      assertEquals(
        second.stderr(),
        blockingLine("build directory .denext", resolve(buildDirLockPath(dir))),
      );
      assertStringIncludes(second.stderr(), "held by another denext process; Ctrl-C to abort");
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

Deno.test("a killed holder's lock is released by the OS — no stale lock", async () => {
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
  async () => {
    const dir = await Deno.makeTempDir();
    const holders: Holder[] = [];
    try {
      const script = await holderScript(dir);
      const reader = spawnHolder(script, { cache: dir, mode: "shared" });
      holders.push(reader);
      await reader.waitFor("locked");
      const downloader = spawnHolder(script, { cache: dir, mode: "download" });
      holders.push(downloader);
      await downloader.waitFor("locked");
      assertEquals(downloader.stderr(), "", "DownloadExclusive does not wait for Shared");
      const second = spawnHolder(script, { cache: dir, mode: "download" });
      holders.push(second);
      await eventually(() => second.stderr().includes("Blocking"), "a second downloader waiting");
      const mutator = spawnHolder(script, { cache: dir, mode: "mutate" });
      holders.push(mutator);
      await eventually(() => mutator.stderr().includes("Blocking"), "the mutator waiting");
      // One release at a time, so exactly one waiter can take each freed lock (the waiters poll:
      // releasing the reader and the downloader together let the mutator take the download lock
      // ahead of the second downloader, and this test then waited on a holder it never released).
      // The downloader's lock goes to the second downloader: the mutator still waits on the reader.
      await downloader.release();
      await second.waitFor("locked");
      assert(!mutator.saw("locked"), "a Shared reader keeps the mutator out");
      // The reader leaves: the mutator takes the mutate lock, then waits on the download lock.
      await reader.release();
      await reader.status;
      await new Promise((r) => setTimeout(r, 500));
      assert(!mutator.saw("locked"), "a download in flight keeps the mutator out");
      await second.release();
      await mutator.waitFor("locked");
      await mutator.release();
      await Promise.all([reader.status, downloader.status, second.status, mutator.status]);
      await Deno.stat(join(dir, CACHE_MUTATE_LOCK));
      await Deno.stat(join(dir, CACHE_DOWNLOAD_LOCK));
    } finally {
      for (const h of holders) h.kill();
      await Promise.all(holders.map((h) => h.status));
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "denext test --coverage=<dir> takes the output-dir lock through the CLI dispatch",
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
        () => err.join("\n").includes("Blocking waiting for file lock on output directory cov ("),
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

/** A promise and the function that settles it. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((r) => open = r);
  return { opened, open };
}

Deno.test("the rank order is per task: an unrelated concurrent task may take a lower rank", async () => {
  // Two independent tasks of one process: one holds an output-dir lock (rank 2) across its work,
  // the other locks another project's build directory (rank 1) meanwhile. Nothing either holds
  // is something the other waits for, so it is no order violation (the process-wide check threw).
  const [a, b] = [await Deno.makeTempDir(), await Deno.makeTempDir()];
  try {
    const holding = gate();
    const done = gate();
    const first = withProjectLocks({ projectDir: a, outputDirs: ["out"] }, async () => {
      holding.open();
      await done.opened;
    });
    await holding.opened;
    try {
      await withProjectLocks({ projectDir: b, buildDir: "exclusive" }, () => Promise.resolve());
      // Outside every task (the process's root task) too: the holder is not this code's task.
      (await acquireCacheLock(join(b, "cache"), "shared", "test cache")).release();
      (await acquireFileLock(join(b, "low.lock"), {
        mode: "exclusive",
        description: "low",
        rank: LOCK_RANK.packageOutput,
      })).release();
    } finally {
      done.open();
    }
    await first;
    // Explicit tasks: one holds a rank-4 lock, a sibling takes rank 3 and then rank 1.
    const high = gate();
    const finish = gate();
    const holder = lockTask(async () => {
      using _l = await acquireFileLock(join(a, "high.lock"), {
        mode: "exclusive",
        description: "high",
        rank: LOCK_RANK.cacheDownload,
      });
      high.open();
      await finish.opened;
    });
    await high.opened;
    try {
      await lockTask(async () => {
        using _mid = await acquireFileLock(join(b, "mid.lock"), {
          mode: "shared",
          description: "mid",
          rank: LOCK_RANK.cacheMutate,
        });
        await assertRejects(
          () =>
            acquireFileLock(join(b, "lower.lock"), {
              mode: "exclusive",
              description: "lower",
              rank: LOCK_RANK.buildDir,
            }),
          Error,
          "requested while holding a rank-3 lock", // its own rank, not the sibling's 4
        );
      });
    } finally {
      finish.open();
    }
    await holder;
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

Deno.test("one task out of rank order still throws: across awaits, nested calls, work it started", async () => {
  const dir = await Deno.makeTempDir();
  const low = (rank: number = LOCK_RANK.buildDir) =>
    acquireFileLock(join(dir, `low-${rank}.lock`), { mode: "exclusive", description: "low", rank });
  const violation = (
    p: () => Promise<unknown>,
    message = "lock order violation — low (rank 1) requested while holding a rank-3 lock",
  ) => assertRejects(p, Error, message);
  try {
    await lockTask(async () => {
      using high = await acquireFileLock(join(dir, "high.lock"), {
        mode: "exclusive",
        description: "high",
        rank: LOCK_RANK.cacheMutate,
      });
      await new Promise((r) => setTimeout(r, 5));
      // Later in the task, and from a function it calls after more awaits.
      await violation(() => low());
      const nested = async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 1));
        return await low();
      };
      await violation(nested);
      // A subtask started inside it sees what its task holds (the task may be waiting on it).
      await violation(() => lockTask(() => low()));
      await violation(
        () => withProjectLocks({ projectDir: dir, buildDir: "exclusive" }, () => Promise.resolve()),
        "(rank 1) requested while holding a rank-3 lock",
      );
      // A timer and a detached promise started under the lock run in the task too.
      const fromTimer = new Promise<FileLock>((res, rej) =>
        setTimeout(() => low().then(res, rej), 1)
      );
      await violation(() => fromTimer);
      const later = gate();
      const detached = later.opened.then(() => low());
      await violation(() => Promise.resolve().then(() => low()));
      // Once the lock is released, the work the task started no longer holds it.
      high.release();
      later.open();
      (await detached).release();
      (await low(LOCK_RANK.packageOutput)).release();
    });
    // Outside every task the order is still the process's: a lock taken there counts everywhere.
    using root = await acquireFileLock(join(dir, "root-high.lock"), {
      mode: "exclusive",
      description: "high",
      rank: LOCK_RANK.cacheMutate,
    });
    await violation(() => lockTask(() => low()));
    root.release();
    // A lock two tasks share (re-entrant) counts against each until that task drops its reference.
    const path = join(dir, "shared.lock");
    const opts = { mode: "shared", description: "high", rank: LOCK_RANK.cacheMutate } as const;
    const hold = gate();
    const drop = gate();
    const other = lockTask(async () => {
      const lock = await acquireFileLock(path, opts);
      hold.open();
      await drop.opened;
      await violation(() => low());
      lock.release();
    });
    await hold.opened;
    await lockTask(async () => {
      const mine = await acquireFileLock(path, opts);
      await violation(() => low());
      mine.release();
      (await low()).release(); // the other task still holds it, but this one no longer does
    });
    drop.open();
    await other;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Whether `p` settles within `ms` (`"settled"`) or is still pending then (`"waiting"`). */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<"settled" | "waiting"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.then(() => "settled" as const, () => "settled" as const),
    new Promise<"waiting">((r) => timer = setTimeout(() => r("waiting"), ms)),
  ]).finally(() => clearTimeout(timer));
}

Deno.test("two tasks of one process take turns on an exclusive lock, first come first served", async () => {
  // Two `denext dev` rebuilds (the startup's prepare steps, a request's typed-module emit, a
  // watcher batch) each lock the build directory as their own task. The OS lock only keeps other
  // processes out: a second task of this process must wait for the first, not share its count.
  const dir = await Deno.makeTempDir();
  try {
    const order: string[] = [];
    const holding = gate();
    const finish = gate();
    const rebuild = (name: string, hold?: () => Promise<void>) =>
      withBuildDirLock(dir, async () => {
        order.push(`${name} in`);
        await hold?.();
        await new Promise((r) => setTimeout(r, 5));
        order.push(`${name} out`);
      });
    const a = rebuild("a", () => {
      holding.open();
      return finish.opened;
    });
    await holding.opened;
    const b = rebuild("b");
    const c = rebuild("c");
    assertEquals(await settlesWithin(b, 50), "waiting", "b waits while a holds the directory");
    assertEquals(order, ["a in"]);
    finish.open();
    await Promise.all([a, b, c]);
    assertEquals(order, ["a in", "a out", "b in", "b out", "c in", "c out"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the holding task and the work it starts re-enter its lock; a sibling waits", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "x.lock");
    const opts = { mode: "exclusive", description: "x", rank: LOCK_RANK.buildDir } as const;
    const holding = gate();
    const finish = gate();
    let siblingIn = false;
    const holder = lockTask(async () => {
      using _held = await acquireFileLock(path, opts);
      holding.open();
      // A nested acquire, a subtask, a nested withProjectLocks, a timer and a detached promise
      // started under the lock all belong to this task: a reference count, never a wait.
      const nested = [
        () => acquireFileLock(path, opts),
        () => lockTask(() => acquireFileLock(path, { ...opts, mode: "shared" })),
        () =>
          new Promise<FileLock>((res, rej) =>
            setTimeout(() => acquireFileLock(path, opts).then(res, rej), 1)
          ),
        () => Promise.resolve().then(() => acquireFileLock(path, opts)),
      ];
      for (const take of nested) {
        const lock = take();
        assertEquals(await settlesWithin(lock, 2_000), "settled");
        (await lock).release();
      }
      await withBuildDirLock(dir, async () => {
        const inner = withBuildDirLock(dir, () => Promise.resolve());
        assertEquals(await settlesWithin(inner, 2_000), "settled");
      });
      assertEquals(siblingIn, false, "the sibling is still waiting");
      await finish.opened;
    });
    await holding.opened;
    const sibling = lockTask(async () => {
      using _l = await acquireFileLock(path, opts);
      siblingIn = true;
    });
    assertEquals(await settlesWithin(sibling, 50), "waiting");
    finish.open();
    await holder;
    await sibling;
    assert(siblingIn);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("across tasks: shared holds coexist, exclusive excludes, waiters go in arrival order", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "x.lock");
    const shared = { mode: "shared", description: "x", rank: LOCK_RANK.buildDir } as const;
    const exclusive = { ...shared, mode: "exclusive" } as const;
    const order: string[] = [];
    /** A task that takes `opts`, records it, and holds until `until` opens. */
    const task = (name: string, opts: typeof shared | typeof exclusive, until: Promise<void>) => {
      const taken = gate();
      const done = lockTask(async () => {
        using _l = await acquireFileLock(path, opts);
        order.push(name);
        taken.open();
        await until;
        order.push(`${name} done`);
      });
      return { taken: taken.opened, done };
    };
    const releaseReaders = gate();
    const r1 = task("r1", shared, releaseReaders.opened);
    await r1.taken;
    const r2 = task("r2", shared, releaseReaders.opened);
    await r2.taken; // a second reader joins at once
    // A reader's own task can't upgrade (as before); another task's exclusive request waits.
    const releaseWriter = gate();
    const w = task("w", exclusive, releaseWriter.opened);
    assertEquals(await settlesWithin(w.taken, 50), "waiting");
    // A reader arriving after the waiting writer queues behind it (no writer starvation).
    const r3 = task("r3", shared, Promise.resolve());
    assertEquals(await settlesWithin(r3.taken, 50), "waiting");
    releaseReaders.open();
    await w.taken;
    assertEquals(await settlesWithin(r3.taken, 50), "waiting", "r3 waits for the writer too");
    releaseWriter.open();
    await Promise.all([r1.done, r2.done, w.done, r3.done]);
    assertEquals(order, ["r1", "r2", "r1 done", "r2 done", "w", "w done", "r3", "r3 done"]);
    // A shared hold still can't be upgraded by its own task.
    await lockTask(async () => {
      using _s = await acquireFileLock(path, shared);
      await assertRejects(() => acquireFileLock(path, exclusive), Error, "not upgraded in place");
    });
    // A request that may wait is rank-checked like a new lock, even to join another task's
    // shared hold: waiting on rank 1 while holding rank 3 could deadlock.
    const hold = gate();
    const end = gate();
    const reader = lockTask(async () => {
      using _s = await acquireFileLock(path, shared);
      hold.open();
      await end.opened;
    });
    await hold.opened;
    await lockTask(async () => {
      using _high = await acquireFileLock(join(dir, "high.lock"), { ...exclusive, rank: 3 });
      await assertRejects(() => acquireFileLock(path, shared), Error, "lock order violation");
    });
    end.open();
    await reader;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a waiter whose acquisition fails hands the turn to the next one", async () => {
  const dir = await Deno.makeTempDir();
  const tryLock = Deno.FsFile.prototype.tryLock;
  try {
    const path = join(dir, "x.lock");
    const opts = { mode: "exclusive", description: "x", rank: LOCK_RANK.buildDir } as const;
    const holding = gate();
    const finish = gate();
    const holder = lockTask(async () => {
      using _l = await acquireFileLock(path, opts);
      holding.open();
      await finish.opened;
    });
    await holding.opened;
    const first = lockTask(() => acquireFileLock(path, opts));
    const second = lockTask(() => acquireFileLock(path, opts));
    assertEquals(await settlesWithin(first, 50), "waiting");
    let failures = 1;
    await withFsFile("tryLock", function (this: Deno.FsFile, exclusive?: boolean) {
      return failures-- > 0
        ? Promise.reject(new Error("EIO: i/o error"))
        : tryLock.call(this, exclusive);
    }, async () => {
      finish.open();
      await holder;
      await assertRejects(() => first, Error, "EIO");
      (await second).release();
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cache locks: another task of this process waits its turn on the cache root", async () => {
  // Two installs in one process (two `ensure*` calls in flight): while one holds the download
  // lock (rank 4), the other's shared read (rank 3) waits for it instead of tripping the rank
  // check, which orders one task's nested locks, not two tasks' independent ones.
  const dir = await Deno.makeTempDir();
  try {
    const order: string[] = [];
    const writer = await acquireCacheLock(dir, "download", "test cache");
    const reader = acquireCacheLock(dir, "shared", "test cache").then((lock) => {
      order.push("reader");
      return lock;
    });
    const replacer = acquireCacheLock(dir, "mutate", "test cache").then((lock) => {
      order.push("replacer");
      return lock;
    });
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(order, [], "both wait while the download lock is held");
    order.push("writer released");
    writer.release();
    (await reader).release();
    (await replacer).release();
    assertEquals(order, ["writer released", "reader", "replacer"]);
    // A failed acquisition gives the turn back: the next one is not stuck behind it.
    await withFsFile("tryLock", () => Promise.reject(new Error("boom")), async () => {
      await assertRejects(() => acquireCacheLock(dir, "shared", "test cache"), Error, "boom");
    });
    using _again = await acquireCacheLock(dir, "mutate", "test cache");
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

Deno.test("more errnos mean a filesystem without locking; each lock file warns once", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const warned: string[] = [];
    const opts = {
      mode: "exclusive",
      description: "nfs dir",
      rank: 1,
      onWarning: (l: string) => warned.push(l),
    } as const;
    const coded = (code: string) => Object.assign(new Error(`${code}: nope`), { code });
    for (const err of [coded("ENOSYS"), coded("EINVAL"), new Error("Function not implemented")]) {
      await withFsFile("tryLock", () => Promise.reject(err), async () => {
        (await acquireFileLock(join(dir, "nfs2.lock"), opts)).release();
      });
    }
    assertEquals(warned.length, 1, "one warning per lock file, however often it is taken");
    assertStringIncludes(warned[0], "warning: proceeding without a lock on nfs dir (");
    assertStringIncludes(warned[0], "nfs2.lock): ENOSYS");
    assert(lockingUnsupported(coded("ENOTSUP")));
    assert(!lockingUnsupported(coded("EIO")));
    assert(!lockingUnsupported("EINVAL as a string is not an error object"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a shared lock on an unwritable directory proceeds unlocked; an exclusive one fails", async () => {
  if (Deno.build.os === "windows") return; // POSIX modes
  const dir = await Deno.makeTempDir();
  const ro = join(dir, "ro");
  await Deno.mkdir(ro);
  await Deno.chmod(ro, 0o555);
  try {
    // root ignores the mode: nothing to test there.
    const writable = await Deno.writeTextFile(join(ro, "probe"), "").then(() => true, () => false);
    if (writable) return;
    const warned: string[] = [];
    const opts = {
      description: "read-only build dir",
      rank: 1,
      onWarning: (l: string) => warned.push(l),
    };
    const lock = await acquireFileLock(join(ro, ".lock"), { ...opts, mode: "shared" });
    lock.release();
    assertStringIncludes(warned.join("\n"), "proceeding without a lock on read-only build dir");
    await assertRejects(
      () => acquireFileLock(join(ro, ".lock2"), { ...opts, mode: "exclusive" }),
      Deno.errors.PermissionDenied,
    );
  } finally {
    await Deno.chmod(ro, 0o755);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  "DENEXT_LOCK_TIMEOUT: a contended lock fails after the limit, naming the lock file",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      const script = await holderScript(dir);
      const holder = spawnHolder(script, { projectDir: dir, buildDir: "exclusive" });
      await holder.waitFor("locked");
      try {
        const path = buildDirLockPath(dir);
        const lines: string[] = [];
        const err = await assertRejects(
          () =>
            acquireFileLock(path, {
              mode: "shared",
              description: "build directory .denext",
              rank: LOCK_RANK.buildDir,
              onBlocking: (l) => lines.push(l),
              timeoutMs: 300,
            }),
          Error,
        );
        assertStringIncludes(err.message, "gave up after 0.3s waiting for file lock");
        assertStringIncludes(err.message, path);
        assertStringIncludes(err.message, "DENEXT_LOCK_TIMEOUT");
        assertEquals(lines, [blockingLine("build directory .denext", resolve(path))]);
      } finally {
        await holder.release();
        await holder.status;
      }
      // Free again: the timed acquire takes it at once.
      (await acquireFileLock(buildDirLockPath(dir), {
        mode: "exclusive",
        description: "x",
        rank: LOCK_RANK.buildDir,
        timeoutMs: 300,
      })).release();
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test("lockTimeoutMs: positive seconds, anything else waits forever", () => {
  assertEquals(lockTimeoutMs("30"), 30_000);
  assertEquals(lockTimeoutMs(" 0.5 "), 500);
  for (const v of [undefined, "", "0", "-3", "soon", "Infinity"]) {
    assertEquals(lockTimeoutMs(v), undefined, String(v));
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

Deno.test("verbs declare their locks", async () => {
  const reg = buildRegistry();
  const locksOf = async (argv: string[]) => {
    const out = reg.parse(argv);
    assert(out.kind === "run");
    return await out.command.locks?.(out.ctx);
  };
  const p = resolve("/p");
  assertEquals(await locksOf(["build", "/p"]), { projectDir: p, buildDir: "exclusive" });
  assertEquals(await locksOf(["export", "/p"]), {
    projectDir: p,
    buildDir: "exclusive",
    outputDirs: ["out"],
  });
  assertEquals((await locksOf(["analyze", "/p"]))?.buildDir, "exclusive");
  assertEquals((await locksOf(["doctor", "/p"]))?.buildDir, "shared");
  assertEquals(await locksOf(["desktop", "package", "/p"]), {
    projectDir: p,
    packageDirs: ["dist"],
  });
  assertEquals(await locksOf(["desktop", "package", "/p", "--regenerate-scripts"]), undefined);
  assertEquals(await locksOf(["start", "/p"]), undefined, "a server never blocks builds");
  assertEquals(await locksOf(["dev", "/p"]), undefined, "dev locks per rebuild, not per session");
  assertEquals(await locksOf(["test"]), undefined);
  assertEquals((await locksOf(["test", "--coverage=cov"]))?.outputDirs, ["cov"]);
  assertEquals(await locksOf(["mobile", "build", "ios", "--dry-run"]), undefined);
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
