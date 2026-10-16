// The browser half of live views (`src/client/live-view-client.ts` + the `denext#LiveView`
// island) over a fake WebSocket: the mount frame, events held until the first render and then
// sent with its revision, patches applied (or a resync when they don't fit), `gone` re-rendering
// the route once, and a reconnect re-mounting with the instance id so the server resumes the
// model. Each test imports fresh module instances (`vi.resetModules()`), which a plain
// `Deno.test` file cannot do.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "./helpers/fake-websocket.ts";

const latest = () => FakeWebSocket.all.at(-1)!;

type ViewClient = typeof import("../src/client/live-view-client.ts");
type LiveClient = typeof import("../src/client/live-client.ts");

let views: ViewClient;
let live: LiveClient;
let refreshes = 0;

beforeEach(async () => {
  FakeWebSocket.all = [];
  refreshes = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", {
    protocol: "http:",
    host: "localhost:8000",
    href: "http://localhost:8000/",
  });
  vi.resetModules();
  live = await import("../src/client/live-client.ts");
  views = await import("../src/client/live-view-client.ts");
  // The parser the Flight entry installs: here, the Flight tree itself stands in for VNodes.
  live.configureLive({ parse: (flight) => flight as never, refresh: () => refreshes++ });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const spec = { view: "counter", props: '{"start":1}', token: "tok" };
const tree = (n: number) => [{ $: "h", t: "p", p: {}, c: [`n=${n}`] }];

describe("live view client", () => {
  it("mounts on open, holds events until the first render, then sends them at its revision", async () => {
    const trees: unknown[] = [];
    const handle = views.mountLiveView(spec, { onTree: (t) => trees.push(t) });
    const ws = latest();
    ws.open();
    expect(ws.frames()).toEqual([
      { type: "view-mount", vid: "v1", view: "counter", props: '{"start":1}', token: "tok" },
    ]);
    handle.event(0, {});
    expect(ws.frames().length).toBe(1); // held: the server is still running init
    ws.server({ type: "view-render", vid: "v1", rev: 4, flight: tree(1), iid: "inst-1" });
    await Promise.resolve();
    await Promise.resolve();
    expect(trees).toEqual([tree(1)]);
    expect(ws.frames().at(-1)).toEqual({
      type: "view-event",
      vid: "v1",
      rev: 4,
      h: 0,
      payload: {},
    });

    ws.server({ type: "view-patch", vid: "v1", base: 4, rev: 5, ops: [["r", [0, 0], "n=2"]] });
    await vi.waitFor(() => expect(trees.length).toBe(2));
    expect(trees[1]).toEqual(tree(2));
    handle.event(0, { value: "x" });
    expect(ws.frames().at(-1)).toMatchObject({
      type: "view-event",
      rev: 5,
      payload: { value: "x" },
    });

    handle.unmount();
    expect(ws.frames().at(-1)).toEqual({ type: "view-unmount", vid: "v1" });
  });

  it("asks for a resync when a patch does not apply to what it holds", () => {
    views.mountLiveView(spec, { onTree: () => {} });
    const ws = latest();
    ws.open();
    ws.server({ type: "view-render", vid: "v1", rev: 1, flight: tree(1), iid: "i" });
    ws.server({ type: "view-patch", vid: "v1", base: 7, rev: 8, ops: [] }); // a base it never had
    expect(ws.frames().at(-1)).toEqual({ type: "view-resync", vid: "v1" });
    ws.server({ type: "view-patch", vid: "v1", base: 1, rev: 2, ops: [["r", [9], "x"]] });
    expect(ws.frames().at(-1)).toEqual({ type: "view-resync", vid: "v1" });
  });

  it("re-renders the route once when the server says the view is gone", () => {
    const errors: string[] = [];
    views.mountLiveView(spec, { onTree: () => {}, onError: (e) => errors.push(e.code) });
    const ws = latest();
    ws.open();
    ws.server({ type: "error", code: "gone", subId: "v1" });
    ws.server({ type: "error", code: "gone", subId: "v1" });
    expect(refreshes).toBe(1);
    expect(errors).toEqual(["gone", "gone"]);
  });

  it("re-mounts with the instance id after a reconnect, holding events meanwhile", () => {
    vi.useFakeTimers();
    try {
      const handle = views.mountLiveView(spec, { onTree: () => {} });
      const first = latest();
      first.open();
      first.server({ type: "view-render", vid: "v1", rev: 3, flight: tree(1), iid: "inst-9" });
      first.drop();
      handle.event(0, {}); // the socket is down: held
      vi.advanceTimersByTime(500);
      const second = latest();
      expect(second).not.toBe(first);
      second.open();
      expect(second.frames()[0]).toMatchObject({ type: "view-mount", vid: "v1", resume: "inst-9" });
      second.server({ type: "view-render", vid: "v1", rev: 4, flight: tree(1), iid: "inst-9" });
      expect(second.frames().at(-1)).toMatchObject({ type: "view-event", rev: 4, h: 0 });
      handle.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops re-mounting a view the server refused", () => {
    vi.useFakeTimers();
    try {
      views.mountLiveView(spec, { onTree: () => {} });
      const first = latest();
      first.open();
      first.server({ type: "error", code: "denied", subId: "v1", reason: "nope" });
      first.drop();
      vi.advanceTimersByTime(500);
      const second = latest();
      second.open();
      expect(second.frames().some((f) => f.type === "view-mount")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("live view island", () => {
  it("binds handler references to listeners that send the index and the event payload", async () => {
    const { render } = await import("../src/testing/mod.ts");
    const { h } = await import("../src/jsx/jsx-runtime.ts");
    const { LiveViewIsland } = await import("../src/client/live-view-island.ts");
    const screen = await render(
      h(LiveViewIsland, { ...spec }, h("button", { onClick: { __dnxlv: 2 } }, "+")),
    );
    const ws = latest();
    ws.open();
    ws.server({
      type: "view-render",
      vid: "v1",
      rev: 1,
      flight: [h("button", { onClick: { __dnxlv: 2 } }, "pushed")],
      iid: "i",
    });
    await vi.waitFor(() => expect(screen.container.textContent).toBe("pushed"));
    await screen.fireEvent.click(screen.getByRole("button"));
    expect(ws.frames().at(-1)).toEqual({
      type: "view-event",
      vid: "v1",
      rev: 1,
      h: 2,
      payload: {},
    });
    await screen.unmount();
    expect(ws.frames().at(-1)).toEqual({ type: "view-unmount", vid: "v1" });
  });
});
