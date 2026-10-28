// `denext desktop dev --inspect-renderer[=<addr>]` (src/build/desktop-inspect-renderer.ts): the
// address parsing and its loopback refusal, the per-backend launch env (kept in step with the
// runtime's own `deno desktop --inspect-renderer`), and the `/json/list` announcement.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  announceCdpPages,
  cdpPages,
  freeLoopbackPort,
  inspectRendererLaunch,
  inspectRendererPlan,
  loopbackPortTaken,
  parseInspectRendererAddr,
} from "../src/build/desktop-inspect-renderer.ts";

const fixed = () => 45555;

Deno.test("parseInspectRendererAddr: the bare flag and every address shape", () => {
  assertEquals(parseInspectRendererAddr(true), { host: "127.0.0.1", port: 0 });
  assertEquals(parseInspectRendererAddr(""), { host: "127.0.0.1", port: 0 });
  assertEquals(parseInspectRendererAddr("9229"), { host: "127.0.0.1", port: 9229 });
  assertEquals(parseInspectRendererAddr(":9229"), { host: "127.0.0.1", port: 9229 });
  assertEquals(parseInspectRendererAddr("localhost"), { host: "localhost", port: 0 });
  assertEquals(parseInspectRendererAddr("127.0.0.2:9339"), { host: "127.0.0.2", port: 9339 });
  assertEquals(parseInspectRendererAddr("[::1]:9339"), { host: "::1", port: 9339 });
  assertThrows(() => parseInspectRendererAddr("127.0.0.1:99999"), Error, "not a port");
  assertThrows(() => parseInspectRendererAddr("127.0.0.1:abc"), Error, "not a port");
  assertThrows(() => parseInspectRendererAddr("::1:9229"), Error, "in brackets");
});

Deno.test("parseInspectRendererAddr: a non-loopback address is refused unless allowed", () => {
  for (const addr of ["0.0.0.0:9229", "192.168.1.5", "[::]:9229", "127.0.0.1.evil.com:1"]) {
    assertThrows(() => parseInspectRendererAddr(addr), Error, "refusing the non-loopback", addr);
  }
  const e = assertThrows(() => parseInspectRendererAddr("0.0.0.0:9229"));
  assertStringIncludes((e as Error).message, "--inspect-renderer-allow-remote");
  assertEquals(parseInspectRendererAddr("0.0.0.0:9229", true), { host: "0.0.0.0", port: 9229 });
});

Deno.test("inspectRendererPlan: CEF sets LAUFEY_REMOTE_DEBUGGING_PORT on every OS", () => {
  for (const os of ["darwin", "linux", "windows"] as const) {
    const plan = inspectRendererPlan("cef", os, { host: "127.0.0.1", port: 9339 });
    assertEquals(plan, {
      protocol: "cdp",
      env: { LAUFEY_REMOTE_DEBUGGING_PORT: "9339" },
      endpoint: "http://127.0.0.1:9339",
      notes: [],
    }, os);
  }
});

Deno.test("inspectRendererPlan: WebView2 appends --remote-debugging-port to the inherited args", () => {
  const fresh = inspectRendererPlan("webview", "windows", { host: "127.0.0.1", port: 9339 });
  assertEquals(fresh.protocol, "cdp");
  assertEquals(fresh.env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9339",
  });
  assertEquals(fresh.endpoint, "http://127.0.0.1:9339");
  const kept = inspectRendererPlan("webview", "windows", { host: "localhost", port: 9339 }, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--disable-gpu ",
  });
  assertEquals(kept.env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--disable-gpu --remote-debugging-port=9339",
  });
});

Deno.test("inspectRendererPlan: WebKitGTK takes the address; WKWebView has no port", () => {
  const gtk = inspectRendererPlan("webview", "linux", { host: "127.0.0.1", port: 9339 });
  assertEquals(gtk.protocol, "webkit");
  assertEquals(gtk.env, { WEBKIT_INSPECTOR_HTTP_SERVER: "127.0.0.1:9339" });
  assertEquals(
    inspectRendererPlan("webview", "linux", { host: "::1", port: 1 }).env,
    { WEBKIT_INSPECTOR_HTTP_SERVER: "[::1]:1" },
  );
  const mac = inspectRendererPlan("webview", "darwin", { host: "127.0.0.1", port: 9339 });
  assertEquals(mac.protocol, "none");
  assertEquals(mac.env, {});
  assertStringIncludes(mac.notes[0], "Safari > Develop");
});

Deno.test("inspectRendererPlan: Chromium ignores an allowed non-loopback host, and says so", () => {
  const plan = inspectRendererPlan("cef", "linux", { host: "0.0.0.0", port: 9339 });
  assertEquals(plan.endpoint, "http://127.0.0.1:9339");
  assertStringIncludes(plan.notes[0], "loopback only");
});

Deno.test("inspectRendererLaunch: a bare flag picks a free port and prints the endpoint", () => {
  const { addr, plan, lines } = inspectRendererLaunch({
    value: true,
    allowRemote: false,
    backend: "cef",
    os: "linux",
    pickPort: fixed,
  });
  assertEquals(addr, { host: "127.0.0.1", port: 45555 });
  assertEquals(plan.env, { LAUFEY_REMOTE_DEBUGGING_PORT: "45555" });
  assertStringIncludes(lines[0], "http://127.0.0.1:45555/json/list");
  // A given port is kept; the picker is not called.
  const given = inspectRendererLaunch({
    value: "127.0.0.1:9339",
    allowRemote: false,
    backend: "cef",
    os: "linux",
    pickPort: () => {
      throw new Error("picked");
    },
  });
  assertEquals(given.addr.port, 9339);
  assertThrows(
    () =>
      inspectRendererLaunch({
        value: "10.0.0.1:1",
        allowRemote: false,
        backend: "cef",
        os: "linux",
      }),
    Error,
    "non-loopback",
  );
});

