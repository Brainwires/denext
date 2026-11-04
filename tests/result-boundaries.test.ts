// `err()` from denext/result at the typed boundaries: a `defineApi` handler may return
// `err(code, init?)` instead of calling `fail()`, and a `defineAction` handler
// `err(message, { fieldErrors })` instead of throwing `ActionValidationError`. The returned
// `Err` maps to the same envelope / ActionResult, is excluded from the success type the
// client sees, and an undeclared code is a compile error (`@ts-expect-error` lines below fail
// the type-check if they stop erroring). Existing `fail()` / throw behaviour is covered by
// define-api.test.ts and define-action.test.ts, unchanged.

import { assert, assertEquals } from "@std/assert";
import { type ApiErrGuard, defineApi } from "../src/server/define-api.ts";
import { handleApi } from "../src/server/api.ts";
import { asyncProps } from "../src/runtime/async-props.ts";
import {
  defineAction,
  idleActionState,
  type StandardSchemaV1,
} from "../src/runtime/define-action.ts";
import type { HandlerErrors, HandlerResponse } from "../src/runtime/api-infer.ts";
import type { ApiModule } from "../src/server/types.ts";
import type { ApiMatch } from "../src/router/match.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { ChannelRef } from "../src/runtime/channel.ts";
import { err, match, ok, type Result } from "../src/result.ts";

type Equal<A, B> = (<V>() => V extends A ? 1 : 2) extends (<V>() => V extends B ? 1 : 2) ? true
  : false;
function expectType<T extends true>(_ok: T): void {}

const ctx = () => ({ params: asyncProps({} as Record<string, string>) });
const get = () => new Request("http://localhost/api/x");

function viaHandleApi(mod: ApiModule): Promise<Response> {
  const route: ApiMatch = {
    route: {
      kind: "api",
      filePath: "route.ts",
      pattern: parsePattern("/api/x"),
      routePath: "/api/x",
    },
    params: {},
  };
  return handleApi(route, get(), () => Promise.resolve(mod), {});
}

/** A response schema with no validation, typed `{ id: number }`. */
const idSchema: StandardSchemaV1<{ id: number }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value: value as { id: number } }),
  },
};

Deno.test("defineApi: a returned err(code) is the declared envelope, exactly like fail(code)", async () => {
  const errors = { not_found: 404, gone: { status: 410, message: "deleted" } } as const;
  const viaErr = defineApi({ errors }, () => err("gone"));
  const viaFail = defineApi({ errors }, ({ fail }) => fail("gone"));
  const a = await viaHandleApi({ GET: viaErr });
  const b = await viaHandleApi({ GET: viaFail });
  assertEquals(a.status, 410);
  assertEquals(await a.json(), await b.json());

  const withData = defineApi(
    { errors },
    () => err("not_found", { message: "no such post", data: { id: 7 } }),
  );
  const res = await viaHandleApi({ GET: withData });
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, {
    code: "not_found",
    status: 404,
    message: "no such post",
    data: { id: 7 },
  });
});

Deno.test("defineApi: err() alongside a response schema; a plain { ok: false } object is still a body", async () => {
  const GET = defineApi(
    { response: idSchema, errors: { not_found: 404 } },
    () => Math.random() > 2 ? { id: 1 } : err("not_found"),
  );
  assertEquals((await viaHandleApi({ GET })).status, 404);
  // Not made by err(): an ordinary JSON body, as before.
  const plain = defineApi({}, () => ({ ok: false, error: "x" }));
  const res = await plain(get(), ctx());
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: false, error: "x" });

  // The client sees the success body only; the declared codes are the error union.
  expectType<Equal<HandlerResponse<typeof GET>, { id: number }>>(true);
  const noSchema = defineApi(
    { errors: { conflict: 409 } },
    () => Math.random() > 2 ? { saved: true } : err("conflict"),
  );
  expectType<Equal<HandlerResponse<typeof noSchema>, { saved: boolean }>>(true);
  expectType<Equal<Extract<HandlerErrors<typeof noSchema>, "conflict">, "conflict">>(true);
});

Deno.test("defineApi: an undeclared err() code is a compile error", () => {
  // @ts-expect-error -- "nope" is not in `errors`
  defineApi({ errors: { conflict: 409 } }, () => err("nope"));
  // @ts-expect-error -- no `errors` declared at all
  defineApi({}, async () => await Promise.resolve(err("conflict")));
  // @ts-expect-error -- with a response schema too
  defineApi({ response: idSchema, errors: { conflict: 409 } }, () => err("typo"));
  // A declared code type-checks (with or without details).
  defineApi({ errors: { conflict: 409 } }, () => err("conflict", { data: { at: 1 } }));
});

Deno.test("defineApi: a handler returning `any` type-checks (no misleading err() guard)", () => {
  // deno-lint-ignore no-explicit-any
  const untyped = (): any => JSON.parse('{"id":1}');
  // An `any` result can't be told apart from an err(), so the guard must accept it.
  defineApi({ errors: { conflict: 409 } }, () => untyped());
  defineApi({}, async () => await Promise.resolve(untyped()));
  defineApi({ response: idSchema, errors: { conflict: 409 } }, () => untyped());
  // deno-lint-ignore no-explicit-any
  expectType<Equal<ApiErrGuard<{ errors: { conflict: 409 } }, any>, unknown>>(true);
  // deno-lint-ignore no-explicit-any
  expectType<Equal<ApiErrGuard<{ errors: { conflict: 409 } }, Promise<any>>, unknown>>(true);
});

const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};

Deno.test("defineAction: a returned err(message, { fieldErrors }) is a failed ActionResult", async () => {
  const createPost = defineAction({
    input: (f) => ({ title: String(f.title ?? "").trim() }),
    handler: ({ title }) => {
      if (!title) return err("Invalid post", { fieldErrors: { title: "Title is required" } });
      if (title === "x") return err("Too short");
      return { id: `post:${title}` };
    },
  });
  const initial = idleActionState<{ id: string }>();
  const bad = await createPost(initial, fd({ title: " " }));
  assertEquals(bad, {
    ok: false,
    error: "Invalid post",
    fieldErrors: { title: "Title is required" },
  });
  const short = await createPost(initial, fd({ title: "x" }));
  assert(!short.ok && short.error === "Too short" && short.fieldErrors === undefined);
  const good = await createPost(initial, fd({ title: "hi" }));
  assert(good.ok);
  // The Err is not part of the success type.
  expectType<Equal<typeof good.data, { id: string }>>(true);
});

Deno.test("defineAction: an err() that is not a message + fieldErrors is a compile error", () => {
  // @ts-expect-error -- the error must be a string message
  defineAction({ handler: () => err(42) });
  // @ts-expect-error -- details carry `fieldErrors`, not arbitrary keys typed wrong
  defineAction({ handler: () => err("bad", { fieldErrors: { title: 1 } }) });
});

Deno.test("channels: a discriminated-union payload matches exhaustively with match()", () => {
  type OrderEvent =
    | { type: "shipped"; carrier: string }
    | { type: "delivered"; at: number }
    | { type: "cancelled"; reason: string };
  type Payload<C> = C extends ChannelRef<infer T> ? T : never;
  const render = (e: Payload<ChannelRef<OrderEvent>>) =>
    match(e)
      .with({ type: "shipped" }, (s) => `via ${s.carrier}`)
      .with({ type: "delivered" }, (d) => `at ${d.at}`)
      .with({ type: "cancelled" }, (c) => c.reason)
      .exhaustive();
  assertEquals(render({ type: "delivered", at: 3 }), "at 3");
  const r = ok(1) as Result<number, string>;
  assert(r.ok);
});
