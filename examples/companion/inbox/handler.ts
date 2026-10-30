// The inbox's request handler — `POST /api/loopy/say` — as a plain `Request` → `Response`
// function (the shape of a route handler), so tests call it directly. desktop.ts serves it on a
// loopback port of its own; the page never talks to it.
//
// A request must:
// - name a loopback host (`127.0.0.1`, `localhost`, `[::1]`): a DNS-rebinding page's Host is its
//   own domain;
// - carry no `Origin`: browsers send one on every cross-origin POST, local programs don't, so no
//   web page can reach Loopy even before the token is checked;
// - present `Authorization: Bearer <token>` (compared in constant time);
// - be `application/json`, at most 16 KiB, and a valid message (lib/messages.ts).

import { type LoopyMessage, MAX_TIMEOUT_MS, parseSayRequest, SayError } from "../lib/messages.ts";

/** The endpoint's path. */
export const SAY_PATH = "/api/loopy/say";

/** The largest body accepted. */
export const MAX_BODY_BYTES = 16 * 1024;

/** Pending button presses, keyed by message id (see {@linkcode createReplies}). */
export interface Replies {
  /** Resolve with the pressed action's id, or `null` when the bubble closed or `ms` passed. */
  wait(id: string, ms: number): Promise<string | null>;
  /** Answer message `id` (`null`: closed without a press). `false` when nothing waits for it. */
  answer(id: string, actionId: string | null): boolean;
}

/** A registry of waits for button presses. */
export function createReplies(): Replies {
  const pending = new Map<string, (actionId: string | null) => void>();
  return {
    wait(id, ms) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(null), ms);
        const finish = (actionId: string | null) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(actionId);
        };
        pending.set(id, finish);
      });
    },
    answer(id, actionId) {
      const finish = pending.get(id);
      if (!finish) return false;
      finish(actionId);
      return true;
    },
  };
}

/** What {@linkcode createInboxHandler} needs. */
export interface InboxOptions {
  /** The bearer token a sender must present. */
  readonly token: string;
  /** Hand a validated message to the page. */
  readonly deliver: (message: LoopyMessage) => void;
  /** Where `wait: true` requests park until a button is pressed (default: a fresh registry). */
  readonly replies?: Replies;
  /** The longest a `wait` holds the response (default two minutes). */
  readonly maxWaitMs?: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A JSON response. */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

/**
 * Whether two tokens are equal, in time that depends on neither: their SHA-256 digests (fixed
 * length, not chosen by the caller) are compared byte for byte with no early exit.
 */
export async function sameToken(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all(
    [a, b].map(async (s) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)))
    ),
  );
  return x.reduce((acc, byte, i) => acc | (byte ^ y[i]), 0) === 0;
}

/** The request's body as text, or `null` past {@linkcode MAX_BODY_BYTES}. */
async function boundedText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    await request.body?.cancel();
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The refusal for a request that fails the transport checks, or `null` when it passes them. */
async function refuse(request: Request, url: URL, token: string): Promise<Response | null> {
  if (!LOOPBACK_HOSTS.has(url.hostname)) return json(403, { error: "loopback only" });
  if (request.headers.has("origin")) return json(403, { error: "browser requests are refused" });
  const auth = request.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!presented || !(await sameToken(presented, token))) {
    return json(401, { error: "missing or wrong token" }, { "www-authenticate": "Bearer" });
  }
  return null;
}

/** A request body that passed the checks: the validated message, or the refusal to answer. */
async function readMessage(
  request: Request,
): Promise<ReturnType<typeof parseSayRequest> | Response> {
  if (request.method !== "POST") {
    await request.body?.cancel();
    return json(405, { error: "POST only" }, { allow: "POST" });
  }
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    await request.body?.cancel();
    return json(415, { error: "send application/json" });
  }
  const text = await boundedText(request);
  if (text === null) return json(413, { error: `the body is over ${MAX_BODY_BYTES} bytes` });
  try {
    return parseSayRequest(JSON.parse(text));
  } catch (e) {
    const reason = e instanceof SayError ? e.message : "the body is not valid JSON";
    return json(400, { error: reason });
  }
}

/**
 * The inbox handler. `200 { id, action }` for a `wait` (the pressed action's id, or `null`),
 * `202 { id }` otherwise; `400` for a bad message, `401` without the token, `403` for a browser or
 * a non-loopback host, `404` / `405` for another path or method, `413` past 16 KiB, `415` for a
 * body that is not JSON.
 */
export function createInboxHandler(options: InboxOptions): (request: Request) => Promise<Response> {
  const replies = options.replies ?? createReplies();
  const maxWait = Math.min(options.maxWaitMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  return async (request) => {
    const url = new URL(request.url);
    const refused = url.pathname === SAY_PATH
      ? await refuse(request, url, options.token)
      : json(404, { error: "not found" });
    if (refused) {
      await request.body?.cancel();
      return refused;
    }
    const read = await readMessage(request);
    if (read instanceof Response) return read;
    const { message, wait } = read;
    // Park the wait BEFORE delivering, so an instant press is not lost.
    const answered = wait
      ? replies.wait(message.id, Math.min(message.timeoutMs || maxWait, maxWait))
      : undefined;
    options.deliver(message);
    if (!answered) return json(202, { id: message.id });
    return json(200, { id: message.id, action: await answered });
  };
}
