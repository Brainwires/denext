// Lustre views over a real Live socket (`installLiveHub` + `handleLiveUpgrade`): the `lustre-*`
// frames reach the Lustre hub through the Live dispatch table, ride its guards (the frame-size
// cap), a second connection can't address the first one's view, a reconnect resumes the parked
// runtime, and `uninstallLiveHub` (what shutdown runs) stops every runtime.

import { assert, assertEquals } from "@std/assert";
import { signLiveViewToken } from "../src/runtime/live-view.ts";
import {
  handleLiveUpgrade,
  installLiveHub,
  lustreViewRuntimes,
  uninstallLiveHub,
} from "../src/server/live.ts";
import { setClientAddr } from "../src/server/remote-addr.ts";
import { defineLustreView, lustreServerKit } from "../src/gleam.ts";
import { lustreTokenName } from "../src/lustre/view.ts";
import { counterApp, fakeLustreServerModules } from "./helpers/fake-lustre-server.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

defineLustreView<number, { start: number }>({
  id: "socket-lustre-counter",
  kit: lustreServerKit(fakeLustreServerModules()),
  app: counterApp,
  flags: (props) => props.start,
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
      const waiter = this.waiters.find((w) => w.pred(frame));
      if (!waiter) return void this.frames.push(frame);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
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

const isLustre = (kind: number) => (f: Any) => f.type === "lustre" && f.msg?.kind === kind;

Deno.test("Lustre views over the socket: mount, events, the frame cap, isolation, resume, teardown", async () => {
  installLiveHub({
    appHandler: () => Promise.resolve(new Response("not used")),
    originAllowed: () => true,
    config: { limits: { maxMessageBytes: 4096 } },
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
  const token = await signLiveViewToken(lustreTokenName("socket-lustre-counter"), props);
  const mount = { type: "lustre-mount", view: "socket-lustre-counter", props, token };
  const click = (vid: string) => ({
    type: "lustre-event",
    vid,
    msg: { kind: 1, path: "0", name: "click", event: {} },
  });
  try {
    const a = new Client(`${base}?ip=203.0.113.5`);
    await a.opened;
    a.send({ ...mount, vid: "l1" });
    const first = await a.next(isLustre(0));
    assertEquals([first.vid, first.msg.vdom], ["l1", "1"]);
    a.send(click("l1"));
    assertEquals((await a.next(isLustre(1))).msg.patch, { text: "2" });

    // An event frame past live.limits.maxMessageBytes is refused before it is parsed.
    a.send({
      ...click("l1"),
      msg: { kind: 1, path: "0", name: "click", event: { v: "9".repeat(8000) } },
    });
    const refused = await a.next((f) => f.type === "error");
    assertEquals([refused.code, refused.reason], ["limit", "message too large"]);

    // Another connection naming `l1` addresses only its own views (it has none): nothing happens.
    const b = new Client(`${base}?ip=203.0.113.6`);
    await b.opened;
    b.send(click("l1"));
    b.send({ ...mount, vid: "l2" });
    assertEquals((await b.next(isLustre(0))).msg.vdom, "1", "b's own view");
    a.send(click("l1"));
    assertEquals((await a.next(isLustre(1))).msg.patch, { text: "3" }, "a's count, untouched by b");
    assertEquals(lustreViewRuntimes(), { running: 2, parked: 0 });

    // Close and reconnect: the parked runtime resumes with its model.
    a.ws.close();
    await a.closed;
    const c = new Client(`${base}?ip=203.0.113.7`);
    await c.opened;
    c.send({ ...mount, vid: "l9", resume: first.iid });
    const resumed = await c.next(isLustre(0));
    assertEquals([resumed.vid, resumed.iid, resumed.msg.vdom], ["l9", first.iid, "3"]);
    b.ws.close();
    c.ws.close();
    await Promise.all([b.closed, c.closed]);
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
  const after = lustreViewRuntimes();
  assert(after.running === 0 && after.parked === 0, JSON.stringify(after));
});
