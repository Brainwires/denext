// Retained vs one-shot desktop events (Qutty: a menu click was replayed to the page after a
// reload and acted on again). The rule: state, and what launched the app (a deep link, an opened
// file, the launching notification click), is retained for a page that subscribes later; a
// one-shot action for the page live now (a menu or tray click, a shortcut press, a focus change, a
// close request) is never replayed to a page that loads afterwards. Covers the log
// (src/desktop/bridge-events.ts), `emit(…, { retain: false })` on an extension's host, the reload
// path end to end through the bridge with the `app` and `deepLinks` capabilities, and the page's
// pull queue taking again on a (re)connect. The notifications queue on a page load is in
// tests/desktop-app-caps.test.ts.

import { assert, assertEquals } from "@std/assert";
import { DesktopEventLog } from "../src/desktop/bridge-events.ts";
import { createDesktopBridge, type DesktopBridge } from "../src/desktop/bridge.ts";
import type { DesktopCapability, DesktopExtensionHost } from "../src/desktop/extension.ts";
import { createAppController } from "../src/desktop/caps/app.ts";
import { createLaunchRouter } from "../src/desktop/launch-events.ts";
import { pullQueue } from "../src/desktop/pull.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { createFakeDesktopRuntime, until } from "./helpers/desktop-fake-runtime.ts";

const ORIGIN = "http://127.0.0.1:8000";
const TOKEN = "test-token-retain";
const decoder = new TextDecoder();

/** One delivered frame. */
type Frame = { id: number; cap: string; event: string; data: unknown };

/** The frame of one SSE block (`id:` + `data:`), or `undefined` for a comment. */
function parseFrame(block: string): Frame | undefined {
  const id = /^id: (\d+)$/m.exec(block);
  const data = /^data: (.*)$/m.exec(block);
  return id && data ? { id: Number(id[1]), ...JSON.parse(data[1]) } : undefined;
}

/**
 * The frames a stream holds, read up to the probe `sentinel` sends (its id when it returns one;
 * else the first probe). Probe frames are not returned.
 */
async function framesOf(
  stream: ReadableStream<Uint8Array>,
  sentinel: () => unknown,
): Promise<Frame[]> {
  const reader = stream.getReader();
  const end = sentinel();
  const isEnd = (f: Frame) => f.cap === "probe" && (typeof end !== "number" || f.id === end);
  const out: Frame[] = [];
  let text = "";
  let ended = false;
  while (!ended) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
    const blocks = text.split("\n\n");
    text = blocks.pop() ?? "";
    const frames = blocks.map(parseFrame).filter((f): f is Frame => f !== undefined);
    ended = frames.some(isEnd);
    out.push(...frames.filter((f) => f.cap !== "probe"));
  }
  await reader.cancel();
  return out;
}

/** What a fresh subscription to `log` (cursor `cursor`) replays. */
function replay(log: DesktopEventLog, cursor: string | null) {
  return framesOf(
    log.open(cursor),
    () => log.append("probe", "end", null, undefined, { retain: false }),
  );
}

Deno.test("DesktopEventLog: a non-retained event reaches live and resuming streams, never a new one", async () => {
  const log = new DesktopEventLog(4);
  const live = log.open(null);
  log.append("deepLinks", "available", null); // 1: what launched the app
  log.append("app", "action", null, undefined, { retain: false }); // 2: a click
  // A stream that was open when it was emitted gets it.
  const got = await framesOf(
    live,
    () => log.append("probe", "end", null, undefined, { retain: false }),
  );
  assertEquals(got.map((f) => `${f.cap}:${f.event}`), ["deepLinks:available", "app:action"]);
  // A page that subscribes now (a reload: no cursor) gets the retained one only.
  assertEquals((await replay(log, null)).map((f) => f.id), [1]);
  // A live page resuming after id 1 (its stream dropped) still gets the click, in id order.
  const state = log.append("window", "state", null);
  assertEquals((await replay(log, "1")).map((f) => `${f.id}:${f.cap}`), [
    "2:app",
    `${state}:window`,
  ]);
  // One-shot events have their own bound: a burst of them never evicts a retained event.
  for (let i = 0; i < 20; i++) log.append("windows", "focus", { i }, undefined, { retain: false });
  assert((await replay(log, null)).some((f) => f.cap === "deepLinks"));
});

/** An events request for page `page` (no cursor: a page that just loaded). */
function eventsRequest(page: string, lastEventId?: string): Request {
  return new Request(`${ORIGIN}/_denext/desktop/events`, {
    headers: {
      "x-denext-desktop-token": TOKEN,
      "x-denext-desktop-page": page,
      ...(lastEventId !== undefined ? { "last-event-id": lastEventId } : {}),
    },
  });
}

/** Open page `page`'s event stream on `bridge`. */
async function openEvents(
  bridge: DesktopBridge,
  page: string,
): Promise<ReadableStream<Uint8Array>> {
  const req = eventsRequest(page);
  const res = await bridge.handle(req, new URL(req.url), TOKEN);
  assertEquals(res?.status, 200);
  return res!.body!;
}

