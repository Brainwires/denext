// The desktop runtime's OS advisory lock (src/desktop/os-lock.ts): a held lock refuses a second
// opener (two opens in one process are separate owners), a waiter takes it once the holder lets go,
// a timeout answers `null`, release is idempotent (and `using` releases), releaseAsync frees the
// lock before it resolves, the lock file is created
// `0600` and kept, and a failing lock call closes the file before it rethrows.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { acquireOsLock } from "../src/desktop/os-lock.ts";

/** Run `fn` with a fresh temporary folder, removed afterwards. */
async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext-os-lock-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("os-lock: a held lock refuses a second opener; release frees it; the file stays", () =>
  withDir(async (dir) => {
    const path = join(dir, "app.lock");
    const first = await acquireOsLock(path, { timeoutMs: 0 });
    assert(first, "the first opener takes the lock");
    try {
      assertEquals(
        await acquireOsLock(path, { timeoutMs: 0 }),
        null,
        "a second open, in the same process, is another owner",
      );
    } finally {
      first.release();
    }
    first.release(); // idempotent: the second call is a no-op
    const again = await acquireOsLock(path, { timeoutMs: 0 });
    assert(again, "released: the next opener takes it");
    again.release();
    const info = await Deno.stat(path);
    assert(info.isFile, "the lock file is never removed");
    assertEquals(info.size, 0, "it carries no content");
    if (Deno.build.os !== "windows") assertEquals(info.mode! & 0o777, 0o600);
  }));

Deno.test("os-lock: a waiter polls until the holder lets go", () =>
  withDir(async (dir) => {
    const path = join(dir, "app.lock");
    const holder = await acquireOsLock(path, { timeoutMs: 0 });
    assert(holder);
    const started = Date.now();
    const freed = setTimeout(() => holder.release(), 60);
    try {
      const waiter = await acquireOsLock(path, { timeoutMs: 5_000, pollMs: 10 });
      assert(waiter, "taken once the holder released it, before the deadline");
      assert(Date.now() - started >= 50, "it waited for the release");
      waiter.release();
    } finally {
      clearTimeout(freed);
      holder.release();
    }
  }));

Deno.test("os-lock: a lock still held at the deadline answers null (default poll interval)", () =>
  withDir(async (dir) => {
    const path = join(dir, "app.lock");
    using _holder = (await acquireOsLock(path, { timeoutMs: 0 }))!;
    const started = Date.now();
    assertEquals(await acquireOsLock(path, { timeoutMs: 80 }), null);
    assert(Date.now() - started >= 70, "it tried until the deadline, not once");
  }));

Deno.test("os-lock: `using` releases the lock at the end of its scope", () =>
  withDir(async (dir) => {
    const path = join(dir, "app.lock");
    {
      using lock = await acquireOsLock(path, { timeoutMs: 0 });
      assert(lock);
      assertEquals(await acquireOsLock(path, { timeoutMs: 0 }), null);
    }
    const after = await acquireOsLock(path, { timeoutMs: 0 });
    assert(after, "disposed: free again");
    after.release();
  }));

Deno.test("os-lock: releaseAsync frees the lock before it resolves, idempotent with release", () =>
  withDir(async (dir) => {
    const path = join(dir, "app.lock");
    for (let i = 0; i < 20; i++) {
      const lock = await acquireOsLock(path, { timeoutMs: 0 });
      assert(lock, `round ${i}: free after the previous releaseAsync resolved`);
      await lock.releaseAsync();
      await lock.releaseAsync(); // idempotent
      lock.release(); // and release after it is a no-op
    }
    const proto = Deno.FsFile.prototype;
    const unlock = proto.unlock;
    proto.unlock = () => Promise.reject(new Error("unlock refused"));
    try {
      const lock = await acquireOsLock(path, { timeoutMs: 0 });
      assert(lock);
      await lock.releaseAsync(); // a failing unlock still closes the file, which frees the lock
    } finally {
      proto.unlock = unlock;
    }
    const after = await acquireOsLock(path, { timeoutMs: 0 });
    assert(after, "closed: free again");
    after.release();
  }));

Deno.test("os-lock: a lock file whose folder is missing rejects", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-os-lock-" });
  await Deno.remove(dir);
  await assertRejects(
    () => acquireOsLock(join(dir, "app.lock"), { timeoutMs: 0 }),
    Deno.errors.NotFound,
  );
});

Deno.test("os-lock: a failing lock call closes the file and rethrows", () =>
  withDir(async (dir) => {
    const path = join(dir, "app.lock");
    const proto = Deno.FsFile.prototype;
    const tryLock = proto.tryLock;
    const close = proto.close;
    let closed = 0;
    proto.tryLock = () => Promise.reject(new Error("lock refused by the file system"));
    proto.close = function (this: Deno.FsFile) {
      closed++;
      return close.call(this);
    };
    try {
      await assertRejects(
        () => acquireOsLock(path, { timeoutMs: 1_000 }),
        Error,
        "lock refused by the file system",
      );
      assertEquals(closed, 1, "the descriptor is closed, not leaked");
    } finally {
      proto.tryLock = tryLock;
      proto.close = close;
    }
    // The real lock still works on the same file afterwards.
    const lock = await acquireOsLock(path, { timeoutMs: 0 });
    assert(lock);
    lock.release();
  }));

Deno.test("os-lock: release swallows a close that throws (the descriptor is already gone)", () =>
  withDir(async (dir) => {
    const path = join(dir, "app.lock");
    const lock = await acquireOsLock(path, { timeoutMs: 0 });
    assert(lock);
    const proto = Deno.FsFile.prototype;
    const close = proto.close;
    proto.close = function (this: Deno.FsFile) {
      close.call(this);
      throw new Deno.errors.BadResource("already closed");
    };
    try {
      lock.release(); // does not throw
    } finally {
      proto.close = close;
    }
    const next = await acquireOsLock(path, { timeoutMs: 0 });
    assert(next, "the lock was released all the same");
    next.release();
  }));
