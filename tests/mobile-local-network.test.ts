// iOS's Local Network permission: until the user answers its prompt, iOS fails requests to a
// LAN host with NSURLErrorNotConnectedToInternet (-1009, "The Internet connection appears to be
// offline"). denext's mobile code adds a hint pointing at the setting when it sees that error
// against a private-range host (src/mobile/local-network.ts): the OTA check, and file transfers
// (the native DenextTransfer plugin's and the page's own).

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  isLocalNetworkHost,
  isOfflineError,
  LOCAL_NETWORK_HINT,
  withLocalNetworkHint,
} from "../src/mobile/local-network.ts";
import { checkForUiUpdate, downloadToFile, FileTransferError } from "../src/mobile/mod.ts";
import type { FileTransferEvent } from "../src/mobile/mod.ts";
import {
  onFileTransfer,
  pageDownload,
  resetFileTransfersForTesting,
} from "../src/mobile/file-transfer.ts";
import { type Any, fakePlugin, inShell, settle } from "./helpers/mobile-fakes.ts";

const OFFLINE = "The Internet connection appears to be offline.";

Deno.test("isLocalNetworkHost: RFC 1918, link-local and .local; not loopback or public", () => {
  for (
    const host of [
      "10.0.0.5",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.20",
      "169.254.10.2",
      "[fe80::1]",
      "fe80::abcd",
      "[fd12:3456::1]",
      "fc00::1",
      "[::ffff:192.168.1.20]",
      "[::ffff:c0a8:114]",
      "macbook.local",
      "MacBook-Pro.LOCAL.",
    ]
  ) assert(isLocalNetworkHost(host), host);
  for (
    const host of [
      "127.0.0.1",
      "localhost",
      "[::1]",
      "8.8.8.8",
      "172.15.0.1",
      "172.32.0.1",
      "192.169.0.1",
      "11.0.0.1",
      "100.64.0.1",
      "[2001:db8::1]",
      "[::ffff:8.8.8.8]",
      "example.com",
      "local",
      "my.local.example.com",
      "",
    ]
  ) assert(!isLocalNetworkHost(host), host);
});

Deno.test("isOfflineError: iOS's -1009 by message, code or cause", () => {
  assert(isOfflineError(new TypeError(OFFLINE)));
  assert(isOfflineError(OFFLINE));
  assert(isOfflineError({ message: "x", code: -1009 }));
  assert(isOfflineError({ message: "x", code: "-1009" }));
  assert(isOfflineError(new Error('Error Domain=NSURLErrorDomain Code=-1009 "…"')));
  assert(isOfflineError(new Error("NSURLErrorNotConnectedToInternet")));
  assert(isOfflineError(new TypeError("fetch failed", { cause: new Error(OFFLINE) })));
  assert(!isOfflineError(new TypeError("Load failed")));
  assert(!isOfflineError(new Error("code -10090")));
  assert(!isOfflineError(null));
  assert(!isOfflineError(undefined));
});

Deno.test("withLocalNetworkHint: added for -1009 against a LAN host only, once", () => {
  const hinted = withLocalNetworkHint(OFFLINE, "http://192.168.1.20:8787/x", OFFLINE);
  assertEquals(hinted, `${OFFLINE} (${LOCAL_NETWORK_HINT})`);
  assert(LOCAL_NETWORK_HINT.includes("Settings → Privacy & Security → Local Network"));
  assertEquals(withLocalNetworkHint(hinted, "http://192.168.1.20:8787/x", hinted), hinted);
  assertEquals(withLocalNetworkHint(OFFLINE, "https://example.com/x", OFFLINE), OFFLINE);
  assertEquals(
    withLocalNetworkHint("Load failed", "http://10.0.0.2/", "Load failed"),
    "Load failed",
  );
  assertEquals(withLocalNetworkHint(OFFLINE, "not a url", OFFLINE), OFFLINE);
});

// deno-lint-ignore no-explicit-any
const g = globalThis as any;

/** A DenextOta plugin whose `apply` rejects with `applyError` (or succeeds). */
function otaPlugin(applyError?: unknown): Any {
  return {
    status: () => Promise.resolve({ bundled: "b".repeat(64) }),
    apply: () => applyError ? Promise.reject(applyError) : Promise.resolve({}),
    download: () => Promise.resolve({}),
    activate: () => Promise.resolve({}),
    booted: () => Promise.resolve(),
    reset: () => Promise.resolve(),
  };
}

