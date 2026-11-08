// The macOS `secureStore` backend under a runtime with its own store (`Deno.desktop.secureStore`
// `supported`: the Keychain written by the app's own process, so only the app may read the item),
// and the move of the items an older denext wrote through `/usr/bin/security` (which trust
// `security`, so any program of the user could read them through it). Fakes model the two keychains
// the runtime may use:
//
// - the login keychain: one item per (service, account). The runtime never reads an item it didn't
//   write (`null`) and refuses to store over one ("in the way"); `security` sees the runtime's item
//   too, and must never be pointed at it with `-w` or `delete` (that would be macOS's prompt);
// - the data-protection keychain: the runtime's items live apart; `security` never sees them.
//
// Items are keyed by (service, account). The pages' items live under `<service>/page`
// (`P(key)`); an earlier denext kept them under the bare `<service>` (`L(key)`), where the
// `security` items it wrote are too.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type SecureRunner, secureStoreCapability } from "../src/desktop/caps/secure-store.ts";
import { DesktopCapError } from "../src/desktop/extension.ts";

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
  os: "darwin" as const,
  signal: new AbortController().signal,
};

// deno-lint-ignore no-explicit-any
function call(cap: { methods: Record<string, any> }, method: string, args: unknown) {
  return Promise.resolve().then(() => cap.methods[method].handler(args, ctx));
}

/** The app's service name. */
const SVC = "com.example.app";

/** The fake keychain's key for (`service`, `account`). */
const item = (service: string, account: string) => `${service}\u0000${account}`;

/** An item under the bare service: where an earlier denext kept the pages' items. */
const L = (account: string) => item(SVC, account);

/** An item under the pages' namespace. */
const P = (account: string) => item(`${SVC}/page`, account);

/** The account of a fake keychain key. */
const accountOf = (key: string) => key.slice(key.indexOf("\u0000") + 1);

/** base64 of UTF-8, as the cap stores values. */
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** Split a `security -i` command line into its words (the cap quotes with `"` and `\`). */
function securityWords(line: string): string[] {
  return [...line.trim().matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) =>
    m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]
  );
}

interface Item {
  value: string;
  owner: "runtime" | "security";
}

type Keychain = "login" | "data-protection";

/**
 * A fake Mac: the runtime's store and the `security` CLI over the same login keychain (or, for
 * `data-protection`, the runtime's items apart). `security` fails the test if it would read or
 * delete the runtime's own item (on a real Mac: macOS's prompt, or the app's token deleted).
 */
function fakeMac(keychain: Keychain, opts: { runtimeFails?: () => boolean } = {}) {
  const login = new Map<string, Item>();
  const dataProtection = new Map<string, Item>();
  const runtimeItems = keychain === "login" ? login : dataProtection;
  const cli: string[][] = [];
  const violations: string[] = [];
  const unavailable = (why: string) => {
    const err = new Error(why);
    err.name = "SecureStoreUnavailable";
    return err;
  };
  const store = {
    supported: true,
    get(service: string, account: string) {
      if (opts.runtimeFails?.()) return Promise.reject(unavailable("the keychain is locked"));
      const found = runtimeItems.get(item(service, account));
      // Items another program wrote are never read (no prompt): not found.
      return Promise.resolve(found?.owner === "runtime" ? found.value : null);
    },
    set(service: string, account: string, value: string) {
      if (opts.runtimeFails?.()) return Promise.reject(unavailable("the keychain is locked"));
      const found = runtimeItems.get(item(service, account));
      if (found && found.owner !== "runtime") {
        return Promise.reject(
          unavailable("another program's keychain item for this service and account is in the way"),
        );
      }
      runtimeItems.set(item(service, account), { value, owner: "runtime" });
      return Promise.resolve();
    },
    delete(service: string, account: string) {
      if (opts.runtimeFails?.()) return Promise.reject(unavailable("the keychain is locked"));
      const key = item(service, account);
      if (runtimeItems.get(key)?.owner === "runtime") runtimeItems.delete(key);
      return Promise.resolve();
    },
  };
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  type Answer = { code: number; stdout: string };
  /** Note a `security` call that would reach the runtime's own item (a prompt, or its loss). */
  const guard = (what: string, account: string) => {
    if (login.get(account)?.owner === "runtime") {
      violations.push(`security ${what} on the runtime's item ${JSON.stringify(account)}`);
    }
  };
  /** `find-generic-password`: the secret with `-w`, else the attributes (no prompt), where the
   * runtime's items carry its creator code. */
  const find = (args: string[], account: string): Answer => {
    const item = login.get(account);
    if (!item) return { code: 44, stdout: "" };
    if (!args.includes("-w")) {
      const creator = item.owner === "runtime" ? '"crtr"<uint32>="Lfy1"' : '"crtr"<uint32>=<NULL>';
      return { code: 0, stdout: `attributes:\n    ${creator}\n` };
    }
    guard("-w", account);
    return { code: 0, stdout: `${item.value}\n` };
  };
  const ops: Record<string, (args: string[], account: string) => Answer> = {
    "add-generic-password": (args, account) => {
      guard("add", account);
      login.set(account, { value: after(args, "-w"), owner: "security" });
      return { code: 0, stdout: "" };
    },
    "find-generic-password": find,
    "delete-generic-password": (_args, account) => {
      guard("delete", account);
      return { code: login.delete(account) ? 0 : 44, stdout: "" };
    },
  };
  const run: SecureRunner = (cmd, argv, stdin) => {
    assertEquals(cmd, "security");
    const args = argv[0] === "-i" ? securityWords(stdin ?? "") : argv;
    cli.push(args);
    return Promise.resolve(ops[args[0]](args, item(after(args, "-s"), after(args, "-a"))));
  };
  return { api: { secureStore: store }, run, login, dataProtection, runtimeItems, cli, violations };
}

