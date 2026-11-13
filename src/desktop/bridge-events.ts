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
 * A NON-RETAINED event (`append(…, { retain: false })`: a menu click, a focus change, a close
 * request — a one-shot action for the page that is live now) is kept apart, in a buffer of its own,
 * only so a live page whose stream was interrupted resumes it with `Last-Event-ID`. A connection
 * without a cursor is a page that subscribes now (a new page, a reload): it never gets them, so an
 * old click is not acted on again, and they never evict the retained events.
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
  /** The one window it is for (`undefined`: every window). */
  readonly target?: string;
}

/** How {@linkcode DesktopEventLog.append} keeps an event. */
export interface DesktopEventAppendOptions {
  /**
   * `false`: a one-shot action for the live pages. It is replayed only to a stream that resumes
   * after it (`Last-Event-ID`), never to a page that subscribes later. Default `true`.
   */
  readonly retain?: boolean;
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
  /** The non-retained events, kept only for a resuming stream (same bound, its own). */
  #transient: LoggedEvent[] = [];
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
   * @param cap The capability the event belongs to.
   * @param event The event name.
   * @param data Its payload (JSON-serializable).
   * @param target The one window it is for (a window id); every window's stream when omitted.
   * @param options `retain: false` for a one-shot action (see {@linkcode DesktopEventAppendOptions}).
   */
  append(
    cap: string,
    event: string,
    data: unknown,
    target?: string,
    options?: DesktopEventAppendOptions,
  ): number {
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
    const logged: LoggedEvent = {
      id: ++this.#nextId,
      json,
      ...(target !== undefined ? { target } : {}),
    };
    const buffer = options?.retain === false ? this.#transient : this.#buffer;
    buffer.push(logged);
    if (buffer.length > this.#max) buffer.shift();
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

  /**
   * The events after `afterId`, in id order: a resuming stream's retained and non-retained ones;
   * every retained one (and no other) when `afterId` is undefined.
   */
  #replayFrom(afterId: number | undefined): LoggedEvent[] {
    if (afterId === undefined) return [...this.#buffer];
    return [...this.#buffer, ...this.#transient]
      .filter((e) => e.id > afterId)
      .sort((a, b) => a.id - b.id);
  }

  /**
   * Open an SSE body for a subscriber: replay the backlog (after `lastEventId`, non-retained events
   * included; or every retained event without one), then stream new events live, with periodic heartbeats. The returned stream is closed by
   * cancelling it (the page navigating away or unsubscribing), which detaches the sink and stops
   * the heartbeat.
   *
   * @param lastEventId The `Last-Event-ID` the page sent, if any (a non-negative integer).
   * @param window The subscriber's window: it gets the events for every window and its own
   *   (default `"main"`).
   * @returns A `text/event-stream` body.
   */
  open(lastEventId: string | null, window: string = "main"): ReadableStream<Uint8Array> {
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
          if (event.target !== undefined && event.target !== window) return;
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