async function withOta(plugin: Any, fn: () => Promise<void>): Promise<void> {
  const saved = Object.getOwnPropertyDescriptor(g, "Capacitor");
  g.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    Plugins: { DenextOta: plugin },
  };
  try {
    await fn();
  } finally {
    if (saved) Object.defineProperty(g, "Capacitor", saved);
    else delete g.Capacitor;
  }
}

const MANIFEST = {
  version: "a".repeat(64),
  files: [{ path: "index.html", sha256: "c".repeat(64), size: 1 }],
};

Deno.test("checkForUiUpdate: a -1009 manifest fetch from a LAN server carries the hint", async () => {
  await withOta(otaPlugin(), async () => {
    const offline = (() => Promise.reject(new TypeError(OFFLINE))) as typeof fetch;
    const lan = await checkForUiUpdate({ baseUrl: "http://192.168.1.20:8787", fetch: offline });
    assert(lan.kind === "error" && lan.reason.includes(LOCAL_NETWORK_HINT), JSON.stringify(lan));
    const remote = await checkForUiUpdate({ baseUrl: "https://ui.example.com", fetch: offline });
    assert(
      remote.kind === "error" && !remote.reason.includes("Local Network"),
      JSON.stringify(remote),
    );
  });
});

Deno.test("checkForUiUpdate: a native -1009 file download from a LAN server carries the hint", async () => {
  const refusal = Object.assign(new Error(OFFLINE), { code: "download" });
  await withOta(otaPlugin(refusal), async () => {
    const ok = (() => Promise.resolve(Response.json(MANIFEST))) as typeof fetch;
    const r = await checkForUiUpdate({ baseUrl: "http://mac.local:8787", fetch: ok });
    assertEquals(r, {
      kind: "error",
      reason: `${OFFLINE} (${LOCAL_NETWORK_HINT})`,
      code: "download",
    });
  });
});

const TRANSFER = ["start", "pause", "resume", "cancel", "forget", "list"];

Deno.test("downloadToFile (shell): a -1009 failure from a LAN host carries the hint, event too", async () => {
  resetFileTransfersForTesting();
  const fake = fakePlugin(TRANSFER, { start: { id: "x" } });
  await inShell("ios", { DenextTransfer: fake.plugin }, async () => {
    const events: FileTransferEvent[] = [];
    const stop = onFileTransfer((e) => events.push(e));
    const run = downloadToFile("http://10.0.0.5:8080/f.bin", "f.bin", { id: "n1" });
    await settle();
    fake.fire("transfer", {
      id: "n1",
      type: "failed",
      state: "failed",
      url: "http://10.0.0.5:8080/f.bin",
      code: "NETWORK",
      error: OFFLINE,
    });
    const err = await assertRejects(() => run, FileTransferError);
    assert(err.message.includes(LOCAL_NETWORK_HINT), err.message);
    assert(events.at(-1)?.error?.includes(LOCAL_NETWORK_HINT), JSON.stringify(events.at(-1)));
    stop();
  });
  resetFileTransfersForTesting();
});

Deno.test("page download: a -1009 fetch failure from a LAN host carries the hint", async () => {
  resetFileTransfersForTesting();
  const prev = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new TypeError(OFFLINE));
  try {
    const sink = { open: () => Promise.reject(new Error("unused")) };
    const spec = (url: string, id: string) => ({
      id,
      url,
      directory: "data",
      path: "p.bin",
      options: {},
    });
    const lan = await assertRejects(
      () => pageDownload(spec("http://192.168.0.9/p.bin", "p1"), sink),
      FileTransferError,
    );
    assert(lan.message.includes(LOCAL_NETWORK_HINT), lan.message);
    const remote = await assertRejects(
      () => pageDownload(spec("https://cdn.example.com/p.bin", "p2"), sink),
      FileTransferError,
    );
    assert(!remote.message.includes("Local Network"), remote.message);
  } finally {
    globalThis.fetch = prev;
    resetFileTransfersForTesting();
  }
});
