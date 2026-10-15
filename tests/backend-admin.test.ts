// `@denext/backend`'s admin endpoint (`/_denext/backend/admin/*`), what `denext ui` and the stack's
// dashboard read the running app through: refused without the backend's keys, without a key, with
// the publishable key or a wrong one, and for anything but GET — before anything is read; with
// the secret key it answers realtime's snapshot, presence KEYS (a key's payloads only when asked
// for by key), Edge Functions with their recent invocations, and the supervision tree. Also the
// invocation ring: bounded, newest first, and only name / status / duration / time.

import { assert, assertEquals } from "@std/assert";
import {
  generateSupabaseKeys,
  installSupabaseKeys,
  resolveSupabaseKeys,
} from "../src/server/auth/gotrue/keys.ts";
import { ADMIN_PREFIX, handleAdminRequest } from "../packages/backend/src/admin.ts";
import { installRealtimeHub, type RealtimeHub } from "../packages/backend/src/realtime-socket.ts";
import {
  installFunctionsAdmin,
  InvocationRing,
  recorded,
} from "../packages/backend/src/functions-admin.ts";

/** Ask the endpoint. */
async function ask(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await handleAdminRequest(new Request(`http://app${ADMIN_PREFIX}${path}`, init));
  assert(res, `${path} is the endpoint's`);
  return res;
}

/** Run `fn` with a fresh key set installed. */
async function withKeys(fn: (k: { secret: string; publishable: string }) => Promise<void>) {
  const g = await generateSupabaseKeys();
  installSupabaseKeys(
    await resolveSupabaseKeys({
      publishableKey: g.publishableKey,
      secretKey: g.secretKey,
      signingKeys: g.signingKey,
    }),
  );
  try {
    await fn({ secret: g.secretKey, publishable: g.publishableKey });
  } finally {
    installSupabaseKeys(undefined);
  }
}

/** A fake hub with one channel and a tracked presence. */
const HUB = {
  adminState: () => ({
    connections: 2,
    channels: [{ topic: "lobby", private: false, subscribers: 2 }],
    bindings: [],
  }),
  presenceKeys: () => Promise.resolve({ "visitor-1": 1 }),
  presenceOf: (_t: string, _p: boolean, key: string) =>
    Promise.resolve(key === "visitor-1" ? [{ secret: "payload" }] : []),
} as unknown as RealtimeHub;

Deno.test("admin endpoint: other paths pass; nothing is answered without the secret key", async () => {
  assertEquals(await handleAdminRequest(new Request("http://app/elsewhere")), null);
  // No keys installed at all: refused, and it says why.
  const none = await ask("/status");
  assertEquals(none.status, 403);
  await withKeys(async ({ publishable }) => {
    for (
      const headers of <Record<string, string>[]> [
        {},
        { apikey: publishable },
        { apikey: "sb_secret_wrong" },
        { authorization: `Bearer ${publishable}` },
      ]
    ) {
      const res = await ask("/status", { headers });
      assertEquals(res.status, 401, JSON.stringify(Object.keys(headers)));
      assertEquals((await res.json()).ok, false);
    }
  });
});

Deno.test("admin endpoint: with the secret key — status, presence keys, one key's payloads", async () => {
  const ring = new InvocationRing();
  ring.push({ name: "hello", status: 200, ms: 3, at: 1 });
  installRealtimeHub(HUB);
  installFunctionsAdmin({
    functions: () => Promise.resolve([{ name: "hello", verifyJwt: true, modified: 5 }]),
    invocations: () => ring.list(),
  });
  try {
    await withKeys(async ({ secret }) => {
      const post = await ask("/status", { method: "POST", headers: { apikey: secret } });
      assertEquals(post.status, 405);
      await post.body?.cancel();
      const status = await (await ask("/status", { headers: { apikey: secret } })).json();
      assertEquals(status.realtime.channels, [{ topic: "lobby", private: false, subscribers: 2 }]);
      assertEquals(status.functions, {
        functions: [{ name: "hello", verifyJwt: true, modified: 5 }],
        invocations: [{ name: "hello", status: 200, ms: 3, at: 1 }],
      });
      assert(Array.isArray(status.services));
      const bearer = await ask("/status", { headers: { authorization: `Bearer ${secret}` } });
      assertEquals(bearer.status, 200);
      await bearer.body?.cancel();
      const keys = await (await ask("/presence?topic=lobby", { headers: { apikey: secret } }))
        .json();
      assertEquals(keys, { ok: true, keys: { "visitor-1": 1 } });
      assert(!JSON.stringify(keys).includes("payload"), "keys only");
      const one = await (await ask("/presence?topic=lobby&key=visitor-1", {
        headers: { apikey: secret },
      })).json();
      assertEquals(one.payloads, [{ secret: "payload" }]);
      const bad = await ask("/presence?topic=", { headers: { apikey: secret } });
      assertEquals(bad.status, 400);
      await bad.body?.cancel();
    });
  } finally {
    installRealtimeHub(undefined);
    installFunctionsAdmin(undefined);
  }
});

Deno.test("the invocation ring: bounded, newest first, name / status / duration / time only", async () => {
  const ring = new InvocationRing(3);
  for (let i = 1; i <= 5; i++) ring.push({ name: `f${i}`, status: 200, ms: i, at: i });
  assertEquals(ring.list().map((c) => c.name), ["f5", "f4", "f3"]);
  const rec = new InvocationRing();
  const answered = await recorded(
    rec,
    "hello",
    () => Promise.resolve(new Response("ok", { status: 201 })),
  );
  assertEquals(answered.status, 201);
  let threw = false;
  try {
    await recorded(rec, "boom", () => Promise.reject(new Error("x")));
  } catch {
    threw = true;
  }
  assert(threw);
  const [boom, hello] = rec.list();
  assertEquals([boom.name, boom.status, hello.name, hello.status], ["boom", 0, "hello", 201]);
  assertEquals(Object.keys(hello).sort(), ["at", "ms", "name", "status"]);
});
