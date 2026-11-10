// The secure store per caller (src/desktop/caps/secure-store.ts): the pages store under
// `<service>/page`, each extension under `<service>/ext/<name>` (`ctx.secureStore` /
// `host.secureStore`), so neither reads the other's items, on every backend. The items an earlier
// denext stored for the pages under the bare `<service>` move into the page namespace once (a
// marker keeps a later launch from adopting an item planted there), a failed move leaves them where
// they were, and a delete leaves no un-namespaced copy. Fakes of the runtime's store (Linux, macOS)
// and of the Windows PasswordVault script stand in for the OS.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type SecureRunner,
  secureStoreHost,
  secureStoreNamespace,
} from "../src/desktop/caps/secure-store.ts";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import {
  type DesktopCapability,
  DesktopCapError,
  type DesktopExtensionHost,
} from "../src/desktop/extension.ts";
import { resolveDesktopCapabilities } from "../src/desktop/caps/mod.ts";
import { secureStoreLegacy } from "../src/desktop/secure-store-config.ts";
import {
  desktopPermissionContext,
  desktopPermissionFlags,
} from "../src/build/desktop-capabilities.ts";
import {
  FIRST_DESKTOP_BAKED_CAPABILITIES_RUNTIME,
  FIRST_MAC_SECURE_STORE_RUNTIME,
  FIRST_PTY_RUNTIME,
} from "../src/build/deno-version.ts";

const SVC = "com.example.app";

const ctx = {
  emit: () => {},
  appSupportDir: "",
  runOnMainThread: () => Promise.reject(new Error("no UI thread in tests")),
  secureStore: {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  },
  pickedPath: () => {
    throw new Error("no picked paths in tests");
  },
  os: "linux" as const,
  signal: new AbortController().signal,
};

// deno-lint-ignore no-explicit-any
function call(cap: { methods: Record<string, any> }, method: string, args: unknown) {
  return Promise.resolve().then(() => cap.methods[method].handler(args, ctx));
}

/** base64 of UTF-8, as the store keeps values. */
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** The fake store's key for (`service`, `account`). */
const item = (service: string, account: string) => `${service}\u0000${account}`;

/**
 * A fake `Deno.desktop.secureStore` (Linux's Secret Service, or macOS's Keychain store) keyed by
 * service and account; `failSet` refuses a write to an item it names.
 */
function fakeStore(opts: { failSet?: (service: string, account: string) => boolean } = {}) {
  const items = new Map<string, string>();
  const calls: string[] = [];
  const store = {
    supported: true,
    get(service: string, account: string) {
      calls.push(`get ${service} ${account}`);
      return Promise.resolve(items.get(item(service, account)) ?? null);
    },
    set(service: string, account: string, value: string) {
      calls.push(`set ${service} ${account}`);
      if (opts.failSet?.(service, account)) {
        const err = new Error("the keyring is locked");
        err.name = "SecureStoreUnavailable";
        return Promise.reject(err);
      }
      items.set(item(service, account), value);
      return Promise.resolve();
    },
    delete(service: string, account: string) {
      calls.push(`delete ${service} ${account}`);
      items.delete(item(service, account));
      return Promise.resolve();
    },
  };
  const api = {
    secureStore: store,
    platformFeatures: () => Promise.resolve({ secretService: "available" }),
  } as unknown as NonNullable<Parameters<typeof secureStoreHost>[0]["api"]>;
  return { api, items, calls };
}

/** A runner that fails the test if a CLI runs (the runtime's store needs none). */
const noCli: SecureRunner = (cmd) => Promise.reject(new Error(`no CLI may run: ${cmd}`));

/** The secure store over `store` on `os` (Linux, or macOS with `legacy: false`). */
function hostOn(store: ReturnType<typeof fakeStore>, os: "linux" | "darwin" = "linux") {
  return secureStoreHost({
    service: SVC,
    os,
    api: store.api,
    run: noCli,
    warn: () => {},
    ...(os === "darwin" ? { legacy: false } : {}),
  });
}

