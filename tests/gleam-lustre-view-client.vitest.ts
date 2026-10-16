// The browser half of Lustre views (`src/lustre/view-client.ts`) over a fake WebSocket: the mount
// frame, Lustre's reconciler mounting the server's whole view (root emptied first) and applying
// its patches, the reconciler's events going out as Lustre's `EventFired` with the event's data
// picked as Lustre's own client does, a patch that fails asking for the whole view again, `emit`
// becoming a DOM event, `gone` re-rendering the route once, a refusal ending the view, and a
// reconnect re-mounting with the instance id. Each test imports fresh module instances
// (`vi.resetModules()`), which a plain `Deno.test` file cannot do.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket, LIVE_TEST_LOCATION } from "./helpers/fake-websocket.ts";

const latest = () => FakeWebSocket.all.at(-1)!;

type ViewClient = typeof import("../src/lustre/view-client.ts");
type LiveClient = typeof import("../src/client/live-client.ts");

let lustre: ViewClient;
let live: LiveClient;
let refreshes = 0;

/** What a fake reconciler saw, and the hooks Lustre's real one would call. */
interface Seen {
  root: unknown;
  mounted: unknown[];
  pushed: unknown[];
  decode: (event: Event, path: string, name: string, include?: string[]) => unknown;
  dispatch: (event: Event, data: unknown) => void;
}

let reconcilers: Seen[] = [];
let failPush = false;

class FakeReconciler {
  seen: Seen;
  constructor(
    root: unknown,
    decode: Seen["decode"],
    dispatch: Seen["dispatch"],
  ) {
    this.seen = { root, mounted: [], pushed: [], decode, dispatch };
    reconcilers.push(this.seen);
  }
  mount(vdom: unknown) {
    this.seen.mounted.push(vdom);
  }
  push(patch: unknown) {
    if (failPush) throw new Error("no such node");
    this.seen.pushed.push(patch);
  }
}

/** A view root: an event target with the contents Lustre's mount replaces. */
class Root extends EventTarget {
  textContent = "<p>server html</p>";
}

beforeEach(async () => {
  FakeWebSocket.all = [];
  refreshes = 0;
  reconcilers = [];
  failPush = false;
  for (
    const [name, value] of Object.entries({
      WebSocket: FakeWebSocket,
      location: LIVE_TEST_LOCATION,
    })
  ) {
    vi.stubGlobal(name, value);
  }
  vi.resetModules();
  [live, lustre] = await Promise.all([
    import("../src/client/live-client.ts"),
    import("../src/lustre/view-client.ts"),
  ]);
  live.configureLive({ parse: () => null, refresh: () => void refreshes++ });
});

afterEach(() => vi.unstubAllGlobals());

/** What the island mounts the view with. */
const spec = { view: "counter", token: "tok", props: '{"start":1}' };
const mountMsg = (vdom: unknown, iid = "inst-1") => ({
  type: "lustre",
  vid: "l1",
  iid,
  msg: { kind: 0, vdom },
});

/** Mount the spec's view and answer with the server's mount: the open socket. */
function mounted(): FakeWebSocket {
  lustre.mountLustreView(spec, new Root() as unknown as Element, FakeReconciler);
  const ws = latest();
  ws.open();
  ws.server(mountMsg({}));
  return ws;
}

