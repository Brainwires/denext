// `usePresence` across instances: each Live hub publishes a snapshot of ITS peers in a room over
// the channel transport (`kind: "presence"`) whenever that membership changes, and again on a
// heartbeat; every other hub keeps the latest snapshot per (room, instance) and merges those peers
// into the `presence-state` it sends its own members. An instance that stops publishes empty
// snapshots; one that dies stops heartbeating, and its peers are dropped after `DEAD_AFTER_MS`.
// When a hub first hears from an instance in a room it also has members in, it answers with its
// own snapshot, so a newcomer sees everyone at once instead of on the next heartbeat.
//
// Authorization stays local: a peer joins a room on the instance holding its socket, after that
// instance's `canJoinRoom`; remote snapshots come from other instances of the same app through the
// transport the app installed, and are only ever relayed to members this instance admitted.

import type { ChannelEvent } from "../runtime/channel.ts";
import type { LivePeer } from "../runtime/live-protocol.ts";

/** How often a hub republishes the rooms it has members in. */
export const PRESENCE_HEARTBEAT_MS = 10_000;
/** A snapshot not refreshed for this long is from a dead instance: dropped. */
export const PRESENCE_DEAD_AFTER_MS = 35_000;

/** One instance's latest snapshot of a room. */
interface Snapshot {
  peers: LivePeer[];
  seq: number;
  seenAt: number;
}

/** What {@link RemotePresence.apply} found. */
export interface PresenceApplied {
  /** The room the event was about. */
  room: string;
  /** The first snapshot from that instance for that room (answer with our own). */
  newcomer: boolean;
}

/** The peers of a snapshot, or `undefined` when it is not a well-formed peer list. */
function parsePeers(encoded: string | undefined, max: number): LivePeer[] | undefined {
  if (encoded === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const peers = value.filter((p): p is LivePeer =>
    typeof p === "object" && p !== null && typeof (p as LivePeer).id === "string"
  );
  return peers.slice(0, max);
}

/** The other instances' peers, per room. */
export class RemotePresence {
  readonly #rooms = new Map<string, Map<string, Snapshot>>();

  /**
   * Record a foreign `presence` event.
   *
   * @param ev The event.
   * @param maxPeers The most peers one instance may contribute to a room.
   * @param now The current time (ms).
   * @returns The room and whether the instance is new there, or `undefined` for a stale or
   *   malformed event.
   */
  apply(ev: ChannelEvent, maxPeers: number, now = Date.now()): PresenceApplied | undefined {
    const peers = parsePeers(ev.encoded, maxPeers);
    if (!peers || !ev.key) return undefined;
    let room = this.#rooms.get(ev.key);
    const previous = room?.get(ev.instance);
    if (previous && ev.seq <= previous.seq) return undefined; // reordered: keep the newer
    if (peers.length === 0) {
      room?.delete(ev.instance);
      if (room?.size === 0) this.#rooms.delete(ev.key);
      return { room: ev.key, newcomer: false };
    }
    if (!room) this.#rooms.set(ev.key, room = new Map());
    room.set(ev.instance, { peers, seq: ev.seq, seenAt: now });
    return { room: ev.key, newcomer: !previous };
  }

  /**
   * The live remote peers of a room.
   *
   * @param room The room.
   * @returns Every other instance's peers there.
   */
  peers(room: string): LivePeer[] {
    const out: LivePeer[] = [];
    for (const snapshot of this.#rooms.get(room)?.values() ?? []) out.push(...snapshot.peers);
    return out;
  }

  /**
   * Drop the snapshots of instances that stopped heartbeating.
   *
   * @param now The current time (ms).
   * @returns The rooms that changed.
   */
  prune(now = Date.now()): string[] {
    const changed: string[] = [];
    for (const [room, byInstance] of this.#rooms) {
      for (const [instance, snapshot] of byInstance) {
        if (now - snapshot.seenAt <= PRESENCE_DEAD_AFTER_MS) continue;
        byInstance.delete(instance);
        if (!changed.includes(room)) changed.push(room);
      }
      if (byInstance.size === 0) this.#rooms.delete(room);
    }
    return changed;
  }

  /** Forget everything (hub teardown). */
  clear(): void {
    this.#rooms.clear();
  }
}
