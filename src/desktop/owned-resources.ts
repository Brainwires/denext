/**
 * Per-window backend resources for desktop extensions (`denext/desktop`): a registry of long-lived
 * things an extension keeps in the Deno process for one window (a PTY, a file watcher, a
 * subprocess), keyed by an id the extension picks. It answers three questions an extension would
 * otherwise get wrong:
 *
 * - **Who hears it.** {@linkcode OwnedResources.emit} sends a resource's events to its owner
 *   window only, never to every window, as `host.emit(event, { id, data }, { window: owner })`.
 * - **What happens when the window goes.** With `onOwnerClosed: "dispose"` (the default) closing
 *   the owner disposes its resources; with `"detach"` they stay alive with no owner, and a window
 *   that comes back (the same `key`) finds them with {@linkcode OwnedResources.ownedBy} and takes
 *   them over with {@linkcode OwnedResources.attach}, which returns what was emitted meanwhile.
 * - **Quitting.** When the app quits (or a window closes because the app is quitting), every
 *   resource is disposed, whatever the policy, with each dispose bounded in time.
 *
 * The module uses no runtime API (no `Deno.*`): the host is a structural type, so it runs under a
 * fake host in a test.
 *
 * @module
 */

import { DesktopCapError, type DesktopEmitOptions } from "./extension.ts";

/** A window as {@linkcode OwnedResourcesHost} describes it. */
export interface OwnedResourcesWindow {
  /** The window id (`"main"`, `"panel"`, or an id `openWindow` returned). */
  readonly id: string;
  /** What kind of window it is. */
  readonly kind: "main" | "panel" | "window";
  /** The app's own key for the window (`openWindow({ key })`), when it has one. */
  readonly key?: string;
}

/** A closed window, as {@linkcode OwnedResourcesHost.onWindowClosed} reports it. */
export interface OwnedResourcesClosedWindow extends OwnedResourcesWindow {
  /** The window closed because the app is quitting. */
  readonly appQuitting: boolean;
}

/**
 * The part of an extension's `setup(host)` host that {@linkcode OwnedResources.connect} uses: its
 * `emit`, the window lifecycle hooks and the open windows.
 */
export interface OwnedResourcesHost {
  /** Push an event to the pages (here always to one window). */
  emit(event: string, data: unknown, options?: DesktopEmitOptions): void;
  /** Run `fn` after a window closes; returns the unsubscribe. */
  onWindowClosed(fn: (info: OwnedResourcesClosedWindow) => void | Promise<void>): () => void;
  /** Run `fn` while the app quits (the host bounds how long it waits); returns the unsubscribe. */
  onAppQuit(fn: () => void | Promise<void>): () => void;
  /** The windows open now. */
  windows(): readonly OwnedResourcesWindow[];
}

/** Options for {@linkcode createOwnedResources}. */
export interface OwnedResourcesOptions<T> {
  /**
   * What closing a resource's owner window does: `"dispose"` (the default) disposes it;
   * `"detach"` keeps it alive with no owner, remembering the window's `key`, so a window with that
   * key can find it with {@linkcode OwnedResources.ownedBy} and {@linkcode OwnedResources.attach}
   * it. `"detach"` is for a resource that should outlive its window (a terminal session the user
   * reopens); pair it with `replay`, or a reattached window misses what happened while it was gone.
   * A detached resource lives until it is removed or the app quits, so an extension that detaches
   * should also give the user a way to end one ({@linkcode OwnedResources.detached} lists them).
   */
  readonly onOwnerClosed?: "detach" | "dispose";
  /**
   * Release a resource (kill the PTY, close the watcher). Called once per resource: from
   * {@linkcode OwnedResources.remove}, on its owner's close under `"dispose"`, and for every
   * resource when the app quits. It is awaited, at most `disposeTimeoutMs`; a throw or a rejection
   * is logged and never stops the others.
   */
  readonly dispose: (resource: T, id: string) => void | Promise<void>;
  /**
   * Keep each resource's recent events for {@linkcode OwnedResources.attach}: a ring buffer of
   * at most `maxBytes` per resource (see {@linkcode OwnedResources.emit} for how a chunk is
   * measured). No replay is kept when omitted.
   */
  readonly replay?: OwnedResourcesReplayOptions;
  /** The longest one dispose is awaited, in ms (default 5000). */
  readonly disposeTimeoutMs?: number;
}