describe("Lustre view client", () => {
  it("mounts over the socket; the server's mount empties the root and Lustre's reconciler renders it", () => {
    const root = new Root();
    const mounted: string[] = [];
    root.addEventListener("lustre:mount", () => mounted.push("mount"));
    lustre.mountLustreView(spec, root as unknown as Element, FakeReconciler);
    const ws = latest();
    ws.open();
    expect(ws.frames()).toEqual([
      { type: "lustre-mount", vid: "l1", view: "counter", props: '{"start":1}', token: "tok" },
    ]);
    ws.server(mountMsg({ tag: "div" }));
    expect(root.textContent).toBe("");
    expect(reconcilers).toHaveLength(1);
    expect(reconcilers[0].root).toBe(root);
    expect(reconcilers[0].mounted).toEqual([{ tag: "div" }]);
    expect(mounted).toEqual(["mount"]);

    ws.server({ type: "lustre", vid: "l1", msg: { kind: 1, patch: { changes: [1] } } });
    expect(reconcilers[0].pushed).toEqual([{ changes: [1] }]);
  });

  it("sends the reconciler's events as Lustre's EventFired, with the event's data", () => {
    const ws = mounted();
    const { decode, dispatch } = reconcilers[0];
    const input = { type: "input", target: { type: "text", value: "hi" } } as unknown as Event;
    const data = decode(input, "0\t3", "input", ["target.id"]);
    expect(data).toEqual({
      kind: 1,
      path: "0\t3",
      name: "input",
      event: { target: { id: undefined, value: "hi" } },
    });
    dispatch(input, data);
    expect(ws.frames().at(-1)).toEqual({ type: "lustre-event", vid: "l1", msg: data });
  });

  it("picks event data as Lustre's own client does", () => {
    mounted();
    const pick = (e: unknown, include?: string[]) =>
      (reconcilers[0].decode(e as Event, "0", "x", include) as { event: unknown }).event;
    expect(pick({ type: "change", target: { type: "checkbox", checked: true } })).toEqual({
      target: { checked: true },
    });
    expect(pick({ type: "keydown", key: "Enter" })).toEqual({ key: "Enter" });
    expect(pick({ type: "submit", detail: { formData: [["a", "1"]] } })).toEqual({
      detail: { formData: [["a", "1"]] },
    });
    expect(pick({ type: "my-event", isLustreEvent: true, detail: { n: 1 } })).toEqual({
      detail: { n: 1 },
    });
    expect(pick({ type: "click", clientX: 4 }, ["clientX"])).toEqual({ clientX: 4 });
    expect(pick({ type: "click" })).toEqual({});
    expect(pick({ type: "toString" })).toEqual({}, "no prototype lookups");
  });

  it("a patch that does not apply asks for the whole view again", () => {
    const ws = mounted();
    failPush = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ws.server({ type: "lustre", vid: "l1", msg: { kind: 1, patch: {} } });
    expect(ws.frames().at(-1)).toEqual({ type: "lustre-resync", vid: "l1" });
    warn.mockRestore();
    failPush = false;
    ws.server(mountMsg({ again: true }));
    expect(reconcilers).toHaveLength(2);
    expect(reconcilers[1].mounted).toEqual([{ again: true }]);
  });

  it("emit becomes a DOM event on the root", () => {
    const root = new Root();
    const got: unknown[] = [];
    root.addEventListener("saved", (e) => got.push((e as CustomEvent).detail));
    lustre.mountLustreView(spec, root as unknown as Element, FakeReconciler);
    const ws = latest();
    ws.open();
    ws.server({ type: "lustre", vid: "l1", msg: { kind: 2, name: "saved", data: { id: 3 } } });
    expect(got).toEqual([{ id: 3 }]);
  });

  it("re-mounts with the instance id on reconnect; events wait for the re-mount", () => {
    vi.useFakeTimers();
    try {
      lustre.mountLustreView(spec, new Root() as unknown as Element, FakeReconciler);
      const first = latest();
      first.open();
      first.server(mountMsg({}, "inst-7"));
      const { dispatch } = reconcilers[0];
      first.drop();
      dispatch({} as Event, { kind: 1, path: "0", name: "click", event: {} }); // socket down
      vi.advanceTimersByTime(500);
      const second = latest();
      expect(second).not.toBe(first);
      second.open();
      expect(second.frames()).toEqual([{
        type: "lustre-mount",
        vid: "l1",
        view: "counter",
        props: '{"start":1}',
        token: "tok",
        resume: "inst-7",
      }]);
      // Until the server answers the re-mount, events are not sent (their paths may be stale).
      dispatch({} as Event, { kind: 1, path: "0", name: "click", event: {} });
      expect(second.frames()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("`gone` re-renders the route once; a refusal ends the view; unmount tells the server", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = lustre.mountLustreView(spec, new Root() as unknown as Element, FakeReconciler);
    const ws = latest();
    ws.open();
    ws.server({ type: "error", code: "gone", subId: "l1", reason: "view unavailable" });
    ws.server({ type: "error", code: "gone", subId: "l1", reason: "view unavailable" });
    expect(refreshes).toBe(1);
    handle.unmount();
    expect(ws.frames().at(-1)).toEqual({ type: "lustre-unmount", vid: "l1" });

    vi.useFakeTimers();
    try {
      lustre.mountLustreView(spec, new Root() as unknown as Element, FakeReconciler);
      const ws2 = latest();
      ws2.open();
      ws2.server({ type: "error", code: "denied", subId: "l2", reason: "view not permitted" });
      ws2.drop();
      vi.advanceTimersByTime(500);
      const ws3 = latest();
      expect(ws3).not.toBe(ws2);
      ws3.open();
      expect(ws3.types()).not.toContain("lustre-mount");
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});
