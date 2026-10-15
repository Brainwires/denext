// Live views over a real Live socket (`installLiveHub` + `handleLiveUpgrade`): the view frames
// ride the hub's own guards — the connection caps, the inbound frame-size cap — and a reconnect
// resumes the server-held model.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { defineLiveView, signLiveViewToken } from "../src/runtime/live-view.ts";
import { handleLiveUpgrade, installLiveHub, uninstallLiveHub } from "../src/server/live.ts";
import { setClientAddr } from "../src/server/remote-addr.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

let updates = 0;

defineLiveView<{ n: number }, { type: "inc" } | { type: "set"; to: string }, { start: number }>({
  id: "socket-counter",
  init: (props) => [{ n: props.start }],
  update: (msg, m) => {
    updates++;
    return msg.type === "inc" ? [{ n: m.n + 1 }] : [{ n: Number(msg.to) }];
  },
  view: (m, send) =>
    h(
      "div",
      null,
      h("p", null, `n=${m.n}`),
      h("button", { onClick: send({ type: "inc" }) }, "+"),
      h("input", { onInput: send((p) => ({ type: "set", to: p.value ?? "" })) }),
    ),
});

/** A socket that collects frames and hands out the next one matching a predicate. */
class Client {
  frames: Any[] = [];
  waiters: Array<{ pred: (f: Any) => boolean; resolve: (f: Any) => void }> = [];
  ws: WebSocket;
  opened: Promise<void>;
  closed: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("socket error"));
    });
    this.closed = new Promise((resolve) => (this.ws.onclose = () => resolve()));
    this.ws.onmessage = (ev) => {
      const frame = JSON.parse(ev.data as string);
      this.frames.push(frame);
      for (const w of [...this.waiters]) {
        if (w.pred(frame)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(frame);
        }
      }
    };
  }
  next(pred: (f: Any) => boolean): Promise<Any> {
    const seen = this.frames.find(pred);
    if (seen) {
      this.frames.splice(this.frames.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }
  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }
}

Deno.test("live views over the socket: patches, the frame-size cap, connection caps and resume", async () => {
  installLiveHub({
    appHandler: () => Promise.resolve(new Response("not used")),
    originAllowed: () => true,
    config: { limits: { maxConnectionsPerIp: 1, maxMessageBytes: 4096 } },
  });
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/_denext/live") return new Response("not found", { status: 404 });
    const ip = url.searchParams.get("ip") ?? undefined;
    setClientAddr(req, ip, ip);
    return handleLiveUpgrade(req);
  });
  const base = `ws://localhost:${(server.addr as Deno.NetAddr).port}/_denext/live`;
  const props = JSON.stringify({ start: 1 });
  const token = await signLiveViewToken("socket-counter", props);
  const mount = { type: "view-mount", view: "socket-counter", props, token };
  try {
    const a = new Client(`${base}?ip=203.0.113.5`);
    await a.opened;
    a.send({ ...mount, vid: "v1" });
    const first = await a.next((f) => f.type === "view-render");
    assertEquals(first.flight[0].c[0].c, ["n=1"]);

    a.send({ type: "view-event", vid: "v1", rev: first.rev, h: 0 });
    const patch = await a.next((f) => f.type === "view-patch");
    assertEquals(patch.ops, [["r", [0, 0, 0], "n=2"]]);

    // An event frame past live.limits.maxMessageBytes is refused before it is parsed.
    const before = updates;
    a.send({
      type: "view-event",
      vid: "v1",
      rev: patch.rev,
      h: 1,
      payload: { value: "9".repeat(8000) },
    });
    const refused = await a.next((f) => f.type === "error");
    assertEquals([refused.code, refused.reason], ["limit", "message too large"]);
    assertEquals(updates, before, "update never saw the oversized event");

    // The same address can't open a second socket (live.limits.maxConnectionsPerIp).
    const second = new Request(`http://localhost${"/_denext/live"}`, {
      headers: { upgrade: "websocket" },
    });
    setClientAddr(second, "203.0.113.5", "203.0.113.5");
    assertEquals((await handleLiveUpgrade(second)).status, 429);

    // Close and reconnect (from another address): the parked model resumes.
    a.ws.close();
    await a.closed;
    const b = new Client(`${base}?ip=203.0.113.6`);
    await b.opened;
    b.send({ ...mount, vid: "v9", resume: first.iid });
    const resumed = await b.next((f) => f.type === "view-render");
    assertEquals(resumed.flight[0].c[0].c, ["n=2"]);
    assertEquals(resumed.vid, "v9");
    b.ws.close();
    await b.closed;
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});
