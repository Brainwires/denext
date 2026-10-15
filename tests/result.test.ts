// denext/result: Result values, the combinators, tryAsync / trySync (which must re-throw React's
// and denext's control flow), assertNever and the exhaustive `match`. The type-level checks are
// compiled by `deno test`'s type-check: an `Equal` assertion that does not hold, or a
// `@ts-expect-error` line that stops erroring, fails the run.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  andThen,
  assertNever,
  type Err,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  match,
  type Ok,
  ok,
  type Result,
  tryAsync,
  trySync,
  unwrapOr,
} from "../src/result.ts";
import { notFound, redirect } from "../src/runtime/error-boundary.ts";

/** Compile-time equality: `expectType<Equal<A, B>>(true)` fails to type-check unless A ≡ B. */
type Equal<A, B> = (<V>() => V extends A ? 1 : 2) extends (<V>() => V extends B ? 1 : 2) ? true
  : false;
function expectType<T extends true>(_ok: T): void {}

type Shape =
  | { kind: "circle"; r: number }
  | { kind: "square"; side: number }
  | { kind: "rect"; w: number; h: number };

Deno.test("ok / err build plain discriminated objects; the brand never reaches JSON", () => {
  const a = ok(1);
  const b = err("nope");
  assertEquals(a, { ok: true, value: 1 } as unknown as Ok<number>);
  assertEquals(JSON.parse(JSON.stringify(a)), { ok: true, value: 1 });
  assertEquals(JSON.parse(JSON.stringify(b)), { ok: false, error: "nope" });
  assertEquals(JSON.parse(JSON.stringify(err("x", { data: 1 }))), {
    ok: false,
    error: "x",
    details: { data: 1 },
  });
  assertEquals(a["~result"], "ok");
  assertEquals(b["~result"], "err");
  assertEquals(Object.keys(b), ["ok", "error"]);
  assertEquals(ok().value, undefined);
  expectType<Equal<typeof b, Err<"nope", undefined>>>(true);
  expectType<Equal<typeof a, Ok<number>>>(true);
});

Deno.test("isOk / isErr narrow, and read .ok so a serialized Result still works", () => {
  const r = (Math.random() > 2 ? err("x") : ok(2)) as Result<number, string>;
  if (isOk(r)) expectType<Equal<typeof r.value, number>>(true);
  else expectType<Equal<typeof r.error, string>>(true);
  const wire = JSON.parse(JSON.stringify(err("gone"))) as Result<number, string>;
  assert(isErr(wire));
  assert(!isOk(wire));
});

Deno.test("map / mapErr / andThen / unwrapOr", () => {
  // `as` (not an annotation) so the declared union is not narrowed away by the initializer.
  const good = ok(2) as Result<number, "bad">;
  const bad = err("bad") as Result<number, "bad">;
  assertEquals(unwrapOr(map(good, (n) => n * 10), 0), 20);
  assertEquals(unwrapOr(map(bad, (n) => n * 10), 0), 0);
  const upper = mapErr(bad, (e) => e.toUpperCase());
  assert(!upper.ok && upper.error === "BAD");
  assertEquals(mapErr(good, () => "never"), good);
  // details survive mapErr
  const detailed = mapErr(err("x", { data: 7 }) as Result<number, string>, (e) => `${e}!`);
  assert(!detailed.ok);
  assertEquals(detailed.details, { data: 7 });
  const half = (n: number): Result<number, "odd"> => n % 2 ? err("odd") : ok(n / 2);
  const chained = andThen(good, half);
  expectType<Equal<typeof chained, Result<number, "bad" | "odd">>>(true);
  assertEquals(unwrapOr(chained, -1), 1);
  assertEquals(unwrapOr(andThen(ok(3) as Result<number, "bad">, half), -1), -1);
  assertEquals(andThen(bad, half), bad);
});

Deno.test("trySync / tryAsync capture throws and rejections, with a typed error mapper", async () => {
  assertEquals(unwrapOr(trySync(() => JSON.parse("[1]") as number[]), []), [1]);
  const broken = trySync(() => JSON.parse("{") as unknown, () => "invalid_json" as const);
  expectType<Equal<typeof broken, Result<unknown, "invalid_json">>>(true);
  assert(!broken.ok && broken.error === "invalid_json");
  const raw = trySync(() => {
    throw new RangeError("r");
  });
  assert(!raw.ok && raw.error instanceof RangeError);

  const fetched = await tryAsync(() => Promise.resolve(5));
  expectType<Equal<typeof fetched, Result<number, unknown>>>(true);
  assertEquals(unwrapOr(fetched, 0), 5);
  const rejected = await tryAsync(
    () => Promise.reject(new Error("down")),
    (e) => ({ tag: "network", message: (e as Error).message }),
  );
  assert(!rejected.ok);
  assertEquals(rejected.error, { tag: "network", message: "down" });
  const sync = await tryAsync(() => 1);
  assertEquals(unwrapOr(sync, 0), 1);
});

