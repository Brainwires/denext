// The DevTools' server-side tap on Live: the recent messages of server-held live views, the
// channel pushes the hub fanned out, and the cache entries written. `denext dev` switches it on
// (`enableLiveDevtools`, from the dev handler); until then every `record*` is one boolean check
// and nothing is kept, so a production server records nothing. The panel reads it through the
// dev server's origin-gated `/_denext/dev-live-views` and `/_denext/dev-live` endpoints.
//
// Redacted like the other dev panels: a value's string CONTENTS never leave this module — every
// string inside a model, a message or a payload is reported as `string(n)`; numbers, booleans,
// `null`, object keys and the structure are kept, cut to a few levels and entries. Identifiers
// the developer chose (view ids, channel ids and keys, cache tags and keys) are shown as they are.

/** How many of each record are kept (newest last). */
const LIVE_DEVTOOLS_MAX_RECORDS = 100;

/** How deep, and how many entries per level, a redacted value keeps. */
const MAX_DEPTH = 4;
const MAX_ENTRIES = 20;
/** The longest identifier (a key, a tag) reported. */
const MAX_ID_CHARS = 200;

let enabled = false;

/** Switch recording on (the dev server does, once). */
export function enableLiveDevtools(): void {
  enabled = true;
}

/**
 * Whether recording is on.
 *
 * @returns `true` under `denext dev`.
 */
export function liveDevtoolsEnabled(): boolean {
  return enabled;
}

/** A redacted value: its structure, with every string as `string(n)`. */
export type RedactedValue =
  | number
  | boolean
  | null
  | string
  | RedactedValue[]
  | { [key: string]: RedactedValue };

/**
 * A value as the panel may see it: strings become `string(n)`, other leaves keep their kind
 * (`Date`, `bigint`, `function`, …), and depth and breadth are capped (`…` marks the cut).
 *
 * @param value Any value.
 * @param depth The current depth (callers pass nothing).
 * @returns The redacted value.
 */
export function redactValue(value: unknown, depth = 0): RedactedValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return `string(${value.length})`;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return typeof value; // bigint, symbol, function
  if (depth >= MAX_DEPTH) return "…";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ENTRIES).map((v) => redactValue(v, depth + 1));
    if (value.length > MAX_ENTRIES) items.push(`… ${value.length - MAX_ENTRIES} more`);
    return items;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
  }
  const out: Record<string, RedactedValue> = {};
  const keys = Object.keys(value);
  for (const k of keys.slice(0, MAX_ENTRIES)) {
    out[ident(k)] = redactValue((value as Record<string, unknown>)[k], depth + 1);
  }
  if (keys.length > MAX_ENTRIES) out["…"] = `${keys.length - MAX_ENTRIES} more`;
  return out;
}

/** An identifier, cut to {@link MAX_ID_CHARS}. */
function ident(text: string): string {
  return text.length > MAX_ID_CHARS ? `${text.slice(0, MAX_ID_CHARS - 1)}…` : text;
}

/** Push onto a capped record list. */
function keep<T>(list: T[], entry: T): void {
  list.push(entry);
  if (list.length > LIVE_DEVTOOLS_MAX_RECORDS) list.shift();
}

/** One batch of messages a live view's `update` ran. */
export interface ViewMessageRecord {
  /** Epoch ms. */
  at: number;
  /** The view id. */
  view: string;
  /** The instance id. */
  iid: string;
  /** The messages, redacted. */
  msgs: RedactedValue[];
}

/** One channel event the hub fanned out. */
export interface ChannelPushRecord {
  /** Epoch ms. */
  at: number;
  /** `publish` or `revoke`. */
  kind: string;
  /** The channel id. */
  channel: string;
  /** The key. */
  key: string;
  /** The payload's JSON size in characters (0 for a revoke). */
  bytes: number;
  /** The payload, redacted (`null` for a revoke). */
  payload: RedactedValue;
  /** Subscribers on this instance when it arrived. */
  subscribers: number;
}

/** One cache entry written. */
export interface CacheEntryRecord {
  /** Epoch ms. */
  at: number;
  /** `data` (`unstable_cache` / `"use cache"`) or `page` (ISR). */
  kind: "data" | "page";
  /** The cache key. */
  key: string;
  /** Its tags. */
  tags: string[];
  /** Approximate size in characters (the value's JSON, or the page body). */
  bytes: number;
  /** Epoch ms it expires at, or `null` for never. */
  expiresAt: number | null;
}

const viewMessages: ViewMessageRecord[] = [];
const channelPushes: ChannelPushRecord[] = [];
const cacheEntries: CacheEntryRecord[] = [];

/**
 * Record the messages a view's `update` ran (dev only).
 *
 * @param view The view id.
 * @param iid The instance id.
 * @param msgs The messages.
 */
export function recordViewMessages(view: string, iid: string, msgs: readonly unknown[]): void {
  if (!enabled || msgs.length === 0) return;
  keep(viewMessages, {
    at: Date.now(),
    view,
    iid,
    msgs: msgs.slice(0, MAX_ENTRIES).map((m) => redactValue(m)),
  });
}

/**
 * Record a channel event the hub delivered (dev only).
 *
 * @param ev The event (`publish` and `revoke` are kept).
 * @param subscribers Subscribers on this instance for its channel and key.
 */
export function recordChannelPush(
  ev: { kind: string; channelId: string; key: string; encoded?: string },
  subscribers: number,
): void {
  if (!enabled || (ev.kind !== "publish" && ev.kind !== "revoke")) return;
  let payload: RedactedValue = null;
  if (ev.encoded !== undefined) {
    try {
      payload = redactValue(JSON.parse(ev.encoded));
    } catch {
      payload = "unparseable";
    }
  }
  keep(channelPushes, {
    at: Date.now(),
    kind: ev.kind,
    channel: ident(ev.channelId),
    key: ident(ev.key),
    bytes: ev.encoded?.length ?? 0,
    payload,
    subscribers,
  });
}

/**
 * Record a cache entry written (dev only).
 *
 * @param entry What was written (`at` is added).
 */
export function recordCacheEntry(entry: Omit<CacheEntryRecord, "at">): void {
  if (!enabled) return;
  keep(cacheEntries, {
    ...entry,
    at: Date.now(),
    key: ident(entry.key),
    tags: entry.tags.slice(0, MAX_ENTRIES).map(ident),
  });
}

/**
 * The recorded view messages, newest last.
 *
 * @returns A copy.
 */
export function viewMessageRecords(): ViewMessageRecord[] {
  return [...viewMessages];
}

/**
 * The recorded channel pushes and cache entries, newest last.
 *
 * @returns Copies.
 */
export function liveRecords(): {
  channelPushes: ChannelPushRecord[];
  cacheEntries: CacheEntryRecord[];
} {
  return { channelPushes: [...channelPushes], cacheEntries: [...cacheEntries] };
}

/** Forget every record and switch recording off (tests). */
export function resetLiveDevtools(): void {
  enabled = false;
  viewMessages.length = 0;
  channelPushes.length = 0;
  cacheEntries.length = 0;
}
