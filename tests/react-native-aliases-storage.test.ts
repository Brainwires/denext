// React Native mode's storage stand-ins over denext/mobile's durable key-value store:
// @react-native-async-storage/async-storage (the 2.x API, 3.x's batch methods, the one-time
// localStorage migration) and react-native-mmkv (the synchronous mirror, write-behind to the
// durable store, reconciliation after the OS evicted localStorage).

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import AsyncStorage, {
  AsyncStorageError,
  createAsyncStorage,
  resetAsyncStorageForTesting,
  useAsyncStorage,
} from "../src/react-native-compat/async-storage.ts";
import {
  createMMKV,
  deleteMMKV,
  existsMMKV,
  MMKV,
  mmkvReady,
  resetMMKVForTesting,
  useMMKVKeys,
  useMMKVObject,
  useMMKVString,
} from "../src/react-native-compat/mmkv.ts";
import { act, render } from "../src/testing/mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { openKeyValueStore, resetKeyValueStoreForTesting } from "../src/mobile/kv-store.ts";
import { withGlobals } from "./helpers/mobile-fakes.ts";
import { fakeIndexedDB } from "./helpers/fake-indexeddb.ts";

/** A Web Storage over a map. */
function fakeLocalStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

/** Run `fn` on a fresh browser: IndexedDB (kept across calls via `idb`) and localStorage. */
async function inBrowser(
  fn: () => unknown,
  opts: { local?: Storage; idb?: ReturnType<typeof fakeIndexedDB> } = {},
): Promise<void> {
  resetKeyValueStoreForTesting();
  resetAsyncStorageForTesting();
  resetMMKVForTesting();
  const idb = opts.idb ?? fakeIndexedDB();
  await withGlobals({ ...idb, localStorage: opts.local ?? fakeLocalStorage() }, fn);
  resetKeyValueStoreForTesting();
  resetAsyncStorageForTesting();
  resetMMKVForTesting();
}

// ---- @react-native-async-storage/async-storage -----------------------------------------------

Deno.test("async-storage: the 2.x API with callbacks, over the durable store", async () => {
  await inBrowser(async () => {
    const seen: unknown[] = [];
    await AsyncStorage.setItem("a", "1", (err) => seen.push(err));
    assertEquals(await AsyncStorage.getItem("a", (err, v) => seen.push([err, v])), "1");
    await AsyncStorage.multiSet([["b", "2"], ["c", "3"]]);
    assertEquals(await AsyncStorage.multiGet(["a", "zz", "c"]), [["a", "1"], ["zz", null], [
      "c",
      "3",
    ]]);
    assertEquals([...await AsyncStorage.getAllKeys()].sort(), ["a", "b", "c"]);
    await AsyncStorage.multiRemove(["a", "b"]);
    assertEquals(await AsyncStorage.getAllKeys(), ["c"]);
    await AsyncStorage.removeItem("c");
    assertEquals(await AsyncStorage.getItem("c"), null);
    assertEquals(seen, [null, [null, "1"]]);
    AsyncStorage.flushGetRequests();
    // The data is in the durable store, not localStorage.
    await AsyncStorage.setItem("kept", "yes");
    assertEquals(await openKeyValueStore("async-storage").get("kept"), "yes");
    assertEquals(globalThis.localStorage.getItem("kept"), null);
  });
});

Deno.test("async-storage: mergeItem deep-merges objects and replaces arrays (native semantics)", async () => {
  await inBrowser(async () => {
    await AsyncStorage.setItem("u", JSON.stringify({ a: 1, n: { x: 1, list: [1, 2] } }));
    await AsyncStorage.mergeItem("u", JSON.stringify({ b: 2, n: { y: 2, list: [3] } }));
    assertEquals(JSON.parse((await AsyncStorage.getItem("u"))!), {
      a: 1,
      b: 2,
      n: { x: 1, y: 2, list: [3] },
    });
    await AsyncStorage.multiMerge([["new", '{"z":1}'], ["new", '{"w":2}']]);
    assertEquals(JSON.parse((await AsyncStorage.getItem("new"))!), { z: 1, w: 2 });
    // useAsyncStorage holds no state: callable outside a component, as in the package.
    // deno-lint-ignore denext/hooks-in-component
    const hook = useAsyncStorage("h");
    await hook.setItem('{"p":1}');
    await hook.mergeItem('{"q":2}');
    assertEquals(JSON.parse((await hook.getItem())!), { p: 1, q: 2 });
    await hook.removeItem();
    assertEquals(await hook.getItem(), null);
  });
});