/** The replay buffer's options ({@linkcode OwnedResourcesOptions.replay}). */
export interface OwnedResourcesReplayOptions {
  /** The most bytes of event `data` kept per resource (a positive integer). */
  readonly maxBytes: number;
  /**
   * The event names to keep (say `["data", "exit"]`, leaving out a high-rate `"progress"`); every
   * event when omitted. An event not listed is still sent to the owner, just not kept.
   */
  readonly events?: readonly string[];
  /**
   * The size of one chunk of event `data`, in the same unit as `maxBytes` (rows, entries, bytes).
   * Defaults to the byte length described at {@linkcode OwnedResources.emit}. Set it, with
   * {@linkcode OwnedResourcesReplayOptions.cut}, for a resource whose chunks are structured
   * objects. It must be a non-negative number and must not throw.
   */
  readonly measure?: (chunk: unknown) => number;
  /**
   * Shrink a chunk larger than `maxBytes` to at most `keepBytes` (in `measure`'s unit), keeping
   * whatever tail the resource finds useful. Replaces the default cut of an oversized string or
   * bytes; without it an oversized structured chunk is dropped and counted in
   * {@linkcode OwnedResourceAttachment.dropped}. A result still over the budget is dropped too.
   */
  readonly cut?: (chunk: unknown, keepBytes: number) => unknown;
}

/** One retained event: what {@linkcode OwnedResources.attach} replays. */
export interface OwnedResourceReplayEntry {
  /** The event name, as given to {@linkcode OwnedResources.emit}. */
  readonly event: string;
  /** Its data (bytes as a copy; an oversized string or bytes cut to its tail). */
  readonly data: unknown;
}

/** Options for {@linkcode OwnedResources.add}. */
export interface OwnedResourceAddOptions {
  /** The window that owns the resource: the calling handler's `ctx.windowId` (`"main"` when absent). */
  readonly owner?: string;
}

/** What {@linkcode OwnedResources.attach} returns. */
export interface OwnedResourceAttachment {
  /** The resource's retained events, oldest first (empty with no `replay`). */
  readonly replay: readonly OwnedResourceReplayEntry[];
  /**
   * How many whole chunks the replay has lost since the resource started: evicted to make room, or
   * too large to keep. `0` means nothing was lost to eviction. It only grows, so a page that
   * attaches twice can tell whether more was lost in between.
   */
  readonly dropped: number;
  /**
   * `true` when the oldest retained entry is a single chunk larger than `maxBytes` that was cut,
   * so the replay starts in the middle of it. It turns `false` again once newer output evicts
   * that chunk (which is then counted in `dropped`).
   */
  readonly truncated: boolean;
}

/** One registered resource. */
interface Entry<T> {
  readonly resource: T;
  owner: string | undefined;
  /** The key of the window that last owned it, kept while it is detached. */
  lastKey: string | undefined;
  chunks: { event: string; data: unknown; bytes: number; cut: boolean }[];
  bytes: number;
  /** Whole chunks evicted or too large to keep, since the resource started. */
  dropped: number;
}

const DEFAULT_DISPOSE_TIMEOUT_MS = 5000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A registry of per-window resources (build it with {@linkcode createOwnedResources}). Keep it at
 * module scope in the extension and call {@linkcode OwnedResources.connect} from the extension's
 * `setup(host)`.
 *
 * @typeParam T The resource type (a PTY session, a watcher).
 */
