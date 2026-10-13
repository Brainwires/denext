// The Phoenix channels wire format Supabase Realtime speaks (and `@supabase/realtime-js` sends):
// serializer `vsn=1.0.0` — each frame a JSON object `{ join_ref, ref, topic, event, payload }` —
// and `vsn=2.0.0` — a JSON array `[join_ref, ref, topic, event, payload]`, plus two binary frame
// kinds for user broadcasts: a client push (kind 3) and a server push (kind 4), each a header of
// one-byte lengths followed by the strings and the payload (JSON text, or raw bytes).
//
// Pure: no I/O, no server imports.

/** A serializer version. */
export type Vsn = "1.0.0" | "2.0.0";

/** One Phoenix message. */
export interface PhxMessage {
  /** The join this message belongs to (`null` for a server push outside a reply). */
  joinRef: string | null;
  /** The client's reference, echoed by the reply. */
  ref: string | null;
  /** `realtime:<name>`, or `phoenix` for heartbeats. */
  topic: string;
  /** `phx_join`, `phx_reply`, `broadcast`, `presence`, `access_token`, `heartbeat`, … */
  event: string;
  /** The event's payload. */
  payload: unknown;
}

/** A user broadcast's payload: JSON, or raw bytes (a binary frame). */
export type BroadcastPayload = unknown;

/** The binary frame kinds. */
const KIND_USER_BROADCAST_PUSH = 3;
const KIND_USER_BROADCAST = 4;
/** A binary frame's payload encoding. */
const ENCODING_BINARY = 0;
const ENCODING_JSON = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The serializer version a socket asked for in its URL (`?vsn=`); anything else is `null`.
 *
 * @param value The `vsn` query parameter.
 * @returns The version, `1.0.0` when absent (Phoenix's default), or `null` when unsupported.
 */
export function parseVsn(value: string | null): Vsn | null {
  if (value === null || value === "1.0.0") return "1.0.0";
  return value === "2.0.0" ? "2.0.0" : null;
}

/** A string or null, as a Phoenix ref. */
function refOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

/** A decoded JSON frame, checked (anything malformed is `null`). */
function fromParts(
  joinRef: unknown,
  ref: unknown,
  topic: unknown,
  event: unknown,
  payload: unknown,
): PhxMessage | null {
  if (typeof topic !== "string" || typeof event !== "string") return null;
  return { joinRef: refOf(joinRef), ref: refOf(ref), topic, event, payload };
}

/** Decode a kind-3 binary frame (a client's user broadcast) into a `broadcast` message. */
function decodeBroadcastPush(bytes: Uint8Array): PhxMessage | null {
  if (bytes.byteLength < 7) return null;
  const [, joinRefLen, refLen, topicLen, eventLen, metaLen, encoding] = bytes;
  let offset = 7;
  const take = (length: number): Uint8Array | null => {
    if (offset + length > bytes.byteLength) return null;
    const part = bytes.subarray(offset, offset + length);
    offset += length;
    return part;
  };
  const parts = [take(joinRefLen), take(refLen), take(topicLen), take(eventLen), take(metaLen)];
  if (parts.some((part) => part === null)) return null;
  const [joinRef, ref, topic, event] = parts.slice(0, 4).map((part) => decoder.decode(part!));
  const body = bytes.slice(offset);
  let payload: unknown;
  if (encoding === ENCODING_JSON) {
    payload = JSON.parse(decoder.decode(body));
  } else if (encoding === ENCODING_BINARY) {
    payload = body;
  } else {
    return null;
  }
  return {
    joinRef: joinRef || null,
    ref: ref || null,
    topic,
    event: "broadcast",
    payload: { type: "broadcast", event, payload },
  };
}

/**
 * Decode one frame from a client.
 *
 * @param vsn The socket's serializer version.
 * @param data A text frame, or a binary one (vsn 2.0.0 user broadcasts).
 * @returns The message, or `null` when it is malformed.
 */
export function decodeFrame(vsn: Vsn, data: string | ArrayBuffer | Uint8Array): PhxMessage | null {
  try {
    if (typeof data !== "string") {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (vsn !== "2.0.0" || bytes[0] !== KIND_USER_BROADCAST_PUSH) return null;
      return decodeBroadcastPush(bytes);
    }
    const value = JSON.parse(data);
    if (vsn === "2.0.0") {
      if (!Array.isArray(value) || value.length !== 5) return null;
      return fromParts(value[0], value[1], value[2], value[3], value[4]);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return fromParts(value.join_ref, value.ref, value.topic, value.event, value.payload);
  } catch {
    return null;
  }
}

/**
 * Encode one message for a client (JSON text).
 *
 * @param vsn The socket's serializer version.
 * @param message The message.
 * @returns The frame.
 */
export function encodeMessage(vsn: Vsn, message: PhxMessage): string {
  if (vsn === "2.0.0") {
    return JSON.stringify([
      message.joinRef,
      message.ref,
      message.topic,
      message.event,
      message.payload,
    ]);
  }
  return JSON.stringify({
    join_ref: message.joinRef,
    ref: message.ref,
    topic: message.topic,
    event: message.event,
    payload: message.payload,
  });
}

/**
 * Encode a user broadcast for a client: on `vsn=2.0.0` the binary kind-4 frame (JSON or raw
 * bytes, as the sender sent it); on `1.0.0` the JSON `broadcast` event — which cannot carry
 * raw bytes, so a binary payload is not delivered there (`null`).
 *
 * @param vsn The socket's serializer version.
 * @param topic The full topic (`realtime:<name>`).
 * @param event The user's event name.
 * @param payload The user's payload: JSON-able, or a `Uint8Array`.
 * @returns The frame, or `null` when it cannot be sent on this version.
 */
export function encodeBroadcast(
  vsn: Vsn,
  topic: string,
  event: string,
  payload: BroadcastPayload,
): string | Uint8Array | null {
  const binary = payload instanceof Uint8Array;
  const topicBytes = encoder.encode(topic);
  const eventBytes = encoder.encode(event);
  if (vsn === "2.0.0" && topicBytes.byteLength <= 255 && eventBytes.byteLength <= 255) {
    const body = binary ? payload : encoder.encode(JSON.stringify(payload ?? null));
    const frame = new Uint8Array(
      5 + topicBytes.byteLength + eventBytes.byteLength + body.byteLength,
    );
    frame.set([
      KIND_USER_BROADCAST,
      topicBytes.byteLength,
      eventBytes.byteLength,
      0,
      binary ? ENCODING_BINARY : ENCODING_JSON,
    ]);
    frame.set(topicBytes, 5);
    frame.set(eventBytes, 5 + topicBytes.byteLength);
    frame.set(body, 5 + topicBytes.byteLength + eventBytes.byteLength);
    return frame;
  }
  if (binary) return null;
  return encodeMessage(vsn, {
    joinRef: null,
    ref: null,
    topic,
    event: "broadcast",
    payload: { type: "broadcast", event, payload },
  });
}

/** A `phx_reply`. */
export function reply(
  message: Pick<PhxMessage, "joinRef" | "ref" | "topic">,
  status: "ok" | "error",
  response: Record<string, unknown> = {},
): PhxMessage {
  return {
    joinRef: message.joinRef,
    ref: message.ref,
    topic: message.topic,
    event: "phx_reply",
    payload: { status, response },
  };
}
