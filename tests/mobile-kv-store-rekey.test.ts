// Key rotation for denext/mobile's encrypted key-value stores (`rekeyKeyValueStore(name)`,
// src/mobile/kv-store.ts) over a fake DenextStorage bridge that models SQLCipher's contract: a
// store's file opens only with its key (else WRONG_KEY), and `rekey` re-encrypts it from the
// current key to a new one. Covered: a rotation end to end (the plugin call, secureStore, the
// calls after it), calls made while it runs, the two half-done states a dead process can leave
// (before and after the rekey committed) and how the next use settles them, a failed rekey, and
// the refusals (web, no SQLCipher, a plugin from before rotation, no secret secureStore). The
// native halves are tests/mobile-storage-cipher-native.test.ts.

import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  KeyValueStoreError,
  openKeyValueStore,
  rekeyKeyValueStore,
  resetKeyValueStoreForTesting,
} from "../src/mobile/kv-store.ts";
import { type Any, fakePlugin, inShell, withGlobals } from "./helpers/mobile-fakes.ts";

const KEY = "capacitor-storage_denext.kv.key.vault";
const NEXT = "capacitor-storage_denext.kv.next-key.vault";

/** A DenextStorage fake whose encrypted stores open only with their key, and rekey. */
function cipherStorage(options: { rekey?: boolean; failRekey?: boolean } = {}) {
  const files = new Map<string, { key: string; rows: Map<string, string> }>();
  const calls: Array<[string, Any]> = [];
  const file = (o: Any) => {
    let f = files.get(o.store);
    if (!f) files.set(o.store, f = { key: o.key, rows: new Map() });
    if (f.key !== o.key) {
      throw Object.assign(new Error("the key does not open this store"), { code: "WRONG_KEY" });
    }
    return f;
  };
  const method = (name: string, fn: (o: Any) => unknown) => (o: Any) => {
    calls.push([name, o]);
    try {
      return Promise.resolve(fn(o));
    } catch (err) {
      return Promise.reject(err);
    }
  };
  const plugin: Record<string, unknown> = {
    cipher: method("cipher", () => ({ available: true })),
    getMany: method("getMany", (o) => ({
      values: o.keys.map((k: string) => file(o).rows.get(k) ?? null),
    })),
    setMany: method("setMany", (o) => {
      for (const [k, v] of o.entries) file(o).rows.set(k, v);
      return {};
    }),
    removeMany: method("removeMany", (o) => {
      for (const k of o.keys) file(o).rows.delete(k);
      return {};
    }),
    keys: method("keys", (o) => ({ keys: [...file(o).rows.keys()].sort() })),
    clear: method("clear", (o) => void file(o).rows.clear()),
  };
  if (options.rekey !== false) {
    plugin.rekey = method("rekey", (o) => {
      const f = file(o);
      if (options.failRekey) throw Object.assign(new Error("disk full"), { code: "STORAGE_ERROR" });
      f.key = o.newKey;
      return {};
    });
  }
  return { plugin, calls, files };
}

/** A SecureStorage fake over a map (the native Keychain / Keystore plugin). */
function securePlugin() {
  const items = new Map<string, string>();
  const fake = fakePlugin(["internalGetItem", "internalSetItem", "internalRemoveItem"]);
  const p = fake.plugin as Any;
  p.internalGetItem = (o: Any) => Promise.resolve({ data: items.get(o.prefixedKey) ?? null });
  p.internalSetItem = (o: Any) => Promise.resolve(void items.set(o.prefixedKey, o.data));
  p.internalRemoveItem = (o: Any) => Promise.resolve(void items.delete(o.prefixedKey));
  return { ...fake, items };
}

/** Run `fn` on a fresh page of an iOS shell with these two plugins. */
async function page(
  storage: ReturnType<typeof cipherStorage>,
  secure: ReturnType<typeof securePlugin>,
  fn: () => Promise<void>,
): Promise<void> {
  resetKeyValueStoreForTesting();
  try {
    await inShell("ios", { DenextStorage: storage.plugin, SecureStorage: secure.plugin }, fn);
  } finally {
    resetKeyValueStoreForTesting();
  }
}