export class OwnedResources<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #policy: "detach" | "dispose";
  readonly #dispose: (resource: T, id: string) => void | Promise<void>;
  readonly #maxBytes: number | undefined;
  readonly #measure: ((chunk: unknown) => number) | undefined;
  readonly #cut: ((chunk: unknown, keepBytes: number) => unknown) | undefined;
  readonly #replayEvents: ReadonlySet<string> | undefined;
  readonly #timeoutMs: number;
  #host: OwnedResourcesHost | undefined;

  /**
   * Prefer {@linkcode createOwnedResources}.
   *
   * @param options The policy, the dispose function and the replay size.
   * @throws {RangeError} when `replay.maxBytes` is not a positive integer.
   */
  constructor(options: OwnedResourcesOptions<T>) {
    const replay = options.replay;
    checkMaxBytes(replay?.maxBytes);
    this.#policy = options.onOwnerClosed ?? "dispose";
    this.#dispose = options.dispose;
    this.#maxBytes = replay?.maxBytes;
    this.#measure = replay?.measure;
    this.#cut = replay?.cut;
    this.#replayEvents = replay?.events && new Set(replay.events);
    this.#timeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
  }

  /**
   * Wire the registry to the extension's host: events go out through `host.emit`, a window's close
   * applies the `onOwnerClosed` policy to its resources, and the app's quit disposes them all.
   * Call it from the extension's `setup(host)`.
   *
   * @param host The extension's host.
   * @returns The unsubscribe: it stops the close and quit handling, and later events are kept for
   *   replay but sent nowhere.
   * @throws {Error} when the registry is already connected.
   */
  connect(host: OwnedResourcesHost): () => void {
    if (this.#host !== undefined) throw new Error("owned resources are already connected");
    this.#host = host;
    const offClose = host.onWindowClosed((info) => this.#ownerClosed(info));
    const offQuit = host.onAppQuit(() => this.disposeAll());
    return () => {
      offClose();
      offQuit();
      if (this.#host === host) this.#host = undefined;
    };
  }

  /**
   * Register a resource under `id`, owned by `options.owner` (default `"main"`).
   *
   * @param id The extension's id for it (unique in this registry).
   * @param resource The resource.
   * @param options The owner window.
   * @throws {Error} when `id` is already registered.
   */
  add(id: string, resource: T, options: OwnedResourceAddOptions = {}): void {
    if (this.#entries.has(id)) throw new Error(`owned resource "${id}" already exists`);
    this.#entries.set(id, {
      resource,
      owner: options.owner ?? "main",
      lastKey: undefined,
      chunks: [],
      bytes: 0,
      dropped: 0,
    });
  }

  /** The resource registered under `id`, or `undefined`. */
  get(id: string): T | undefined {
    return this.#entries.get(id)?.resource;
  }

  /** The window that owns `id`: `undefined` when it is detached or unknown. */
  owner(id: string): string | undefined {
    return this.#entries.get(id)?.owner;
  }

  /**
   * Send one of a resource's events to its owner window ONLY, as
   * `host.emit(event, { id, data }, { window: owner })` (never to every window), and append
   * `{ event, data }` to its replay (unless `replay.events` leaves the event out), even while it is
   * detached (then it is only appended). `event` must be one the extension declared, as for
   * `host.emit`.
   *
   * Only `data` counts toward `maxBytes` (the event name is free). The replay measures it as the UTF-8 length of a string, the `byteLength` of an
   * `ArrayBuffer` or a typed array / `DataView`, and otherwise the UTF-8 length of its JSON. Past
   * `maxBytes` it drops the OLDEST whole chunks. A single chunk larger than `maxBytes` keeps its
   * last `maxBytes` bytes when it is a string (cut on a character boundary) or bytes (as a
   * `Uint8Array`); any other oversized chunk is not retained. `replay.measure` replaces the
   * measuring and `replay.cut` the cutting (for structured chunks). {@linkcode OwnedResources.attach}
   * reports the loss as `dropped` and `truncated`. Bytes are copied when retained (an
   * `ArrayBuffer` as an `ArrayBuffer`, any view as a `Uint8Array`), so a reader may reuse its
   * buffer.
   *
   * An `id` that is not registered (a resource removed while its reader was still running) is a
   * no-op that returns `false`.
   *
   * @param id The resource.
   * @param event The event name.
   * @param data The payload (JSON-serializable, or bytes the host can carry).
   * @returns Whether `id` is registered.
   */
  emit(id: string, event: string, data: unknown): boolean {
    const entry = this.#entries.get(id);
    if (entry === undefined) return false;
    if (entry.owner !== undefined && this.#host !== undefined) {
      this.#host.emit(event, { id, data }, { window: entry.owner });
    }
    if (this.#maxBytes !== undefined && (this.#replayEvents?.has(event) ?? true)) {
      this.#retain(entry, event, data, this.#maxBytes);
    }
    return true;
  }

  /**
   * Give `id` to `windowId` (a detached resource, a move to another window, or the same window
   * after a reload): later events go to that window, and the result carries the retained replay.
   * The replay is kept, so a later attach gets it again.
   *
   * @param id The resource.
   * @param windowId The new owner (the calling handler's `ctx.windowId`).
   * @returns The replay.
   * @throws {DesktopCapError} `not_found` when `id` is not registered.
   */
  attach(id: string, windowId: string): OwnedResourceAttachment {
    const entry = this.#entries.get(id);
    if (entry === undefined) {
      throw new DesktopCapError("not_found", `no resource "${id}"`, { status: 404 });
    }
    entry.owner = windowId;
    entry.lastKey = undefined;
    return {
      replay: entry.chunks.map(({ event, data }) => ({ event, data })),
      dropped: entry.dropped,
      truncated: entry.chunks[0]?.cut === true,
    };
  }

  /**
   * Take `id` away from its owner without disposing it: its events are only retained until a
   * window attaches. The owner's key (from the host's open windows) is remembered for
   * {@linkcode OwnedResources.ownedBy}.
   *
   * @returns Whether `id` is registered.
   */
  detach(id: string): boolean {
    const entry = this.#entries.get(id);
    if (entry === undefined) return false;
    if (entry.owner !== undefined) {
      const owner = entry.owner;
      entry.lastKey = this.#host?.windows().find((w) => w.id === owner)?.key;
      entry.owner = undefined;
    }
    return true;
  }

  /**
   * Unregister `id` and dispose it (awaited, bounded; a failure is logged).
   *
   * @returns Whether `id` was registered.
   */
  async remove(id: string): Promise<boolean> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return false;
    this.#entries.delete(id);
    await this.#disposeOne(id, entry.resource);
    return true;
  }

  /** The ids of the resources with no owner. */
  detached(): string[] {
    return [...this.#entries].filter(([, e]) => e.owner === undefined).map(([id]) => id);
  }

  /**
   * The ids of the resources `windowIdOrKey` owns now, plus the detached ones whose last owner had
   * that key: what a window reopened with the same `key` should restore.
   */
  ownedBy(windowIdOrKey: string): string[] {
    return [...this.#entries]
      .filter(([, e]) =>
        e.owner === undefined ? e.lastKey === windowIdOrKey : e.owner === windowIdOrKey
      )
      .map(([id]) => id);
  }

  /** Unregister and dispose every resource (the app's quit does this). */
  async disposeAll(): Promise<void> {
    const all = [...this.#entries];
    this.#entries.clear();
    await Promise.all(all.map(([id, e]) => this.#disposeOne(id, e.resource)));
  }

  async #ownerClosed(info: OwnedResourcesClosedWindow): Promise<void> {
    if (info.appQuitting) return await this.disposeAll();
    const owned = [...this.#entries].filter(([, e]) => e.owner === info.id);
    if (this.#policy === "detach") {
      for (const [, entry] of owned) {
        entry.owner = undefined;
        entry.lastKey = info.key;
      }
      return;
    }
    for (const [id] of owned) this.#entries.delete(id);
    await Promise.all(owned.map(([id, e]) => this.#disposeOne(id, e.resource)));
  }

  async #disposeOne(id: string, resource: T): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.#timeoutMs);
    });
    try {
      const done = Promise.resolve().then(() => this.#dispose(resource, id));
      if (await Promise.race([done, timeout]) === "timeout") {
        console.error(`owned resource "${id}": dispose did not finish in ${this.#timeoutMs} ms`);
      }
    } catch (err) {
      console.error(`owned resource "${id}": dispose failed:`, err);
    } finally {
      clearTimeout(timer);
    }
  }

  #retain(entry: Entry<T>, event: string, data: unknown, maxBytes: number): void {
    const chunk = boundedChunk(data, maxBytes, this.#measure, this.#cut);
    if (chunk === undefined) {
      entry.dropped++;
      return;
    }
    entry.chunks.push({ event, ...chunk });
    entry.bytes += chunk.bytes;
    while (entry.bytes > maxBytes) {
      entry.bytes -= entry.chunks.shift()!.bytes;
      entry.dropped++;
    }
  }
}

/**
 * Build a registry of per-window resources for a desktop extension.
 *
 * @example
 * ```ts
 * // desktop/extensions/terminal.ts: runs in the Deno process only
 * import { createOwnedResources, defineDesktopExtension } from "denext/desktop";
 * const sessions = createOwnedResources<Pty>({
 *   onOwnerClosed: "detach",
 *   dispose: (pty) => pty.kill(),
 *   replay: { maxBytes: 256 * 1024, events: ["output", "exit"] },
 * });
 * export default defineDesktopExtension({
 *   name: "terminal",
 *   events: ["output", "exit"],
 *   setup: (host) => sessions.connect(host),
 *   methods: {
 *     open: {
 *       handler: (_args, ctx) => {
 *         const id = crypto.randomUUID();
 *         const pty = spawnPty(); // your PTY
 *         sessions.add(id, pty, { owner: ctx.windowId });
 *         pty.onData((text) => sessions.emit(id, "output", text));
 *         pty.onExit((code) => sessions.emit(id, "exit", code));
 *         return id;
 *       },
 *     },
 *     resume: {
 *       handler: (args, ctx) => sessions.attach((args as { id: string }).id, ctx.windowId ?? "main"),
 *     },
 *   },
 * });
 * ```
 *
 * @typeParam T The resource type.
 * @param options The close policy, the dispose function and the replay size.
 * @returns The registry.
 */
export function createOwnedResources<T>(options: OwnedResourcesOptions<T>): OwnedResources<T> {
  return new OwnedResources(options);
}

/** Refuse a `replay.maxBytes` that is set and not a positive integer. */
function checkMaxBytes(maxBytes: number | undefined): void {
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 1)) {
    throw new RangeError(`replay.maxBytes must be a positive integer, got ${maxBytes}`);
  }
}

/** A chunk ready to retain (bytes copied, an oversized chunk cut), or `undefined` to drop it. */
function boundedChunk(
  data: unknown,
  maxBytes: number,
  measure: ((chunk: unknown) => number) | undefined,
  cut: ((chunk: unknown, keepBytes: number) => unknown) | undefined,
): { data: unknown; bytes: number; cut: boolean } | undefined {
  const sizeOf = (chunk: unknown): number => measure ? measure(chunk) : defaultSize(chunk);
  const size = sizeOf(data);
  if (size <= maxBytes) return { data: copyBytes(data), bytes: size, cut: false };
  const shrunk = cut ? cut(data, maxBytes) : cutTail(data, maxBytes);
  if (shrunk === undefined) return undefined;
  const bytes = sizeOf(shrunk);
  return bytes > maxBytes ? undefined : { data: shrunk, bytes, cut: true };
}

/** The default measure: UTF-8 length of a string, `byteLength` of bytes, else of the JSON. */
function defaultSize(data: unknown): number {
  if (typeof data === "string") return encoder.encode(data).byteLength;
  const bytes = asBytes(data);
  if (bytes !== undefined) return bytes.byteLength;
  return encoder.encode(JSON.stringify(data) ?? "").byteLength;
}

/** A copy of bytes (so a reader may reuse its buffer); anything else as it is. */
function copyBytes(data: unknown): unknown {
  const bytes = asBytes(data);
  if (bytes === undefined) return data;
  return data instanceof ArrayBuffer ? bytes.slice().buffer : bytes.slice();
}

/** The default cut: the last `maxBytes` of a string or bytes; `undefined` for any other chunk. */
function cutTail(data: unknown, maxBytes: number): unknown {
  if (typeof data === "string") return boundedString(data, maxBytes).data;
  const bytes = asBytes(data);
  if (bytes === undefined) return undefined;
  const kept = bytes.subarray(bytes.byteLength - maxBytes);
  return data instanceof ArrayBuffer ? kept.slice().buffer : kept.slice();
}

/** A string chunk, cut to its last `maxBytes` UTF-8 bytes on a character boundary. */
function boundedString(text: string, maxBytes: number): { data: string; bytes: number } {
  const utf8 = encoder.encode(text);
  if (utf8.byteLength <= maxBytes) return { data: text, bytes: utf8.byteLength };
  let start = utf8.byteLength - maxBytes;
  while (start < utf8.byteLength && (utf8[start] & 0xc0) === 0x80) start++; // a continuation byte
  return { data: decoder.decode(utf8.subarray(start)), bytes: utf8.byteLength - start };
}

/** The bytes of an `ArrayBuffer` or an `ArrayBuffer` view, else `undefined`. */
function asBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return undefined;
}
