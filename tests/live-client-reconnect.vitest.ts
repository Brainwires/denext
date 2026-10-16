// The Live transport's reconnect loop (`src/client/live-client.ts`): after the socket drops it
// reconnects with exponential backoff — 500 ms, doubling, capped at 15 s — resets the backoff on
// a successful open, re-sends every live subscription, and stops trying once nothing is
// subscribed. Driven on Vitest's fake clock (denext's Deno toolchain; CONTRIBUTING.md → Vitest
// files) with a fake WebSocket, so every delay is asserted to the millisecond. The module keeps
// the socket and backoff in module state, so each test imports a fresh instance
// (`vi.resetModules()`), which a plain `Deno.test` file cannot do.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "./helpers/fake-websocket.ts";

type LiveClient = typeof import("../src/client/live-client.ts");

const sockets = () => FakeWebSocket.all;
const latest = () => FakeWebSocket.all.at(-1)!;

let live: LiveClient;

beforeEach(async () => {
  vi.useFakeTimers();
  FakeWebSocket.all = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", {
    protocol: "http:",
    host: "localhost:8000",
    href: "http://localhost:8000/orders",
  });
  vi.resetModules();
  live = await import("../src/client/live-client.ts");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Advance to one millisecond before `ms`, check no new socket opened, then to `ms`. */
function expectReconnectAfter(ms: number): void {
  const before = sockets().length;
  vi.advanceTimersByTime(ms - 1);
  expect(sockets().length, `no reconnect before ${ms} ms`).toBe(before);
  vi.advanceTimersByTime(1);
  expect(sockets().length, `a reconnect at ${ms} ms`).toBe(before + 1);
}

describe("Live transport reconnect", () => {
  it("backs off exponentially from 500 ms, capped at 15 s, while the server stays away", () => {
    const unsub = live.subscribeLiveData("act#1", [], ["orders"], () => {});
    latest().open();
    latest().drop();
    for (const delay of [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
      expectReconnectAfter(delay);
      latest().drop(); // the attempt fails: the server is still down
    }
    unsub();
  });

  it("a successful open resets the backoff, and re-sends every subscription", () => {
    const unsub = live.subscribeLiveData("act#1", [], ["orders"], () => {});
    const unsubTags = live.subscribeLiveTags(["cart"], () => {});
    latest().open();
    expect(latest().types()).toEqual(["data-subscribe", "tags-subscribe"]);
    latest().drop();
    expectReconnectAfter(500);
    latest().drop();
    expectReconnectAfter(1_000);
    latest().open();
    expect(latest().types(), "the reconnected socket re-subscribes").toEqual([
      "data-subscribe",
      "tags-subscribe",
    ]);
    latest().drop();
    expectReconnectAfter(500); // back to the first step
    unsub();
    unsubTags();
  });

  it("an error then a close schedule one reconnect, not two", () => {
    const unsub = live.subscribeLiveData("act#1", [], [], () => {});
    const ws = latest();
    ws.open();
    ws.onerror?.();
    ws.drop();
    ws.onclose?.(); // a second close event for the same socket
    expect(vi.getTimerCount()).toBe(1);
    expectReconnectAfter(500);
    unsub();
  });

  it("dropping the last subscription cancels a pending reconnect", () => {
    const unsub = live.subscribeLiveData("act#1", [], [], () => {});
    latest().open();
    latest().drop();
    expect(vi.getTimerCount(), "a reconnect is pending").toBe(1);
    unsub();
    expect(vi.getTimerCount(), "the pending reconnect is cancelled").toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(sockets().length, "and nothing reconnects").toBe(1);
  });

  it("a drop with nothing subscribed does not reconnect", () => {
    const unsub = live.subscribeLiveData("act#1", [], [], () => {});
    const ws = latest();
    ws.open();
    unsub(); // closes the socket
    ws.drop(); // its close event arrives afterwards
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(sockets().length).toBe(1);
  });

  it("a new subscription after an idle close starts over at 500 ms", () => {
    const first = live.subscribeLiveData("act#1", [], [], () => {});
    latest().open();
    latest().drop();
    expectReconnectAfter(500);
    latest().drop();
    first(); // the backoff had reached 1 s; closing resets it
    const second = live.subscribeLiveData("act#2", [], [], () => {});
    latest().open();
    latest().drop();
    expectReconnectAfter(500);
    second();
  });
});
