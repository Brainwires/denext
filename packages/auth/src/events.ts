/**
 * Dispatch for {@link ./types.ts | AuthEvents}. The single rule: **an event handler can
 * never fail the flow it observes.** `emitAuthEvent` awaits the app's handler (so a
 * handler that writes an audit row finishes before the response is built) and routes any
 * throw — sync or async — to the configured logger instead of letting it escape into the
 * sign-in path.
 *
 * Every payload carries `ip`: the client address of the request that caused the event, read
 * the way `clientIp()` reads it (the socket peer, or the trusted proxy's last
 * `x-forwarded-for` hop). An event raised outside a request (a job revoking sessions) has none.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { clientAddrOf } from "@denext/denext/auth-kit";
import { currentContext, trustsForwardedHeaders } from "@denext/denext/auth-kit";
import type { ResolvedAuthOptions } from "./options.ts";
import type { AuthEvents } from "./types.ts";

/** The event names an app may hook. */
export type AuthEventName = keyof AuthEvents;

/** The payload one event name expects. */
export type AuthEventPayload<K extends AuthEventName> = Parameters<
  NonNullable<AuthEvents[K]>
>[0];

/**
 * The request an auth endpoint is answering — set around each `{basePath}/*` handler, so an
 * event raised there names the client even when the handler runs outside a request context
 * (an embedder calling the handler directly).
 */
const eventRequest = new AsyncLocalStorage<Request>();

/**
 * Run `fn` with `request` as the request its auth events report the client of.
 *
 * @param request The request being answered.
 * @param fn The work that may raise events.
 * @returns What `fn` returns.
 */
export function withAuthEventRequest<T>(request: Request, fn: () => Promise<T>): Promise<T> {
  return eventRequest.run(request, fn);
}

/**
 * The client address of the request behind an event: the endpoint's request, else the current
 * request context's; `undefined` outside both, or when the request has no known peer.
 */
function eventIp(options: ResolvedAuthOptions): string | undefined {
  const request = eventRequest.getStore() ?? currentContext()?.request;
  if (!request) return undefined;
  return clientAddrOf(request, trustsForwardedHeaders(options.trustForwardedHeaders));
}

/** `payload` with its `ip` filled in, unless the caller already set one or none is known. */
function withIp<K extends AuthEventName>(
  options: ResolvedAuthOptions,
  payload: AuthEventPayload<K>,
): AuthEventPayload<K> {
  if ((payload as { ip?: string }).ip !== undefined) return payload;
  const ip = eventIp(options);
  return ip === undefined ? payload : { ...payload, ip };
}

/**
 * Fire one lifecycle event. A no-op when the app configured no handler for it.
 *
 * @param options The resolved auth options carrying `events` + `logger`.
 * @param name Which event fired.
 * @param payload The event's typed payload (`ip` is added when the request has one).
 * @returns A promise that settles once the handler has run — it never rejects.
 */
export async function emitAuthEvent<K extends AuthEventName>(
  options: ResolvedAuthOptions,
  name: K,
  payload: AuthEventPayload<K>,
): Promise<void> {
  const handler = options.events[name] as
    | ((payload: AuthEventPayload<K>) => Promise<void> | void)
    | undefined;
  if (!handler) return;
  try {
    await handler(withIp(options, payload));
  } catch (error) {
    options.logger.error(`denextAuth: the "${name}" event handler threw`, error);
  }
}