Deno.test("secureStoreNamespace: the pages under <service>/page, an extension under <service>/ext/<name>", () => {
  assertEquals(secureStoreNamespace(SVC, "page"), "com.example.app/page");
  assertEquals(secureStoreNamespace(SVC, { extension: "notes" }), "com.example.app/ext/notes");
  // No extension name can make the pages' namespace (or another extension's).
  assert(secureStoreNamespace(SVC, { extension: "page" }) !== secureStoreNamespace(SVC, "page"));
});

for (const os of ["linux", "darwin"] as const) {
  Deno.test(`secureStore (${os}): a page and an extension never see each other's keys`, async () => {
    const store = fakeStore();
    const host = hostOn(store, os);
    const notes = host.extension("notes");
    const sync = host.extension("sync");
    await call(host.capability, "set", { key: "token", value: "page secret" });
    assertEquals(await notes.get("token"), null, "an extension can't read the page's key");
    await notes.set("token", "notes secret");
    assertEquals(await sync.get("token"), null, "nor another extension's");
    assertEquals(await call(host.capability, "get", { key: "token" }), "page secret");
    assertEquals(await notes.get("token"), "notes secret");
    // Each is its own item, under its own service name.
    assertEquals(store.items.get(item(`${SVC}/page`, "token")), b64("page secret"));
    assertEquals(store.items.get(item(`${SVC}/ext/notes`, "token")), b64("notes secret"));
    // A page delete leaves the extension's item, and the other way round.
    await call(host.capability, "delete", { key: "token" });
    assertEquals(await notes.get("token"), "notes secret");
    await call(host.capability, "set", { key: "token", value: "again" });
    await notes.delete("token");
    assertEquals(await call(host.capability, "get", { key: "token" }), "again");
    assertEquals(await notes.get("token"), null);
  });
}

Deno.test("secureStore: an extension's store validates keys and values like the page API", async () => {
  const host = hostOn(fakeStore());
  const ext = host.extension("notes");
  for (const key of ["-x", "a\u0000b", "line\nbreak"]) {
    const err = await assertRejects(() => ext.get(key), DesktopCapError);
    assertEquals(err.code, "validation", key);
  }
  const value = await assertRejects(
    () => ext.set("k", 1 as unknown as string),
    DesktopCapError,
  );
  assertEquals(value.code, "validation");
  // A name that can't be a namespace (a control character) refuses every call.
  const bad = host.extension("a\nb");
  assertEquals((await assertRejects(() => bad.get("k"), DesktopCapError)).code, "validation");
  // The same name is the same store.
  assertEquals(host.extension("notes"), ext);
});

Deno.test("secureStore: the pages' earlier items move into the page namespace once, then the bare copy is gone", async () => {
  const store = fakeStore();
  // What an earlier denext wrote for the pages: the bare service.
  store.items.set(item(SVC, "token"), b64("signed in"));
  store.items.set(item(SVC, "unread"), b64("left"));
  const first = hostOn(store);
  assertEquals(await call(first.capability, "get", { key: "token" }), "signed in");
  assertEquals(store.items.get(item(`${SVC}/page`, "token")), b64("signed in"));
  assertEquals(store.items.has(item(SVC, "token")), false, "moved, not copied");
  // Later reads in the launch go to the page namespace alone.
  const before = store.calls.length;
  assertEquals(await call(first.capability, "get", { key: "token" }), "signed in");
  assertEquals(store.calls.slice(before), [`get ${SVC}/page token`]);
  // An extension gets no move: the bare item is never its.
  assertEquals(await first.extension("notes").get("unread"), null);
  assert(!store.calls.some((c) => c === `get ${SVC} unread`), JSON.stringify(store.calls));

  // A later launch never reads the bare service again: an item planted there is not adopted.
  store.items.set(item(SVC, "planted"), b64("attacker's token"));
  const later = hostOn(store);
  const mark = store.calls.length;
  assertEquals(await call(later.capability, "get", { key: "planted" }), null);
  assertEquals(await call(later.capability, "get", { key: "unread" }), null);
  assert(
    // (The session's Secret Service probe looks up an account never written.)
    !store.calls.slice(mark).some((c) => c.startsWith(`get ${SVC} `) && !c.endsWith("-probe")),
    JSON.stringify(store.calls.slice(mark)),
  );
  // The marker lives in the page namespace, under a key no caller can name.
  const marker = [...store.items.keys()].find((k) =>
    k.startsWith(`${SVC}/page\u0000-`) && !k.includes("probe")
  );
  assert(marker, JSON.stringify([...store.items.keys()]));
  const account = marker.slice(marker.indexOf("\u0000") + 1);
  const err = await assertRejects(() => call(later.capability, "get", { key: account }));
  assertEquals((err as DesktopCapError).code, "validation");
});