/** A capability over `mac`. */
function capOn(mac: ReturnType<typeof fakeMac>, legacy?: boolean) {
  return secureStoreCapability({
    service: SVC,
    os: "darwin",
    api: mac.api,
    run: mac.run,
    ...(legacy === undefined ? {} : { legacy }),
  });
}

/** The `security` subcommands run so far. */
const ops = (mac: ReturnType<typeof fakeMac>) => mac.cli.map((a) => a[0]);

for (const keychain of ["login", "data-protection"] as const) {
  Deno.test(`secureStore (macOS, runtime store, ${keychain}): a round trip through the runtime, never \`security add\``, async () => {
    const mac = fakeMac(keychain);
    const cap = capOn(mac);
    assertEquals(await call(cap, "get", { key: "absent" }), null);
    assertEquals(await call(cap, "set", { key: "tok", value: 'line1\nline2 🔒 "q"' }), {
      ok: true,
    });
    assertEquals(await call(cap, "get", { key: "tok" }), 'line1\nline2 🔒 "q"');
    // Stored base64 of UTF-8, as the `security` path wrote them.
    assertEquals(mac.runtimeItems.get(P("tok")), {
      value: b64('line1\nline2 🔒 "q"'),
      owner: "runtime",
    });
    assertEquals(await call(cap, "delete", { key: "tok" }), { ok: true });
    assertEquals(await call(cap, "get", { key: "tok" }), null);
    // `security` only looked (attributes), and never wrote, read a secret or touched the app's item.
    assert(!ops(mac).includes("add-generic-password"), JSON.stringify(mac.cli));
    assert(!mac.cli.some((a) => a.includes("-w")), JSON.stringify(mac.cli));
    assertEquals(mac.violations, []);
  });

  Deno.test(`secureStore (macOS, runtime store, ${keychain}): a legacy item moves over on its first read`, async () => {
    const mac = fakeMac(keychain);
    // What an older denext wrote: `security add-generic-password`, base64 of the value.
    mac.login.set(L("tok"), { value: b64("signed-in token"), owner: "security" });
    const cap = capOn(mac);
    assertEquals(await call(cap, "get", { key: "tok" }), "signed-in token");
    // Now the runtime's (only the app may read it) in the pages' namespace, and the legacy item
    // (and the bare copy the move made on the way) is gone.
    assertEquals(mac.runtimeItems.get(P("tok")), {
      value: b64("signed-in token"),
      owner: "runtime",
    });
    assertEquals(mac.runtimeItems.has(L("tok")), false);
    assertEquals(
      [...mac.login.values()].filter((i) => i.owner === "security"),
      [],
      "the legacy item is deleted",
    );
    assertEquals(mac.violations, []);
    // Later reads go to the runtime alone.
    const before = mac.cli.length;
    assertEquals(await call(cap, "get", { key: "tok" }), "signed-in token");
    assertEquals(mac.cli.length, before, "no `security` once moved");
    // A miss is looked up in `security` once per process, not on every read.
    assertEquals(await call(cap, "get", { key: "other" }), null);
    const afterMiss = mac.cli.length;
    assertEquals(await call(cap, "get", { key: "other" }), null);
    assertEquals(mac.cli.length, afterMiss);
  });

  Deno.test(`secureStore (macOS, runtime store, ${keychain}): a write over a legacy item replaces it; a delete removes it`, async () => {
    const mac = fakeMac(keychain);
    mac.login.set(L("tok"), { value: b64("old"), owner: "security" });
    mac.login.set(L("gone"), { value: b64("old"), owner: "security" });
    const cap = capOn(mac);
    await call(cap, "set", { key: "tok", value: "new" });
    assertEquals(mac.runtimeItems.get(P("tok")), { value: b64("new"), owner: "runtime" });
    assertEquals(await call(cap, "get", { key: "tok" }), "new");
    // A delete never leaves a legacy copy to come back on a later read.
    await call(cap, "delete", { key: "gone" });
    assertEquals(mac.login.has(L("gone")), false);
    assertEquals(await call(cap, "get", { key: "gone" }), null);
    assertEquals(
      [...mac.login.values()].filter((i) => i.owner === "security"),
      [],
    );
    assertEquals(mac.violations, []);
  });
}

