// The desktop half of the inbox: serve inbox/handler.ts on a loopback port, write the inbox file,
// and take the page's button presses (`POST /_loopy/reply` on the window's own origin, routed
// here by desktop.ts's `onRequest`). Runtime-only: desktop.ts imports it, the page never does.

import { createInboxHandler, createReplies, type Replies } from "./handler.ts";
import { saveInbox } from "./store.ts";
import type { LoopyMessage } from "../lib/messages.ts";

/** The port the inbox tries first (`LOOPY_PORT` overrides it); a free one when it is taken. */
export const DEFAULT_PORT = 47833;

/** The page's button-press endpoint, on the window's own origin. */
export const REPLY_PATH = "/_loopy/reply";

/** A running inbox. */
export interface Inbox {
  /** Where it listens. */
  readonly url: string;
  /** The inbox file. */
  readonly file: string;
  /** Pending button presses. */
  readonly replies: Replies;
  /** Stop listening. */
  shutdown(): Promise<void>;
}

/** What {@linkcode startInbox} needs. */
export interface StartInboxOptions {
  /** The inbox file (inbox/paths.ts). */
  readonly file: string;
  /** Hand a message to the page. */
  readonly deliver: (message: LoopyMessage) => void;
  /** The port to try first. */
  readonly port?: number;
}

/** Listen on `port` on loopback, or on a free port when it is taken. */
function listen(
  port: number,
  handler: (r: Request) => Promise<Response>,
): Deno.HttpServer<Deno.NetAddr> {
  const opts = { hostname: "127.0.0.1", onListen: () => {} };
  try {
    return Deno.serve({ ...opts, port }, handler);
  } catch (e) {
    if (!(e instanceof Deno.errors.AddrInUse)) throw e;
    return Deno.serve({ ...opts, port: 0 }, handler);
  }
}

/** Start the inbox and record where it is. */
export async function startInbox(options: StartInboxOptions): Promise<Inbox> {
  // Under denext's pinned runtime the window's server took the in-process address this variable
  // names; this server is a real loopback socket.
  try {
    Deno.env.delete("DENO_SERVE_ADDRESS");
  } catch { /* no env permission: nothing to clear */ }
  const replies = createReplies();
  // The handler needs the token, which needs the URL (one file): start with a placeholder token
  // that nothing can present, then swap the real one in once the file is written.
  let handle: (r: Request) => Promise<Response> = () =>
    Promise.resolve(new Response("starting", { status: 503 }));
  const server = listen(options.port ?? DEFAULT_PORT, (r) => handle(r));
  const url = `http://127.0.0.1:${server.addr.port}`;
  const { token } = await saveInbox(options.file, url);
  handle = createInboxHandler({ token, deliver: options.deliver, replies });
  return { url, file: options.file, replies, shutdown: () => server.shutdown() };
}

/**
 * The page's answer to a message with buttons: `{ id, action }` (`action: null` when the bubble
 * closed). Only the page knows a message's random id, so a guess answers nothing. A request from
 * another site (`Sec-Fetch-Site`) is refused.
 */
export async function replyResponse(
  request: Request,
  replies: Replies | undefined,
): Promise<Response> {
  const site = request.headers.get("sec-fetch-site");
  if (request.method !== "POST" || (site !== null && site !== "same-origin")) {
    await request.body?.cancel();
    return new Response("forbidden", { status: 403 });
  }
  let body: { id?: unknown; action?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : null;
  const answered = typeof body.id === "string" && replies !== undefined &&
    replies.answer(body.id, action);
  return Response.json({ answered });
}
