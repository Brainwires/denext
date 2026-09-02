// Coverage for the small pure utilities: tryCatch's success/throw/reject branches
// and useAsyncEffect.wrap's aborted / ran / threw branches.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { tryCatch } from "../src/utils/try-catch.ts";
import { useAsyncEffect } from "../src/utils/use-async-effect.ts";

Deno.test("tryCatch: a returned value yields [true, data]", async () => {
  const r = await tryCatch(() => 42);
  assertEquals(r, [true, 42]);
});

Deno.test("tryCatch: a fulfilled promise yields [true, data]", async () => {
  const r = await tryCatch(() => Promise.resolve("ok"));
  assert(r[0]);
  assertEquals(r[1], "ok");
});

Deno.test("tryCatch: a synchronous throw yields [false, error]", async () => {
  const boom = new Error("sync boom");
  const r = await tryCatch<never, Error>(() => {
    throw boom;
  });
  assert(!r[0]);
  assertEquals(r[1], boom);
});

Deno.test("tryCatch: a rejected promise yields [false, error]", async () => {
  const r = await tryCatch<number, string>(() => Promise.reject("nope"));
  assertEquals(r, [false, "nope"]);
});

Deno.test("useAsyncEffect.wrap: runs the task and resolves when not aborted", async () => {
  const ac = new AbortController();
  let ran = false;
  await useAsyncEffect.wrap(ac.signal, () => {
    ran = true;
  });
  assert(ran, "task should run when the signal is not aborted");
});

Deno.test("useAsyncEffect.wrap: skips the task (resolves) when already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  let ran = false;
  await useAsyncEffect.wrap(ac.signal, () => {
    ran = true;
  });
  assert(!ran, "task must be skipped when the signal is already aborted");
});

Deno.test("useAsyncEffect.wrap: rejects if the task throws", async () => {
  const ac = new AbortController();
  await assertRejects(
    () =>
      useAsyncEffect.wrap(ac.signal, () => {
        throw new Error("task boom");
      }),
    Error,
    "task boom",
  );
});
