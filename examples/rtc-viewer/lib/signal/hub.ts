// The signalling hub: rooms of peers, each holding one server-sent-events stream; a POST relays a
// message to one peer of the same room. Web-standard Request / Response only, so the same hub
// serves the app's route handler (`app/api/signal/route.ts`) and a packaged desktop app's backend
// (`desktop.ts`), and the tests drive it with plain `Request`s.
//
// It is an in-memory, single-instance demo hub: peers on two server instances never meet. A real
// deployment would put the rooms behind a shared transport (denext's `createChannel` with
// `redisChannelTransport()`) or a dedicated SFU.

import {
  type HubEvents,
  isPeerId,
  isRole,
  isRoomName,
  parsePostBody,
  type PeerInfo,
  type PostBody,
  type Role,
} from "./protocol.ts";

/** The hub's caps. */
export interface HubLimits {
  /** Rooms open at once. */
  maxRooms: number;
  /** Peers in one room (the sender included). */
  maxPeersPerRoom: number;
  /** The largest POST body, in bytes (an SDP is a few KiB). */
  maxMessageBytes: number;
  /** How often an idle stream gets an SSE comment, so proxies keep it open (ms). */
  heartbeatMs: number;
}

/** Options for {@link SignalHub}. */
export interface HubOptions extends Partial<HubLimits> {
  /**
   * Origins besides the request's own that may connect (CORS): a packaged shell whose page is not
   * served by this server, e.g. `capacitor://localhost`.
   */
  allowedOrigins?: readonly string[];
}

const DEFAULT_LIMITS: HubLimits = {
  maxRooms: 64,
  maxPeersPerRoom: 16,
  maxMessageBytes: 64 * 1024,
  heartbeatMs: 15_000,
};

/** The Capacitor shells' origins (iOS, Android): the mobile build's page is served by the app. */
export const SHELL_ORIGINS: readonly string[] = ["capacitor://localhost", "https://localhost"];

interface Peer extends PeerInfo {
  emit<E extends keyof HubEvents>(event: E, data: HubEvents[E]): void;
  close(): void;
}

type Cors = Record<string, string>;

const encoder = new TextEncoder();

function problem(status: number, error: string, headers: HeadersInit = {}): Response {
  return Response.json({ error }, { status, headers });
}

function preflight(cors: Cors): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
    },
  });
}

/** The rooms, their peers and the request handling. */
export class SignalHub {
  readonly #limits: HubLimits;
  readonly #origins: ReadonlySet<string>;
  readonly #rooms = new Map<string, Map<string, Peer>>();
  /** Each connected peer's token (issued in its welcome; it signs the peer's POSTs) → its id. */
  readonly #tokens = new Map<string, string>();

  constructor(options: HubOptions = {}) {
    const { allowedOrigins = [], ...limits } = options;
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    this.#origins = new Set(allowedOrigins);
  }

