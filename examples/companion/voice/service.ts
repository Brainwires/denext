// Loopy's voice backend: the five things the page may ask for, shared by the desktop extension
// (voice/extension.ts) and the browser dev route (app/api/voice/route.ts).
//
// - `status`: whether a key is set and where it comes from (never the key);
// - `setKey` / `clearKey`: write-only key management (the keychain; read-only from the env);
// - `session`: mint an ephemeral client secret for the Realtime session (voice/realtime.ts);
// - `tool`: run a function call the model made (voice/tools.ts).
//
// Each is rate-limited, so a misbehaving page can't mint secrets or call tools in a loop.

import { type ClientSecret, mintClientSecret, VoiceError } from "./realtime.ts";
import type { CapCtx, KeyStore } from "./keys.ts";
import { createToolRegistry, type ToolCallResult, type ToolRegistry } from "./tools.ts";

/** What the page learns about the key. */
export interface VoiceStatus {
  /** A key is set. */
  readonly hasKey: boolean;
  /** Where it is kept: `keychain` (settable from the page) or `env` (the dev server's). */
  readonly keySource: "keychain" | "env";
}

/** The backend's operations. `ctx` is the bridge call's context in the desktop app. */
export interface VoiceService {
  status(ctx?: CapCtx): Promise<VoiceStatus>;
  setKey(args: unknown, ctx?: CapCtx): Promise<VoiceStatus>;
  clearKey(ctx?: CapCtx): Promise<VoiceStatus>;
  session(ctx?: CapCtx): Promise<ClientSecret>;
  tool(args: unknown): Promise<ToolCallResult>;
}

/** A sliding-window limit: at most `limit` calls in any `windowMs`. */
export interface RateLimit {
  readonly limit: number;
  readonly windowMs: number;
}

/** The limits per operation. */
export const VOICE_LIMITS = {
  /** A session per push-to-talk would be odd; one a few seconds is plenty. */
  session: { limit: 6, windowMs: 60_000 },
  /** Key changes. */
  key: { limit: 10, windowMs: 60_000 },
  /** Tool calls (a few per reply). */
  tool: { limit: 120, windowMs: 60_000 },
} as const satisfies Record<string, RateLimit>;

/**
 * A sliding-window limiter.
 *
 * @param rate The limit.
 * @param now The clock (tests pass a fake).
 * @returns `take()`: whether one more call is allowed now (and counts it when it is).
 */
export function createRateLimiter(
  rate: RateLimit,
  now: () => number = Date.now,
): { take(): boolean } {
  const calls: number[] = [];
  return {
    take() {
      const t = now();
      while (calls.length > 0 && calls[0] <= t - rate.windowMs) calls.shift();
      if (calls.length >= rate.limit) return false;
      calls.push(t);
      return true;
    },
  };
}

/** The shortest and longest key accepted (OpenAI keys are a few dozen to a few hundred chars). */
const KEY_LENGTH = { min: 20, max: 512 } as const;

/** The key in `setKey`'s arguments, or a `validation` refusal. */
function parseKey(args: unknown): string {
  const key = (args as { key?: unknown } | null)?.key;
  if (typeof key !== "string") throw new VoiceError("validation", "key must be a string");
  const trimmed = key.trim();
  if (
    trimmed.length < KEY_LENGTH.min || trimmed.length > KEY_LENGTH.max ||
    !/^[\x21-\x7e]+$/.test(trimmed)
  ) {
    throw new VoiceError("validation", "That doesn't look like an API key.");
  }
  return trimmed;
}

/** The tool call in `tool`'s arguments, or a `validation` refusal. */
function parseToolCall(args: unknown): { name: string; arguments: string } {
  const a = args as { name?: unknown; arguments?: unknown } | null;
  if (typeof a?.name !== "string" || a.name === "" || a.name.length > 64) {
    throw new VoiceError("validation", "name must be a tool name");
  }
  if (typeof a.arguments !== "string") {
    throw new VoiceError("validation", "arguments must be a JSON string");
  }
  return { name: a.name, arguments: a.arguments };
}

/** What {@linkcode createVoiceService} needs. */
export interface VoiceServiceOptions {
  /** Where the key is kept. */
  readonly keys: KeyStore;
  /** The tools (default: `set_mood`). */
  readonly tools?: ToolRegistry;
  /** The fetch OpenAI is called with (tests pass a fake). */
  readonly fetch?: typeof fetch;
  /** The clock for the rate limits. */
  readonly now?: () => number;
}

/** Build the voice backend. */
export function createVoiceService(options: VoiceServiceOptions): VoiceService {
  const { keys } = options;
  const tools = options.tools ?? createToolRegistry();
  const limiter = (rate: RateLimit) => createRateLimiter(rate, options.now);
  const limits = {
    session: limiter(VOICE_LIMITS.session),
    key: limiter(VOICE_LIMITS.key),
    tool: limiter(VOICE_LIMITS.tool),
  };
  const take = (which: keyof typeof limits) => {
    if (!limits[which].take()) {
      throw new VoiceError("rate_limited", "Too many requests; wait a moment.", 429);
    }
  };
  const status = async (ctx?: CapCtx): Promise<VoiceStatus> => ({
    hasKey: (await keys.get(ctx)) !== null,
    keySource: keys.source,
  });

  return {
    status,
    async setKey(args, ctx) {
      take("key");
      await keys.set(parseKey(args), ctx);
      return await status(ctx);
    },
    async clearKey(ctx) {
      take("key");
      await keys.clear(ctx);
      return await status(ctx);
    },
    async session(ctx) {
      take("session");
      const apiKey = await keys.get(ctx);
      if (!apiKey) {
        throw new VoiceError("no_key", "Add your OpenAI API key in Loopy's settings first.", 409);
      }
      return await mintClientSecret({
        apiKey,
        tools: tools.definitions(),
        fetch: options.fetch,
        signal: (ctx as { signal?: AbortSignal } | undefined)?.signal,
      });
    },
    async tool(args) {
      take("tool");
      const call = parseToolCall(args);
      return await tools.call(call.name, call.arguments);
    },
  };
}
