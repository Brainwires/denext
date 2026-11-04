// A minimal QMP (QEMU Machine Protocol) client over any byte stream: newline-delimited JSON, a
// greeting, `qmp_capabilities`, then one command at a time. Asynchronous events (`{"event": …}`)
// are skipped. The stream comes from `Host.qmp` (a unix socket in the app, an in-memory pair in
// the tests).

import type { QmpSession } from "./host.ts";

/** A duplex byte stream (a `Deno.UnixConn`, or a test's fake). */
export interface ByteStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): void;
}

/** A QMP `error` reply. */
export class QmpError extends Error {
  /** QEMU's error class (`GenericError`, `CommandNotFound`, …). */
  readonly errorClass: string;
  constructor(errorClass: string, description: string) {
    super(description);
    this.name = "QmpError";
    this.errorClass = errorClass;
  }
}

/** The longest line accepted from the socket (a `query-*` reply is a few KiB). */
const MAX_LINE = 1024 * 1024;

/** Reads newline-delimited JSON objects off a byte stream. */
class LineReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #decoder = new TextDecoder();
  #buffer = "";

  constructor(readable: ReadableStream<Uint8Array>) {
    this.#reader = readable.getReader();
  }

  /** The next JSON object, or a rejection when the stream ends first. */
  async next(): Promise<Record<string, unknown>> {
    while (true) {
      const nl = this.#buffer.indexOf("\n");
      if (nl >= 0) {
        const line = this.#buffer.slice(0, nl).trim();
        this.#buffer = this.#buffer.slice(nl + 1);
        if (line === "") continue;
        const value = JSON.parse(line);
        if (typeof value === "object" && value !== null) return value;
        continue;
      }
      const { value, done } = await this.#reader.read();
      if (done) throw new Error("QMP: the socket closed");
      this.#buffer += this.#decoder.decode(value, { stream: true });
      if (this.#buffer.length > MAX_LINE) throw new Error("QMP: reply too long");
    }
  }

  cancel(): void {
    this.#reader.cancel().catch(() => {});
  }
}

/** Whether a message answers the command `id` (an event or another id's reply does not). */
function isAnswer(msg: Record<string, unknown>, id: number | undefined): boolean {
  if ("event" in msg) return false;
  return id === undefined || !("id" in msg) || msg.id === id;
}

/**
 * The command's result if `msg` is its reply: `{ value }` for a `return`, a thrown
 * {@linkcode QmpError} for an `error`, `null` for anything else.
 */
function answerOf(msg: Record<string, unknown>, id: number | undefined): { value: unknown } | null {
  if (!isAnswer(msg, id)) return null;
  if ("error" in msg) {
    const e = (msg.error ?? {}) as { class?: unknown; desc?: unknown };
    throw new QmpError(String(e.class ?? "GenericError"), String(e.desc ?? "QMP error"));
  }
  return "return" in msg ? { value: msg.return } : null;
}

/** Reject with a timeout unless `promise` settles first (the timer is always cleared). */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`QMP: ${what} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open a QMP session on `stream`: read the greeting, negotiate capabilities, and return a session
 * that runs one command at a time.
 *
 * @param stream The connected socket.
 * @param timeoutMs How long the handshake and each command may take.
 */
export async function openQmpSession(stream: ByteStream, timeoutMs: number): Promise<QmpSession> {
  const lines = new LineReader(stream.readable);
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  let nextId = 1;
  let queue: Promise<unknown> = Promise.resolve();

  const send = (message: Record<string, unknown>) =>
    writer.write(encoder.encode(JSON.stringify(message) + "\n"));

  /** Read until the reply with `id` (or an id-less reply, for the handshake). */
  const reply = async (id?: number): Promise<unknown> => {
    while (true) {
      const answer = answerOf(await lines.next(), id);
      if (answer) return answer.value;
    }
  };

  const close = () => {
    lines.cancel();
    writer.releaseLock();
    try {
      stream.close();
    } catch { /* already closed */ }
  };

  try {
    await within(
      (async () => {
        const greeting = await lines.next();
        if (!("QMP" in greeting)) throw new Error("QMP: no greeting (not a QMP socket?)");
        await send({ execute: "qmp_capabilities" });
        await reply();
      })(),
      timeoutMs,
      "handshake",
    );
  } catch (err) {
    close();
    throw err;
  }

  return {
    execute(command, args) {
      const id = nextId++;
      const run = async () => {
        await send({ execute: command, ...(args ? { arguments: args } : {}), id });
        return await reply(id);
      };
      const result = queue.then(() => within(run(), timeoutMs, command));
      queue = result.catch(() => {});
      return result;
    },
    close,
  };
}
