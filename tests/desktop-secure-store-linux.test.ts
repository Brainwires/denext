// The Linux `secureStore` backend: the runtime's own store (`Deno.desktop.secureStore` in denext's
// pinned runtime: the Secret Service through libsecret). Every refusal is `backend_unavailable`
// with the runtime's reason — never `null`, never "not found", never a generic `store_failed` — and
// a runtime without the store (the stock runtime) has no Linux backend at all: there is no
// `secret-tool` fallback, so no subprocess ever runs on Linux.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  missingBackendError,
  runSecureCli,
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

/** A runner that fails the test if the cap ever spawns a CLI (Linux has none). */
function noCli(): { run: SecureRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: (cmd) => {
      calls.push(cmd);
      return Promise.reject(new Error(`no CLI may run on Linux: ${cmd}`));
    },
  };
}

const METHODS = [["get", { key: "k" }], ["set", { key: "k", value: "v" }], [
  "delete",
  { key: "k" },
]] as const;

Deno.test("secureStore (Linux): a missing CLI keeps the generic backend_unavailable wording", async () => {
  // The real runner (macOS / Windows), with a binary that does not exist.
  const err = await assertRejects(
    () => runSecureCli("denext-no-such-credential-cli", ["lookup"]),
    DesktopCapError,
  );
  assertEquals(err.code, "backend_unavailable");
  assertStringIncludes(
    missingBackendError("security", new Deno.errors.NotFound("x")).message,
    `"security" is not available`,
  );
});

// --- the runtime's own store (`Deno.desktop.secureStore`) ---------------------------------------

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

Deno.test("secureStore (Linux, runtime store): a round-trip through the runtime; no CLI runs", async () => {
  const runtime = fakeRuntimeStore(() => "ok");
  const tool = noCli();
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
  // Stored base64 of UTF-8 (as secret-tool wrote them), so earlier items stay readable.
  assertEquals(
    runtime.items.get("tok"),
    btoa(String.fromCharCode(...new TextEncoder().encode("héllo\n"))),
  );
  assertEquals(await call(cap, "delete", { key: "tok" }), { ok: true });
  assertEquals(await call(cap, "get", { key: "tok" }), null);
  assertEquals(tool.calls, [], "no CLI");
  // The app's service, the page's key, the label, and the answer timeout.
  assertEquals(runtime.calls[1], {
    op: "set",
    service: "com.example.app",
    account: "tok",
    options: { label: "com.example.app", timeout: 7000 },
  });
  assertEquals(runtime.calls[0].options, { timeout: 7000 });
  // The runtime store needs an unscoped --allow-sys, and nothing to run.
  assertEquals(cap.methods.get.permissions, { sys: ["*"] });
});

Deno.test("secureStore (Linux, runtime store): unavailable is backend_unavailable with the reason, never null", async () => {
  const runtime = fakeRuntimeStore(() => "unavailable");
  const cap = secureStoreCapability({ service: "com.example.app", os: "linux", api: runtime.api });
  for (const [method, args] of METHODS) {
    await unavailable(call(cap, method, args), "the secure store is unavailable", "locked");
  }
  // Bad arguments the runtime refuses are validation errors.
  const invalid = fakeRuntimeStore(() => "invalid");
  const bad = secureStoreCapability({ service: "com.example.app", os: "linux", api: invalid.api });
  const err = await assertRejects(() => call(bad, "get", { key: "k" }), DesktopCapError);
  assertEquals(err.code, "validation");
});

Deno.test("secureStore (Linux): a runtime without its own store is backend_unavailable; never on Windows", async () => {
  // A runtime whose store is not supported (or absent: the stock runtime) — no fallback, no CLI.
  for (const api of [fakeRuntimeStore(() => "ok", false).api, null, {}]) {
    const tool = noCli();
    const cap = secureStoreCapability({
      service: "com.example.app",
      os: "linux",
      run: tool.run,
      api: api as Parameters<typeof secureStoreCapability>[0]["api"],
    });
    for (const [method, args] of METHODS) {
      await unavailable(call(cap, method, args), "denext's pinned runtime", "libsecret");
    }
    assertEquals(tool.calls, []);
  }
  // A store whose `supported` getter throws reads as none.
  const throwing = {
    secureStore: {
      get supported(): boolean {
        throw new Error("boom");
      },
    },
  };
  const cap = secureStoreCapability({
    service: "s",
    os: "linux",
    api: throwing as unknown as Parameters<typeof secureStoreCapability>[0]["api"],
  });
  await unavailable(call(cap, "get", { key: "k" }), "denext's pinned runtime");
  // Validation still comes first (a bad key never reaches a backend).
  const bad = await assertRejects(() => call(cap, "get", { key: "-x" }), DesktopCapError);
  assertEquals(bad.code, "validation");
  // Windows: PasswordVault through PowerShell, even with a runtime store present (macOS uses the
  // runtime's store: desktop-secure-store-macos.test.ts).
  const runtime = fakeRuntimeStore(() => "ok");
  const ran: string[] = [];
  const win = secureStoreCapability({
    service: "com.example.app",
    os: "windows",
    api: runtime.api,
    run: (cmd) => {
      ran.push(cmd);
      return Promise.resolve({ code: 1, stdout: "" });
    },
  });
  assertEquals(await call(win, "get", { key: "tok" }), null);
  assertEquals(ran, ["powershell.exe"]);
  assertEquals(runtime.calls, []);
});