Deno.test("secureStore: a move whose write fails leaves the item where it was; the next read moves it", async () => {
  let locked = true;
  const store = fakeStore({
    failSet: (service, account) => locked && service === `${SVC}/page` && account === "token",
  });
  store.items.set(item(SVC, "token"), b64("signed in"));
  const host = hostOn(store);
  // The value still reaches the page; nothing was deleted.
  assertEquals(await call(host.capability, "get", { key: "token" }), "signed in");
  assertEquals(store.items.get(item(SVC, "token")), b64("signed in"));
  assertEquals(store.items.has(item(`${SVC}/page`, "token")), false);
  locked = false;
  assertEquals(await call(host.capability, "get", { key: "token" }), "signed in");
  assertEquals(store.items.get(item(`${SVC}/page`, "token")), b64("signed in"));
  assertEquals(store.items.has(item(SVC, "token")), false);
});

Deno.test("secureStore: a page write or delete removes the bare copy, in a later launch too", async () => {
  const store = fakeStore();
  store.items.set(item(SVC, "a"), b64("old a"));
  store.items.set(item(SVC, "b"), b64("old b"));
  // The first launch writes `a` without reading it: the bare copy goes.
  const first = hostOn(store);
  await call(first.capability, "set", { key: "a", value: "new a" });
  assertEquals(store.items.has(item(SVC, "a")), false);
  assertEquals(await call(first.capability, "get", { key: "a" }), "new a");
  // A later launch deletes `b`, never read: its bare copy goes too (no secret lingers).
  const later = hostOn(store);
  await call(later.capability, "delete", { key: "b" });
  assertEquals(store.items.has(item(SVC, "b")), false);
  assertEquals(await call(later.capability, "get", { key: "b" }), null);
});

Deno.test("secureStore: a page and an extension serialize per key; a value an earlier denext didn't write stays put", async () => {
  const store = fakeStore();
  store.items.set(item(SVC, "foreign"), "%%% not ours %%%");
  const host = hostOn(store);
  assertEquals(await call(host.capability, "get", { key: "foreign" }), null);
  assertEquals(store.items.get(item(SVC, "foreign")), "%%% not ours %%%");
  // A read and a write of the same key in flight: the write wins, in call order.
  store.items.set(item(SVC, "tok"), b64("old"));
  const [read, write] = await Promise.all([
    call(host.capability, "get", { key: "tok" }),
    call(host.capability, "set", { key: "tok", value: "new" }),
  ]);
  assertEquals([read, write], ["old", { ok: true }]);
  assertEquals(await call(host.capability, "get", { key: "tok" }), "new");
});

// ---- Windows: the PasswordVault resource is the namespace -------------------------------------