Deno.test("inspectRendererLaunch: a picked port another process holds is picked again", () => {
  const held = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const taken = (held.addr as Deno.NetAddr).port;
    const free = freeLoopbackPort();
    const picks = [taken, free];
    const { addr, plan } = inspectRendererLaunch({
      value: true,
      allowRemote: false,
      backend: "cef",
      os: "linux",
      pickPort: () => picks.shift()!,
    });
    assertEquals(addr.port, free);
    assertEquals(plan.env, { LAUFEY_REMOTE_DEBUGGING_PORT: String(free) });
    assertEquals(loopbackPortTaken(taken), true);
    assertEquals(loopbackPortTaken(free), false);
    // A port the developer gave is used as given, taken or not.
    const given = inspectRendererLaunch({
      value: String(taken),
      allowRemote: false,
      backend: "cef",
      os: "linux",
    });
    assertEquals(given.addr.port, taken);
  } finally {
    held.close();
  }
  assertThrows(
    () =>
      inspectRendererLaunch({
        value: true,
        allowRemote: false,
        backend: "cef",
        os: "linux",
        pickPort: fixed,
        portTaken: () => true,
      }),
    Error,
    "no free loopback port in 5 picks",
  );
});

Deno.test("freeLoopbackPort returns a port that can be bound", () => {
  const port = freeLoopbackPort();
  assert(port > 0);
  const l = Deno.listen({ hostname: "127.0.0.1", port });
  l.close();
});

Deno.test("cdpPages keeps page targets with a WebSocket", () => {
  assertEquals(cdpPages({}), []);
  const page = {
    id: "A",
    type: "page",
    url: "app://localhost/",
    webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/A",
  };
  assertEquals(
    cdpPages([page, { ...page, id: "B", type: "service_worker" }, { id: "C", type: "page" }]),
    [page],
  );
});

Deno.test("announceCdpPages polls /json/list until the page appears, then prints it", async () => {
  const seen: string[] = [];
  let calls = 0;
  const fake = ((url: string) => {
    seen.push(url);
    calls++;
    if (calls === 1) return Promise.reject(new TypeError("connection refused"));
    if (calls === 2) return Promise.resolve(Response.json([]));
    // The window's page exists before it navigates: not announced as about:blank.
    if (calls === 3) {
      return Promise.resolve(Response.json([{
        id: "P1",
        type: "page",
        url: "about:blank",
        webSocketDebuggerUrl: "ws://127.0.0.1:9339/devtools/page/P1",
      }]));
    }
    return Promise.resolve(Response.json([{
      id: "P1",
      type: "page",
      url: "app://localhost/",
      webSocketDebuggerUrl: "ws://127.0.0.1:9339/devtools/page/P1",
    }]));
  }) as typeof fetch;
  const lines: string[] = [];
  const pages = await announceCdpPages("http://127.0.0.1:9339", {
    log: (l) => lines.push(l),
    signal: new AbortController().signal,
    fetch: fake,
    intervalMs: 1,
  });
  assertEquals(pages.length, 1);
  assertEquals(seen[0], "http://127.0.0.1:9339/json/list");
  assertEquals(calls, 4);
  const text = lines.join("\n");
  assertStringIncludes(text, "app://localhost/");
  assert(!text.includes("about:blank"), text);
  assertStringIncludes(text, "ws://127.0.0.1:9339/devtools/page/P1");
  assertStringIncludes(
    text,
    "devtools://devtools/bundled/inspector.html?ws=127.0.0.1:9339/devtools/page/P1",
  );
});

Deno.test("announceCdpPages stops when aborted and gives up on timeout", async () => {
  const never = (() => Promise.resolve(Response.json([]))) as typeof fetch;
  const ac = new AbortController();
  ac.abort();
  const lines: string[] = [];
  assertEquals(
    await announceCdpPages("http://x", {
      log: (l) => lines.push(l),
      signal: ac.signal,
      fetch: never,
    }),
    [],
  );
  assertEquals(lines, []);
  const timedOut = await announceCdpPages("http://x", {
    log: (l) => lines.push(l),
    signal: new AbortController().signal,
    fetch: never,
    intervalMs: 1,
    timeoutMs: 5,
  });
  assertEquals(timedOut, []);
  assertStringIncludes(lines.join("\n"), "No renderer page appeared");
  // A page that never navigates is still announced at the deadline (its WebSocket works).
  const blankPage = {
    id: "B",
    type: "page",
    url: "about:blank",
    webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/B",
  };
  const stuck = (() => Promise.resolve(Response.json([blankPage]))) as typeof fetch;
  const atDeadline = await announceCdpPages("http://x", {
    log: (l) => lines.push(l),
    signal: new AbortController().signal,
    fetch: stuck,
    intervalMs: 1,
    timeoutMs: 5,
  });
  assertEquals(atDeadline, [blankPage]);
});
