// The signalling wire format, shared by the hub (server), the browser pages and the CLI sender.
// Pure: no DOM, no Deno APIs, so every side imports it.

/** A peer's part in a room: one sender, any number of viewers (up to the hub's cap). */
export type Role = "sender" | "viewer";

/** What one peer tells another through the hub (the hub never reads it, only relays it). */
export type PeerMessage =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "candidate"; candidate: RTCIceCandidateInit | null }
  /** The viewer asks the sender to start a fresh connection (its decoder lost the stream). */
  | { type: "restart" };

/** A peer in a room, as the hub announces it. */
export interface PeerInfo {
  id: string;
  role: Role;
}

/** The server-sent events a connected peer receives, by SSE `event:` name. */
export interface HubEvents {
  /** First event: the peer's own `token` (it signs its POSTs) and who is already there. */
  welcome: { id: string; token: string; peers: PeerInfo[] };
  join: PeerInfo;
  leave: { id: string };
  message: { from: string; data: PeerMessage };
}

/** The JSON body of `POST /api/signal?room=…`. */
export interface PostBody {
  from: string;
  token: string;
  to: string;
  data: PeerMessage;
}

const ROOM = /^[A-Za-z0-9_-]{1,40}$/;
const PEER_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** A room name the hub accepts: 1–40 of `A–Z a–z 0–9 _ -`. */
export function isRoomName(value: unknown): value is string {
  return typeof value === "string" && ROOM.test(value);
}

/** A peer id the hub accepts: 8–64 of `A–Z a–z 0–9 _ -` (a UUID qualifies). */
export function isPeerId(value: unknown): value is string {
  return typeof value === "string" && PEER_ID.test(value);
}

/** `sender` or `viewer`. */
export function isRole(value: unknown): value is Role {
  return value === "sender" || value === "viewer";
}

/** A message's own fields, checked: one parser per `type`. */
const MESSAGE_PARSERS: Record<string, (msg: Record<string, unknown>) => PeerMessage | null> = {
  offer: (m) => typeof m.sdp === "string" ? { type: "offer", sdp: m.sdp } : null,
  answer: (m) => typeof m.sdp === "string" ? { type: "answer", sdp: m.sdp } : null,
  // `null` is the end of candidates; anything else must be an object (RTCIceCandidateInit).
  candidate: (m) =>
    typeof m.candidate === "object"
      ? { type: "candidate", candidate: m.candidate as RTCIceCandidateInit | null }
      : null,
  restart: () => ({ type: "restart" }),
};

/** A {@link PeerMessage} with the fields its `type` needs, else `null`. */
function parsePeerMessage(value: unknown): PeerMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const msg = value as Record<string, unknown>;
  const parse = typeof msg.type === "string" && Object.hasOwn(MESSAGE_PARSERS, msg.type)
    ? MESSAGE_PARSERS[msg.type]
    : undefined;
  return parse ? parse(msg) : null;
}

/** A {@link PostBody}, else `null`. */
export function parsePostBody(value: unknown): PostBody | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (
    !isPeerId(body.from) || !isPeerId(body.to) || typeof body.token !== "string"
  ) return null;
  const data = parsePeerMessage(body.data);
  return data ? { from: body.from, to: body.to, token: body.token, data } : null;
}