Deno.test("secureStore (macOS, runtime store): a move that can't store keeps the legacy item, and returns the value", async () => {
  let fail = false;
  const mac = fakeMac("login", { runtimeFails: () => fail });
  mac.login.set(L("tok"), { value: b64("keep me"), owner: "security" });
  const cap = capOn(mac);
  // The runtime answers the read, then refuses every write (the keychain locked meanwhile).
  const store = mac.api.secureStore;
  const realSet = store.set.bind(store);
  store.set = (...a: Parameters<typeof realSet>) => {
    fail = true;
    const p = realSet(...a);
    fail = false;
    return p;
  };
  assertEquals(await call(cap, "get", { key: "tok" }), "keep me");
  // Still where it was (deleted to make room, then put back): the next read retries the move.
  assertEquals(mac.login.get(L("tok")), { value: b64("keep me"), owner: "security" });
  assertEquals(mac.login.has(P("tok")), false);
  store.set = realSet;
  assertEquals(await call(cap, "get", { key: "tok" }), "keep me");
  assertEquals(mac.login.get(P("tok")), { value: b64("keep me"), owner: "runtime" });
  assertEquals(mac.login.has(L("tok")), false);
  assertEquals(mac.violations, []);
});

Deno.test("secureStore (macOS, runtime store): a write whose store fails after the legacy delete puts the old value back, and fails", async () => {
  // The keychain locks right after the legacy item is deleted to make room (prompts are off, so
  // the runtime's store refuses). The old code deleted the legacy item and lost it: it had no copy.
  // (A `security` item in the pages' namespace: what a runtime without its own store wrote.)
  let locked = false;
  let lockOnDelete = true;
  const mac = fakeMac("login", { runtimeFails: () => locked });
  mac.login.set(P("tok"), { value: b64("signed-in token"), owner: "security" });
  const cap = secureStoreCapability({
    service: SVC,
    os: "darwin",
    api: mac.api,
    run: async (cmd, args, stdin, signal) => {
      const answer = await mac.run(cmd, args, stdin, signal);
      if (args[0] === "delete-generic-password" && lockOnDelete) locked = true;
      return answer;
    },
  });
  const err = await assertRejects(
    () => call(cap, "set", { key: "tok", value: "new" }),
    DesktopCapError,
  );
  assertEquals(err.code, "backend_unavailable");
  assertStringIncludes(err.message, "locked");
  // The new value isn't saved; the old one is intact, where it was.
  assertEquals(mac.login.get(P("tok")), { value: b64("signed-in token"), owner: "security" });
  assertEquals(mac.violations, []);
  // Unlocked again: the next write moves it over and removes the legacy item.
  locked = lockOnDelete = false;
  await call(cap, "set", { key: "tok", value: "new" });
  assertEquals(mac.login.get(P("tok")), { value: b64("new"), owner: "runtime" });
  assertEquals(await call(cap, "get", { key: "tok" }), "new");
  assertEquals(mac.violations, []);
});

