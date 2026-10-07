// The Linux `secureStore` backend (`secret-tool`) told apart from its failures, with a stubbed CLI
// that answers exactly as secret-tool 0.21 + gnome-keyring did on a real Ubuntu desktop
// (2026-10-05): a miss is a SILENT exit 1; no session bus, no Secret Service provider and a write
// to a locked collection print `secret-tool: …` and exit 1; a lookup or clear in a LOCKED
// collection is silent too, but `secret-tool search` still lists the item. Every failure is
// `backend_unavailable` with a reason that names the fix — never `null`, never "not found", never
// a generic `store_failed`. A missing `secret-tool` names the package to install.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  missingBackendError,
  runSecureCli,
  secretToolError,
  type SecureRunner,
  secureStoreCapability,
} from "../src/desktop/caps/secure-store.ts";
import { DesktopCapError } from "../src/desktop/extension.ts";

const ctx = {
  emit: () => {},
  appSupportDir: "",
  runOnMainThread: () => Promise.reject(new Error("no UI thread in tests")),
  os: "linux" as const,
  signal: new AbortController().signal,
};

type Mode = "ok" | "no-bus" | "no-provider" | "locked";

/** The stderr secret-tool printed for each failure on the real box. */
const STDERR = {
  "no-bus": "secret-tool: Could not connect: No such file or directory\n",
  "no-provider":
    "secret-tool: The name org.freedesktop.secrets was not provided by any .service files\n",
  "no-display": "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n",
  "locked-store": "secret-tool: Cannot create an item in a locked collection\n",
};

type Out = { code: number; stdout: string; stderr: string };
const out = (code: number, stdout = "", stderr = ""): Out => ({ code, stdout, stderr });
/** A silent exit 1: a miss, or a lookup / clear in a locked collection. */
const SILENT = out(1);

/** One secret-tool verb against the in-memory keyring, `locked` or not. */
type Verb = (items: Map<string, string>, key: string, locked: boolean, stdin?: string) => Out;
const VERBS: Record<string, Verb> = {
  lookup: (items, key, locked) => locked || !items.has(key) ? SILENT : out(0, items.get(key)!),
  // Lists a locked item without its secret; the attributes go to stderr.
  search: (items, key, locked) =>
    !items.has(key)
      ? out(0)
      : locked
      ? out(0, "[/6]\nlabel = \n", "secret-tool: Cannot get secret of a locked object\n")
      : out(0, `[/6]\nsecret = ${items.get(key)}\n`, `attribute.account = ${key}\n`),
  store: (items, key, locked, stdin) =>
    locked ? out(1, "", STDERR["locked-store"]) : (items.set(key, stdin ?? ""), out(0)),
  clear: (items, key, locked) => locked || !items.delete(key) ? SILENT : out(0),
};

/** A fake secret-tool over an in-memory keyring in `mode`, logging each call's verb. */
function fakeSecretTool(mode: () => Mode, items = new Map<string, string>()) {
  const calls: string[] = [];
  const run: SecureRunner = (cmd, args, stdin) => {
    assertEquals(cmd, "secret-tool");
    // store: [store, --label, svc, service, svc, account, KEY]; else [op, service, svc, account, KEY]
    const op = args[0];
    calls.push(op);
    const m = mode();
    if (m === "no-bus" || m === "no-provider") return Promise.resolve(out(1, "", STDERR[m]));
    const key = op === "store" ? args[6] : args[4];
    return Promise.resolve(VERBS[op](items, key, m === "locked", stdin));
  };
  return { run, calls, items };
}

// deno-lint-ignore no-explicit-any
function call(cap: { methods: Record<string, any> }, method: string, args: unknown) {
  return Promise.resolve().then(() => cap.methods[method].handler(args, ctx));
}

