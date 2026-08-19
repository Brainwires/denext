// Live Server Components — the <Live> boundary, the slice, and the WebSocket hub.
//
// Deno ships a real WebSocket + Deno.upgradeWebSocket, so the hub is exercised
// end-to-end in-process: a real client connects, subscribes a boundary, and a
// server-side revalidateTag pushes a patch back over the socket.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { FlightNode } from "../src/jsx/render-to-flight.ts";
import { renderToFlight } from "../src/jsx/render-to-flight.ts";
import { ID_PATH_PROP, prefixFromId } from "../src/jsx/tree-id.ts";
import { LIVE_REF_ID } from "../src/runtime/live-protocol.ts";
import { Live } from "../src/runtime/live-boundary.ts";
import {
  handleLiveUpgrade,
  installLiveHub,
  sliceBoundary,
  uninstallLiveHub,
} from "../src/server/live.ts";
import { revalidateTag } from "../src/server/cache.ts";
import { serializeFlightNav } from "../src/server/document.ts";
import { setLiveRegistrar } from "../src/runtime/live-registry.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// ---- sliceBoundary ---------------------------------------------------------

function liveNode(id: string, children: FlightNode[]): FlightNode {
  return { $: "c", i: LIVE_REF_ID, p: { [ID_PATH_PROP]: id }, c: children };
}

Deno.test("sliceBoundary finds a nested boundary's children by id", () => {
  const tree: FlightNode = {
    $: "h",
    t: "main",
    p: {},
    c: [
      { $: "h", t: "header", p: {}, c: ["nav"] },
      liveNode("0.2", [{ $: "h", t: "ul", p: {}, c: ["fresh"] }]),
    ],
  };
  const sliced = sliceBoundary(tree, "0.2");
  assertEquals(sliced, [{ $: "h", t: "ul", p: {}, c: ["fresh"] }]);
});

Deno.test("sliceBoundary returns null for an absent boundary", () => {
  const tree: FlightNode = liveNode("0.1", ["x"]);
  assertEquals(sliceBoundary(tree, "9.9"), null);
});

Deno.test("sliceBoundary ignores a non-Live client node with a matching id path", () => {
  const notLive: FlightNode = { $: "c", i: "c_app#Widget", p: { [ID_PATH_PROP]: "0.1" }, c: ["x"] };
  assertEquals(sliceBoundary(notLive, "0.1"), null);
});

// ---- boundaryId parity -----------------------------------------------------

Deno.test("<Live> emits an island whose id path is the boundary id the client derives", async () => {
  // Render a tree with a <Live> boundary through the Flight renderer. The emitted
  // client-ref node carries __dnxIdPath = the island's scope prefix — exactly what
  // the client <Live> recovers from its first useId() via prefixFromId.
  const flight = await renderToFlight(
    h("div", null, h(Live as Any, { tags: ["orders"] }, "content")),
  );
  // Walk to the Live node.
  const found = firstLiveNode(flight);
  assert(found, "a Live client-ref node was emitted");
  const idPath = (found.p as Record<string, unknown>)[ID_PATH_PROP] as string;
  assertEquals(typeof idPath, "string");
  // The client derives the same id from a useId() seeded at that prefix.
  assertEquals(prefixFromId(`:d${idPath}_0:`), idPath);
});

function firstLiveNode(node: FlightNode): { p: unknown; c: FlightNode[] } | null {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const c of node) {
      const f = firstLiveNode(c);
      if (f) return f;
    }
    return null;
  }
  if (node.$ === "c" && node.i === LIVE_REF_ID) return { p: node.p, c: node.c };
  if (node.$ === "h" || node.$ === "c") {
    for (const c of node.c) {
      const f = firstLiveNode(c);
      if (f) return f;
    }
  }
  return null;
}

// ---- WebSocket hub end-to-end ----------------------------------------------

Deno.test("hub pushes a boundary patch when a subscribed tag is invalidated", async () => {
  const boundaryId = "0.1";
  // A fake app handler returning a Flight payload with the boundary's fresh content.
  let sawNavHeader = false;
  const appHandler = (req: Request): Promise<Response> => {
    sawNavHeader = req.headers.get("x-denext-nav") === "1";
    const flight: FlightNode = liveNode(boundaryId, [{ $: "h", t: "p", p: {}, c: ["v2"] }]);
    const body = serializeFlightNav({ flight, data: {} as Any });
    return Promise.resolve(
      new Response(body, {
        headers: { "content-type": "application/json", "x-denext-flight": "1" },
      }),
    );
  };
  installLiveHub({ appHandler, originAllowed: () => true });

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    (req) => {
      if (new URL(req.url).pathname === "/_denext/live") return handleLiveUpgrade(req);
      return new Response("not found", { status: 404 });
    },
  );
  const { port } = server.addr as Deno.NetAddr;

  const patch = await new Promise<Any>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/_denext/live`);
    const timer = setTimeout(() => reject(new Error("no patch received")), 3000);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "subscribe",
        url: "/orders",
        boundaries: [{ id: boundaryId, tags: ["orders"] }],
      }));
      // Give the subscribe a tick to register, then invalidate the tag server-side.
      setTimeout(() => void revalidateTag("orders"), 50);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === "patch") {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
    };
    ws.onerror = () => reject(new Error("socket error"));
  });

  assertEquals(patch.boundaryId, boundaryId);
  assertEquals(patch.flight, [{ $: "h", t: "p", p: {}, c: ["v2"] }]);
  assert(sawNavHeader, "the re-render requested the Flight soft-nav payload");

  uninstallLiveHub();
  await server.shutdown();
});

// ---- <Live> client reconcile ----------------------------------------------

Deno.test("<Live> swaps only its subtree on a patch, and follows the parent on refresh", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let onPatch: ((children: Any) => void) | null = null;
  setLiveRegistrar((_id, _tags, cb) => {
    onPatch = cb;
    return () => {};
  });
  try {
    // `text` flows through props so a re-render genuinely changes the tree (a
    // closure variable would be invisible to the reconciler's bail-out).
    const App = ({ text }: { text: string }) => h(Live as Any, { tags: ["x"] }, h("p", null, text));
    const root = createRoot(container as Any);
    root.render(h(App as Any, { text: "v1" }));
    flushSync();
    assertEquals(container.textContent, "v1");

    // A pushed patch replaces just the boundary's children.
    onPatch!(h("p", null, "patched"));
    flushSync();
    assertEquals(container.textContent, "patched");

    // A parent refresh (new children identity) drops the stale patch.
    root.render(h(App as Any, { text: "v2" }));
    flushSync();
    assertEquals(container.textContent, "v2");
    root.unmount();
  } finally {
    setLiveRegistrar(null);
  }
});

Deno.test("hub rejects a disallowed-origin handshake", () => {
  installLiveHub({ appHandler: () => Promise.resolve(new Response()), originAllowed: () => false });
  const req = new Request("http://localhost/_denext/live", {
    headers: { upgrade: "websocket", origin: "http://evil.example" },
  });
  const res = handleLiveUpgrade(req);
  assertEquals(res.status, 403);
  uninstallLiveHub();
});