for (const method of ["set", "get"] as const) {
  Deno.test(`secureStore (macOS, runtime store): a ${method} whose store times out the call still puts the legacy item back`, async () => {
    // The store hangs until the bridge's per-method timeout aborts the call's signal, then fails.
    // The put-back must not run under that (already aborted) signal: `security` would be killed
    // at once and the legacy item, deleted to make room, lost.
    // A read moves the bare legacy item; a write meets the one `security` wrote in the pages'
    // namespace (under a runtime without its own store).
    const planted = method === "set" ? P("tok") : L("tok");
    const caller = new AbortController();
    const mac = fakeMac("login");
    mac.login.set(planted, { value: b64("signed-in token"), owner: "security" });
    const store = mac.api.secureStore;
    const realSet = store.set.bind(store);
    store.set = (...a: Parameters<typeof realSet>) => {
      // The first try (the legacy item in the way) is refused as usual; the store after the
      // delete hangs until the timeout. Other items (the markers) are stored as usual.
      if (a[1] !== "tok" || mac.login.has(item(a[0], a[1]))) return realSet(...a);
      caller.abort(new DOMException("the call timed out", "TimeoutError"));
      const err = new Error("the keychain did not answer");
      err.name = "SecureStoreUnavailable";
      return Promise.reject(err);
    };
    const cap = secureStoreCapability({
      service: SVC,
      os: "darwin",
      api: mac.api,
      // Deno kills a child whose signal is aborted: the command never runs.
      run: (cmd, args, stdin, signal) =>
        signal?.aborted
          ? Promise.reject(new DOMException("aborted", "AbortError"))
          : mac.run(cmd, args, stdin, signal),
    });
    const args = method === "set" ? { key: "tok", value: "new" } : { key: "tok" };
    const result = Promise.resolve(
      cap.methods[method].handler(args, { ...ctx, signal: caller.signal }),
    );
    if (method === "set") {
      const err = await assertRejects(() => result, DesktopCapError);
      assertEquals(err.code, "backend_unavailable");
      assertStringIncludes(err.message, "did not answer");
    } else {
      assertEquals(await result, "signed-in token");
    }
    assertEquals(mac.login.get(planted), { value: b64("signed-in token"), owner: "security" });
    assertEquals(mac.violations, []);
  });
}

Deno.test("secureStore (macOS, runtime store): a write while the keychain is locked fails before the legacy item is touched", async () => {
  const mac = fakeMac("login", { runtimeFails: () => true });
  mac.login.set(P("tok"), { value: b64("signed-in token"), owner: "security" });
  const cap = capOn(mac);
  const err = await assertRejects(
    () => call(cap, "set", { key: "tok", value: "new" }),
    DesktopCapError,
  );
  assertEquals(err.code, "backend_unavailable");
  // Only looked (attributes): never read the secret, deleted or rewrote the item.
  assertEquals(ops(mac), ["find-generic-password"]);
  assert(!mac.cli.some((a) => a.includes("-w")), JSON.stringify(mac.cli));
  assertEquals(mac.login.get(P("tok")), { value: b64("signed-in token"), owner: "security" });
});

