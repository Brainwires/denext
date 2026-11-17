// The receiving end: a WHIP endpoint (WebRTC-HTTP Ingestion Protocol, RFC 9725) the app serves on
// loopback. A sender POSTs its SDP offer to `/whip`; the answer comes back in the 201 response,
// with every ICE candidate in it (no trickle), and `DELETE` on the `Location` it names ends the
// session. Any WHIP sender works: scripts/send.ts, OBS, GStreamer's `whipclientsink`, a browser.
//
// One stream at a time (a viewer shows one picture): a new POST replaces the session. The peer
// connection and the frame transform come from the app (`ReceiverDeps`), so this file is the HTTP
// and negotiation logic alone and its tests run on a fake peer.

import type { CodecName } from "./native.ts";
import { type CodecCapability, DECODABLE, negotiatedVideoCodec, preferDecodable } from "./sdp.ts";

/** The slice of `RTCPeerConnection` the receiver uses. */
export interface PeerLike {
  connectionState: string;
  iceGatheringState: string;
  localDescription: { sdp: string } | null;
  ontrack: ((event: { receiver: unknown; track: { kind: string } }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  onicegatheringstatechange: (() => void) | null;
  setRemoteDescription(desc: { type: "offer"; sdp: string }): Promise<void>;
  createAnswer(): Promise<{ type: "answer"; sdp?: string }>;
  setLocalDescription(desc: { type: "answer"; sdp?: string }): Promise<void>;
  getTransceivers(): {
    receiver: { track: { kind: string } };
    direction: string;
    setCodecPreferences?(codecs: CodecCapability[]): void;
  }[];
  close(): void;
}

/** What one session reports. */
export interface SessionInfo {
  readonly id: string;
  readonly codec: CodecName;
  /** The peer connection's `connectionState`. */
  readonly state: string;
  readonly since: number;
}

/** What the receiver needs from the app. */
export interface ReceiverDeps {
  /** A new peer connection. */
  peer(): PeerLike;
  /** The video codecs this runtime can receive (`RTCRtpReceiver.getCapabilities("video").codecs`). */
  capabilities(): readonly CodecCapability[];
  /** A video track arrived: start taking its encoded frames (sets `receiver.transform`). */
  attach(receiver: unknown, sessionId: string): { close(): void };
  /** The answer settled on `codec`: make the viewer decode it. A throw refuses the session. */
  ready(codec: CodecName, sessionId: string): Promise<void> | void;
  /** The session ended (closed, replaced or failed). */
  ended?(sessionId: string): void;
  /** How long to wait for ICE gathering, in ms. Default 2000. */
  readonly gatherTimeoutMs?: number;
  /** A session id. Default `crypto.randomUUID()`. */
  newId?(): string;
}

interface Session {
  readonly id: string;
  readonly peer: PeerLike;
  codec: CodecName | null;
  readonly since: number;
  attached: { close(): void } | null;
}

/** The endpoint's path. */
export const WHIP_PATH = "/whip";

export class WhipReceiver {
  #deps: ReceiverDeps;
  #session: Session | null = null;

  constructor(deps: ReceiverDeps) {
    this.#deps = deps;
  }

  /** The current session, or null. */
  session(): SessionInfo | null {
    const s = this.#session;
    if (!s || !s.codec) return null;
    return { id: s.id, codec: s.codec, state: s.peer.connectionState, since: s.since };
  }

  /** Ends the current session. */
  closeSession(): void {
    const s = this.#session;
    if (!s) return;
    this.#session = null;
    s.attached?.close();
    try {
      s.peer.close();
    } catch {
      // Already closed.
    }
    this.#deps.ended?.(s.id);
  }

  /** The HTTP handler: `POST /whip`, `DELETE /whip/<id>`, `OPTIONS`. */
  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { "accept-post": "application/sdp", allow: "POST, DELETE, OPTIONS" },
      });
    }
    if (path === WHIP_PATH) {
      if (request.method !== "POST") {
        return text(405, "POST an SDP offer", { allow: "POST, OPTIONS" });
      }
      const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (type !== "application/sdp") return text(415, "the offer must be application/sdp");
      return await this.#offer(await request.text());
    }
    if (path.startsWith(`${WHIP_PATH}/`)) {
      if (request.method !== "DELETE") {
        return text(405, "DELETE ends the session", { allow: "DELETE" });
      }
      const id = decodeURIComponent(path.slice(WHIP_PATH.length + 1));
      if (this.#session?.id !== id) return text(404, "no such session");
      this.closeSession();
      return new Response(null, { status: 200 });
    }
    return text(404, "not found");
  }

  async #offer(sdp: string): Promise<Response> {
    if (!/^m=video /m.test(sdp)) return text(400, "the offer has no video");
    this.closeSession();
    const session = this.#open();
    try {
      const answer = await this.#negotiate(session.peer, sdp);
      const codec = decodableCodec(answer);
      await this.#deps.ready(codec, session.id);
      session.codec = codec;
      return new Response(answer, {
        status: 201,
        headers: {
          "content-type": "application/sdp",
          location: `${WHIP_PATH}/${encodeURIComponent(session.id)}`,
        },
      });
    } catch (err) {
      if (this.#session === session) this.closeSession();
      const status = err instanceof RefusedError ? 406 : 400;
      return text(status, err instanceof Error ? err.message : String(err));
    }
  }

  /** A new session with its peer, wired to attach the video track and to end with the peer. */
  #open(): Session {
    const id = this.#deps.newId?.() ?? crypto.randomUUID();
    const peer = this.#deps.peer();
    const session: Session = { id, peer, codec: null, since: Date.now(), attached: null };
    this.#session = session;
    peer.ontrack = (event) => {
      if (event.track.kind === "video" && !session.attached) {
        session.attached = this.#deps.attach(event.receiver, id);
      }
    };
    peer.onconnectionstatechange = () => {
      const ended = peer.connectionState === "failed" || peer.connectionState === "closed";
      if (ended && this.#session === session) this.closeSession();
    };
    return session;
  }

  /** Applies the offer, answers receive-only with the decodable codecs, and returns the answer. */
  async #negotiate(peer: PeerLike, sdp: string): Promise<string> {
    await peer.setRemoteDescription({ type: "offer", sdp });
    const codecs = preferDecodable(this.#deps.capabilities());
    for (const t of peer.getTransceivers()) {
      if (t.receiver.track.kind !== "video") continue;
      t.direction = "recvonly";
      if (codecs.length) t.setCodecPreferences?.(codecs);
    }
    await peer.setLocalDescription(await peer.createAnswer());
    await gathered(peer, this.#deps.gatherTimeoutMs ?? 2000);
    return peer.localDescription?.sdp ?? "";
  }
}

/** The answer's video codec, refused (406) when the native decoder doesn't take it. */
function decodableCodec(answer: string): CodecName {
  const codec = negotiatedVideoCodec(answer);
  if (codec && DECODABLE.includes(codec)) return codec;
  throw new RefusedError(
    `the sender settled on ${codec ?? "no video codec"}; the viewer decodes H.265, H.264 and VP9`,
  );
}

/** A session the viewer can't show. */
class RefusedError extends Error {}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

/** Resolves when ICE gathering completes, or after `timeoutMs`. */
function gathered(peer: PeerLike, timeoutMs: number): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      peer.onicegatheringstatechange = null;
      resolve();
    }
    peer.onicegatheringstatechange = () => {
      if (peer.iceGatheringState === "complete") done();
    };
  });
}