  /** The peers of a room, for tests and diagnostics. */
  peers(room: string): PeerInfo[] {
    return [...(this.#rooms.get(room)?.values() ?? [])].map(({ id, role }) => ({ id, role }));
  }

  /** Answers `GET` (join, an SSE stream), `POST` (relay) and `OPTIONS` (CORS preflight). */
  async handle(request: Request): Promise<Response> {
    const cors = this.#cors(request);
    if (cors === null) return problem(403, "origin_not_allowed");
    if (request.method === "OPTIONS") return preflight(cors);
    const url = new URL(request.url);
    const room = url.searchParams.get("room");
    if (!isRoomName(room)) return problem(400, "bad_room", cors);
    if (request.method === "GET") return this.#join(request, url, room, cors);
    if (request.method === "POST") return await this.#relay(request, room, cors);
    return problem(405, "method_not_allowed", { ...cors, allow: "GET, POST, OPTIONS" });
  }

  /** The CORS headers for the request's origin; `null` when it is a foreign, unlisted origin. */
  #cors(request: Request): Cors | null {
    const origin = request.headers.get("origin");
    if (origin === null || origin === new URL(request.url).origin) return {};
    if (!this.#origins.has(origin)) return null;
    return { "access-control-allow-origin": origin, vary: "origin" };
  }

  #join(request: Request, url: URL, room: string, cors: Cors): Response {
    const id = url.searchParams.get("id");
    const role = url.searchParams.get("role");
    if (!isPeerId(id) || !isRole(role)) return problem(400, "bad_peer", cors);
    const refusal = this.#refusal(room, id, role);
    if (refusal) return problem(refusal[0], refusal[1], cors);
    return new Response(this.#stream(room, id, role, request.signal), {
      headers: {
        ...cors,
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  }

  /** Why `id` may not join `room` as `role` (status and code), else `null`. */
  #refusal(room: string, id: string, role: Role): [number, string] | null {
    const peers = this.#rooms.get(room);
    if (!peers) return this.#rooms.size >= this.#limits.maxRooms ? [503, "too_many_rooms"] : null;
    if (peers.has(id)) return [409, "id_taken"];
    if (peers.size >= this.#limits.maxPeersPerRoom) return [503, "room_full"];
    const senderPresent = [...peers.values()].some((p) => p.role === "sender");
    return role === "sender" && senderPresent ? [409, "sender_present"] : null;
  }

  #stream(room: string, id: string, role: Role, signal: AbortSignal): ReadableStream<Uint8Array> {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const token = crypto.randomUUID();
    const write = (chunk: string) => controller?.enqueue(encoder.encode(chunk));
    const leave = () => {
      if (!controller) return;
      controller = null;
      clearInterval(heartbeat);
      signal.removeEventListener("abort", end);
      this.#tokens.delete(token);
      this.#leave(room, id);
    };
    function end() {
      const open = controller;
      leave();
      try {
        open?.close();
      } catch { /* already closed */ }
    }
    return new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
        const peer: Peer = {
          id,
          role,
          emit: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          close: end,
        };
        // Reconnect after 1 s if the stream drops (the client side's EventSource retry).
        write("retry: 1000\n\n");
        this.#enter(room, peer, token);
        heartbeat = setInterval(() => write(": keep-alive\n\n"), this.#limits.heartbeatMs);
        if (signal.aborted) end();
        else signal.addEventListener("abort", end, { once: true });
      },
      cancel: leave,
    });
  }

  /** Adds `peer` to `room`: its welcome (with its token), then a join to everyone else. */
  #enter(room: string, peer: Peer, token: string): void {
    const peers = this.#rooms.get(room) ?? new Map<string, Peer>();
    this.#rooms.set(room, peers);
    const others = [...peers.values()];
    peers.set(peer.id, peer);
    this.#tokens.set(token, peer.id);
    peer.emit("welcome", {
      id: peer.id,
      token,
      peers: others.map(({ id, role }) => ({ id, role })),
    });
    for (const other of others) other.emit("join", { id: peer.id, role: peer.role });
  }

  #leave(room: string, id: string): void {
    const peers = this.#rooms.get(room);
    if (!peers?.delete(id)) return;
    if (peers.size === 0) this.#rooms.delete(room);
    for (const other of peers.values()) other.emit("leave", { id });
  }

  async #relay(request: Request, room: string, cors: Cors): Promise<Response> {
    const body = await this.#readBody(request);
    if (typeof body === "number") {
      return problem(body, body === 413 ? "too_large" : "bad_message", cors);
    }
    const peers = this.#rooms.get(room);
    // The token is the proof: it was issued to `from` alone, in its own stream's welcome.
    if (this.#tokens.get(body.token) !== body.from || !peers?.has(body.from)) {
      return problem(403, "not_a_peer", cors);
    }
    const to = peers.get(body.to);
    if (!to) return problem(404, "no_such_peer", cors);
    to.emit("message", { from: body.from, data: body.data });
    return new Response(null, { status: 204, headers: cors });
  }

  /** The POST body, parsed and checked; else the status to answer (413 too large, 400 bad). */
  async #readBody(request: Request): Promise<PostBody | number> {
    const max = this.#limits.maxMessageBytes;
    if (Number(request.headers.get("content-length") ?? 0) > max) return 413;
    const bytes = await request.arrayBuffer().catch(() => null);
    if (bytes === null || bytes.byteLength > max) return 413;
    try {
      return parsePostBody(JSON.parse(new TextDecoder().decode(bytes))) ?? 400;
    } catch {
      return 400;
    }
  }

  /** Ends every stream (a server shutting down, or a test's cleanup). */
  close(): void {
    for (const peers of [...this.#rooms.values()]) {
      for (const peer of [...peers.values()]) peer.close();
    }
  }
}