for (const keychain of ["login", "data-protection"] as const) {
  Deno.test(`secureStore (macOS, runtime store, ${keychain}): a key's operations run one at a time, so a move never undoes a write`, async () => {
    const mac = fakeMac(keychain);
    mac.login.set(L("tok"), { value: b64("old"), owner: "security" });
    const cap = capOn(mac);
    // A first read starts the move; a write of the same key arrives before it finishes.
    const [read, write] = await Promise.all([
      call(cap, "get", { key: "tok" }),
      call(cap, "set", { key: "tok", value: "new" }),
    ]);
    assertEquals(read, "old");
    assertEquals(write, { ok: true });
    assertEquals(mac.runtimeItems.get(P("tok")), { value: b64("new"), owner: "runtime" });
    assertEquals(await call(cap, "get", { key: "tok" }), "new");
    assertEquals([...mac.login.values()].filter((i) => i.owner === "security"), []);
    assertEquals(mac.violations, []);
  });
}

Deno.test("secureStore (macOS, runtime store): a value this cap didn't write is left alone", async () => {
  const mac = fakeMac("login");
  // Not our base64 (another tool's item under the same service and account).
  mac.login.set(L("tok"), { value: "not base64 at all!", owner: "security" });
  const cap = capOn(mac);
  assertEquals(await call(cap, "get", { key: "tok" }), null);
  assertEquals(mac.login.get(L("tok")), { value: "not base64 at all!", owner: "security" });
});

Deno.test("secureStore (macOS, runtime store): a refusal is backend_unavailable with the reason; no fallback to `security`", async () => {
  const mac = fakeMac("login", { runtimeFails: () => true });
  mac.login.set(L("tok"), { value: b64("legacy"), owner: "security" });
  const cap = capOn(mac);
  for (const [method, args] of [["get", { key: "tok" }], ["delete", { key: "tok" }]] as const) {
    const err = await assertRejects(() => call(cap, method, args), DesktopCapError);
    assertEquals(err.code, "backend_unavailable");
    assertStringIncludes(err.message, "locked");
  }
  // A read the runtime refused never reads the legacy item instead.
  assert(!mac.cli.some((a) => a.includes("-w")));
  assertEquals(mac.login.get(L("tok"))?.owner, "security");
});

Deno.test("secureStore (macOS): permissions cover the runtime's store and `security`", () => {
  const cap = capOn(fakeMac("login"));
  assertEquals(cap.methods.get.permissions, { run: ["security"], sys: ["*"] });
});

Deno.test("secureStore (macOS): fail first, the `security` path is what a runtime without a store keeps", async () => {
  // Without the runtime's store (an older or the stock runtime), the value is written by
  // `security add-generic-password`: an item that trusts /usr/bin/security, which any program of
  // the user can run to read it back. With the store, `security` never writes (the tests above).
  for (const api of [null, { secureStore: { supported: false } }]) {
    const mac = fakeMac("login");
    const cap = secureStoreCapability({
      service: SVC,
      os: "darwin",
      api: api as Parameters<typeof secureStoreCapability>[0]["api"],
      run: mac.run,
    });
    await call(cap, "set", { key: "tok", value: "v" });
    assert(ops(mac).includes("add-generic-password"), JSON.stringify(mac.cli));
    assertEquals(mac.login.get(P("tok")), { value: b64("v"), owner: "security" });
    assertEquals(await call(cap, "get", { key: "tok" }), "v");
  }
});

// ---- the move is a one-time thing (a marker in the runtime's store) ----------------------------

for (const keychain of ["login", "data-protection"] as const) {
  Deno.test(`secureStore (macOS, runtime store, ${keychain}): after the first launch, a planted legacy item is never adopted`, async () => {
    const mac = fakeMac(keychain);
    // The first launch under the runtime's store: it looks once, finds nothing to move.
    const first = capOn(mac);
    assertEquals(await call(first, "get", { key: "tok" }), null);
    // Another program of the same user plants an item the way an older denext wrote one.
    mac.login.set(L("tok"), { value: b64("attacker's token"), owner: "security" });
    mac.login.set(L("other"), { value: b64("attacker's token"), owner: "security" });
    // A later launch (a new process) never imports it, whichever key it is.
    const later = capOn(mac);
    const before = mac.cli.length;
    assertEquals(await call(later, "get", { key: "tok" }), null);
    assertEquals(await call(later, "get", { key: "other" }), null);
    assertEquals(mac.cli.slice(before), [], "no `security` once the move is done");
    assertEquals(mac.login.get(L("tok")), { value: b64("attacker's token"), owner: "security" });
    assertEquals(mac.violations, []);
  });
}