/** A fake PasswordVault behind the constant script: every payload on stdin, as JSON. */
function windowsVault() {
  const items = new Map<string, string>();
  const payloads: Array<{ op: string; service: string; key: string }> = [];
  const run: SecureRunner = (cmd, args, stdin) => {
    assertEquals(cmd, "powershell.exe");
    assertEquals(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    const p = JSON.parse(stdin ?? "{}") as {
      op: string;
      service: string;
      key: string;
      value: string;
    };
    payloads.push({ op: p.op, service: p.service, key: p.key });
    const id = item(p.service, p.key);
    if (p.op === "set") items.set(id, p.value);
    if (p.op === "delete") items.delete(id);
    if (p.op === "get") {
      return Promise.resolve(
        items.has(id) ? { code: 0, stdout: items.get(id)! } : { code: 1, stdout: "" },
      );
    }
    return Promise.resolve({ code: 0, stdout: "" });
  };
  return { run, items, payloads };
}

Deno.test("secureStore (Windows): the vault resource is <service>/page or <service>/ext/<name>; earlier items move", async () => {
  const vault = windowsVault();
  vault.items.set(item(SVC, "token"), b64("signed in"));
  const host = secureStoreHost({ service: SVC, os: "windows", run: vault.run, warn: () => {} });
  assertEquals(await call(host.capability, "get", { key: "token" }), "signed in");
  await host.extension("notes").set("token", "notes");
  const services = new Set(vault.payloads.map((p) => p.service));
  assertEquals([...services].sort(), [SVC, `${SVC}/ext/notes`, `${SVC}/page`]);
  // The bare resource was only read, then deleted (the move).
  assertEquals(
    vault.payloads.filter((p) => p.service === SVC).map((p) => p.op),
    ["get", "delete"],
  );
  assertEquals(vault.items.get(item(`${SVC}/page`, "token")), b64("signed in"));
  assertEquals(vault.items.get(item(`${SVC}/ext/notes`, "token")), b64("notes"));
  assertEquals(vault.items.has(item(SVC, "token")), false);
  // Windows declares PowerShell only.
  assertEquals(host.capability.methods.get.permissions, { run: ["powershell.exe"] });
});

// ---- the bridge: ctx.secureStore and host.secureStore -----------------------------------------

const ORIGIN = "http://127.0.0.1:8000";
const TOKEN = "test-token-1234";

async function rpc(
  bridge: ReturnType<typeof createDesktopBridge>,
  body: unknown,
): Promise<{ ok?: boolean; data?: unknown; code?: string; message?: string }> {
  const req = new Request(`${ORIGIN}/_denext/desktop/rpc`, {
    method: "POST",
    headers: {
      "x-denext-desktop-token": TOKEN,
      origin: ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const res = await bridge.handle(req, new URL(req.url), TOKEN);
  assert(res !== null);
  const env = await res.json();
  return { ok: env.ok, data: env.data, code: env.error?.code, message: env.error?.message };
}

/** An extension that keeps a secret through `ctx.secureStore`, and hands its host out. */
function vaultExtension(name: string, hosts: DesktopExtensionHost[]): DesktopCapability {
  return {
    name,
    setup: (host) => void hosts.push(host),
    methods: {
      save: {
        handler: async (args, c) => {
          await c.secureStore.set("k", (args as { v: string }).v);
          return { ok: true };
        },
      },
      load: { handler: (_args, c) => c.secureStore.get("k") },
    },
  };
}

Deno.test("bridge: each capability's ctx.secureStore and host.secureStore is its own namespace", async () => {
  const store = fakeStore();
  const secure = hostOn(store);
  const hosts: DesktopExtensionHost[] = [];
  const bridge = createDesktopBridge(
    [secure.capability, vaultExtension("alpha", hosts), vaultExtension("beta", hosts)],
    { secureStore: (name) => secure.extension(name) },
  );
  assertEquals((await rpc(bridge, { cap: "alpha", method: "save", args: { v: "a" } })).ok, true);
  assertEquals((await rpc(bridge, { cap: "beta", method: "load" })).data, null);
  assertEquals((await rpc(bridge, { cap: "alpha", method: "load" })).data, "a");
  // The page can't name it either.
  assertEquals(
    (await rpc(bridge, { cap: "secureStore", method: "get", args: { key: "k" } })).data,
    null,
  );
  assertEquals(store.items.get(item(`${SVC}/ext/alpha`, "k")), b64("a"));
  // The setup host reaches the same store as the method context.
  assertEquals(await hosts[0].secureStore.get("k"), "a");
  assertEquals(await hosts[1].secureStore.get("k"), null);
});

Deno.test("bridge: without the secureStore capability, ctx.secureStore and host.secureStore reject not_enabled", async () => {
  const hosts: DesktopExtensionHost[] = [];
  const bridge = createDesktopBridge([vaultExtension("alpha", hosts)]);
  const answer = await rpc(bridge, { cap: "alpha", method: "save", args: { v: "a" } });
  assertEquals(answer.ok, false);
  assertEquals(answer.code, "not_enabled");
  assertStringIncludes(answer.message ?? "", "denext desktop add secure-store");
  const err = await assertRejects(() => hosts[0].secureStore.get("k"), DesktopCapError);
  assertEquals(err.code, "not_enabled");
});

Deno.test("resolveDesktopCapabilities: the extensions' stores come with the secureStore capability", async () => {
  const off = await resolveDesktopCapabilities({
    desktop: { app: { identifier: SVC }, capabilities: { fs: true } },
  });
  assertEquals(off.extensionSecureStore, undefined);
  const on = await resolveDesktopCapabilities({
    desktop: { app: { identifier: SVC }, capabilities: { secureStore: true } },
  });
  assert(on.capabilities.some((c) => c.name === "secureStore"));
  assert(typeof on.extensionSecureStore === "function");
  const store = on.extensionSecureStore("notes");
  assert(typeof store.get === "function" && typeof store.set === "function");
});

Deno.test("secureStoreLegacy: on unless desktop.secureStore.legacy is false", () => {
  assertEquals(secureStoreLegacy(undefined), true);
  assertEquals(secureStoreLegacy({}), true);
  assertEquals(secureStoreLegacy({ secureStore: {} }), true);
  assertEquals(secureStoreLegacy({ secureStore: { legacy: true } }), true);
  assertEquals(secureStoreLegacy({ secureStore: { legacy: false } }), false);
});

Deno.test("secureStore: the declared method permissions are what packaging bakes, per runtime and config", () => {
  // A runtime version for each set of runtime facts.
  const runtimes = [
    { version: FIRST_PTY_RUNTIME, bakedCapabilities: false, macRuntimeStore: false },
    { version: FIRST_MAC_SECURE_STORE_RUNTIME, bakedCapabilities: false, macRuntimeStore: true },
    {
      version: FIRST_DESKTOP_BAKED_CAPABILITIES_RUNTIME,
      bakedCapabilities: true,
      macRuntimeStore: true,
    },
  ];
  const flags = (perms: { run?: readonly string[]; sys?: readonly string[] } | undefined) => [
    ...(perms?.sys ? [perms.sys.includes("*") ? "--allow-sys" : `--allow-sys=${perms.sys}`] : []),
    ...(perms?.run ? [`--allow-run=${[...perms.run].sort().join(",")}`] : []),
  ];
  for (const os of ["darwin", "linux", "windows"] as const) {
    for (const legacy of [true, false]) {
      for (const { version, ...facts } of runtimes) {
        const cap =
          secureStoreHost({ service: SVC, os, legacy, runtimeVersion: version, api: null })
            .capability;
        assertEquals(
          flags(cap.methods.get.permissions),
          desktopPermissionFlags(["secure-store"], os, { legacy, ...facts }),
          `${os} legacy=${legacy} ${version}`,
        );
      }
    }
  }
});

Deno.test("desktopPermissionContext: the config's legacy flag and the runtime's facts", () => {
  assertEquals(
    desktopPermissionContext({ desktop: { secureStore: { legacy: false } } }, {
      bakedCapabilities: true,
      macSecureStore: false,
    }),
    { legacy: false, bakedCapabilities: true, macRuntimeStore: false },
  );
  // The pinned runtime reads the baked list.
  assertEquals(desktopPermissionContext(undefined).bakedCapabilities, true);
  assertEquals(desktopPermissionContext(undefined).legacy, true);
});
