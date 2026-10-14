// GraphQL over WebSocket — the `graphql-ws` protocol (subprotocol `graphql-transport-ws`),
// implemented here against Yoga's enveloped pipeline rather than through the `graphql-ws` npm
// server: the same parse / validate / execute / subscribe Yoga runs over HTTP (so the depth and
// cost limits, introspection blocking and error masking all apply), with no extra dependency.
// Internal: `mod.ts` routes an upgrade on the GraphQL path here after the Origin check.
//
// Protocol (https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md):
//   client `connection_init` (once, within the init timeout) → server `connection_ack`;
//   `ping` ↔ `pong`; client `subscribe { id, payload }` → server `next`* then `complete`, or
//   `error` (a refusal before execution); client `complete { id }` stops one operation.
// Close codes: 4400 invalid message, 4401 subscribe before ack, 4408 init timeout, 4409 duplicate
// operation id, 4429 a second `connection_init`.
//
// Identity: the upgrade request's cookies / `Authorization` (captured before the upgrade
// consumes it), or — when the upgrade carried no `Authorization`, as a browser's never does — a
// `connection_init` payload token (`{ authorization: "Bearer …" }` or `{ token: "…" }`), applied
// as that header. Every operation runs in a copy of that request's context, as one peer.

import { captureRequestContext } from "@denext/denext/plugin-kit";
import type { DocumentNode, OperationDefinitionNode } from "graphql";
import { withPeer } from "./peer.ts";

/** The GraphQL over WebSocket subprotocol this server speaks. */
const GRAPHQL_WS_PROTOCOL = "graphql-transport-ws";

/** Yoga's enveloped pipeline (the subset the socket drives). */
export interface EnvelopedLike {
  parse(source: string): DocumentNode;
  validate(schema: unknown, document: DocumentNode): readonly unknown[];
  contextFactory(): unknown;
  execute(args: Record<string, unknown>): unknown;
  subscribe(args: Record<string, unknown>): unknown;
  schema: unknown;
}

/** What the socket needs from the plugin. */
export interface GraphqlWsDeps {
  /** The current Yoga (re-read per operation, so a dev schema reload reaches open sockets). */
  getEnveloped(initialContext: Record<string, unknown>): Promise<EnvelopedLike>;
  /** Close the socket when no `connection_init` arrived within this many ms. */
  connectionInitTimeoutMs: number;
  /** Operations (subscriptions, queries, mutations) one socket may run at once. */
  maxOperations: number;
  /** A message larger than this many UTF-16 units closes the socket (4400). */
  maxMessageBytes: number;
}

/** Does this request ask for a WebSocket upgrade? */
export function isWebSocketUpgrade(request: Request): boolean {
  return (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

/** Headers the per-operation request does not keep (the handshake's and a body's). */
const HANDSHAKE_HEADERS =
  /^(?:upgrade|connection|sec-websocket-.*|content-length|content-type|transfer-encoding)$/i;

/** Pause pulling results while this many bytes wait in the socket's send buffer. */
const HIGH_WATER_BYTES = 1024 * 1024;

/**
 * Upgrade `request` to a `graphql-transport-ws` socket. Call inside the request (its context is
 * captured for every operation) and only after the Origin check.
 *
 * @param request The upgrade request.
 * @param deps The plugin's Yoga and limits.
 * @returns The 101 response, or a 400 when the client did not offer the subprotocol.
 */
export function acceptGraphqlWs(request: Request, deps: GraphqlWsDeps): Response {
  const offered = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",").map((p) => p.trim());
  if (!offered.includes(GRAPHQL_WS_PROTOCOL)) {
    return new Response(`expected the ${GRAPHQL_WS_PROTOCOL} subprotocol`, { status: 400 });
  }
  // Capture BEFORE the upgrade, which consumes the request.
  const url = request.url;
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!HANDSHAKE_HEADERS.test(name)) headers.append(name, value);
  }
  const runAsUpgrade = captureRequestContext();
  let upgrade: { socket: WebSocket; response: Response };
  try {
    upgrade = Deno.upgradeWebSocket(request, { protocol: GRAPHQL_WS_PROTOCOL });
  } catch {
    return new Response("upgrade failed", { status: 400 });
  }
  serve(upgrade.socket, { url, headers, runAs: runAsUpgrade }, deps);
  return upgrade.response;
}

