// The page side of the window capability (`denext/desktop/window`) and the rich clipboard of
// `denext/mobile` (`readClipboard({ format })`, `writeClipboard(content)`, `clipboardFormats`):
// driven through the fake runtime gate (tests/helpers/desktop-fake-runtime.ts), and off desktop
// against fake `navigator.clipboard` / `ClipboardItem`.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  closeWindow,
  getScreens,
  getWindowState,
  makeWindowDraggable,
  maximizeWindow,
  onCloseRequested,
  onDisplayChanged,
  onFileDrop,
  onWindowStateChange,
  quitApp,
  setFullScreen,
  setMinimumWindowSize,
  setTitleBarStyle,
  setWindowBackdrop,
  setWindowBounds,
  startFileDrag,
  windowCapabilities,
} from "../src/desktop/window.ts";
import { clipboardFormats, readClipboard, writeClipboard } from "../src/mobile/clipboard.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { isDesktopBridgeError } from "../src/desktop/client.ts";
import {
  createFakeDesktopRuntime,
  type FakeMethod,
  until,
} from "./helpers/desktop-fake-runtime.ts";
import { withGlobals } from "./helpers/mobile-fakes.ts";

type Rt = ReturnType<typeof createFakeDesktopRuntime>;

/** Run `fn` in a fake desktop window with `caps` enabled. */
async function inDesktop(
  caps: Record<string, Record<string, FakeMethod>>,
  fn: (rt: Rt) => Promise<void>,
): Promise<void> {
  const rt = createFakeDesktopRuntime(caps);
  const restore = rt.install();
  try {
    await fn(rt);
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
}

const calls = (rt: Rt) => rt.calls.map((c) => `${c.cap}.${c.method}`);

const STATE = {
  maximized: true,
  minimized: false,
  fullscreen: false,
  visible: true,
  bounds: { x: 1, y: 2, width: 800, height: 600 },
  contentBounds: null,
  normalBounds: null,
  screen: null,
  minimumSize: [0, 0],
  maximumSize: [0, 0],
};

Deno.test("window client: calls carry their arguments; results are shaped", async () => {
  await inDesktop({
    window: {
      capabilities: () => ({ state: true, closeGuard: true }),
      state: () => STATE,
      maximize: () => null,
      setFullScreen: () => null,
      setBounds: () => null,
      setMinimumSize: () => null,
      setTitleBarStyle: () => ({ applied: true }),
      setBackdrop: () => ({ applied: false }),
      screens: () => [{ id: 1 }],
    },
  }, async (rt) => {
    assertEquals((await windowCapabilities()).closeGuard, true);
    assertEquals((await getWindowState()).maximized, true);
    await maximizeWindow();
    await setFullScreen(true);
    await setWindowBounds({ x: 5, width: 900 });
    await setMinimumWindowSize(400, 300);
    assertEquals(await setTitleBarStyle("hidden"), true);
    assertEquals(await setWindowBackdrop("vibrancy", { material: "sidebar" }), false);
    assertEquals((await getScreens()).length, 1);
    assertEquals(rt.calls.map((c) => c.args), [
      {},
      {},
      {},
      { fullscreen: true },
      { x: 5, width: 900 },
      { width: 400, height: 300 },
      { style: "hidden" },
      { backdrop: "vibrancy", material: "sidebar" },
      {},
    ]);
  });
});

Deno.test("window client: off desktop every call rejects unavailable without a request", async () => {
  const prev = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (input) => {
    urls.push(String(input));
    return Promise.reject(new Error("offline"));
  };
  try {
    const err = await assertRejects(() => maximizeWindow());
    assert(isDesktopBridgeError(err) && err.code === "unavailable");
    const stop = onCloseRequested(() => false);
    stop();
    onFileDrop(() => {})();
    assertEquals(urls, []);
  } finally {
    globalThis.fetch = prev;
  }
});

Deno.test("window client: state and display signals re-read the current values", async () => {
  await inDesktop({
    window: { state: () => STATE, screens: () => [{ id: 7 }] },
  }, async (rt) => {
    const states: unknown[] = [];
    const screens: unknown[] = [];
    const a = onWindowStateChange((s) => states.push(s.maximized));
    const b = onDisplayChanged((s) => screens.push(s[0]));
    rt.emit("window", "state", null);
    rt.emit("window", "display", null);
    await until(() => states.length === 1 && screens.length === 1);
    assertEquals(states, [true]);
    assertEquals(screens, [{ id: 7 }]);
    a();
    b();
  });
});

Deno.test("window client: onCloseRequested guards, acks, then answers with the handlers' verdict", async () => {
  let current = true;
  const responses: unknown[] = [];
  await inDesktop({
    window: {
      setCloseGuard: () => null,
      closeAck: () => ({ current }),
      closeRespond: (args) => {
        responses.push(args);
        return { closing: (args as { close: boolean }).close };
      },
    },
  }, async (rt) => {
    let answer: boolean | undefined = false;
    const stopA = onCloseRequested(() => answer);
    const stopB = onCloseRequested(async () => {
      await Promise.resolve();
    });
    await until(() => calls(rt).includes("window.setCloseGuard"));
    assertEquals(rt.calls.filter((c) => c.method === "setCloseGuard").length, 1, "once");
    rt.emit("window", "closeRequested", { id: "r1" });
    await until(() => responses.length === 1);
    assertEquals(responses[0], { id: "r1", close: false });
    answer = undefined;
    rt.emit("window", "closeRequested", { id: "r2" });
    await until(() => responses.length === 2);
    assertEquals(responses[1], { id: "r2", close: true });
    // A replayed request that is no longer current runs no handler and sends no answer.
    current = false;
    rt.emit("window", "closeRequested", { id: "r1" });
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(responses.length, 2);
    stopA();
    assert(
      !rt.calls.some((c) => c.method === "setCloseGuard" && (c.args as Any).enabled === false),
    );
    stopB();
    await until(() =>
      rt.calls.some((c) => c.method === "setCloseGuard" && (c.args as Any).enabled === false)
    );
  });
});

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("window client: a throwing close handler keeps the window open", async () => {
  const responses: unknown[] = [];
  const errors = console.error;
  console.error = () => {};
  try {
    await inDesktop({
      window: {
        setCloseGuard: () => null,
        closeAck: () => ({ current: true }),
        closeRespond: (args) => void responses.push(args),
      },
    }, async (rt) => {
      const stop = onCloseRequested(() => {
        throw new Error("boom");
      });
      rt.emit("window", "closeRequested", { id: "x" });
      await until(() => responses.length === 1);
      assertEquals(responses[0], { id: "x", close: false });
      stop();
    });
  } finally {
    console.error = errors;
  }
});

Deno.test("window client: closeWindow / quitApp", async () => {
  await inDesktop({
    window: { close: () => null, quit: () => ({ quitting: false }) },
  }, async (rt) => {
    await closeWindow();
    assertEquals(await quitApp(), false);
    assertEquals(calls(rt), ["window.close", "window.quit"]);
  });
});

Deno.test("window client: onFileDrop takes the queue on each signal", async () => {
  let queue: unknown[] = [{
    x: 3,
    y: 4,
    files: [
      { handle: "h1", name: "a.txt", path: "/a.txt", kind: "file", size: 2 },
      { handle: "", name: "bad" },
    ],
  }];
  await inDesktop({
    window: {
      takeDrops: () => {
        const out = queue;
        queue = [];
        return out;
      },
    },
  }, async (rt) => {
    const drops: unknown[] = [];
    const stop = onFileDrop((d) => drops.push(d));
    rt.emit("window", "drop", null);
    await until(() => drops.length === 1);
    assertEquals(drops[0], {
      x: 3,
      y: 4,
      files: [{ handle: "h1", name: "a.txt", path: "/a.txt", kind: "file", size: 2 }],
    });
    // A replayed signal finds the queue empty.
    rt.emit("window", "drop", null);
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(drops.length, 1);
    stop();
  });
});

Deno.test("window client: startFileDrag sends handles / app-folder items, no timeout", async () => {
  await inDesktop({
    window: { startDrag: () => ({ result: "cancelled" }) },
  }, async (rt) => {
    const result = await startFileDrag([
      { directory: { picked: "h1" } },
      { directory: "cache", path: "out/r.pdf" },
    ], { icon: "iVBO" });
    assertEquals(result, "cancelled");
    assertEquals(rt.calls[0].args, {
      items: [{ directory: { picked: "h1" } }, { directory: "cache", path: "out/r.pdf" }],
      icon: "iVBO",
    });
  });
});

/** A fake element recording style and listeners. */
function fakeElement() {
  const style = new Map<string, string>();
  const listeners = new Map<string, (e: Event) => void>();
  const captured: number[] = [];
  return {
    style: {
      setProperty: (k: string, v: string) => void style.set(k, v),
      removeProperty: (k: string) => void style.delete(k),
    },
    addEventListener: (t: string, fn: (e: Event) => void) => void listeners.set(t, fn),
    removeEventListener: (t: string) => void listeners.delete(t),
    setPointerCapture: (id: number) => void captured.push(id),
    releasePointerCapture: () => {},
    fire: (t: string, init: Record<string, unknown>) =>
      listeners.get(t)?.({ target: null, ...init } as unknown as Event),
    styleMap: style,
    listeners,
    captured,
  };
}

Deno.test("makeWindowDraggable: CSS app-region always; the WebKit path moves the window", async () => {
  await inDesktop({
    window: { state: () => STATE, setPosition: () => null },
  }, async (rt) => {
    await withGlobals(
      { navigator: { userAgent: "Mozilla/5.0 AppleWebKit/605.1.15" } },
      async () => {
        const el = fakeElement();
        const undo = makeWindowDraggable(el);
        assertEquals(el.styleMap.get("app-region"), "drag");
        el.fire("pointerdown", { button: 0, pointerId: 1, screenX: 100, screenY: 100 });
        await until(() => calls(rt).includes("window.state"));
        await new Promise((r) => setTimeout(r, 10));
        el.fire("pointermove", { pointerId: 1, screenX: 130, screenY: 90 });
        await until(() => calls(rt).includes("window.setPosition"));
        assertEquals(rt.calls.at(-1)!.args, { x: 31, y: -8 });
        el.fire("pointerup", { pointerId: 1 });
        el.fire("pointermove", { pointerId: 1, screenX: 500, screenY: 500 });
        await new Promise((r) => setTimeout(r, 20));
        assertEquals(rt.calls.filter((c) => c.method === "setPosition").length, 1);
        // An interactive child keeps its own mouse handling.
        el.fire("pointerdown", {
          button: 0,
          pointerId: 2,
          screenX: 0,
          screenY: 0,
          target: { closest: () => ({}) },
        });
        assertEquals(el.captured, [1]);
        undo();
        assertEquals(el.styleMap.size, 0);
        assertEquals(el.listeners.size, 0);
      },
    );
    // CEF (Chromium) moves the window natively for app-region: CSS only.
    await withGlobals({ navigator: { userAgent: "Mozilla/5.0 Chrome/140.0" } }, () => {
      const el = fakeElement();
      makeWindowDraggable(el);
      assertEquals(el.listeners.size, 0);
    });
  });
});

// --- the rich clipboard ------------------------------------------------------------------

Deno.test("clipboard (desktop): rich reads / writes / formats go to the runtime", async () => {
  await inDesktop({
    clipboard: {
      read: (args) => (args as { format: string }).format === "html" ? "<b>x</b>" : "iVBO",
      write: () => null,
      formats: () => ["text/html", "text/plain"],
    },
  }, async (rt) => {
    assertEquals(await readClipboard({ format: "html" }), "<b>x</b>");
    assertEquals(await readClipboard({ format: "image" }), "iVBO");
    await writeClipboard({ html: "<i>y</i>", text: "y" });
    await writeClipboard({ image: "iVBO" });
    assertEquals(await clipboardFormats(), ["text/html", "text/plain"]);
    assertEquals(rt.calls.map((c) => c.args), [
      { format: "html" },
      { format: "image" },
      { html: "<i>y</i>", text: "y" },
      { image: "iVBO" },
      {},
    ]);
  });
});

/** A fake async clipboard with `ClipboardItem` support. */
function webClipboard(items: Array<Record<string, string | Uint8Array<ArrayBuffer>>> = []) {
  const written: unknown[] = [];
  class ClipboardItem {
    constructor(readonly data: Record<string, Blob>) {}
  }
  const clipboard = {
    readText: () => Promise.resolve(String(items[0]?.["text/plain"] ?? "")),
    writeText: (t: string) => Promise.resolve(void written.push(t)),
    read: () =>
      Promise.resolve(items.map((item) => ({
        types: Object.keys(item),
        getType: (t: string) => Promise.resolve(new Blob([item[t]], { type: t })),
      }))),
    write: (list: ClipboardItem[]) => Promise.resolve(void written.push(...list)),
  };
  return { clipboard, ClipboardItem, written };
}

Deno.test("clipboard (desktop): `unsupported` (a text-only backend) falls back to the web path", async () => {
  const web = webClipboard([{ "text/html": "<p>web</p>" }]);
  await withGlobals({ navigator: { clipboard: web.clipboard } }, async () => {
    await inDesktop({
      clipboard: {
        read: () => {
          throw { code: "unsupported", message: "no HTML" };
        },
      },
    }, async () => {
      assertEquals(await readClipboard({ format: "html" }), "<p>web</p>");
    });
  });
});

Deno.test("clipboard (web): HTML and images through ClipboardItem; text-only fallback", async () => {
  const web = webClipboard([{
    "text/html": "<b>a</b>",
    "image/png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  }]);
  await withGlobals({
    navigator: { clipboard: web.clipboard },
    ClipboardItem: web.ClipboardItem,
  }, async () => {
    assertEquals(await readClipboard({ format: "html" }), "<b>a</b>");
    assertEquals(await readClipboard({ format: "image" }), btoa("\x89PNG"));
    await writeClipboard({ html: "<i>hi</i> &amp; bye" });
    const item = web.written[0] as { data: Record<string, Blob> };
    assertEquals(await item.data["text/plain"].text(), "hi & bye");
    assertEquals(await item.data["text/html"].text(), "<i>hi</i> &amp; bye");
    await writeClipboard({ image: btoa("\x89PNG") });
    assertEquals(Object.keys((web.written[1] as { data: object }).data), ["image/png"]);
    assertEquals((await clipboardFormats()).sort(), ["image/png", "text/html"]);
  });
  // No ClipboardItem: HTML degrades to its text; an image is refused.
  const plain = webClipboard();
  await withGlobals(
    { navigator: { clipboard: { ...plain.clipboard, write: undefined } } },
    async () => {
      await writeClipboard({ html: "<b>x</b>" });
      assertEquals(plain.written, ["x"]);
      await assertRejects(() => writeClipboard({ image: "iVBO" }), Error, "image");
    },
  );
});

Deno.test("clipboard: invalid content and formats are TypeErrors", async () => {
  await assertRejects(() => readClipboard({ format: "rtf" as never }), TypeError);
  for (const bad of [{}, { image: "a", text: "b" }, { text: 3 }, null]) {
    await assertRejects(() => writeClipboard(bad as never), TypeError);
  }
});
