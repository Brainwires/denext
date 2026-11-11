// A small DevTools protocol client over one WebSocket to Chrome's browser endpoint, with flattened
// sessions: a command names its target's `sessionId`, and every event carries the one it came
// from. voice/cdp-guard.ts attaches the page and everything it starts through it. The socket is
// injected, so the client is unit-tested with a fake one.

import type { Cdp, CdpEvent } from "./cdp-guard.ts";

/** The slice of `WebSocket` the client uses. */
export interface SocketLike {
  send(data: string): void;
  addEventListener(type: "message" | "close", listener: (event: Event) => void): void;
  close(): void;
}

/** A protocol command failed (its `error.message`). */
export class CdpError extends Error {
  override readonly name = "CdpError";
}

/** A message from the browser, or `null` when it isn't a JSON object. */
function parseMessage(data: unknown): Record<string, unknown> | null {
  try {
    const m = JSON.parse(String(data));
    return typeof m === "object" && m !== null ? m : null;
  } catch {
    return null;
  }
}

/** The event a message carries, or `null` when it carries none. */
function toEvent(m: Record<string, unknown>): CdpEvent | null {
  if (typeof m.method !== "string") return null;
  return {
    method: m.method,
    params: (m.params ?? {}) as Record<string, unknown>,
    ...(typeof m.sessionId === "string" ? { sessionId: m.sessionId } : {}),
  };
}

/** The client over `socket`, and its shutdown. */
export function cdpClient(socket: SocketLike): Cdp & { close(): void } {
  let next = 0;
  let closed = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners: ((event: CdpEvent) => void)[] = [];
  const fail = () => {
    closed = true;
    for (const p of pending.values()) p.reject(new CdpError("the browser connection closed"));
    pending.clear();
  };
  socket.addEventListener("close", fail);
  /** Settle the command an answer is for. */
  const answer = (m: Record<string, unknown> & { id: number }) => {
    const p = pending.get(m.id);
    pending.delete(m.id);
    const error = m.error as { message?: unknown } | undefined;
    if (error) p?.reject(new CdpError(String(error.message ?? "protocol error")));
    else p?.resolve(m.result ?? {});
  };
  socket.addEventListener("message", (event) => {
    const m = parseMessage((event as MessageEvent).data);
    if (m === null) return;
    if (typeof m.id === "number") return answer(m as Record<string, unknown> & { id: number });
    const e = toEvent(m);
    if (e) { for (const l of listeners) l(e); }
  });
  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new CdpError("the browser connection closed"));
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    onEvent: (listener) => void listeners.push(listener),
    close() {
      fail();
      socket.close();
    },
  };
}
