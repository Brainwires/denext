// The two ends of a connection, over the hub. The sender offers (one connection per viewer, made
// when a viewer joins or asks for a restart); the viewer answers. Only web-standard WebRTC is used,
// so the sender runs in a browser page and in the Deno CLI alike.

import { connectSignal, type SignalClient } from "../signal/client.ts";
import type { PeerMessage } from "../signal/protocol.ts";

/** One `RTCPeerConnection` and the remote candidates that arrived before its remote description. */
class Link {
  readonly pc: RTCPeerConnection;
  #pending: RTCIceCandidateInit[] = [];

  constructor(
    config: RTCConfiguration | undefined,
    signal: SignalClient,
    peer: string,
  ) {
    this.pc = new RTCPeerConnection(config);
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        signal.send(peer, {
          type: "candidate",
          candidate: e.candidate.toJSON(),
        }).catch(() => {});
      }
    };
  }

  async remote(description: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(description);
    const pending = this.#pending;
    this.#pending = [];
    for (const candidate of pending) {
      await this.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  async candidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (!candidate) return;
    if (this.pc.remoteDescription) {
      await this.pc.addIceCandidate(candidate).catch(() => {});
    } else this.#pending.push(candidate);
  }

  close(): void {
    this.pc.close();
  }
}

/** What a side reports as it goes. */
export type StatusListener = (status: string) => void;

/** Options for {@link startSender}. */
export interface SenderOptions {
  /** The hub's URL (default: this origin's `/api/signal`). */
  url?: string | URL;
  room: string;
  /** The video track every viewer receives. */
  track: MediaStreamTrack;
  rtcConfig?: RTCConfiguration;
  /** Adjusts each new transceiver before the offer (e.g. `setCodecPreferences`). */
  prepare?(transceiver: RTCRtpTransceiver, pc: RTCPeerConnection): void;
  onStatus?: StatusListener;
}

/** A running sender. */
export interface Sender {
  /** The viewers with a connection (connected or still connecting). */
  readonly viewers: number;
  close(): void;
}

/** Joins `room` as its sender and offers `track` to every viewer that is or comes there. */
export function startSender(options: SenderOptions): Sender {
  const links = new Map<string, Link>();
  const status = (s: string) => options.onStatus?.(s);
  const drop = (viewer: string) => {
    links.get(viewer)?.close();
    links.delete(viewer);
  };
  const offer = async (viewer: string) => {
    drop(viewer);
    const link = new Link(options.rtcConfig, signal, viewer);
    links.set(viewer, link);
    const transceiver = link.pc.addTransceiver(options.track, {
      direction: "sendonly",
    });
    options.prepare?.(transceiver, link.pc);
    link.pc.onconnectionstatechange = () =>
      status(`viewer ${viewer.slice(0, 8)}: ${link.pc.connectionState}`);
    await link.pc.setLocalDescription(await link.pc.createOffer());
    await signal.send(viewer, {
      type: "offer",
      sdp: link.pc.localDescription!.sdp,
    });
  };
  const offerSafely = (viewer: string) =>
    offer(viewer).catch((err) => status(`offer to ${viewer.slice(0, 8)} failed: ${err}`));

  const signal = connectSignal({
    url: options.url,
    room: options.room,
    role: "sender",
    onWelcome(peers) {
      status(`in room "${options.room}" as sender`);
      for (const peer of peers) {
        if (peer.role === "viewer") offerSafely(peer.id);
      }
    },
    onJoin(peer) {
      if (peer.role === "viewer") offerSafely(peer.id);
    },
    onLeave: drop,
    onMessage(from, data: PeerMessage) {
      const link = links.get(from);
      if (data.type === "restart") offerSafely(from);
      else if (data.type === "answer") {
        link?.remote({ type: "answer", sdp: data.sdp }).catch(() => {});
      } else if (data.type === "candidate") link?.candidate(data.candidate);
    },
    onDisconnect: () => status("signalling dropped; reconnecting"),
  });

  return {
    get viewers() {
      return links.size;
    },
    close() {
      for (const viewer of [...links.keys()]) drop(viewer);
      signal.close();
    },
  };
}

/** Options for {@link startViewer}. */
export interface ViewerOptions {
  url?: string | URL;
  room: string;
  rtcConfig?: RTCConfiguration;
  /** A remote track arrived on a new connection (attach the encoded-frame tap here). */
  onTrack(event: RTCTrackEvent, pc: RTCPeerConnection): void;
  /** The connection in use closed or was replaced (stop reading its receiver). */
  onClosed?(): void;
  onStatus?: StatusListener;
}

/** A running viewer. */
export interface Viewer {
  /** Asks the sender for a fresh connection (it starts with a key frame). */
  restart(): void;
  close(): void;
}

/** Joins `room` as a viewer and answers the sender's offers. */
export function startViewer(options: ViewerOptions): Viewer {
  let link: Link | null = null;
  let sender: string | null = null;
  const status = (s: string) => options.onStatus?.(s);
  const drop = () => {
    if (!link) return;
    link.close();
    link = null;
    options.onClosed?.();
  };
  const answer = async (from: string, sdp: string) => {
    drop();
    sender = from;
    const current = new Link(options.rtcConfig, signal, from);
    link = current;
    current.pc.ontrack = (e) => options.onTrack(e, current.pc);
    current.pc.onconnectionstatechange = () => status(`connection: ${current.pc.connectionState}`);
    await current.remote({ type: "offer", sdp });
    await current.pc.setLocalDescription(await current.pc.createAnswer());
    await signal.send(from, {
      type: "answer",
      sdp: current.pc.localDescription!.sdp,
    });
  };

  const signal = connectSignal({
    url: options.url,
    room: options.room,
    role: "viewer",
    onWelcome(peers) {
      status(
        peers.some((p) => p.role === "sender")
          ? "sender found; waiting for its offer"
          : `waiting for a sender in room "${options.room}"`,
      );
    },
    onJoin(peer) {
      if (peer.role === "sender") {
        status("sender joined; waiting for its offer");
      }
    },
    onLeave(id) {
      if (id !== sender) return;
      sender = null;
      drop();
      status(`sender left; waiting for a sender in room "${options.room}"`);
    },
    onMessage(from, data) {
      if (data.type === "offer") {
        answer(from, data.sdp).catch((err) => status(`answer failed: ${err}`));
      } else if (data.type === "candidate" && from === sender) {
        link?.candidate(data.candidate);
      }
    },
    onDisconnect: () => status("signalling dropped; reconnecting"),
  });

  return {
    restart() {
      if (sender) signal.send(sender, { type: "restart" }).catch(() => {});
    },
    close() {
      drop();
      signal.close();
    },
  };
}
