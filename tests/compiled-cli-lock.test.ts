// The lock that keeps the compiled-binary integration tests from compiling the CLI twice at once
// (tests/integration/_compiled-cli.ts): two compiles together outgrow a 3.5 GB CI container.

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { sharedCompileDir, withLock } from "./integration/_compiled-cli.ts";

Deno.test("compiled CLI lock: a second holder waits until the first lets go", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const lock = join(tmp, "x.lock");
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => release = resolve);
    let entered!: () => void;
    const firstIn = new Promise<void>((resolve) => entered = resolve);
    const first = withLock(lock, async () => {
      order.push("first in");
      entered();
      await held;
      order.push("first out");
    });
    await firstIn;
    const second = withLock(lock, () => {
      order.push("second in");
      return Promise.resolve(7);
    });
    // The second open of the file is a separate lock: it must not get in while the first holds it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assertEquals(order, ["first in"]);
    release();
    await first;
    assertEquals(await second, 7);
    assertEquals(order, ["first in", "first out", "second in"]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("compiled CLI lock: the lock is released when the work throws", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const lock = join(tmp, "x.lock");
    let threw = false;
    await withLock(lock, () => Promise.reject(new Error("compile failed"))).catch(() =>
      threw = true
    );
    assertEquals(threw, true);
    assertEquals(await withLock(lock, () => Promise.resolve("next")), "next");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("compiled CLI lock: one shared directory per process, beside its lock", () => {
  const a = sharedCompileDir("/t");
  assertEquals(a, sharedCompileDir("/t"));
  assertEquals(a.dir, join("/t", `denext_compiled_cli_shared_${Deno.pid}`));
  assertEquals(a.lock, `${a.dir}.lock`);
  assertNotEquals(a.dir, sharedCompileDir("/u").dir);
});