Deno.test("rekeyKeyValueStore: re-encrypts the store, then replaces the key in secureStore", async () => {
  const storage = cipherStorage();
  const secure = securePlugin();
  let before = "";
  await page(storage, secure, async () => {
    const vault = openKeyValueStore("vault", { encrypted: true });
    await vault.setMany([["pin", "4321"], ["token", "t"]]);
    before = secure.items.get(KEY)!;
    await rekeyKeyValueStore("vault");
    // The same handle goes on with the new key.
    assertEquals(await vault.getMany(["pin", "token"]), ["4321", "t"]);
    await vault.set("after", "1");
  });
  const after = secure.items.get(KEY)!;
  assert(/^[0-9a-f]{64}$/.test(after), after);
  assertNotEquals(after, before);
  assertEquals(secure.items.has(NEXT), false, "the pending entry is gone");
  assertEquals(storage.files.get("vault")!.key, after);
  const rekeys = storage.calls.filter(([m]) => m === "rekey").map(([, o]) => o);
  assertEquals(rekeys, [{ store: "vault", key: before, newKey: after }]);
  assertEquals(storage.calls.at(-1)![1].key, after, "calls after it carry the new key");
  // A later page reads the new key back.
  await page(storage, secure, async () => {
    assertEquals(await openKeyValueStore("vault", { encrypted: true }).get("after"), "1");
  });
});

Deno.test("rekeyKeyValueStore: calls made while it runs wait for the new key", async () => {
  const storage = cipherStorage();
  const secure = securePlugin();
  await page(storage, secure, async () => {
    const vault = openKeyValueStore("vault", { encrypted: true });
    await vault.set("a", "1");
    const [, , value, keys] = await Promise.all([
      rekeyKeyValueStore("vault"),
      vault.set("b", "2"),
      vault.get("a"),
      vault.keys(),
    ]);
    assertEquals(value, "1");
    assert(keys.includes("a"));
    assertEquals(await vault.getMany(["a", "b"]), ["1", "2"]);
    // Two rotations in a row chain.
    await Promise.all([rekeyKeyValueStore("vault"), rekeyKeyValueStore("vault")]);
    assertEquals(await vault.get("b"), "2");
  });
  assertEquals(storage.calls.filter(([m]) => m === "rekey").length, 3);
  assertEquals(storage.files.get("vault")!.key, secure.items.get(KEY));
});

Deno.test("rekeyKeyValueStore: a store with no key yet gets one, then rotates", async () => {
  const storage = cipherStorage();
  const secure = securePlugin();
  await page(storage, secure, async () => {
    await rekeyKeyValueStore("vault");
    assertEquals(await openKeyValueStore("vault", { encrypted: true }).keys(), []);
  });
  assertEquals(storage.files.get("vault")!.key, secure.items.get(KEY));
  assertEquals(secure.items.has(NEXT), false);
});

Deno.test("rekeyKeyValueStore: a process that died after the rekey committed loses nothing", async () => {
  const storage = cipherStorage();
  const secure = securePlugin();
  await page(storage, secure, async () => {
    await openKeyValueStore("vault", { encrypted: true }).set("pin", "4321");
  });
  // The state it left: the store under the new key, the new key still in the pending entry.
  const next = "ab".repeat(32);
  storage.files.get("vault")!.key = next;
  secure.items.set(NEXT, next);
  await page(storage, secure, async () => {
    assertEquals(await openKeyValueStore("vault", { encrypted: true }).get("pin"), "4321");
  });
  assertEquals(secure.items.get(KEY), next, "the pending key was promoted");
  assertEquals(secure.items.has(NEXT), false);
});

