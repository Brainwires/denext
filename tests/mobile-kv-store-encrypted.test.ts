// denext/mobile's encrypted key-value stores (`openKeyValueStore(name, { encrypted: true })`,
// src/mobile/kv-store.ts): the store's key is created once in secureStore and carried by every
// call to the DenextStorage plugin, whose SQLCipher database holds the store; everywhere that
// cannot encrypt it (the browser, memory, a plugin without SQLCipher or from before it, a
// secureStore that is not secret) every call is refused and nothing is written. The native halves
// are tests/mobile-storage-cipher-native.test.ts.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  KeyValueStoreError,
  openKeyValueStore,
  resetKeyValueStoreForTesting,
} from "../src/mobile/kv-store.ts";
import { type Any, fakePlugin, inShell, withGlobals } from "./helpers/mobile-fakes.ts";
import { fakeIndexedDB } from "./helpers/fake-indexeddb.ts";

const KEY_ENTRY = "capacitor-storage_denext.kv.key.vault";

/** A DenextStorage fake over one map per (key, store); `cipher` answers `available`. */
function storagePlugin(available: boolean | undefined) {
  const data = new Map<string, string>();
  const methods = ["getMany", "setMany", "removeMany", "keys", "clear"];
  const fake = fakePlugin(available === undefined ? methods : [...methods, "cipher"], {
    cipher: { available },
  });
  const slot = (o: Any, k: string) => `${o.key ?? "-"}|${o.store}/${k}`;
  const record = fake.plugin as Any;
  const wrap = (name: string, fn: (o: Any) => unknown) => {
    record[name] = (o: Any) => {
      fake.calls.push([name, o]);
      return Promise.resolve(fn(o));
    };
  };
  wrap("getMany", (o) => ({ values: o.keys.map((k: string) => data.get(slot(o, k)) ?? null) }));
  wrap("setMany", (o) => {
    for (const [k, v] of o.entries) data.set(slot(o, k), v);
    return {};
  });
  wrap("keys", (o) => ({
    keys: [...data.keys()].filter((s) => s.startsWith(`${o.key ?? "-"}|${o.store}/`))
      .map((s) => s.slice(s.indexOf("/") + 1)),
  }));
  return { ...fake, data };
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

Deno.test("kv-store (encrypted): the key is made once in secureStore and every call carries it", async () => {
  resetKeyValueStoreForTesting();
  const storage = storagePlugin(true);
  const secure = securePlugin();
  await inShell(
    "ios",
    { DenextStorage: storage.plugin, SecureStorage: secure.plugin },
    async () => {
      const vault = openKeyValueStore("vault", { encrypted: true });
      assertEquals(vault.encrypted, true);
      await vault.setMany([["pin", "4321"], ["token", "t"]]);
      assertEquals(await vault.get("pin"), "4321");
      assertEquals(await vault.keys(), ["pin", "token"]);
      const plain = openKeyValueStore("prefs");
      assertEquals(plain.encrypted, false);
      await plain.set("theme", "dark");
    },
  );
  const key = secure.items.get(KEY_ENTRY);
  assert(key && /^[0-9a-f]{64}$/.test(key), `a 256-bit hex key in secureStore: ${key}`);
  const keyed = storage.calls.filter(([m]) => m !== "cipher").map(([m, o]) => [m, (o as Any).key]);
  assertEquals(keyed, [
    ["setMany", key],
    ["getMany", key],
    ["keys", key],
    ["setMany", undefined],
  ]);
  assert(!("key" in (storage.calls.at(-1)![1] as object)), "a plain store's call has no key");
  assertEquals(storage.calls.filter(([m]) => m === "cipher").length, 1, "checked once per page");

  // A later page reads the same key back instead of making another.
  resetKeyValueStoreForTesting();
  await inShell(
    "ios",
    { DenextStorage: storage.plugin, SecureStorage: secure.plugin },
    async () => {
      assertEquals(await openKeyValueStore("vault", { encrypted: true }).get("pin"), "4321");
    },
  );
  assertEquals(secure.items.get(KEY_ENTRY), key);
  resetKeyValueStoreForTesting();
});

Deno.test("kv-store (encrypted): the web refuses and writes nothing (no plaintext in IndexedDB)", async () => {
  resetKeyValueStoreForTesting();
  const fake = fakeIndexedDB();
  await withGlobals(fake, async () => {
    const vault = openKeyValueStore("vault", { encrypted: true } as Any);
    const err = await assertRejects(() => vault.set("pin", "4321"), Error, "IndexedDB");
    assertEquals((err as KeyValueStoreError).code, "ENCRYPTION_UNAVAILABLE");
    assert(err instanceof KeyValueStoreError);
    assert(String((err as Error).message).includes("Nothing was written"));
    await assertRejects(() => vault.get("pin"), KeyValueStoreError);
    assertEquals(await openKeyValueStore("vault").keys(), [], "nothing reached IndexedDB");
  });
  resetKeyValueStoreForTesting();
  await withGlobals({ indexedDB: undefined }, async () => {
    const memory = openKeyValueStore("vault", { encrypted: true });
    await assertRejects(() => memory.keys(), KeyValueStoreError, "not encrypted");
  });
  resetKeyValueStoreForTesting();
});

Deno.test("kv-store (encrypted): a plugin without SQLCipher, or from before it, is refused", async () => {
  for (const available of [false, undefined]) {
    resetKeyValueStoreForTesting();
    const storage = storagePlugin(available);
    const secure = securePlugin();
    await inShell(
      "android",
      { DenextStorage: storage.plugin, SecureStorage: secure.plugin },
      () =>
        assertRejects(
          () => openKeyValueStore("vault", { encrypted: true }).set("pin", "1"),
          KeyValueStoreError,
          "denext mobile add storage --encrypted",
        ),
    );
    assertEquals(storage.data.size, 0, `nothing written (cipher: ${available})`);
    assertEquals(secure.items.size, 0, "no key made");
  }
  resetKeyValueStoreForTesting();
});

Deno.test("kv-store (encrypted): a secureStore that is not secret is refused; the next call asks again", async () => {
  resetKeyValueStoreForTesting();
  const storage = storagePlugin(true);
  const fake = fakeIndexedDB();
  await inShell("ios", { DenextStorage: storage.plugin }, async () => {
    const vault = openKeyValueStore("vault", { encrypted: true });
    await assertRejects(() => vault.set("pin", "1"), KeyValueStoreError, "secure-store");
  }, fake);
  assertEquals(storage.data.size, 0);
  // The refusal is not kept: once the plugin is there, the same page goes on.
  const secure = securePlugin();
  await inShell(
    "ios",
    { DenextStorage: storage.plugin, SecureStorage: secure.plugin },
    async () => {
      await openKeyValueStore("vault", { encrypted: true }).set("pin", "1");
    },
  );
  assertEquals(storage.data.size, 1);
  resetKeyValueStoreForTesting();
});

Deno.test("kv-store (encrypted): a secureStore that does not keep the key in the OS store is refused", async () => {
  resetKeyValueStoreForTesting();
  const storage = storagePlugin(true);
  const secure = securePlugin();
  (secure.plugin as Any).internalSetItem = () => Promise.reject(new Error("keychain locked"));
  await inShell(
    "ios",
    { DenextStorage: storage.plugin, SecureStorage: secure.plugin },
    () =>
      assertRejects(
        () => openKeyValueStore("vault", { encrypted: true }).set("pin", "1"),
        Error,
        "keychain locked",
      ),
  );
  assertEquals(storage.data.size, 0);
  resetKeyValueStoreForTesting();
});

Deno.test("kv-store (encrypted): the plugin's WRONG_KEY / ENCRYPTION_UNAVAILABLE become KeyValueStoreError", async () => {
  for (const code of ["WRONG_KEY", "ENCRYPTION_UNAVAILABLE"] as const) {
    resetKeyValueStoreForTesting();
    const storage = storagePlugin(true);
    (storage.plugin as Any).getMany = () =>
      Promise.reject(Object.assign(new Error("the key does not open this store"), { code }));
    const secure = securePlugin();
    await inShell(
      "ios",
      { DenextStorage: storage.plugin, SecureStorage: secure.plugin },
      async () => {
        const err = await assertRejects(
          () => openKeyValueStore("vault", { encrypted: true }).get("pin"),
          KeyValueStoreError,
        );
        assertEquals((err as KeyValueStoreError).code, code);
        assertEquals((err as Error).name, "KeyValueStoreError");
      },
    );
  }
  // Any other rejection passes through unchanged.
  resetKeyValueStoreForTesting();
  const storage = storagePlugin(true);
  const boom = Object.assign(new Error("disk full"), { code: "STORAGE_ERROR" });
  (storage.plugin as Any).getMany = () => Promise.reject(boom);
  await inShell("ios", { DenextStorage: storage.plugin }, async () => {
    const err = await assertRejects(() => openKeyValueStore("p").get("x"));
    assertEquals(err, boom);
  });
  resetKeyValueStoreForTesting();
});

Deno.test("kv-store (encrypted): @capacitor-community/sqlite and Deno Desktop backings refuse", async () => {
  const { sqlKvDriver } = await import("../src/mobile/kv-store.ts");
  const runner = {
    exec: () => Promise.resolve(),
    run: () => Promise.resolve({}),
    rows: () => Promise.resolve({ columns: [], rows: [] }),
  };
  for (const kind of ["sqlite", "desktop"] as const) {
    const driver = await sqlKvDriver(runner as Any, kind);
    assertEquals(driver.cipher, undefined, `${kind} has no cipher`);
  }
});