async function unavailable(p: Promise<unknown>, ...reason: string[]): Promise<DesktopCapError> {
  const err = await assertRejects(() => p, DesktopCapError);
  assertEquals(err.code, "backend_unavailable", err.message);
  for (const r of reason) assertStringIncludes(err.message, r);
  return err;
}

Deno.test("secureStore (Linux): a round-trip, and a genuine miss reads null / deletes idempotently", async () => {
  const tool = fakeSecretTool(() => "ok");
  const cap = secureStoreCapability({ service: "com.example.app", os: "linux", run: tool.run });
  assertEquals(await call(cap, "get", { key: "absent" }), null);
  assertEquals(tool.calls, ["lookup", "search"], "a silent miss is double-checked");
  assertEquals(await call(cap, "set", { key: "tok", value: "héllo\n" }), { ok: true });
  assertEquals(await call(cap, "get", { key: "tok" }), "héllo\n");
  assertEquals(await call(cap, "delete", { key: "tok" }), { ok: true });
  assertEquals(await call(cap, "delete", { key: "tok" }), { ok: true }, "idempotent");
  assertEquals(await call(cap, "get", { key: "tok" }), null);
});

Deno.test("secureStore (Linux): no Secret Service provider is backend_unavailable on every method", async () => {
  const cap = secureStoreCapability({
    service: "svc",
    os: "linux",
    run: fakeSecretTool(() => "no-provider").run,
  });
  const why = "no Secret Service provider (gnome-keyring or KWallet)";
  await unavailable(call(cap, "get", { key: "k" }), why);
  await unavailable(call(cap, "set", { key: "k", value: "v" }), why);
  await unavailable(call(cap, "delete", { key: "k" }), why);
});

Deno.test("secureStore (Linux): no session bus is backend_unavailable, naming the provider", async () => {
  const cap = secureStoreCapability({
    service: "svc",
    os: "linux",
    run: fakeSecretTool(() => "no-bus").run,
  });
  await unavailable(call(cap, "get", { key: "k" }), "no D-Bus session bus", "gnome-keyring");
  await unavailable(call(cap, "set", { key: "k", value: "v" }), "no D-Bus session bus");
  await unavailable(call(cap, "delete", { key: "k" }), "no D-Bus session bus");
});

Deno.test("secureStore (Linux): a locked keyring is backend_unavailable, never a miss", async () => {
  let mode: Mode = "ok";
  const tool = fakeSecretTool(() => mode);
  const cap = secureStoreCapability({ service: "svc", os: "linux", run: tool.run });
  await call(cap, "set", { key: "tok", value: "v" });
  mode = "locked";
  // The lookup is silent (exit 1, no stderr) exactly like a miss; `search` still lists the item.
  await unavailable(call(cap, "get", { key: "tok" }), "locked");
  await unavailable(call(cap, "set", { key: "tok", value: "w" }), "locked");
  await unavailable(call(cap, "delete", { key: "tok" }), "locked");
  assert(tool.items.has("tok"), "nothing was lost");
  // A key that is not there at all is still a miss while locked (nothing to unlock for).
  assertEquals(await call(cap, "get", { key: "other" }), null);
  mode = "ok";
  assertEquals(await call(cap, "get", { key: "tok" }), "v");
});

Deno.test("secureStore (Linux): a missing secret-tool names the package to install", async () => {
  // The real runner, with a binary that does not exist.
  const err = await assertRejects(
    () => runSecureCli("denext-no-such-secret-tool", ["lookup"]),
    DesktopCapError,
  );
  assertEquals(err.code, "backend_unavailable");
  const missing = missingBackendError("secret-tool", new Deno.errors.NotFound("no such file"));
  assertEquals(missing.code, "backend_unavailable");
  assertStringIncludes(missing.message, "libsecret-tools (Debian/Ubuntu)");
  assertStringIncludes(missing.message, "libsecret (Fedora)");
  // Through the capability: every method surfaces it (never null / not found).
  const cap = secureStoreCapability({
    service: "svc",
    os: "linux",
    run: () => Promise.reject(missing),
  });
  for (
    const [m, a] of [["get", { key: "k" }], ["set", { key: "k", value: "v" }], ["delete", {
      key: "k",
    }]] as const
  ) {
    await unavailable(call(cap, m, a), "libsecret-tools");
  }
  // Another command (or another spawn failure) keeps the generic wording.
  assertStringIncludes(
    missingBackendError("security", new Deno.errors.NotFound("x")).message,
    `"security" is not available`,
  );
  assertStringIncludes(
    missingBackendError("secret-tool", new Deno.errors.NotCapable("x")).message,
    `"secret-tool" is not available`,
  );
});