Deno.test("secureStore (macOS, runtime store): during the first launch every key a page touches moves over", async () => {
  const mac = fakeMac("login");
  mac.login.set(L("a"), { value: b64("one"), owner: "security" });
  mac.login.set(L("b"), { value: b64("two"), owner: "security" });
  const cap = capOn(mac);
  assertEquals(await call(cap, "get", { key: "a" }), "one");
  assertEquals(await call(cap, "get", { key: "b" }), "two");
  assertEquals(mac.login.get(P("b")), { value: b64("two"), owner: "runtime" });
  assertEquals(mac.violations, []);
});

Deno.test("secureStore (macOS, runtime store): the markers are not keys a page can read, write or delete", async () => {
  const mac = fakeMac("login");
  const cap = capOn(mac);
  await call(cap, "get", { key: "tok" });
  const markers = [...new Set([...mac.runtimeItems.keys()].map(accountOf))];
  // The legacy markers (bare and page namespace) and the page namespace's own.
  assertEquals(markers.length, 2, JSON.stringify(markers));
  assertEquals(mac.runtimeItems.size, 3, JSON.stringify([...mac.runtimeItems.keys()]));
  for (const marker of markers) {
    assert(marker.startsWith("-"), marker);
    for (
      const [method, args] of [["get", { key: marker }], ["set", { key: marker, value: "x" }], [
        "delete",
        { key: marker },
      ]] as const
    ) {
      const err = await assertRejects(() => call(cap, method, args), DesktopCapError);
      assertEquals(err.code, "validation");
    }
  }
});

Deno.test("secureStore (macOS, runtime store, login): after the first launch a write still replaces a leftover legacy item, never adopting it", async () => {
  const mac = fakeMac("login");
  assertEquals(await call(capOn(mac), "get", { key: "x" }), null);
  // A legacy item no page touched during the first launch is in the runtime's way (one
  // `security` wrote in the pages' namespace, under a runtime without its own store).
  mac.login.set(P("tok"), { value: b64("old"), owner: "security" });
  const later = capOn(mac);
  assertEquals(await call(later, "set", { key: "tok", value: "new" }), { ok: true });
  assertEquals(mac.login.get(P("tok")), { value: b64("new"), owner: "runtime" });
  assertEquals(await call(later, "get", { key: "tok" }), "new");
  assertEquals(mac.violations, []);
});

Deno.test("secureStore (macOS, runtime store): a write over a legacy item whose value can't be read fails and leaves it", async () => {
  // `security` sees the item (attributes) but the read of its value fails (the CLI erred, or was
  // killed): with nothing to put back, deleting it to make room could lose it.
  let locked = false;
  const mac = fakeMac("login", { runtimeFails: () => locked });
  mac.login.set(P("tok"), { value: b64("signed-in token"), owner: "security" });
  const warnings: string[] = [];
  const cap = secureStoreCapability({
    service: SVC,
    os: "darwin",
    api: mac.api,
    warn: (m) => warnings.push(m),
    run: async (cmd, args, stdin, signal) => {
      if (args[0] === "find-generic-password" && args.includes("-w")) {
        return { code: 1, stdout: "", stderr: "security: SecKeychainSearchCopyNext failed" };
      }
      const answer = await mac.run(cmd, args, stdin, signal);
      if (args[0] === "delete-generic-password") locked = true;
      return answer;
    },
  });
  const err = await assertRejects(
    () => call(cap, "set", { key: "tok", value: "new" }),
    DesktopCapError,
  );
  assertEquals(err.code, "backend_unavailable");
  assert(!ops(mac).includes("delete-generic-password"), JSON.stringify(mac.cli));
  assertEquals(mac.login.get(P("tok")), { value: b64("signed-in token"), owner: "security" });
});