Deno.test("async-storage: 3.x getMany / setMany / removeMany and createAsyncStorage", async () => {
  await inBrowser(async () => {
    await AsyncStorage.setMany({ a: "1", b: "2" });
    assertEquals(await AsyncStorage.getMany(["a", "b", "c"]), { a: "1", b: "2", c: null });
    await AsyncStorage.removeMany(["a"]);
    assertEquals(await AsyncStorage.getMany(["a"]), { a: null });
    const users = createAsyncStorage("users");
    await users.setItem("a", "other");
    assertEquals(await users.getItem("a"), "other");
    assertEquals(await AsyncStorage.getItem("a"), null, "separate key spaces");
    await users.clear();
    assertEquals(await users.getAllKeys(), []);
    assertEquals(await AsyncStorage.getItem("b"), "2", "clear is per storage");
    const err = AsyncStorageError.jsError("x", AsyncStorageError.Type.WebStorageError);
    assert(err instanceof Error && err.type === "WebStorageError");
  });
});

Deno.test("async-storage: a failure rejects with AsyncStorageError and reaches the callback", async () => {
  await inBrowser(async () => {
    let got: unknown = null;
    await assertRejects(
      () => AsyncStorage.mergeItem("bad", "{not json", (e) => (got = e)),
      AsyncStorageError,
    );
    assert(got instanceof AsyncStorageError);
  });
});

Deno.test("async-storage: the first call moves what the web build left in localStorage, once", async () => {
  const local = fakeLocalStorage({
    token: "abc",
    user: '{"id":1}',
    "denext:ota-install-id": "framework",
    "mmkv.default\\k": "mmkv's",
  });
  const idb = fakeIndexedDB();
  await inBrowser(async () => {
    await AsyncStorage.setItem("user", '{"id":2}'); // runs after the move
    assertEquals(await AsyncStorage.getItem("token"), "abc");
    assertEquals(await AsyncStorage.getItem("user"), '{"id":2}');
    assertEquals([...await AsyncStorage.getAllKeys()].sort(), ["token", "user"]);
    assertEquals(local.getItem("token"), "abc", "the localStorage copy stays");
  }, { local, idb });
  // A later launch does not move again (a key removed since stays removed).
  await inBrowser(async () => {
    await AsyncStorage.removeItem("token");
  }, { local, idb });
  await inBrowser(async () => {
    assertEquals(await AsyncStorage.getItem("token"), null);
  }, { local, idb });
});

// ---- react-native-mmkv ------------------------------------------------------------------------

Deno.test("mmkv: synchronous reads and writes, typed getters, listeners", async () => {
  await inBrowser(() => {
    const storage = createMMKV();
    const changed: string[] = [];
    const listener = storage.addOnValueChangedListener((k) => changed.push(k));
    storage.set("name", "Ada");
    storage.set("age", 36);
    storage.set("on", true);
    storage.set("bytes", new Uint8Array([0, 255, 7]).buffer);
    assertEquals(storage.getString("name"), "Ada");
    assertEquals(storage.getNumber("age"), 36);
    assertEquals(storage.getBoolean("on"), true);
    assertEquals([...new Uint8Array(storage.getBuffer("bytes")!)], [0, 255, 7]);
    assertEquals(storage.contains("name"), true);
    assertEquals(storage.getAllKeys().sort(), ["age", "bytes", "name", "on"]);
    assertEquals(storage.remove("name"), true);
    assertEquals(storage.remove("name"), false);
    listener.remove();
    storage.set("quiet", "x");
    assertEquals(changed, ["name", "age", "on", "bytes", "name"]);
    assertThrows(() => storage.set("", "x"), Error, "empty key");
    assertThrows(() => createMMKV({ id: "s", encryptionKey: "k" }), Error, "encryption");
    const v3 = new MMKV({ id: "legacy" });
    v3.set("k", "v");
    v3.delete("k");
    assertEquals(v3.contains("k"), false);
    // The same id shares data.
    assertEquals(createMMKV().getNumber("age"), 36);
  });
});