Deno.test("trySync / tryAsync re-throw Suspense thenables and notFound() / redirect()", async () => {
  const thenable = Promise.resolve();
  try {
    trySync(() => {
      throw thenable;
    });
    throw new Error("expected a re-throw");
  } catch (e) {
    assert(e === thenable);
  }
  assertThrows(() => trySync(() => notFound()));
  await assertRejects(() => tryAsync(() => redirect("/login")));
  await assertRejects(() =>
    tryAsync(() => {
      throw new Error("wrapped", { cause: notFound() });
    })
  );
});

Deno.test("assertNever: a compile-time guard that throws if reached", () => {
  const area = (s: Shape): number => {
    switch (s.kind) {
      case "circle":
        return s.r;
      case "square":
        return s.side;
      case "rect":
        return s.w * s.h;
      default:
        return assertNever(s);
    }
  };
  assertEquals(area({ kind: "rect", w: 2, h: 3 }), 6);
  assertThrows(() => area({ kind: "hexagon" } as unknown as Shape), TypeError, "hexagon");
  assertThrows(() => assertNever(1 as never, "custom"), TypeError, "custom");

  const missing = (s: Shape): number => {
    switch (s.kind) {
      case "circle":
        return s.r;
      case "square":
        return s.side;
      default:
        // @ts-expect-error -- "rect" is not handled, so `s` is not `never`
        return assertNever(s);
    }
  };
  void missing;
});

Deno.test("match: discriminated unions narrow per case and the result is the handlers' union", () => {
  const describe = (s: Shape) =>
    match(s)
      .with({ kind: "circle" }, (c) => {
        expectType<Equal<typeof c, { kind: "circle"; r: number }>>(true);
        return c.r;
      })
      .with({ kind: "square" }, (q) => `side ${q.side}`)
      .with({ kind: "rect" }, (r) => r.w * r.h > 10)
      .exhaustive();
  expectType<Equal<ReturnType<typeof describe>, number | string | boolean>>(true);
  assertEquals(describe({ kind: "circle", r: 2 }), 2);
  assertEquals(describe({ kind: "square", side: 1 }), "side 1");
  assertEquals(describe({ kind: "rect", w: 4, h: 4 }), true);
});

Deno.test("match: literal unions, Results, first match wins, and otherwise()", () => {
  type Status = "idle" | "loading" | "done";
  const icon = (s: Status) =>
    match(s).with("idle", () => "·").with("loading", () => "…").with("done", () => "✓")
      .exhaustive();
  assertEquals(icon("loading"), "…");

  const r = err("nope") as Result<number, "nope">;
  const text = match(r)
    .with({ ok: true }, (v) => `value ${v.value}`)
    .with({ ok: false }, (e) => `error ${e.error}`)
    .exhaustive();
  assertEquals(text, "error nope");

  const first = match(3 as 1 | 2 | 3 | number).with(3, () => "three").otherwise(() => "other");
  assertEquals(first, "three");
  assertEquals(match(NaN).with(NaN, () => "nan").otherwise(() => "num"), "nan");
  assertEquals(match(null as string | null).with(null, () => 0).otherwise((s) => s.length), 0);
  assertEquals(match({ a: 1 } as { a: number } | null).with(null, () => 0).otherwise(() => 1), 1);
  assertEquals(
    match("x" as string | { k: string }).with({ k: "x" }, () => 1).otherwise(() => 2),
    2,
  );
});

Deno.test("match: a missing case does not compile; a value outside the type throws at runtime", () => {
  const partial = (s: Shape) =>
    match(s).with({ kind: "circle" }, () => 1).with({ kind: "square" }, () => 2)
      // @ts-expect-error -- `{ kind: "rect" }` is unhandled, so `.exhaustive` is not callable
      .exhaustive();
  void partial;
  // @ts-expect-error -- "late" is not a member of the union
  match("idle" as "idle" | "done").with("late", () => 0);
  assertThrows(
    () => match("other" as unknown as "a").with("a", () => 1).exhaustive(),
    TypeError,
    "no pattern matched",
  );
});
