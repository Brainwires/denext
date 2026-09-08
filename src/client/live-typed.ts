// `useSubscription` — the client side of `defineSubscription`: a typed `useLive` whose input is
// validated by the server, whose tags are server-derived, and whose failures arrive as a
// structured error instead of an opaque string.

import { useEffect, useState } from "../runtime/hooks.ts";
import type { LiveErrorInfo } from "./live-client.ts";
import { subscribeChannel, subscribeLiveData } from "./live-client.ts";
import type { ChannelRef } from "../runtime/channel.ts";

/** A `defineSubscription` ref as the client sees it (the id, plus the phantom types). */
export interface SubscriptionRefLike<In, Out> {
  /** The stable server-reference id. */
  readonly denextActionId: string;
  /** Phantom — carries the types. */
  readonly __sub?: { input: In; output: Out };
}

/** Why a subscription is not (or no longer) delivering. */
export interface LiveSubscriptionError {
  /**
   * `invalid-input` (the schema rejected the input; see `fieldErrors`), `denied` (a policy or
   * `authorize` said no — the subscription is dropped), `no-policy` (a setup gap), `limit` (a
   * cap was hit), `failed` (the resolver threw — redacted in production, `digest` correlates
   * with the server log; the subscription stays and retries on the next invalidation).
   */
  code: "invalid-input" | "denied" | "no-policy" | "limit" | "failed" | "bad-message";
  /** A short, non-sensitive explanation. */
  message: string;
  /** Per-field validation messages (`invalid-input`). */
  fieldErrors?: Record<string, string>;
  /** The redaction digest (`failed`, production). */
  digest?: string;
}

/** What {@link useSubscription} returns. */
export interface SubscriptionState<Out> {
  /** The latest value (or `initial`). */
  data: Out | undefined;
  /** The latest failure, if any. */
  error: LiveSubscriptionError | undefined;
  /**
   * `idle` before the subscription is confirmed; `subscribed` once the server acks it but before any
   * value (channels only — a data subscription's first value arrives with the ack, so it goes
   * straight to `live`); `live` while delivering values; `error` after a failure.
   */
  status: "idle" | "subscribed" | "live" | "error";
  /** A channel push's per-instance sequence number (orders frames from one instance). */
  seq?: number;
}

/** Options for {@link useSubscription}. */
export interface UseSubscriptionOptions<Out> {
  /** The value before the first push (an SSR-computed `await sub(input)`, say). */
  initial?: Out;
  /** `false` keeps the hook idle (no subscription). Default true. */
  enabled?: boolean;
}

/**
 * Subscribe to a `defineSubscription` over the Live socket. The server validates `input`,
 * derives the tags, authorizes on every recompute, and pushes each new value.
 *
 * @param sub The subscription ref (imported from a `"use server"` module).
 * @param input The typed input.
 * @param options `initial`, `enabled`.
 * @returns `{ data, error, status }`.
 */
export function useSubscription<In, Out>(
  sub: SubscriptionRefLike<In, Out>,
  input: In,
  options: UseSubscriptionOptions<Out> = {},
): SubscriptionState<Out> {
  const [state, setState] = useState<SubscriptionState<Out>>({
    data: options.initial,
    error: undefined,
    status: "idle",
  });
  const enabled = options.enabled ?? true;
  // A new input is a new subscription (compared structurally).
  const key = JSON.stringify([sub.denextActionId, input, enabled]);
  useEffect(() => {
    if (!enabled) return;
    return subscribeLiveData(sub.denextActionId, [input], [], (value, err, info) => {
      if (!err) setState({ data: value as Out, error: undefined, status: "live" });
      else setState((s) => ({ ...s, error: toSubscriptionError(err, info), status: "error" }));
    });
    // deno-lint-ignore no-explicit-any
  }, [key] as any);
  return state;
}

/** Shape a transport error (string reason + optional structured frame) as a `LiveSubscriptionError`. */
function toSubscriptionError(reason: string, info?: LiveErrorInfo): LiveSubscriptionError {
  const code = (info?.code ?? "failed") as LiveSubscriptionError["code"];
  const out: LiveSubscriptionError = { code, message: info?.reason ?? reason };
  if (info?.fieldErrors) out.fieldErrors = info.fieldErrors;
  if (info?.digest) out.digest = info.digest;
  return out;
}

/** Options for {@link useChannel}. */
export interface UseChannelOptions<T> {
  /** The value before the first push (channels carry no history — compute it during SSR). */
  initial?: T;
  /** `false` keeps the hook idle (no subscription). Default true. */
  enabled?: boolean;
}

/** The id under which a channel ref subscribes: the server object's id, or the "use server" stub's. */
function channelIdOf(ref: ChannelRef<unknown> | { denextActionId: string }): string {
  return (ref as ChannelRef<unknown>).denextChannelId ??
    (ref as { denextActionId: string }).denextActionId;
}

/**
 * Receive a `createChannel` channel's pushes for `key`. The server authorizes the subscription
 * in this viewer's session (and re-checks it lazily); every `publish(key, payload)` — from an
 * action, a webhook, a cron — arrives as a new `data`. At-most-once, latest-wins; no replay on
 * reconnect.
 *
 * @param channel The channel ref (imported from a `"use server"` module or received as a prop).
 * @param key The key to subscribe to.
 * @param options `initial`, `enabled`.
 * @returns `{ data, error, status }` typed by the channel's payload.
 */
export function useChannel<T>(
  channel: ChannelRef<T> | { denextActionId: string; __channel?: { payload: T } },
  key: string,
  options: UseChannelOptions<T> = {},
): SubscriptionState<T> {
  const [state, setState] = useState<SubscriptionState<T>>({
    data: options.initial,
    error: undefined,
    status: "idle",
  });
  const enabled = options.enabled ?? true;
  const id = channelIdOf(channel);
  useEffect(() => {
    if (!enabled) return;
    return subscribeChannel(
      id,
      key,
      (value, seq) => setState({ data: value as T, error: undefined, status: "live", seq }),
      (info) =>
        setState((s) => ({
          ...s,
          error: toSubscriptionError(info.reason ?? info.code, info),
          status: "error",
        })),
      // Registered but no value yet: reflect `subscribed`, without clobbering a value or error that
      // arrived first (a publish can beat the ack).
      () => setState((s) => (s.status === "idle" ? { ...s, status: "subscribed" } : s)),
    );
    // deno-lint-ignore no-explicit-any
  }, [id, key, enabled] as any);
  return state;
}
