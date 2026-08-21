// useWakeLock: a React-style hook over the Screen Wake Lock API, modeled as a
// refcounted singleton — every instance shares one real sentinel and the global
// count/active reads, while request/release act on a per-instance claim.
// navigator.wakeLock is browser-only (absent in Deno), so a persistent global
// `document` + a swappable `navigator.wakeLock` mock drive the client path.

import { assertEquals } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useWakeLock, type WakeLockControls } from "../src/runtime/wake-lock.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// ---- one persistent browser-like environment for the whole file ------------
const g = globalThis as Any;
const visListeners: (() => void)[] = [];
g.document = {
  visibilityState: "visible",
  addEventListener(type: string, cb: () => void) {
    if (type === "visibilitychange") visListeners.push(cb);
  },
  removeEventListener(_type: string, cb: () => void) {
    const i = visListeners.indexOf(cb);
    if (i >= 0) visListeners.splice(i, 1);
  },
};
let mockRequest: ((type?: string) => Promise<Any>) | null = null;
Object.defineProperty(g.navigator, "wakeLock", {
  configurable: true,
  value: {
    request: (t?: string) => mockRequest ? mockRequest(t) : Promise.reject(new Error("nomock")),
  },
});
function fireVisible() {
  g.document.visibilityState = "visible";
  for (const cb of [...visListeners]) cb();
}

/** A stand-in WakeLockSentinel that records release() and fires its "release" event. */
function fakeSentinel() {
  let onRelease: (() => void) | null = null;
  const s = {
    released: false,
    type: "screen" as const,
    releaseCalls: 0,
    addEventListener(type: string, cb: () => void) {
      if (type === "release") onRelease = cb;
    },
    removeEventListener() {},
    release() {
      s.releaseCalls++;
      if (!s.released) {
        s.released = true;
        onRelease?.();
      }
      return Promise.resolve();
    },
  };
  return s;
}

/** Mount a component exposing the hook's controls into `ref`; returns the root. */
function mount(ref: { c?: WakeLockControls }) {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  function View() {
    ref.c = useWakeLock();
    return h("i", null, `${ref.c.count}`);
  }
  const root = createRoot(container as Any);
  root.render(h(View, null));
  flushSync();
  return root;
}

Deno.test("useWakeLock: two instances share global count/active; released is per-instance", async () => {
  mockRequest = () => Promise.resolve(fakeSentinel());
  const A: { c?: WakeLockControls } = {};
  const B: { c?: WakeLockControls } = {};
  const ra = mount(A);
  const rb = mount(B);
  try {
    assertEquals(A.c!.isSupported, true);
    assertEquals(A.c!.count, 0);
    assertEquals(A.c!.released, undefined);
    assertEquals(B.c!.released, undefined);

    await A.c!.request();
    flushSync();
    assertEquals(A.c!.count, 1, "A sees the global count");
    assertEquals(B.c!.count, 1, "B sees the SAME global count");
    assertEquals(A.c!.active, true);
    assertEquals(B.c!.active, true);
    assertEquals(A.c!.released, false, "A holds a claim");
    assertEquals(B.c!.released, undefined, "B never requested → still undefined");

    await B.c!.request();
    flushSync();
    assertEquals(A.c!.count, 2);
    assertEquals(B.c!.released, false);

    await A.c!.release();
    flushSync();
    assertEquals(A.c!.count, 1, "count drops by one");
    assertEquals(A.c!.released, true, "A's claim dropped");
    assertEquals(B.c!.released, false, "B still holds");
    assertEquals(B.c!.active, true, "screen still awake for B");
  } finally {
    ra.unmount();
    rb.unmount();
  }
});

Deno.test("useWakeLock: one real sentinel is refcounted (acquired once, released on last claim)", async () => {
  let requests = 0;
  const sentinel = fakeSentinel();
  mockRequest = () => (requests++, Promise.resolve(sentinel));
  const A: { c?: WakeLockControls } = {};
  const B: { c?: WakeLockControls } = {};
  const ra = mount(A);
  const rb = mount(B);
  try {
    await A.c!.request();
    await B.c!.request();
    flushSync();
    assertEquals(requests, 1, "second claim reuses the existing sentinel");
    assertEquals(sentinel.releaseCalls, 0);

    await A.c!.release();
    flushSync();
    assertEquals(sentinel.releaseCalls, 0, "not released while B still holds");

    await B.c!.release();
    flushSync();
    assertEquals(sentinel.releaseCalls, 1, "released once the last claim drops");
    assertEquals(A.c!.active, false);
  } finally {
    ra.unmount();
    rb.unmount();
  }
});