/** One running operation. */
interface Operation {
  /** Aborts the operation's request signal. */
  controller: AbortController;
  /** The result stream, once there is one. */
  iterator?: AsyncIterator<unknown>;
  /** The client sent `complete` (or the socket closed): send nothing more for it. */
  stopped: boolean;
}

/** The connection's identity: the upgrade request, possibly with a `connection_init` token. */
interface Identity {
  url: string;
  headers: Headers;
  runAs: <T>(fn: () => T) => T;
}

/** A message the client sent, parsed (only the fields the protocol reads). */
interface ClientMessage {
  type: string;
  id?: unknown;
  payload?: unknown;
}

function serve(socket: WebSocket, initial: Identity, deps: GraphqlWsDeps): void {
  const peerId = crypto.randomUUID();
  const ops = new Map<string, Operation>();
  let identity = initial;
  let initReceived = false;
  let acknowledged = false;
  let closed = false;

  const send = (msg: Record<string, unknown>) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };
  const close = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    try {
      socket.close(code, reason);
    } catch { /* already closing */ }
  };
  const initTimer = setTimeout(() => {
    if (!initReceived) close(4408, "Connection initialisation timeout");
  }, deps.connectionInitTimeoutMs);

  const stopAll = () => {
    clearTimeout(initTimer);
    for (const op of ops.values()) stopOperation(op);
    ops.clear();
  };
  socket.onclose = () => {
    closed = true;
    stopAll();
  };
  socket.onerror = () => {};

  const onInit = (payload: unknown) => {
    if (initReceived) return close(4429, "Too many initialisation requests");
    initReceived = true;
    clearTimeout(initTimer);
    const token = initToken(payload);
    if (token !== null && !identity.headers.has("authorization")) {
      try {
        const headers = new Headers(identity.headers);
        headers.set("authorization", token);
        const runAs = identity.runAs(() =>
          captureRequestContext({ headers: { authorization: token } })
        );
        identity = { url: identity.url, headers, runAs };
      } catch {
        return close(4400, "Invalid connection_init payload");
      }
    }
    acknowledged = true;
    send({ type: "connection_ack" });
  };

  const onSubscribe = (msg: ClientMessage) => {
    if (!acknowledged) return close(4401, "Unauthorized");
    const id = msg.id;
    const payload = subscribePayload(msg.payload);
    if (typeof id !== "string" || id.length === 0 || id.length > 128 || !payload) {
      return close(4400, "Invalid message received");
    }
    if (ops.has(id)) return close(4409, `Subscriber for ${id} already exists`);
    if (ops.size >= deps.maxOperations) {
      return send({ type: "error", id, payload: [{ message: "Too many operations" }] });
    }
    const op: Operation = { controller: new AbortController(), stopped: false };
    ops.set(id, op);
    const who = identity;
    void withPeer(
      peerId,
      () => who.runAs(() => runOperation(op, id, payload, who, deps, send, socket)),
    )
      .finally(() => {
        if (ops.get(id) === op) ops.delete(id);
      });
  };

  socket.onmessage = (ev) => {
    if (closed) return;
    if (typeof ev.data !== "string") return close(4400, "Invalid message received");
    if (ev.data.length > deps.maxMessageBytes) return close(4400, "Message too large");
    const msg = parseMessage(ev.data);
    if (!msg) return close(4400, "Invalid message received");
    switch (msg.type) {
      case "connection_init":
        return onInit(msg.payload);
      case "ping":
        return send({ type: "pong" });
      case "pong":
        return;
      case "subscribe":
        return onSubscribe(msg);
      case "complete": {
        if (typeof msg.id !== "string") return close(4400, "Invalid message received");
        const op = ops.get(msg.id);
        if (op) {
          ops.delete(msg.id);
          stopOperation(op);
        }
        return;
      }
      default:
        return close(4400, "Invalid message received");
    }
  };
}

/** Stop one operation: no further frames, its request signal aborts, its stream returns. */
function stopOperation(op: Operation): void {
  if (op.stopped) return;
  op.stopped = true;
  op.controller.abort();
  void Promise.resolve(op.iterator?.return?.()).catch(() => {});
}