Deno.test("secretToolError: each real stderr maps to its reason; paths never reach the page", () => {
  assertStringIncludes(
    secretToolError(STDERR["no-provider"]).message,
    "no Secret Service provider",
  );
  assertStringIncludes(secretToolError(STDERR["no-bus"]).message, "no D-Bus session bus");
  assertStringIncludes(secretToolError(STDERR["no-display"]).message, "no D-Bus session bus");
  assertStringIncludes(secretToolError(STDERR["locked-store"]).message, "keyring is locked");
  const other = secretToolError("secret-tool: Failed at /run/user/1000/bus: odd\nmore");
  assertEquals(other.code, "backend_unavailable");
  assertStringIncludes(other.message, "the Secret Service failed (Failed at … odd)");
  assert(!other.message.includes("/run/"), other.message);
});

Deno.test("secureStore (Linux): a silent write failure stays store_failed (not a backend outage)", async () => {
  const cap = secureStoreCapability({
    service: "svc",
    os: "linux",
    run: () => Promise.resolve({ code: 1, stdout: "", stderr: "" }),
  });
  const err = await assertRejects(
    () => call(cap, "set", { key: "k", value: "v" }),
    DesktopCapError,
  );
  assertEquals(err.code, "store_failed");
});

Deno.test("secureStore (Linux): an unlock prompt nobody answers is backend_unavailable, and the CLI is killed", async () => {
  const signals: AbortSignal[] = [];
  const cap = secureStoreCapability({
    service: "svc",
    os: "linux",
    answerTimeoutMs: 20,
    // A store that blocks on the keyring's unlock prompt (what secret-tool does on a locked GUI
    // session): it only ends when its signal aborts.
    run: (_cmd, _args, _stdin, signal) => {
      signals.push(signal!);
      return new Promise((_, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason))
      );
    },
  });
  await unavailable(call(cap, "set", { key: "k", value: "v" }), "did not answer", "locked");
  await unavailable(call(cap, "get", { key: "k" }), "did not answer");
  assert(signals.every((s) => s.aborted), "the hung secret-tool was aborted (killed)");
});

// --- runtime 2.9.7-denext.12: the runtime's own store (`Deno.desktop.secureStore`) -------------

type StoreMode = "ok" | "unavailable" | "invalid";

/** A fake `Deno.desktop.secureStore` over an in-memory map (what libsecret would hold). */
function fakeRuntimeStore(mode: () => StoreMode, supported = true) {
  const items = new Map<string, string>();
  const calls: Array<{ op: string; service: string; account: string; options?: unknown }> = [];
  const fail = () => {
    if (mode() === "unavailable") {
      const err = new Error(
        "the gnome-keyring keyring is locked and no one here can answer its unlock prompt",
      );
      err.name = "SecureStoreUnavailable";
      throw err;
    }
    if (mode() === "invalid") throw new TypeError("account must be a non-empty string");
  };
  const store = {
    supported,
    get(service: string, account: string, options?: unknown) {
      calls.push({ op: "get", service, account, options });
      fail();
      return Promise.resolve(items.get(account) ?? null);
    },
    set(service: string, account: string, value: string, options?: unknown) {
      calls.push({ op: "set", service, account, options });
      fail();
      items.set(account, value);
      return Promise.resolve();
    },
    delete(service: string, account: string, options?: unknown) {
      calls.push({ op: "delete", service, account, options });
      fail();
      items.delete(account);
      return Promise.resolve();
    },
  };
  return { api: { secureStore: store }, calls, items };
}

