// `taintObjectReference` / `taintUniqueValue` hold for a server function's return value too:
// a Server Action's result is refused (a redacted 500) when it holds a tainted value at any
// depth, as React's Flight refuses one; an untainted result is unaffected.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { handleAction } from "../src/server/action-handler.ts";
import { actionEndpoint } from "../src/runtime/server-action.ts";
import { serverAction } from "../src/runtime/action-stub.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import {
  assertUntainted,
  experimental_taintObjectReference,
  experimental_taintUniqueValue,
} from "../src/runtime/taint.ts";

const SECRET = "taint-test-unique-value-7f3a";
const lifetime = {};
const row = { id: 1, hash: "h" };

/** POST the action `id` as the client dispatch does; the response and what the server logged. */
async function call(id: string): Promise<{ status: number; body: string; log: string }> {
  const req = new Request("http://localhost" + actionEndpoint(id), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "localhost",
      origin: "http://localhost",
      "x-denext-action": "1",
    },
    body: '{"args":[]}',
  });
  const original = console.error;
  let log = "";
  console.error = (...args: unknown[]) => void (log += args.map(String).join(" "));
  try {
    const res = await runWithContext(createRequestContext(req), () => handleAction(req));
    return { status: res.status, body: await res.text(), log };
  } finally {
    console.error = original;
  }
}

Deno.test("taint: a Server Action result holding a tainted value is refused at any depth", async () => {
  experimental_taintUniqueValue("the token stays on the server", lifetime, SECRET);
  experimental_taintObjectReference("the row stays on the server", row);
  const shapes: Record<string, () => unknown> = {
    taint_direct: () => SECRET,
    taint_field: () => ({ ok: true, session: { token: SECRET } }),
    taint_array: () => [1, [row]],
    taint_map: () => new Map([["k", { row }]]),
    taint_map_key: () => new Map([[SECRET, 1]]),
    taint_set: () => new Set([SECRET]),
  };
  for (const [id, make] of Object.entries(shapes)) {
    serverAction(id, make);
    const res = await call(id);
    assertEquals(res.status, 500, id);
    assertEquals(res.body, '{"error":"server action failed"}', id);
    assert(!res.body.includes(SECRET) && !res.body.includes('"hash"'), id);
    assert(res.log.includes("stays on the server"), "the server log names the taint");
  }
});

Deno.test("taint: an untainted result, and a structural copy of a tainted object, still return", async () => {
  serverAction("taint_clean", () => ({ copy: { ...row }, when: new Date(0), n: 1n }));
  const res = await call("taint_clean");
  assertEquals(res.status, 200);
  assert(res.body.includes('"hash":"h"'));
});

Deno.test("assertUntainted: walks arrays, objects, Maps and Sets; stops at the codec's depth", () => {
  experimental_taintUniqueValue(undefined, lifetime, SECRET);
  assertThrows(() => assertUntainted({ a: [new Set([new Map([["k", SECRET]])])] }), Error);
  assertUntainted({ a: [1, "x", null, undefined, new Date(0), new URL("https://x.test/")] });
  // A cycle is not a taint (the encoder reports it): the walk is depth-bounded and returns.
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assertUntainted(loop);
});
