// Coverage for the small pure utilities: tryCatch's success/throw/reject branches
// and useAsyncEffect.wrap's aborted / ran / threw branches.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { tryCatch } from "../src/utils/try-catch.ts";
import { useAsyncEffect } from "../src/utils/use-async-effect.ts";
import { choose } from "../src/utils/choose.ts";

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

Deno.test("choose: runs the matching branch and returns its value", () => {
  const out = choose<"a" | "b" | "c", number>("b", {
    a: () => 1,
    b: () => 2,
    c: () => 3,
  });
  assertEquals(out, 2);
});

Deno.test("choose: runs defaultCase when no case matches", () => {
  const out = choose("z" as "a" | "z", { a: () => 1 }, () => 99);
  assertEquals(out, 99);
});

Deno.test("choose: returns undefined when nothing matches and no default", () => {
  const out = choose("z" as "a" | "z", { a: () => 1 });
  assertEquals(out, undefined);
});

Deno.test("choose: only the selected branch runs", () => {
  let aRan = false;
  let bRan = false;
  choose<"a" | "b", number>("a", {
    a: () => {
      aRan = true;
      return 1;
    },
    b: () => {
      bRan = true;
      return 2;
    },
  });
  assert(aRan);
  assert(!bRan);
});

Deno.test('choose: a "default" value matches a `default` case, not the fallback', () => {
  const out = choose<"default", string>("default", { default: () => "case" }, () => "fallback");
  assertEquals(out, "case");
});
