import { assert, assertEquals, assertRejects } from "@std/assert";
import { Context, Effect, Layer } from "effect";
import {
  type ActionResult,
  createEffectRuntime,
  DenextRequest,
  effect,
  effectAction,
  effectHandler,
  runEffect,
  runEffectExit,
} from "../packages/effect/mod.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { applyPlugins, resetPlugins, runPluginTeardown } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";

const noopLoad = (() => Promise.resolve({})) as unknown as ModuleLoader;

/** Run `fn` inside a fresh denext request context (optionally with an abort signal). */
function withRequest<T>(
  init: RequestInit & { url?: string; signal?: AbortSignal },
  fn: () => T,
): T {
  const { url = "https://example.test/", signal, ...requestInit } = init;
  const ctx = createRequestContext(new Request(url, requestInit), signal);
  return runWithContext(ctx, fn);
}

// --- DenextRequest service + runEffect --------------------------------------

Deno.test("runEffect resolves a request-scoped DenextRequest service", async () => {
  const program = Effect.gen(function* () {
    const req = yield* DenextRequest;
    return req.request.headers.get("x-user");
  });
  const user = await withRequest(
    { headers: { "x-user": "ada" } },
    () => runEffect(program),
  );
  assertEquals(user, "ada");
});

Deno.test("runEffect exposes the request correlation id", async () => {
  const id = await withRequest({}, () => runEffect(Effect.map(DenextRequest, (r) => r.requestId)));
  assert(typeof id === "string" && id.length > 0);
});

Deno.test("runEffect outside a request context fails with a clear error", async () => {
  await assertRejects(
    () => runEffect(Effect.map(DenextRequest, (r) => r.requestId)),
    Error,
    "no active denext request context",
  );
});

// --- typed errors via runEffectExit -----------------------------------------

Deno.test("runEffectExit surfaces a typed failure without throwing", async () => {
  const failing = Effect.fail({ _tag: "Nope", detail: 42 } as const);
  const exit = await withRequest({}, () => runEffectExit(failing));
  assertEquals(exit._tag, "Failure");
  if (exit._tag === "Failure") {
    // The typed error is recoverable from the Cause.
    const err = (exit.cause as { error?: { _tag: string } }).error;
    assertEquals(err?._tag, "Nope");
  }
});

// --- createEffectRuntime: typed app services --------------------------------

class Db extends Context.Tag("test/Db")<Db, { name: (id: string) => Effect.Effect<string> }>() {}
const DbLive = Layer.succeed(Db, { name: (id) => Effect.succeed(`user#${id}`) });

Deno.test("createEffectRuntime provides app services alongside DenextRequest", async () => {
  const runner = createEffectRuntime(DbLive);
  try {
    const program = Effect.gen(function* () {
      const req = yield* DenextRequest;
      const db = yield* Db;
      const name = yield* db.name("7");
      return `${name}@${new URL(req.request.url).host}`;
    });
    const out = await withRequest({ url: "https://acme.test/x" }, () => runner.runEffect(program));
    assertEquals(out, "user#7@acme.test");
  } finally {
    await runner.dispose();
  }
});

Deno.test("createEffectRuntime memoizes the layer (built once, not per run)", async () => {
  let builds = 0;
  const Counted = Layer.effect(
    Db,
    Effect.sync(() => {
      builds++;
      return { name: (id) => Effect.succeed(id) };
    }),
  );
  const runner = createEffectRuntime(Counted);
  try {
    await withRequest({}, () => runner.runEffect(Effect.flatMap(Db, (d) => d.name("a"))));
    await withRequest({}, () => runner.runEffect(Effect.flatMap(Db, (d) => d.name("b"))));
    assertEquals(builds, 1);
  } finally {
    await runner.dispose();
  }
});