/** The `subscribe` payload's request fields, or `null` when malformed. */
function subscribePayload(raw: unknown): {
  query: string;
  variables?: Record<string, unknown> | null;
  operationName?: string | null;
  extensions?: Record<string, unknown> | null;
} | null {
  if (!isRecord(raw) || typeof raw.query !== "string") return null;
  const { variables, operationName, extensions } = raw;
  if (variables != null && !isRecord(variables)) return null;
  if (operationName != null && typeof operationName !== "string") return null;
  if (extensions != null && !isRecord(extensions)) return null;
  return {
    query: raw.query,
    variables: variables as Record<string, unknown> | null | undefined,
    operationName: operationName as string | null | undefined,
    extensions: extensions as Record<string, unknown> | null | undefined,
  };
}

/** The bearer credential a `connection_init` payload carries, as an `Authorization` value. */
function initToken(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const auth = payload.authorization ?? payload.Authorization;
  if (typeof auth === "string" && auth.length > 0) return auth;
  if (typeof payload.token === "string" && payload.token.length > 0) {
    return `Bearer ${payload.token}`;
  }
  return null;
}

function parseMessage(text: string): ClientMessage | null {
  try {
    const msg: unknown = JSON.parse(text);
    return isRecord(msg) && typeof msg.type === "string" ? msg as unknown as ClientMessage : null;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return typeof v === "object" && v !== null && Symbol.asyncIterator in v;
}

/** The operation `document` runs for `operationName` (the sole one when unnamed). */
export function operationOf(
  document: DocumentNode,
  operationName: string | null | undefined,
): OperationDefinitionNode | undefined {
  const ops = document.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === "OperationDefinition",
  );
  if (operationName) return ops.find((o) => o.name?.value === operationName);
  // No name: valid only when there's exactly one operation; otherwise graphql errors first.
  return ops.length === 1 ? ops[0] : undefined;
}

/** An error frame's payload: GraphQL errors as their JSON form, anything else masked. */
function formatErrors(errors: readonly unknown[]): unknown[] {
  return errors.map((e) => {
    const json = (e as { toJSON?: () => unknown })?.toJSON?.();
    return json ?? { message: "Unexpected error." };
  });
}

/** Wait while the socket's send buffer is over the high-water mark (pull-based back-pressure). */
async function drained(op: Operation, socket: { bufferedAmount: number }): Promise<void> {
  while (!op.stopped && socket.bufferedAmount > HIGH_WATER_BYTES) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Run one operation to completion, sending its frames. Runs in the connection's context. */
async function runOperation(
  op: Operation,
  id: string,
  payload: NonNullable<ReturnType<typeof subscribePayload>>,
  who: Identity,
  deps: GraphqlWsDeps,
  send: (msg: Record<string, unknown>) => void,
  socket: { bufferedAmount: number },
): Promise<void> {
  const emit = (msg: Record<string, unknown>) => {
    if (!op.stopped) send(msg);
  };
  try {
    const request = new Request(who.url, {
      headers: who.headers,
      signal: op.controller.signal,
    });
    const enveloped = await deps.getEnveloped({ request, params: payload });
    let document: DocumentNode;
    try {
      document = enveloped.parse(payload.query);
    } catch (err) {
      return emit({ type: "error", id, payload: formatErrors([err]) });
    }
    const errors = enveloped.validate(enveloped.schema, document);
    if (errors.length > 0) return emit({ type: "error", id, payload: formatErrors(errors) });
    const operation = operationOf(document, payload.operationName);
    const args = {
      schema: enveloped.schema,
      document,
      operationName: payload.operationName,
      variableValues: payload.variables,
      contextValue: await enveloped.contextFactory(),
    };
    const result = await (operation?.operation === "subscription"
      ? enveloped.subscribe(args)
      : enveloped.execute(args));
    if (op.stopped) {
      if (isAsyncIterable(result)) {
        void result[Symbol.asyncIterator]().return?.();
      }
      return;
    }
    if (!isAsyncIterable(result)) {
      emit({ type: "next", id, payload: result });
      return emit({ type: "complete", id });
    }
    const iterator = result[Symbol.asyncIterator]();
    op.iterator = iterator;
    while (!op.stopped) {
      const step = await iterator.next();
      if (step.done) {
        break;
      }
      emit({ type: "next", id, payload: step.value });
      await drained(op, socket);
    }
    emit({ type: "complete", id });
  } catch {
    emit({ type: "error", id, payload: [{ message: "Unexpected error." }] });
  }
}