Deno.test("secureStore (macOS, runtime store): a put-back that fails is logged, without the value or the key", async () => {
  let locked = false;
  const mac = fakeMac("login", { runtimeFails: () => locked });
  mac.login.set(P("tok"), { value: b64("signed-in token"), owner: "security" });
  const warnings: string[] = [];
  const cap = secureStoreCapability({
    service: SVC,
    os: "darwin",
    api: mac.api,
    warn: (m) => warnings.push(m),
    run: async (cmd, args, stdin, signal) => {
      // The put-back (`security -i add`) fails too.
      if (args[0] === "-i" && locked) return { code: 1, stdout: "" };
      const answer = await mac.run(cmd, args, stdin, signal);
      if (args[0] === "delete-generic-password") locked = true;
      return answer;
    },
  });
  await assertRejects(() => call(cap, "set", { key: "tok", value: "new" }), DesktopCapError);
  assertEquals(warnings.length, 1, JSON.stringify(warnings));
  assertStringIncludes(warnings[0], "could not be put back");
  assert(!warnings[0].includes("tok") && !warnings[0].includes(b64("signed-in token")));
});

// ---- `desktop.secureStore.legacy: false`: `security` never runs --------------------------------

for (const keychain of ["login", "data-protection"] as const) {
  Deno.test(`secureStore (macOS, runtime store, ${keychain}, legacy off): \`security\` never runs and no legacy item is adopted`, async () => {
    const mac = fakeMac(keychain);
    // Items `security` wrote, bare and in the pages' namespace: none is the app's under legacy off.
    mac.login.set(L("tok"), { value: b64("legacy"), owner: "security" });
    mac.login.set(P("other"), { value: b64("legacy"), owner: "security" });
    const cap = capOn(mac, false);
    assertEquals(await call(cap, "get", { key: "tok" }), null);
    assertEquals(await call(cap, "get", { key: "other" }), null);
    assertEquals(await call(cap, "set", { key: "fresh", value: "v" }), { ok: true });
    assertEquals(await call(cap, "get", { key: "fresh" }), "v");
    assertEquals(await call(cap, "delete", { key: "fresh" }), { ok: true });
    assertEquals(mac.cli, [], "no `security` call of any kind");
    assertEquals(mac.login.get(L("tok")), { value: b64("legacy"), owner: "security" });
    assertEquals(mac.violations, []);
  });
}

Deno.test("secureStore (macOS, no runtime store, legacy off): backend_unavailable naming legacy; `security` never runs", async () => {
  for (const api of [null, { secureStore: { supported: false } }]) {
    const ran: string[] = [];
    const cap = secureStoreCapability({
      service: SVC,
      os: "darwin",
      legacy: false,
      api: api as Parameters<typeof secureStoreCapability>[0]["api"],
      run: (cmd) => {
        ran.push(cmd);
        return Promise.resolve({ code: 0, stdout: "" });
      },
    });
    for (
      const [method, args] of [["get", { key: "k" }], ["set", { key: "k", value: "v" }]] as const
    ) {
      const err = await assertRejects(() => call(cap, method, args), DesktopCapError);
      assertEquals(err.code, "backend_unavailable");
      assertStringIncludes(err.message, "desktop.secureStore.legacy");
    }
    assertEquals(ran, []);
  }
});

Deno.test("secureStore (macOS): declared permissions follow legacy and the runtime", () => {
  const mac = fakeMac("login");
  const perms = (legacy: boolean, runtimeVersion: string) =>
    secureStoreCapability({ service: SVC, os: "darwin", api: mac.api, legacy, runtimeVersion })
      .methods.get.permissions;
  // The pinned runtime (its own Keychain store; no baked capability list yet).
  assertEquals(perms(true, "3.0.0-denext.13"), { run: ["security"], sys: ["*"] });
  assertEquals(perms(false, "3.0.0-denext.13"), { sys: ["*"] });
  // A runtime without its own macOS store: `security` stays declared.
  assertEquals(perms(false, "3.0.0-denext.12"), { run: ["security"], sys: ["*"] });
  // A runtime that gates the store on app.json's capability list: no --allow-sys.
  assertEquals(perms(false, "99999.0.0"), {});
  assertEquals(perms(true, "99999.0.0"), { run: ["security"] });
});