Deno.test("DenextRequest is per-run, not memoized across requests (isolation)", async () => {
  // The one regression that matters: a ManagedRuntime memoizes its layers, so the
  // request service must be provided fresh per run — never captured once and reused.
  const runner = createEffectRuntime(DbLive);
  try {
    const idOf = () => runner.runEffect(Effect.map(DenextRequest, (r) => r.requestId));
    const a = await withRequest({ headers: { "x-request-id": "req-aaa" } }, idOf);
    const b = await withRequest({ headers: { "x-request-id": "req-bbb" } }, idOf);
    assertEquals(a, "req-aaa");
    assertEquals(b, "req-bbb"); // would be "req-aaa" if the service were memoized
  } finally {
    await runner.dispose();
  }
});

// --- abort-signal interruption ----------------------------------------------

Deno.test("runEffect is interrupted by the request abort signal", async () => {
  const ac = new AbortController();
  ac.abort();
  await assertRejects(() =>
    withRequest(
      { signal: ac.signal },
      () => runEffect(Effect.as(Effect.sleep("10 seconds"), "done")),
    )
  );
});

// --- effect() plugin: ambient app services + teardown -----------------------

Deno.test("effect() plugin makes app services ambient and disposes on teardown", async () => {
  resetPlugins();
  let released = false;
  const Resourceful = Layer.scoped(
    Db,
    Effect.acquireRelease(
      Effect.succeed({ name: (id: string) => Effect.succeed(`P:${id}`) } as const),
      () => Effect.sync(() => (released = true)),
    ),
  );
  await applyPlugins({
    projectRoot: "/tmp/proj",
    appDir: "/tmp/proj/app",
    config: { plugins: [effect({ layer: Resourceful })] } as unknown as DenextConfig,
    mode: "prod",
    load: noopLoad,
  });
  // Ambient runEffect now resolves Db (typed as unknown-service — cast for the test).
  const program = Effect.flatMap(
    Db,
    (d) => d.name("9"),
  ) as unknown as Effect.Effect<string, never, DenextRequest>;
  const out = await withRequest({}, () => runEffect(program));
  assertEquals(out, "P:9");

  await runPluginTeardown();
  assert(released, "plugin teardown should dispose the runtime (release resources)");
  resetPlugins();
});

// --- effectHandler ----------------------------------------------------------

Deno.test("effectHandler returns the success Response", async () => {
  const GET = effectHandler(() => Effect.succeed(new Response("ok", { status: 200 })));
  const res = await withRequest({}, () => GET(new Request("https://x/")));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ok");
});

Deno.test("effectHandler maps a typed failure via onError", async () => {
  const GET = effectHandler(
    () => Effect.fail({ _tag: "BadInput" } as const),
    { onError: (e) => Response.json({ error: e._tag }, { status: 400 }) },
  );
  const res = await withRequest({}, () => GET(new Request("https://x/")));
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "BadInput" });
});

Deno.test("effectHandler returns 500 on a defect", async () => {
  const GET = effectHandler(() => Effect.die(new Error("boom")));
  const res = await withRequest({}, () => GET(new Request("https://x/")));
  assertEquals(res.status, 500);
});

// --- effectAction -----------------------------------------------------------

Deno.test("effectAction wraps success as { ok: true, value }", async () => {
  const subscribe = effectAction((email: string) => Effect.succeed({ email }));
  const result: ActionResult<{ email: string }, never> = await withRequest(
    {},
    () => subscribe("a@b.co"),
  );
  assertEquals(result, { ok: true, value: { email: "a@b.co" } });
});

Deno.test("effectAction wraps a typed failure as { ok: false, error }", async () => {
  const subscribe = effectAction((email: string) =>
    email.includes("@") ? Effect.succeed(email) : Effect.fail({ _tag: "InvalidEmail" } as const)
  );
  const result = await withRequest({}, () => subscribe("nope"));
  assertEquals(result, { ok: false, error: { _tag: "InvalidEmail" } });
});

Deno.test("effectAction rethrows a defect (not an expected outcome)", async () => {
  const act = effectAction(() => Effect.die(new Error("kaboom")));
  await assertRejects(() => withRequest({}, () => act()), Error, "defect");
});