Deno.test("useWakeLock: concurrent acquires in one tick create only ONE real sentinel", async () => {
  // Two claims added in the same tick must coalesce to a single api.request — else
  // the second overwrites `sentinel` and the first real lock leaks (never released).
  let requests = 0;
  let resolveReq: (() => void) | null = null;
  const sentinel = fakeSentinel();
  mockRequest = () => {
    requests++;
    return new Promise<Any>((res) => {
      resolveReq = () => res(sentinel);
    });
  };
  const A: { c?: WakeLockControls } = {};
  const B: { c?: WakeLockControls } = {};
  const ra = mount(A);
  const rb = mount(B);
  try {
    // Fire both WITHOUT awaiting between them, then resolve the single in-flight request.
    const p1 = A.c!.request();
    const p2 = B.c!.request();
    resolveReq!();
    await Promise.all([p1, p2]);
    flushSync();
    assertEquals(requests, 1, "concurrent acquires coalesce to one api.request");

    await A.c!.release();
    await B.c!.release();
    flushSync();
    assertEquals(sentinel.releaseCalls, 1, "the single sentinel is released exactly once");
  } finally {
    ra.unmount();
    rb.unmount();
  }
});

Deno.test("useWakeLock: releaseAll drops every claim and sleeps the screen", async () => {
  const sentinel = fakeSentinel();
  mockRequest = () => Promise.resolve(sentinel);
  const A: { c?: WakeLockControls } = {};
  const B: { c?: WakeLockControls } = {};
  const ra = mount(A);
  const rb = mount(B);
  try {
    await A.c!.request();
    await B.c!.request();
    flushSync();
    assertEquals(A.c!.count, 2);

    await A.c!.releaseAll();
    flushSync();
    assertEquals(A.c!.count, 0, "all claims cleared");
    assertEquals(A.c!.active, false);
    assertEquals(A.c!.released, true, "A's claim gone");
    assertEquals(B.c!.released, true, "B's claim gone too (global kill-switch)");
    assertEquals(sentinel.releaseCalls, 1, "the shared sentinel was released");
  } finally {
    ra.unmount();
    rb.unmount();
  }
});

Deno.test("useWakeLock: re-acquires the sentinel when the page returns to visible", async () => {
  const first = fakeSentinel();
  const second = fakeSentinel();
  const queue = [first, second];
  let requests = 0;
  mockRequest = () => (requests++, Promise.resolve(queue.shift()));
  const A: { c?: WakeLockControls } = {};
  const ra = mount(A);
  try {
    await A.c!.request();
    flushSync();
    assertEquals(requests, 1);

    // Browser auto-releases on hide (claim is still held).
    first.release();
    flushSync();
    assertEquals(A.c!.released, false, "the claim is still held even though the OS lock dropped");

    fireVisible();
    await Promise.resolve();
    flushSync();
    assertEquals(requests, 2, "re-acquired a fresh sentinel on return to visible");
    assertEquals(A.c!.active, true);
  } finally {
    ra.unmount();
  }
});

Deno.test("useWakeLock: unmount drops only that instance's claim", async () => {
  const sentinel = fakeSentinel();
  mockRequest = () => Promise.resolve(sentinel);
  const A: { c?: WakeLockControls } = {};
  const B: { c?: WakeLockControls } = {};
  const ra = mount(A);
  const rb = mount(B);
  try {
    await A.c!.request();
    await B.c!.request();
    flushSync();
    assertEquals(B.c!.count, 2);

    ra.unmount(); // A leaves
    flushSync();
    assertEquals(B.c!.count, 1, "A's claim released on unmount, B's remains");
    assertEquals(sentinel.releaseCalls, 0, "screen still awake for B");
  } finally {
    rb.unmount();
    flushSync();
    assertEquals(sentinel.releaseCalls, 1, "last claim gone → sentinel released");
  }
});

Deno.test("useWakeLock: unsupported environment — isSupported false, request is a no-op", () => {
  // Temporarily remove the API so the hook reports unsupported.
  Object.defineProperty(g.navigator, "wakeLock", { configurable: true, value: undefined });
  const A: { c?: WakeLockControls } = {};
  const ra = mount(A);
  try {
    assertEquals(A.c!.isSupported, false);
    return A.c!.request().then(() => {
      flushSync();
      assertEquals(A.c!.count, 0, "no claim added when unsupported");
      assertEquals(A.c!.released, undefined, "request() was a no-op");
      ra.unmount();
    });
  } finally {
    Object.defineProperty(g.navigator, "wakeLock", {
      configurable: true,
      value: {
        request: (t?: string) => mockRequest ? mockRequest(t) : Promise.reject(new Error("nomock")),
      },
    });
  }
});
