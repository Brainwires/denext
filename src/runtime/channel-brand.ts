// The channel BRAND, split from `channel.ts` so the modules every client bundle carries
// (`server-action.ts` for the action stubs, the Flight scalar serializer) can recognize a
// channel without importing `channel.ts` — whose module scope allocates the default transport
// and an instance id (server-only state no browser needs). Side-effect free by contract.

import type { Channel } from "./channel.ts";

/** The symbol a `createChannel` result carries (shared across module instances). */
export const CHANNEL_BRAND: unique symbol = Symbol.for("denext.channel") as never;

/**
 * Is `value` a server-side channel object?
 *
 * @param value Any export.
 * @returns True for a `createChannel` result.
 */
export function isChannel(value: unknown): value is Channel<unknown> {
  return typeof value === "object" && value !== null && CHANNEL_BRAND in value;
}

/** Registers a channel under a stable id (installed by `channel.ts` when it loads). */
export type ChannelRegistrar = (id: string, channel: Channel<unknown>) => void;

let registrar: ChannelRegistrar | null = null;

/** Install the registrar — `channel.ts` does this at module load on the server. */
export function setChannelRegistrar(fn: ChannelRegistrar): void {
  registrar = fn;
}

/**
 * Register a channel if the server registry is loaded. In a browser bundle no registrar exists
 * and this is a no-op — registration is a server concern (`"use server"` export tagging).
 */
export function registerChannelIfLoaded(id: string, channel: Channel<unknown>): void {
  registrar?.(id, channel);
}