/** Call `cap.method` as page `page`; the envelope's data. */
async function rpc(bridge: DesktopBridge, page: string, cap: string, method: string, args = {}) {
  const req = new Request(`${ORIGIN}/_denext/desktop/rpc`, {
    method: "POST",
    headers: {
      "x-denext-desktop-token": TOKEN,
      "x-denext-desktop-page": page,
      origin: ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cap, method, args }),
  });
  const res = await bridge.handle(req, new URL(req.url), TOKEN);
  const body = await res!.json();
  assert(body.ok, JSON.stringify(body));
  return body.data;
}

Deno.test("reload: a menu click is not replayed to the reloaded page; a deep link still is", async () => {
  const bridgeRef: { bridge?: DesktopBridge } = {};
  const emit = (
    cap: string,
    event: string,
    data: unknown,
    target?: string,
    options?: { retain?: boolean },
  ) => bridgeRef.bridge?.emit(cap, event, data, target, options);
  const win = Object.assign(new EventTarget(), { setApplicationMenu() {} });
  const app = createAppController({
    window: win,
    api: { menuCapabilities: () => ({ appMenu: true, accelerators: true }) },
    emit,
    os: "darwin",
  });
  app.install();
  const router = createLaunchRouter({ schemes: ["qutty"], emit, api: {} });
  const bridge = bridgeRef.bridge = createDesktopBridge(
    [...router.capabilities, app.capability],
    {},
  );
  const sentinel = () => bridge.emit("probe", "end", null, undefined, { retain: false });
  const click = (id: string) => win.dispatchEvent(new CustomEvent("menuclick", { detail: { id } }));

  // The app was launched by a deep link; page 1 loads, builds its menu and listens.
  router.acceptUrl("qutty://open/session-1", true);
  const page1 = await openEvents(bridge, "page-1");
  await rpc(bridge, "page-1", "app", "setAppMenu", {
    menu: [{ label: "File", children: [{ id: "reload", label: "Reload" }] }],
  });
  click("reload");
  const seen1 = await framesOf(page1, sentinel);
  assertEquals(seen1.map((f) => `${f.cap}:${f.event}`), ["deepLinks:available", "app:action"]);
  assertEquals(await rpc(bridge, "page-1", "app", "take"), [
    { source: "menu", id: "reload", kind: "appMenu", keyWindow: null },
  ]);
  // The click reloads the page; a second one lands while it reloads, before page 2 listens.
  click("reload");

  // Page 2 (the reload) subscribes with no cursor.
  const seen2 = await framesOf(await openEvents(bridge, "page-2"), sentinel);
  assertEquals(seen2.map((f) => `${f.cap}:${f.event}`), ["deepLinks:available"]);
  assertEquals(await rpc(bridge, "page-2", "app", "take"), []);
  // The deep link that launched the app still waits for the page that takes it.
  assertEquals(await rpc(bridge, "page-2", "deepLinks", "take"), [
    { url: "qutty://open/session-1", launch: true },
  ]);
});

Deno.test("host.emit: { retain: false } reaches the live page only; the default is retained", async () => {
  let host: DesktopExtensionHost | undefined;
  const cap: DesktopCapability = {
    name: "qutty",
    methods: {},
    events: ["menu", "state"],
    setup: (h) => void (host = h),
  };
  const bridge = createDesktopBridge([cap], {});
  const sentinel = () => bridge.emit("probe", "end", null, undefined, { retain: false });
  const live = await openEvents(bridge, "page-1");
  host!.emit("menu", { id: "new-tab" }, { retain: false });
  host!.emit("state", { tabs: 1 });
  assertEquals((await framesOf(live, sentinel)).map((f) => f.event), ["menu", "state"]);
  const reloaded = await framesOf(await openEvents(bridge, "page-2"), sentinel);
  assertEquals(reloaded.map((f) => f.event), ["state"]);
  // The bridge's own emit (what `runDesktop`'s result uses) takes the same option.
  bridge.emit("qutty", "menu", { id: "close-tab" }, undefined, { retain: false });
  const again = await framesOf(await openEvents(bridge, "page-3"), sentinel);
  assertEquals(again.map((f) => f.event), ["state"]);
});

Deno.test("pullQueue: a (re)connect takes again, so a one-shot signal sent before it is not missed", async () => {
  const pending: unknown[] = [];
  let takes = 0;
  const rt = createFakeDesktopRuntime({
    app: {
      take: () => {
        takes++;
        // The first take answers empty, and a click lands right after it, its signal sent before
        // the page's stream connected (a one-shot signal: not replayed to the new connection).
        if (takes === 1) {
          queueMicrotask(() => pending.push({ source: "menu", id: "late" }));
          return [];
        }
        return pending.splice(0);
      },
    },
  });
  const restore = rt.install();
  try {
    const got: unknown[] = [];
    const stop = pullQueue("app", "action", (raw) => raw)((x) => got.push(x));
    await until(() => got.length === 1);
    assertEquals(got, [{ source: "menu", id: "late" }]);
    stop();
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
});