Deno.test("mmkv: writes reach localStorage at once and the durable store behind", async () => {
  const local = fakeLocalStorage();
  await inBrowser(async () => {
    const storage = createMMKV({ id: "app" });
    await mmkvReady(storage);
    storage.set("k", "v");
    assertEquals(local.getItem("app\\k"), "v", "the package's web format");
    await mmkvReady("app");
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(await openKeyValueStore("mmkv:app").get("k"), "v");
    storage.clearAll();
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(await openKeyValueStore("mmkv:app").keys(), []);
    assertEquals(local.getItem("app\\k"), null);
  }, { local });
});

Deno.test("mmkv: after localStorage is evicted, the durable store restores the keys", async () => {
  const idb = fakeIndexedDB();
  const local = fakeLocalStorage({ "mmkv.default\\seen": "1" });
  await inBrowser(async () => {
    const storage = createMMKV();
    assertEquals(storage.getString("seen"), "1", "seeded synchronously from localStorage");
    await mmkvReady();
    storage.set("token", "t");
    await new Promise((r) => setTimeout(r, 20));
  }, { local, idb });
  // The OS evicted the WebView's storage; the durable store (native in the shell) survived.
  local.clear();
  await inBrowser(async () => {
    const storage = createMMKV();
    const restored: string[] = [];
    storage.addOnValueChangedListener((k) => restored.push(k));
    assertEquals(storage.getString("token"), undefined, "the gap before hydration");
    await mmkvReady();
    assertEquals(storage.getString("token"), "t");
    assertEquals(storage.getString("seen"), "1", "the first launch copied it to the store");
    assertEquals(restored.sort(), ["seen", "token"]);
    assertEquals(local.getItem("mmkv.default\\token"), "t", "the mirror is refilled");
  }, { local, idb });
});

Deno.test("mmkv: existsMMKV / deleteMMKV", async () => {
  await inBrowser(() => {
    assertEquals(existsMMKV("x"), false);
    createMMKV({ id: "x" }).set("a", "1");
    assertEquals(existsMMKV("x"), true);
    assertEquals(deleteMMKV("x"), true);
    assertEquals(existsMMKV("x"), false);
  });
});

Deno.test("mmkv: useMMKVString / useMMKVObject re-render on writes; useMMKVKeys follows keys", async () => {
  await inBrowser(async () => {
    const storage = createMMKV({ id: "hooks" });
    let setName: (v: string | undefined) => void = () => {};
    function View() {
      const [name, set] = useMMKVString("name", storage);
      const [user] = useMMKVObject<{ id: number }>("user", storage);
      const keys = useMMKVKeys(storage);
      setName = set;
      return h("p", null, `${name ?? "-"}|${user?.id ?? "-"}|${keys.sort().join(",")}`);
    }
    const screen = await render(h(View, null));
    assertEquals(screen.container.textContent, "-|-|");
    await act(() => setName("Ada"));
    assertEquals(screen.container.textContent, "Ada|-|name");
    await act(() => storage.set("user", JSON.stringify({ id: 7 })));
    assertEquals(screen.container.textContent, "Ada|7|name,user");
    await act(() => setName(undefined));
    assertEquals(screen.container.textContent, "-|7|user");
    screen.unmount();
  });
});