Deno.test("rekeyKeyValueStore: a process that died before the rekey keeps the old key", async () => {
  const storage = cipherStorage();
  const secure = securePlugin();
  await page(storage, secure, async () => {
    await openKeyValueStore("vault", { encrypted: true }).set("pin", "4321");
  });
  const old = secure.items.get(KEY)!;
  secure.items.set(NEXT, "cd".repeat(32)); // written, but the rekey never ran
  await page(storage, secure, async () => {
    assertEquals(await openKeyValueStore("vault", { encrypted: true }).get("pin"), "4321");
  });
  assertEquals(secure.items.get(KEY), old);
  assertEquals(secure.items.has(NEXT), false, "the unused pending key was dropped");
  assertEquals(storage.files.get("vault")!.key, old);
});

Deno.test("rekeyKeyValueStore: neither key opening the store is WRONG_KEY", async () => {
  const storage = cipherStorage();
  const secure = securePlugin();
  await page(storage, secure, async () => {
    await openKeyValueStore("vault", { encrypted: true }).set("pin", "4321");
  });
  storage.files.get("vault")!.key = "ef".repeat(32);
  secure.items.set(NEXT, "cd".repeat(32));
  await page(storage, secure, async () => {
    const err = await assertRejects(
      () => openKeyValueStore("vault", { encrypted: true }).get("pin"),
      KeyValueStoreError,
      "neither",
    );
    assertEquals((err as KeyValueStoreError).code, "WRONG_KEY");
  });
  assert(secure.items.has(NEXT), "nothing is thrown away while neither key works");
});

Deno.test("rekeyKeyValueStore: a failed rekey leaves the old key in place", async () => {
  const storage = cipherStorage({ failRekey: true });
  const secure = securePlugin();
  await page(storage, secure, async () => {
    const vault = openKeyValueStore("vault", { encrypted: true });
    await vault.set("pin", "4321");
    const old = secure.items.get(KEY);
    await assertRejects(() => rekeyKeyValueStore("vault"), Error, "disk full");
    assertEquals(secure.items.get(KEY), old);
    assertEquals(secure.items.has(NEXT), false);
    assertEquals(await vault.get("pin"), "4321", "the store still opens");
  });
});

Deno.test("rekeyKeyValueStore: refused wherever an encrypted store can't run", async () => {
  // The browser.
  resetKeyValueStoreForTesting();
  await withGlobals({ Capacitor: undefined, indexedDB: undefined }, async () => {
    const err = await assertRejects(() => rekeyKeyValueStore("vault"), KeyValueStoreError);
    assertEquals((err as KeyValueStoreError).code, "ENCRYPTION_UNAVAILABLE");
  });
  // A plugin from before key rotation.
  const old = cipherStorage({ rekey: false });
  const secure = securePlugin();
  await page(old, secure, async () => {
    const err = await assertRejects(
      () => rekeyKeyValueStore("vault"),
      KeyValueStoreError,
      "predates key rotation",
    );
    assertEquals((err as KeyValueStoreError).code, "ENCRYPTION_UNAVAILABLE");
  });
  // A plugin without SQLCipher linked.
  const plain = cipherStorage();
  plain.plugin.cipher = () => Promise.resolve({ available: false });
  await page(plain, secure, async () => {
    const err = await assertRejects(() => rekeyKeyValueStore("vault"), KeyValueStoreError);
    assertEquals((err as KeyValueStoreError).code, "ENCRYPTION_UNAVAILABLE");
  });
  // A secureStore that is not secret (no Keychain plugin): no key is made or moved.
  const storage = cipherStorage();
  resetKeyValueStoreForTesting();
  await inShell("ios", { DenextStorage: storage.plugin }, async () => {
    const err = await assertRejects(() => rekeyKeyValueStore("vault"), KeyValueStoreError);
    assertEquals((err as KeyValueStoreError).code, "ENCRYPTION_UNAVAILABLE");
  });
  resetKeyValueStoreForTesting();
  assertEquals(storage.calls.filter(([m]) => m === "rekey"), []);
  assertEquals(secure.items.size, 0, "nothing was written");
  await assertRejects(() => rekeyKeyValueStore(""), TypeError);
});
