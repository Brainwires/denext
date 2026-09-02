// A bounded in-memory log of dev-server events — the "black box recorder" the dev server
// keeps so the running app's signal (server-side errors, build errors, type-check
// diagnostics, and the browser's console/errors reported back over `/_denext/dev-log`) can
// be read back out of process — by the MCP server's live tools, or any localhost reader —
// via `GET /_denext/dev-state`.
//
// It's deliberately small and pure (no I/O): the dev server records into it; the endpoint
// serializes a snapshot. This closes the loop the error overlay opened — the same runtime
// signal a developer sees in the browser is now available to the agent driving the edit.

/**
 * What produced an event: an `error` (server render/build/type-check), a `console` line
 * (server-side `console.*` or the browser's), a `request` (an app request completed), or an
 * `hmr` event (a hot-swap / reload).
 */
export type DevEventKind = "error" | "console" | "request" | "hmr";

/** One recorded dev event. */
export interface DevEvent {
  /** The category. */
  kind: DevEventKind;
  /** Epoch milliseconds when it was recorded. */
  ts: number;
  /** Where it came from. */
  source: "server" | "browser";
  /** Severity/level (`error`, `warn`, `info`, …). */
  level: string;
  /** A short title (server errors: "Server render error", "Bundle error", …). */
  title?: string;
  /** The message text. */
  message: string;
  /** A stack trace, when available. */
  stack?: string;
  /** The URL/path the event is associated with (a browser page, a request path). */
  url?: string;
  /** HTTP status (request events). */
  status?: number;
  /** Duration in milliseconds (request events). */
  durationMs?: number;
  /** The first in-project stack frame (server errors), when resolved. */
  frame?: { file: string; display: string; line: number; column: number };
  /** A source snippet around the frame with a caret at the column (server errors). */
  codeframe?: string;
}

/** Filter/limit options for {@link DevEventLog.snapshot}. */
export interface SnapshotOptions {
  /** Only events of this kind. */
  kind?: DevEventKind;
  /** Only events from this source. */
  source?: "server" | "browser";
  /** At most this many (most-recent) events (default 50). */
  limit?: number;
}

/** A bounded ring buffer of {@link DevEvent}s (oldest dropped past the cap). */
export class DevEventLog {
  #events: DevEvent[] = [];
  readonly #cap: number;

  /** @param cap Maximum retained events (default 500). */
  constructor(cap = 500) {
    this.#cap = Math.max(1, cap);
  }

  /** Record one event, evicting the oldest when over the cap. */
  record(event: DevEvent): void {
    this.#events.push(event);
    const overflow = this.#events.length - this.#cap;
    if (overflow > 0) this.#events.splice(0, overflow);
  }

  /** The most-recent events, filtered by {@link SnapshotOptions}. */
  snapshot(opts: SnapshotOptions = {}): DevEvent[] {
    let out = this.#events;
    if (opts.kind) out = out.filter((e) => e.kind === opts.kind);
    if (opts.source) out = out.filter((e) => e.source === opts.source);
    return out.slice(-(opts.limit ?? 50));
  }

  /** Current number of retained events. */
  get size(): number {
    return this.#events.length;
  }
}

/** Clamp a value to a string of at most `max` chars (defensive against a hostile client). */
function clampStr(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * Parse a browser-reported log payload (the `POST /_denext/dev-log` body) into a
 * `console` {@link DevEvent}. Every field is validated + length-clamped — the body comes
 * from the page, so treat it as untrusted. Returns null when there's no usable message.
 *
 * @param body The parsed JSON request body.
 * @returns A `console`/`browser` event, or null to ignore the report.
 */
/** The subset of `console` that {@link captureConsole} wraps. */
export type ConsoleLike = Record<
  "log" | "info" | "warn" | "error" | "debug",
  (...args: unknown[]) => void
>;

/** The `console` levels captured. */
const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;

/** Render one console argument to a string (objects via `Deno.inspect`, no color). */
function inspectArg(a: unknown): string {
  if (typeof a === "string") return a;
  try {
    return Deno.inspect(a, { colors: false, depth: 3 });
  } catch {
    return String(a);
  }
}

/**
 * Wrap a `console` object so each `log`/`info`/`warn`/`error`/`debug` call is reported to
 * `sink` (as a `console`/`server` {@link DevEvent}) and then passes through to the original.
 * Returns a restore function that unwraps it.
 *
 * IMPORTANT: this mutates the passed object, so on `globalThis.console` it is process-global —
 * only the real `denext dev` process (one dev server) enables it; embedded/in-process servers
 * (tests) must not, or parallel servers would fight over the same console. Kept pure here (it
 * takes the console + sink as arguments) so it is unit-testable against a fake console.
 *
 * @param target The console-like object to wrap (e.g. `globalThis.console`).
 * @param sink Receives one `console`/`server` event per captured call.
 * @returns A function that restores the original methods.
 */
export function captureConsole(target: ConsoleLike, sink: (event: DevEvent) => void): () => void {
  const original = new Map<string, (...args: unknown[]) => void>();
  for (const level of CONSOLE_LEVELS) {
    const orig = target[level];
    original.set(level, orig);
    target[level] = (...args: unknown[]) => {
      try {
        sink({
          kind: "console",
          ts: Date.now(),
          source: "server",
          level,
          message: args.map(inspectArg).join(" ").slice(0, 2000),
        });
      } catch { /* recording must never break logging */ }
      orig.apply(target, args);
    };
  }
  return () => {
    for (const level of CONSOLE_LEVELS) {
      const orig = original.get(level);
      if (orig) target[level] = orig;
    }
  };
}

export function browserLogEvent(body: unknown): DevEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const message = clampStr(b.message, 2000);
  if (!message) return null;
  const level = clampStr(b.level, 16) || "log";
  return {
    kind: "console",
    ts: Date.now(),
    source: "browser",
    level: level === "warn" || level === "error" ? level : "log",
    message,
    stack: clampStr(b.stack, 4000) || undefined,
    url: clampStr(b.url, 512) || undefined,
  };
}
