// Bound Server Actions (src/server/action-bound.ts): an inline action's closed-over values and
// `action.bind(null, …)` ride the reference id sealed with AES-GCM, and the endpoint runs the
// action with them first. The browser can neither read nor change them: an edited, truncated or
// forged token, a token moved to another action, and a token sealed under another key are all
// an unknown action (409, `x-denext-action: unknown`) — the handler never runs.

import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import {
  ACTIONS_KEY_ENV,
  bindInlineAction,
  openBoundValues,
  sealBoundValues,
  setBuildServerActionsKey,
} from "../src/server/action-bound.ts";
import { handleAction } from "../src/server/action-handler.ts";
import {
  actionEndpoint,
  registerServerReference,
  type ServerActionRef,
  tagServerExports,
} from "../src/runtime/server-action.ts";

const ORIGIN = "http://app.test";

/** POST `/_denext/action/<id>` as the hydrated client does; the JSON body. */
async function call(id: string, args: unknown[] = []): Promise<{ status: number; body: unknown }> {
  const res = await handleAction(
    new Request(ORIGIN + actionEndpoint(id), {
      method: "POST",
      headers: {
        origin: ORIGIN,
        host: "app.test",
        "content-type": "application/json",
        "x-denext-action": "1",
      },
      body: JSON.stringify({ args }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

/** A fresh registered action recording what it was called with. */
function recorder(id: string) {
  const calls: unknown[][] = [];
  const ref = registerServerReference(id, (...args: unknown[]) => {
    calls.push(args);
    return args;
  });
  return { ref, calls };
}

/** Run `fn` with `DENEXT_SERVER_ACTIONS_ENCRYPTION_KEY` set to `key`. */
function withKey<T>(key: string | undefined, fn: () => T): T {
  const prior = Deno.env.get(ACTIONS_KEY_ENV);
  if (key === undefined) Deno.env.delete(ACTIONS_KEY_ENV);
  else Deno.env.set(ACTIONS_KEY_ENV, key);
  try {
    return fn();
  } finally {
    if (prior === undefined) Deno.env.delete(ACTIONS_KEY_ENV);
    else Deno.env.set(ACTIONS_KEY_ENV, prior);
  }
}

const KEY_A = encodeBase64(new Uint8Array(32).fill(1));
const KEY_B = encodeBase64(new Uint8Array(32).fill(2));

Deno.test("a bound inline action's id seals its values; the endpoint runs it with them", async () => {
  const { ref, calls } = recorder("aBoundRun");
  const bound = bindInlineAction(ref, () => ["secret-value", 42, new Date(0)], "del");
  const id = bound.denextActionId;
  assertMatch(id, /^aBoundRun\.[A-Za-z0-9_-]+$/);
  assert(!id.includes("secret-value"), "the value is not readable from the id");
  assert(!atobSafe(id.split(".")[1]).includes("secret-value"), "nor from its token's bytes");
  const res = await call(id, ["arg"]);
  assertEquals(res.status, 200);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].slice(0, 2), ["secret-value", 42]);
  assertEquals((calls[0][2] as Date).getTime(), 0, "codec values survive (Date)");
  assertEquals(calls[0][3], "arg", "the caller's arguments come after the bound values");
});

/** The token's raw bytes as latin1 text (to look for a plaintext value). */
function atobSafe(token: string): string {
  return String.fromCharCode(...decodeBase64Url(token));
}

Deno.test("a tampered, truncated or forged token is an unknown action; the handler never runs", async () => {
  const { ref, calls } = recorder("aBoundTamper");
  const id = bindInlineAction(ref, () => ["v"]).denextActionId;
  const [action, token] = id.split(".");
  const bytes = decodeBase64Url(token);
  const flipped = bytes.slice();
  flipped[flipped.length - 20] ^= 1; // a ciphertext byte
  const shortTag = bytes.slice(0, bytes.length - 8); // the tag cut to 8 bytes
  const forged = encodeBase64Url(new Uint8Array(bytes.length).fill(7));
  for (const bad of [encodeBase64Url(flipped), encodeBase64Url(shortTag), forged, "", "%%%"]) {
    const res = await call(`${action}.${bad}`);
    assertEquals(res.status, 409, `token ${bad.slice(0, 12)}…`);
    assertEquals(res.body, { error: "unknown action" });
  }
  assertEquals(calls.length, 0);
});

Deno.test("a token sealed for one action never opens for another", async () => {
  const a = recorder("aBoundA");
  const b = recorder("aBoundB");
  const token = bindInlineAction(a.ref, () => ["for-a"]).denextActionId.split(".")[1];
  const res = await call(`aBoundB.${token}`);
  assertEquals(res.status, 409, "replayed on another action");
  assertEquals(b.calls.length, 0);
  assertEquals(openBoundValues("aBoundA", token), ["for-a"]);
  assertEquals(openBoundValues("aBoundB", token), null);
});

Deno.test("the key: the env key wins, another key's token fails, a bad env key is refused", () => {
  const token = withKey(KEY_A, () => sealBoundValues("aKeyed", ["x"]));
  assertEquals(withKey(KEY_A, () => openBoundValues("aKeyed", token)), ["x"]);
  assertEquals(withKey(KEY_B, () => openBoundValues("aKeyed", token)), null, "another key");
  // The build's key is used only when the env sets none.
  setBuildServerActionsKey(KEY_B);
  try {
    assertEquals(withKey(undefined, () => openBoundValues("aKeyed", token)), null);
    const built = withKey(undefined, () => sealBoundValues("aKeyed", ["y"]));
    assertEquals(withKey(KEY_B, () => openBoundValues("aKeyed", built)), ["y"]);
    assertEquals(withKey(KEY_A, () => openBoundValues("aKeyed", built)), null);
  } finally {
    setBuildServerActionsKey(null);
  }
  // A 128-bit key works too (Next.js accepts one); anything but 16/24/32 bytes is refused.
  const k16 = encodeBase64(new Uint8Array(16).fill(3));
  assertEquals(withKey(k16, () => openBoundValues("a", sealBoundValues("a", [1]))), [1]);
  assertThrows(
    () => withKey(encodeBase64(new Uint8Array(20)), () => sealBoundValues("a", [1])),
    Error,
    "must be base64 of 16, 24 or 32 bytes",
  );
  // Each seal uses a fresh IV: the same values never give the same token.
  withKey(KEY_A, () => assert(sealBoundValues("a", [1]) !== sealBoundValues("a", [1])));
});

Deno.test("`.bind(null, …)` on a server reference binds sealed values and stays an action", async () => {
  const mod: Record<string, unknown> = {
    update: (...args: unknown[]) => args,
  };
  tagServerExports(mod, "file:///app/actions.ts");
  const update = mod.update as ServerActionRef<unknown[], unknown[]>;
  const bound = update.bind(null, "user-1") as unknown as ServerActionRef<unknown[], unknown[]>;
  assertEquals(await bound("x"), ["user-1", "x"], "a direct call prepends the value");
  const id = bound.denextActionId;
  assert(id.startsWith(`${update.denextActionId}.`), id);
  const res = await call(id, ["form"]);
  assertEquals(res.body, { result: ["user-1", "form"] });
  // Binding again appends, as Function.prototype.bind does.
  const twice = bound.bind(null, "more") as unknown as ServerActionRef<unknown[], unknown[]>;
  assertEquals((await call(twice.denextActionId, ["z"])).body, { result: ["user-1", "more", "z"] });
  // `bind` with no values keeps the plain id.
  const same = update.bind(null) as unknown as ServerActionRef<unknown[], unknown[]>;
  assertEquals(same.denextActionId, update.denextActionId);
});

Deno.test("a value that can't be sent fails when the bound action renders, naming it", () => {
  const { ref } = recorder("aBoundFn");
  const bound = bindInlineAction(ref, () => [() => 1], "save");
  assertThrows(() => bound.denextActionId, TypeError, "the Server Action save can't be sent");
});
