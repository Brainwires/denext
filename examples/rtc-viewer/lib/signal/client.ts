// A peer's side of the hub: an `EventSource` for what arrives, `fetch` POSTs for what it sends.
// Both are web standards, so the same client runs in the browser pages and in the Deno CLI sender.

import type { HubEvents, PeerInfo, PeerMessage, Role } from "./protocol.ts";

/** What the client reports. */
export interface SignalHandlers {
  /** Joined (again, after a reconnect): the peers already in the room. */
  onWelcome?(peers: PeerInfo[]): void;
  onJoin?(peer: PeerInfo): void;
  onLeave?(id: string): void;
  onMessage?(from: string, data: PeerMessage): void;
  /** The stream dropped; `EventSource` reconnects by itself (a new welcome follows). */
  onDisconnect?(): void;
}

/** Options for {@link connectSignal}. */
export interface SignalOptions extends SignalHandlers {
  /** The hub's URL, e.g. `http://127.0.0.1:3000/api/signal` (default: this origin's). */
  url?: string | URL;
  room: string;
  role: Role;
}

/** A connected peer. */
export interface SignalClient {
  readonly id: string;
  readonly role: Role;
  /** Sends one message to a peer of the room. Calls are delivered in the order they are made. */
  send(to: string, data: PeerMessage): Promise<void>;
  close(): void;
}

/** The hub URL a page uses: `?signal=<origin or url>` when given, else this origin's route. */
export function hubUrl(location: { href: string }): URL {
  const here = new URL(location.href);
  const given = here.searchParams.get("signal");
  if (!given) return new URL("/api/signal", here);
  const url = new URL(given, here);
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/api/signal";
  return url;
}

/** Joins a room. The id is a fresh random UUID for every client. */
export function connectSignal(options: SignalOptions): SignalClient {
  const id = crypto.randomUUID();
  const base = new URL(
    options.url ?? "/api/signal",
    (globalThis as { location?: Location }).location?.href,
  );
  const streamUrl = new URL(base);
  streamUrl.search = new URLSearchParams({
    room: options.room,
    id,
    role: options.role,
  }).toString();
  const postUrl = new URL(base);
  postUrl.search = new URLSearchParams({ room: options.room }).toString();

  let token = "";
  let queue: Promise<void> = Promise.resolve();
  const source = new EventSource(streamUrl);
  const on = <E extends keyof HubEvents>(
    event: E,
    fn: (data: HubEvents[E]) => void,
  ) =>
    source.addEventListener(
      event,
      (e) => fn(JSON.parse((e as MessageEvent<string>).data)),
    );

  on("welcome", (data) => {
    token = data.token;
    options.onWelcome?.(data.peers);
  });
  on("join", (peer) => options.onJoin?.(peer));
  on("leave", ({ id }) => options.onLeave?.(id));
  on("message", ({ from, data }) => options.onMessage?.(from, data));
  source.onerror = () => options.onDisconnect?.();

  const post = async (to: string, data: PeerMessage) => {
    const res = await fetch(postUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: id, token, to, data }),
    });
    await res.body?.cancel();
    // A peer that left between the message and its delivery is not an error worth surfacing.
    if (!res.ok && res.status !== 404) {
      throw new Error(`signal: POST answered ${res.status}`);
    }
  };

  return {
    id,
    role: options.role,
    send(to, data) {
      const sent = queue.then(() => post(to, data));
      queue = sent.catch(() => {});
      return sent;
    },
    close: () => source.close(),
  };
}