Deno.test("secureStore (Linux, runtime store): used when supported; secret-tool never runs", async () => {
  const runtime = fakeRuntimeStore(() => "ok");
  const tool = fakeSecretTool(() => "ok");
  const cap = secureStoreCapability({
    service: "com.example.app",
    os: "linux",
    run: tool.run,
    api: runtime.api,
    answerTimeoutMs: 7000,
  });
  assertEquals(await call(cap, "get", { key: "absent" }), null);
  assertEquals(await call(cap, "set", { key: "tok", value: "héllo\n" }), { ok: true });
  assertEquals(await call(cap, "get", { key: "tok" }), "héllo\n");
  // Stored as secret-tool did (base64 of UTF-8), so items of either path read the same.
  assertEquals(
    runtime.items.get("tok"),
    btoa(String.fromCharCode(...new TextEncoder().encode("héllo\n"))),
  );
  assertEquals(await call(cap, "delete", { key: "tok" }), { ok: true });
  assertEquals(await call(cap, "get", { key: "tok" }), null);
  assertEquals(tool.calls, [], "no secret-tool");
  // The app's service, the page's key, the label, and the answer timeout.
  assertEquals(runtime.calls[1], {
    op: "set",
    service: "com.example.app",
    account: "tok",
    options: { label: "com.example.app", timeout: 7000 },
  });
  assertEquals(runtime.calls[0].options, { timeout: 7000 });
  // The method permissions cover the runtime store (unscoped --allow-sys) and the older path.
  assertEquals(cap.methods.get.permissions, { run: ["secret-tool"], sys: ["*"] });
});

Deno.test("secureStore (Linux, runtime store): unavailable is backend_unavailable with the reason, never null", async () => {
  const runtime = fakeRuntimeStore(() => "unavailable");
  const cap = secureStoreCapability({ service: "com.example.app", os: "linux", api: runtime.api });
  for (
    const [method, args] of [["get", { key: "k" }], ["set", { key: "k", value: "v" }], [
      "delete",
      { key: "k" },
    ]] as const
  ) {
    await unavailable(call(cap, method, args), "the secure store is unavailable", "locked");
  }
  // Bad arguments the runtime refuses are validation errors.
  const invalid = fakeRuntimeStore(() => "invalid");
  const bad = secureStoreCapability({ service: "com.example.app", os: "linux", api: invalid.api });
  const err = await assertRejects(() => call(bad, "get", { key: "k" }), DesktopCapError);
  assertEquals(err.code, "validation");
});

Deno.test("secureStore (Linux, runtime store): a runtime without one keeps secret-tool; never on macOS / Windows", async () => {
  const none = fakeRuntimeStore(() => "ok", false);
  const tool = fakeSecretTool(() => "ok");
  const cap = secureStoreCapability({
    service: "com.example.app",
    os: "linux",
    run: tool.run,
    api: none.api,
  });
  assertEquals(await call(cap, "set", { key: "tok", value: "v" }), { ok: true });
  assertEquals(tool.calls, ["store"]);
  assertEquals(none.calls, []);
  // macOS: the Keychain CLI, even with a runtime store present.
  const runtime = fakeRuntimeStore(() => "ok");
  const ran: string[] = [];
  const mac = secureStoreCapability({
    service: "com.example.app",
    os: "darwin",
    api: runtime.api,
    run: (cmd) => {
      ran.push(cmd);
      return Promise.resolve({ code: 1, stdout: "" });
    },
  });
  assertEquals(await call(mac, "get", { key: "tok" }), null);
  assertEquals(ran, ["security"]);
  assertEquals(runtime.calls, []);
});
