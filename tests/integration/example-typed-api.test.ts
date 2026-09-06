// examples/typed-api built + served: the typed route handlers, the batch endpoint, and the
// Flight refs a Server Component hands its live islands — every HTTP wire, no browser.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { build } from "../../src/build/build.ts";
import { startProdOrigin } from "../helpers/prod-origin.ts";

const APP = new URL("../../examples/typed-api", import.meta.url).pathname;

type Ctx = { origin: string; html: string };

const json = (body: unknown, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...extra },
  body: JSON.stringify(body),
});

async function stepTypedRoutes(ctx: Ctx): Promise<void> {
  const list = await (await fetch(`${ctx.origin}/api/todos`)).json();
  assert(Array.isArray(list) && list.length >= 2, "the seeded list");
  // A schema mismatch is a structured 400 before the handler runs.
  const bad = await fetch(`${ctx.origin}/api/todos`, json({ title: 5 }));
  assertEquals(bad.status, 400);
  const badBody = await bad.json();
  assertEquals(badBody.error.code, "validation");
  assertEquals(badBody.error.fieldErrors, {
    title: "must be a non-empty string",
  });
  assertEquals(badBody.error.data, { source: "body" });
  // A typed query: `done=maybe` is rejected by the `oneOf` schema.
  const badQuery = await fetch(`${ctx.origin}/api/todos?done=maybe`);
  assertEquals(badQuery.status, 400);
  assertEquals((await badQuery.json()).error.data, { source: "query" });
  // A valid create: the response schema keeps exactly the declared fields.
  const created = await fetch(
    `${ctx.origin}/api/todos`,
    json({ title: "Ship 2.1" }),
  );
  assertEquals(created.status, 200);
  const todo = await created.json();
  assertEquals(Object.keys(todo).sort(), ["done", "id", "title"]);
  // A declared error code: `fail("duplicate")` → 409 with that code.
  const dup = await fetch(
    `${ctx.origin}/api/todos`,
    json({ title: "ship 2.1" }),
  );
  assertEquals(dup.status, 409);
  assertEquals((await dup.json()).error.code, "duplicate");
  // Params + body on a dynamic route; a missing id is the declared 404.
  const toggled = await fetch(`${ctx.origin}/api/todos/${todo.id}`, {
    ...json({ done: true }),
    method: "PATCH",
  });
  assertEquals((await toggled.json()).done, true);
  const missing = await fetch(`${ctx.origin}/api/todos/nope`, {
    ...json({ done: true }),
    method: "PATCH",
  });
  assertEquals([missing.status, (await missing.json()).error.code], [
    404,
    "not_found",
  ]);
  const gone = await fetch(`${ctx.origin}/api/todos/${todo.id}`, {
    method: "DELETE",
  });
  assertEquals(gone.status, 204);
}

async function stepBatch(ctx: Ctx): Promise<void> {
  const res = await fetch(
    `${ctx.origin}/_denext/api-batch`,
    json(
      {
        v: 1,
        items: [{ id: 0, m: "GET", p: "/api/todos" }, {
          id: 1,
          m: "GET",
          p: "/api/todos?done=true",
        }],
      },
      { origin: ctx.origin, "x-denext-api-batch": "1" },
    ),
  );
  assertEquals(res.status, 200);
  const { r } = await res.json();
  assertEquals(r.length, 2);
  assert(Array.isArray(JSON.parse(r[0].t)));
  assert(JSON.parse(r[1].t).every((t: { done: boolean }) => t.done));
  // Without the same-origin proof the batch is refused as a whole.
  const cross = await fetch(
    `${ctx.origin}/_denext/api-batch`,
    json(
      { v: 1, items: [{ id: 0, m: "GET", p: "/api/todos" }] },
      { "x-denext-api-batch": "1" },
    ),
  );
  assertEquals(cross.status, 403);
}

/** The ids the SSR'd Flight payload hands the client: server refs (`a`) and channels (`ch`). */
function flightIds(html: string, tag: "a" | "ch"): string[] {
  // The Flight payload is JSON inside a <script>: `{"$":"a","i":"<id>"}`.
  const re = new RegExp(`"\\$":"${tag}","i":"([^"]+)"`, "g");
  return [...html.matchAll(re)].map((m) => m[1]);
}

/**
 * The socket paths themselves (a validated subscription refusing bad input, a channel push)
 * are exercised against a real hub in tests/live-data.test.ts and in a real browser by
 * tests/e2e/typed-api.e2e.test.ts — the production handshake requires a browser `Origin`
 * header, which Deno's stable `WebSocket` client cannot send. Here we prove the other half:
 * the Server Component hands the client its subscription and channel as opaque Flight refs.
 */
function stepRefsCrossFlight(ctx: Ctx): void {
  const actions = flightIds(ctx.html, "a");
  const channels = flightIds(ctx.html, "ch");
  assert(actions.length >= 1, "the subscription ref crossed as a server reference");
  assertEquals(channels.length, 1, "the channel crossed as a channel reference");
  assert(!ctx.html.includes("subscriptions.ts"), "an id, never a module path");
}

Deno.test({
  name: "examples/typed-api: typed routes, batch, live refs",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  await build(APP);
  const ac = new AbortController();
  const { origin, server } = await startProdOrigin(APP, ac.signal);
  const ctx: Ctx = { origin, html: "" };
  try {
    ctx.html = await (await fetch(origin + "/")).text();
    assertStringIncludes(ctx.html, "Typed API, end to end");
    await t.step("typed route handlers", () => stepTypedRoutes(ctx));
    await t.step("batch endpoint", () => stepBatch(ctx));
    await t.step("refs cross Flight as opaque ids", () => stepRefsCrossFlight(ctx));
  } finally {
    ac.abort();
    await server.finished;
  }
});
