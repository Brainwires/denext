// Who called a desktop bridge handler (`ctx.caller`, src/desktop/bridge.ts): the window's origin,
// the calling frame (main or sub, with its own origin; told by the runtime when it marks frames,
// else as the page reported it, unverified) and the window — in the memory world (the pinned
// runtime) and the loopback world (the stock runtime). Driven by `bridge.handle` with constructed
// requests; no `deno desktop` runtime and no window.

import { assert, assertEquals } from "@std/assert";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import type { DesktopCaller, DesktopCapability } from "../src/desktop/extension.ts";
import {
  DESKTOP_FRAME_HEADER,
  type DesktopServeInfo,
  type DesktopTrust,
  runtimeMarksFrames,
} from "../src/desktop/transport.ts";

const APP = "myapp://app";
const TOKEN = "caller-test-token-0123";
const MEMORY: DesktopTrust = { kind: "memory", origin: APP };
const MEM_INFO: DesktopServeInfo = { remoteAddr: { transport: "memory" } };
const LOOPBACK = "http://127.0.0.1:8000";

/** A capability that answers the caller it was handed. */
function whoami(seen: (DesktopCaller | undefined)[]): DesktopCapability {
  return {
    name: "who",
    methods: {
      am: {
        handler: (_args, ctx) => {
          seen.push(ctx.caller);
          return ctx.caller ?? null;
        },
      },
    },
  };
}

interface Call {
  base?: string;
  origin?: string | null;
  headers?: Record<string, string>;
}

async function callWho(
  bridge: ReturnType<typeof createDesktopBridge>,
  o: Call = {},
  info?: DesktopServeInfo,
): Promise<DesktopCaller> {
  const headers = new Headers(o.headers);
  headers.set("x-denext-desktop-token", TOKEN);
  headers.set("content-type", "application/json");
  if (o.origin !== null) headers.set("origin", o.origin ?? APP);
  const request = new Request(`${o.base ?? "http+memory://app"}/_denext/desktop/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({ cap: "who", method: "am", args: null }),
  });
  const res = await bridge.handle(request, new URL(request.url), TOKEN, info);
  assert(res);
  const body = await res.json();
  assert(body.ok, JSON.stringify(body));
  return body.data;
}

Deno.test("caller: a runtime that marks frames tells main from sub, verified", async () => {
  const seen: (DesktopCaller | undefined)[] = [];
  const bridge = createDesktopBridge([whoami(seen)], { trust: MEMORY, marksFrames: true });
  assertEquals(await callWho(bridge, { headers: { [DESKTOP_FRAME_HEADER]: "main" } }, MEM_INFO), {
    origin: APP,
    frame: { kind: "main", origin: APP, verified: true },
    window: "main",
  });
  // The runtime's mark wins over what the page says of itself.
  const sub = await callWho(bridge, {
    headers: { [DESKTOP_FRAME_HEADER]: "sub", "x-denext-desktop-frame": "main" },
  }, MEM_INFO);
  assertEquals(sub.frame, { kind: "sub", origin: APP, verified: true });
  // No Origin (the memory transport may omit it): the frame's origin is the window's.
  const bare = await callWho(
    bridge,
    { origin: null, headers: { [DESKTOP_FRAME_HEADER]: "SUB" } },
    MEM_INFO,
  );
  assertEquals(bare.frame, { kind: "sub", origin: APP, verified: true });
  // The handler got a frozen object.
  assert(Object.isFrozen(seen[0]) && Object.isFrozen(seen[0]!.frame));
});

Deno.test("caller: without frame marking the page's own report is unverified", async () => {
  const bridge = createDesktopBridge([whoami([])], { trust: MEMORY, marksFrames: false });
  // A forged runtime header is not read on a runtime that does not mark frames.
  const forged = await callWho(bridge, {
    headers: { [DESKTOP_FRAME_HEADER]: "main", "x-denext-desktop-frame": "sub" },
  }, MEM_INFO);
  assertEquals(forged.frame, { kind: "sub", origin: APP, verified: false });
  const nothing = await callWho(bridge, {}, MEM_INFO);
  assertEquals(nothing.frame, { kind: "unknown", origin: APP, verified: false });
  const junk = await callWho(bridge, { headers: { "x-denext-desktop-frame": "top" } }, MEM_INFO);
  assertEquals(junk.frame.kind, "unknown");
});

Deno.test("caller: the loopback world's origin, and the calling window", async () => {
  const bridge = createDesktopBridge([whoami([])], {
    marksFrames: false,
    resolveWindow: (token) => token === "w2-token" ? "window-2" : undefined,
  });
  const caller = await callWho(bridge, {
    base: LOOPBACK,
    origin: LOOPBACK,
    headers: { "x-denext-desktop-window": "w2-token", "x-denext-desktop-frame": "main" },
  });
  assertEquals(caller, {
    origin: LOOPBACK,
    frame: { kind: "main", origin: LOOPBACK, verified: false },
    window: "window-2",
  });
});

Deno.test("caller: over loopback a runtime frame header is never trusted, marking or not", async () => {
  // The loopback connection carries whatever headers the page sets, so a subframe holding the
  // page token could claim the runtime's "main" mark: only the memory connection is marked.
  const bridge = createDesktopBridge([whoami([])], { marksFrames: true });
  const forged = await callWho(bridge, {
    base: LOOPBACK,
    origin: LOOPBACK,
    headers: { [DESKTOP_FRAME_HEADER]: "main", "x-denext-desktop-frame": "sub" },
  });
  assertEquals(forged.frame, { kind: "sub", origin: LOOPBACK, verified: false });
  const bare = await callWho(bridge, {
    base: LOOPBACK,
    origin: LOOPBACK,
    headers: { [DESKTOP_FRAME_HEADER]: "main" },
  });
  assertEquals(bare.frame, { kind: "unknown", origin: LOOPBACK, verified: false });
});

Deno.test("runtimeMarksFrames: only Deno.desktop.marksFrames === true", () => {
  assertEquals(runtimeMarksFrames({ marksFrames: true }), true);
  for (const desktop of [undefined, null, {}, { marksFrames: "yes" }, { marksFrames: false }]) {
    assertEquals(runtimeMarksFrames(desktop), false, JSON.stringify(desktop));
  }
  const throwing = {
    get marksFrames(): never {
      throw new Error("no");
    },
  };
  assertEquals(runtimeMarksFrames(throwing), false);
});
