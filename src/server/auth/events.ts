/**
 * Dispatch for {@link ./types.ts | AuthEvents}. The single rule: **an event handler can
 * never fail the flow it observes.** `emitAuthEvent` awaits the app's handler (so a
 * handler that writes an audit row finishes before the response is built) and routes any
 * throw — sync or async — to the configured logger instead of letting it escape into the
 * sign-in path.
 *
 * @module
 */

import type { ResolvedAuthOptions } from "./options.ts";
import type { AuthEvents } from "./types.ts";

/** The event names an app may hook. */
export type AuthEventName = keyof AuthEvents;

/** The payload one event name expects. */
export type AuthEventPayload<K extends AuthEventName> = Parameters<
  NonNullable<AuthEvents[K]>
>[0];

/**
 * Fire one lifecycle event. A no-op when the app configured no handler for it.
 *
 * @param options The resolved auth options carrying `events` + `logger`.
 * @param name Which event fired.
 * @param payload The event's typed payload.
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
    await handler(payload);
  } catch (error) {
    options.logger.error(`denextAuth: the "${name}" event handler threw`, error);
  }
}
