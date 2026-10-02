// `ctx.runOnMainThread` (G.10): a `defineDesktopExtension` handler reaches the pinned runtime's
// `Deno.desktop.runOnMainThread` through its context. On a runtime without it (the stock one, a
// plain `deno run`, this test process) it rejects `unsupported`, which the bridge answers as that
// code; with a (stubbed) runtime it passes the function and context through unchanged and resolves
// with the native return value. The real UI-thread hop is proven by the kitchen sink's window test.

import { assertEquals, assertRejects } from "@std/assert";
import { createDesktopBridge, runOnDesktopMainThread } from "../src/desktop/bridge.ts";
import { defineDesktopExtension, DesktopCapError } from "../src/desktop/extension.ts";

const ORIGIN = "http://127.0.0.1:8000";
const TOKEN = "test-token-1234";

/** Run `fn` with `Deno.desktop` replaced by `desktop` (or removed), restoring it afterwards. */
async function withDesktop(desktop: unknown, fn: () => Promise<void>): Promise<void> {
  const had = Object.getOwnPropertyDescriptor(Deno, "desktop");
  Object.defineProperty(Deno, "desktop", { value: desktop, configurable: true });
  try {
    await fn();
  } finally {
    if (had) Object.defineProperty(Deno, "desktop", had);
    else delete (Deno as unknown as { desktop?: unknown }).desktop;
  }
}

/** An extension whose one method calls `ctx.runOnMainThread` and returns the result as a string. */
const probe = defineDesktopExtension({
  name: "mainThreadProbe",
  methods: {
    call: {
      handler: async (_args, ctx) => {
        const fn = Deno.UnsafePointer.create(0x1234n)!;
        return String(await ctx.runOnMainThread(fn, Deno.UnsafePointer.create(7n)));
      },
    },
  },
});

async function callProbe(): Promise<{ status: number; env: Record<string, unknown> }> {
  const bridge = createDesktopBridge([probe]);
  const req = new Request(`${ORIGIN}/_denext/desktop/rpc`, {
    method: "POST",
    headers: {
      "x-denext-desktop-token": TOKEN,
      origin: ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cap: "mainThreadProbe", method: "call", args: {} }),
  });
  const res = await bridge.handle(req, new URL(req.url), TOKEN);
  return { status: res!.status, env: await res!.json() };
}

Deno.test("runOnMainThread: without the pinned runtime it rejects unsupported", async () => {
  for (const desktop of [undefined, {}, { runOnMainThread: "nope" }]) {
    await withDesktop(desktop, async () => {
      const err = await assertRejects(
        () => runOnDesktopMainThread(Deno.UnsafePointer.create(1n)!),
        DesktopCapError,
      );
      assertEquals(err.code, "unsupported");
      assertEquals(err.status, 501);
      const { status, env } = await callProbe();
      assertEquals(status, 501);
      assertEquals((env.error as { code: string }).code, "unsupported");
    });
  }
});

Deno.test("runOnMainThread: passes fn and context to Deno.desktop.runOnMainThread", async () => {
  const calls: unknown[][] = [];
  const desktop = {
    runOnMainThread: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(42n);
    },
  };
  await withDesktop(desktop, async () => {
    const fn = Deno.UnsafePointer.create(0x99n)!;
    assertEquals(await runOnDesktopMainThread(fn), 42n);
    assertEquals(calls[0].length, 1, "no context → the runtime's default (null)");
    assertEquals(calls[0][0], fn);
    assertEquals(await runOnDesktopMainThread(fn, null), 42n);
    assertEquals(calls[1], [fn, null]);
    const { status, env } = await callProbe();
    assertEquals(status, 200);
    assertEquals(env.data, "42");
    assertEquals(Deno.UnsafePointer.value(calls[2][0] as Deno.PointerObject), 0x1234n);
    assertEquals(Deno.UnsafePointer.value(calls[2][1] as Deno.PointerObject), 7n);
  });
});

Deno.test("runOnMainThread: a quitting runtime's rejection reaches the handler", async () => {
  const desktop = {
    runOnMainThread: () => Promise.reject(new Error("the app is quitting")),
  };
  await withDesktop(desktop, async () => {
    await assertRejects(
      () => runOnDesktopMainThread(Deno.UnsafePointer.create(1n)!),
      Error,
      "quitting",
    );
    const { status, env } = await callProbe();
    assertEquals(status, 500);
    assertEquals((env.error as { code: string }).code, "internal");
  });
});
