// Where Loopy's OpenAI API key lives, server side only:
//
// - in the desktop app, the OS keychain through the `secureStore` capability (enabled with
//   `denext desktop add secure-store`). desktop.ts takes that capability OUT of the page's bridge
//   and hands it to the voice backend, so the page can set, replace or clear the key (through
//   voice/extension.ts) but never read it back;
// - in the browser dev server, the `OPENAI_API_KEY` environment variable (read-only there).
//
// A key is never logged, printed or returned to the page.

import { VoiceError } from "./realtime.ts";

/**
 * A bridge call's context (`DesktopCapCtx` from `denext/desktop`), passed through to the secure
 * store untouched. Opaque here, so this module needs no desktop import (the unit tests load it).
 */
export type CapCtx = unknown;

/** The `secureStore` capability, as far as the key store uses it (a `DesktopCapability`). */
export interface StoreCapability {
  readonly name: string;
  readonly methods: Readonly<
    Record<string, { readonly handler: (args: unknown, ctx: never) => unknown }>
  >;
}

/** The keychain item's name (the service is the app's identifier, `dev.denext.loopy`). */
export const KEY_ITEM = "openai-api-key";

/** The environment variable the dev server reads. */
export const KEY_ENV = "OPENAI_API_KEY";

/** Where the key is kept, and what can be done with it there. */
export interface KeyStore {
  /** `keychain` (the desktop app) or `env` (the dev server). */
  readonly source: "keychain" | "env";
  /** The key, or `null` when none is set. `ctx` is the capability call's context, passed on. */
  get(ctx?: CapCtx): Promise<string | null>;
  /** Store or replace the key (`read_only` where it comes from the environment). */
  set(key: string, ctx?: CapCtx): Promise<void>;
  /** Forget the key (`read_only` where it comes from the environment). */
  clear(ctx?: CapCtx): Promise<void>;
}

/** A context for a call made outside the bridge (the store reads only its `signal`). */
const standaloneCtx = () => ({ signal: new AbortController().signal });

/** Call one of the secure store's methods. */
async function callStore(
  store: StoreCapability,
  method: "get" | "set" | "delete",
  args: Record<string, string>,
  ctx: CapCtx | undefined,
): Promise<unknown> {
  const m = store.methods[method];
  if (!m) throw new VoiceError("no_store", "The keychain is not available.", 503);
  return await m.handler(args, (ctx ?? standaloneCtx()) as never);
}

/**
 * The key in the OS keychain, through the app's `secureStore` capability (the object
 * `resolveDesktopCapabilities` built from `desktop.capabilities.secureStore`).
 *
 * @param store The `secureStore` capability.
 */
export function keychainKeyStore(store: StoreCapability): KeyStore {
  return {
    source: "keychain",
    async get(ctx) {
      const value = await callStore(store, "get", { key: KEY_ITEM }, ctx);
      return typeof value === "string" && value !== "" ? value : null;
    },
    async set(key, ctx) {
      await callStore(store, "set", { key: KEY_ITEM, value: key }, ctx);
    },
    async clear(ctx) {
      await callStore(store, "delete", { key: KEY_ITEM }, ctx);
    },
  };
}

/**
 * The key from the dev server's environment (`OPENAI_API_KEY`), read on each use.
 *
 * @param read Reads a variable (default `Deno.env.get`, `undefined` without permission).
 */
export function envKeyStore(
  read: (name: string) => string | undefined = (name) => {
    try {
      return Deno.env.get(name);
    } catch {
      return undefined;
    }
  },
): KeyStore {
  const readOnly = () =>
    Promise.reject(
      new VoiceError(
        "read_only",
        `In the browser the key comes from ${KEY_ENV} in the dev server's environment.`,
        409,
      ),
    );
  return {
    source: "env",
    get: () => Promise.resolve(read(KEY_ENV)?.trim() || null),
    set: readOnly,
    clear: readOnly,
  };
}
