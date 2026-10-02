/**
 * The desktop bridge's server-to-page event channel: a `GET /_denext/desktop/events` SSE stream
 * (see {@link ./bridge.ts} for the gate) fed by {@linkcode DesktopEventLog}. Capabilities push
 * events with {@link DesktopCapCtx.emit}; the page reads them with `denext/desktop/client`'s
 * `onDesktopEvent`.
 *
 * Delivery is AT-LEAST-ONCE. Each event gets a monotonic id. A page reconnect sends
 * `Last-Event-ID`, and the log replays everything after it that is still buffered; a fresh
 * connection with no id replays the whole retained buffer, so a launch event (a deep link or
 * notification tap that STARTED the app, emitted before the page ever subscribed) is not lost.
 * The buffer is bounded and drops oldest, so a client that was away longer than the buffer spans
 * misses the gap — capability consumers must tolerate a repeat and a rare miss.
 *
 * This module is RUNTIME-ONLY (imported by the desktop entry, never a client bundle).
 *
 * @module
 */

/** One retained event. */
interface LoggedEvent {
  readonly id: number;
  /** The SSE `data:` payload, `{ cap, event, data }` serialized once at append. */
  readonly json: string;
}

/** A live subscriber's sink: called with each new event once it is connected. */
type Sink = (event: LoggedEvent) => void;

/** How many recent events are retained for replay (drop-oldest past this). */
const DEFAULT_BUFFER = 256;
/** Heartbeat interval: a comment line that keeps the connection and proxies from idling out. */
const HEARTBEAT_MS = 15_000;

/**
 * A bounded, replayable log of desktop bridge events. One instance per running app (created by the
 * bridge); exported as a type so `DesktopBridge["events"]` is documentable.
 */
export class DesktopEventLog {
  #nextId = 0;
  #buffer: LoggedEvent[] = [];
  #sinks = new Set<Sink>();
  readonly #max: number;

  /**
   * Create an empty log.
   *
   * @param maxBuffered How many recent events to keep for replay (at least 1).
   */
  constructor(maxBuffered: number = DEFAULT_BUFFER) {
    this.#max = Math.max(1, maxBuffered);
  }

  /**
   * Append an event: assign the next id, retain it (evicting the oldest past the cap), and hand it
   * to every connected sink. Returns the assigned id.
   *
   * @throws {TypeError} when `data` is not JSON-serializable (a `BigInt`, a cycle). It is serialized
   *   here, before anything is retained, so such an event can neither poison the replay buffer
   *   (every later subscriber's backlog) nor silently detach the live subscribers.
   */
  append(cap: string, event: string, data: unknown): number {
    let json: string;
    try {
      json = JSON.stringify({ cap, event, data });
    } catch (err) {
      throw new TypeError(
        `desktop event "${cap}/${event}" data is not JSON-serializable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const logged: LoggedEvent = { id: ++this.#nextId, json };
    this.#buffer.push(logged);
    if (this.#buffer.length > this.#max) this.#buffer.shift();
    for (const sink of [...this.#sinks]) {
      try {
        sink(logged);
      } catch {
        // A failed enqueue (a closed stream) must not stop delivery to the others; the stream's
        // own cancel path removes the sink.
      }
    }
    return logged.id;
  }

  /** The retained events after `afterId` (all of them when `afterId` is undefined). */
  #replayFrom(afterId: number | undefined): LoggedEvent[] {
    if (afterId === undefined) return [...this.#buffer];
    return this.#buffer.filter((e) => e.id > afterId);
  }

  /**
   * Open an SSE body for a subscriber: replay the retained backlog (after `lastEventId`, or all of
   * it), then stream new events live, with periodic heartbeats. The returned stream is closed by
   * cancelling it (the page navigating away or unsubscribing), which detaches the sink and stops
   * the heartbeat.
   *
   * @param lastEventId The `Last-Event-ID` the page sent, if any (a non-negative integer).
   * @returns A `text/event-stream` body.
   */
  open(lastEventId: string | null): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const afterId = parseCursor(lastEventId);
    let sink: Sink | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const detach = () => {
      if (sink) this.#sinks.delete(sink);
      sink = undefined;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeat = undefined;
    };
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (event: LoggedEvent) => {
          const frame = `id: ${event.id}\ndata: ${event.json}\n\n`;
          controller.enqueue(encoder.encode(frame));
        };
        // Backlog first (in id order), then attach for live events.
        for (const event of this.#replayFrom(afterId)) send(event);
        sink = (event) => {
          try {
            send(event);
          } catch {
            detach(); // the stream is gone
          }
        };
        this.#sinks.add(sink);
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            detach();
          }
        }, HEARTBEAT_MS);
      },
      cancel: () => detach(),
    });
  }
}

/** Parse a `Last-Event-ID` into a cursor, or `undefined` when it is absent or not a whole number. */
function parseCursor(lastEventId: string | null): number | undefined {
  if (lastEventId === null || !/^\d+$/.test(lastEventId)) return undefined;
  return Number(lastEventId);
}
