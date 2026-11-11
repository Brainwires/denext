// Loopy's voice backend: what the page may ask for, shared by the desktop extension
// (voice/extension.ts) and the browser dev route (app/api/voice/route.ts).
//
// - `status`: whether a key is set and where it comes from (never the key);
// - `setKey` / `clearKey`: write-only key management (the keychain; read-only from the env);
// - `session`: mint an ephemeral client secret for the Realtime session (voice/realtime.ts) with
//   the tools of the features the page has switched on;
// - `configure`: switch features on or off mid-session (answers the tools and instructions the
//   page sends in a `session.update`);
// - `tool`: run a function call the model made (voice/tools.ts);
// - `confirm`: the user's Yes or No to a question a tool asked (voice/confirm.ts);
// - `pending`: a question the page should ask without a tool call (the browser holds data a page
//   sent a beat after Loopy's last action), polled while a session is open;
// - `remember`: keep a finished turn (refused while memory is off); `memories`, `forget`,
//   `forgetAll`: the settings' memory list (voice/memory.ts).
//
// Each is rate-limited, so a misbehaving page can't mint secrets or call tools in a loop.

import { type ClientSecret, LOOPY_INSTRUCTIONS, mintClientSecret, VoiceError } from "./realtime.ts";
import type { CapCtx, KeyStore } from "./keys.ts";
import { parseTurn } from "./memory.ts";
import type { MemoryRecord } from "./memory-store.ts";
import type { ConfirmRequest } from "./confirm.ts";
import {
  createToolRegistry,
  NO_FEATURES,
  type ToolCallResult,
  type ToolContext,
  type ToolDefinition,
  type ToolFeatures,
  type ToolRegistry,
} from "./tools.ts";
import type { Toolset } from "./toolset.ts";

/** What the page learns about the key. */
export interface VoiceStatus {
  /** A key is set. */
  readonly hasKey: boolean;
  /** Where it is kept: `keychain` (settable from the page) or `env` (the dev server's). */
  readonly keySource: "keychain" | "env";
}

/** What `configure` answers: the declarations and instructions for a `session.update`. */
export interface SessionTools {
  readonly tools: ToolDefinition[];
  readonly instructions: string;
}

/** The backend's operations. `ctx` is the bridge call's context in the desktop app. */
export interface VoiceService {
  status(ctx?: CapCtx): Promise<VoiceStatus>;
  setKey(args: unknown, ctx?: CapCtx): Promise<VoiceStatus>;
  clearKey(ctx?: CapCtx): Promise<VoiceStatus>;
  session(args?: unknown, ctx?: CapCtx): Promise<ClientSecret>;
  configure(args: unknown): Promise<SessionTools>;
  tool(args: unknown, ctx?: CapCtx): Promise<ToolCallResult>;
  confirm(args: unknown): Promise<ToolCallResult>;
  pending(): Promise<{ readonly confirm: ConfirmRequest | null }>;
  remember(args: unknown, ctx?: CapCtx): Promise<{ readonly ok: true }>;
  memories(): Promise<MemoryRecord[]>;
  forget(args: unknown): Promise<{ readonly forgotten: boolean }>;
  forgetAll(): Promise<{ readonly forgotten: number }>;
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
  /** Tool calls and confirmations (a few per reply), and feature changes. */
  tool: { limit: 120, windowMs: 60_000 },
  /** Memory writes, lists and deletes. */
  memory: { limit: 60, windowMs: 60_000 },
  /** The page's poll for questions (every second or two while a session is open). */
  poll: { limit: 120, windowMs: 60_000 },
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

/** The features in `args.features` (each a boolean, a missing one off). */
export function parseFeatures(args: unknown): ToolFeatures {
  const f = (args as { features?: unknown } | null)?.features;
  const raw = (typeof f === "object" && f !== null ? f : {}) as Record<string, unknown>;
  return {
    webSearch: raw.webSearch === true,
    browser: raw.browser === true,
    memory: raw.memory === true,
  };
}

/** The answer in `confirm`'s arguments, or a `validation` refusal. */
function parseAnswer(args: unknown): { id: string; approved: boolean } {
  const a = args as { id?: unknown; approved?: unknown } | null;
  if (typeof a?.id !== "string" || a.id.length === 0 || a.id.length > 64) {
    throw new VoiceError("validation", "id must be a confirmation id");
  }
  if (typeof a.approved !== "boolean") {
    throw new VoiceError("validation", "approved must be a boolean");
  }
  return { id: a.id, approved: a.approved };
}

/** The memory id in `forget`'s arguments, or a `validation` refusal. */
function parseMemoryId(args: unknown): number {
  const id = (args as { id?: unknown } | null)?.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw new VoiceError("validation", "id must be a memory id");
  }
  return id;
}

/** What {@linkcode createVoiceService} needs. */
export interface VoiceServiceOptions {
  /** Where the key is kept. */
  readonly keys: KeyStore;
  /** Loopy's tools, memory and instructions (voice/toolset.ts). */
  readonly toolset?: Toolset;
  /** Just a registry, without memory (default: `set_mood`); ignored with a toolset. */
  readonly tools?: ToolRegistry;
  /** The fetch OpenAI is called with (tests pass a fake). */
  readonly fetch?: typeof fetch;
  /** The clock for the rate limits. */
  readonly now?: () => number;
}

/** The refusal for a memory write while memory is off. */
const memoryOff = () =>
  new VoiceError("memory_off", "Memory is turned off in Loopy's settings.", 409);

/** Build the voice backend. */
export function createVoiceService(options: VoiceServiceOptions): VoiceService {
  const { keys, toolset } = options;
  const tools = toolset?.registry ?? options.tools ?? createToolRegistry();
  const instructions = () => toolset?.instructions() ?? LOOPY_INSTRUCTIONS;
  const limiter = (rate: RateLimit) => createRateLimiter(rate, options.now);
  const limits = {
    session: limiter(VOICE_LIMITS.session),
    key: limiter(VOICE_LIMITS.key),
    tool: limiter(VOICE_LIMITS.tool),
    memory: limiter(VOICE_LIMITS.memory),
    poll: limiter(VOICE_LIMITS.poll),
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
  const toolContext = (ctx?: CapCtx): ToolContext => ({ apiKey: () => keys.get(ctx) });
  const sync = <T>(run: () => T): Promise<T> => {
    try {
      return Promise.resolve(run());
    } catch (err) {
      return Promise.reject(err);
    }
  };

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
    async session(args, ctx) {
      take("session");
      const apiKey = await keys.get(ctx);
      if (!apiKey) {
        throw new VoiceError("no_key", "Add your OpenAI API key in Loopy's settings first.", 409);
      }
      tools.configure(args === undefined ? NO_FEATURES : parseFeatures(args));
      return await mintClientSecret({
        apiKey,
        tools: tools.definitions(),
        instructions: instructions(),
        fetch: options.fetch,
        signal: (ctx as { signal?: AbortSignal } | undefined)?.signal,
      });
    },
    configure: (args) =>
      sync(() => {
        take("tool");
        tools.configure(parseFeatures(args));
        return { tools: tools.definitions(), instructions: instructions() };
      }),
    async tool(args, ctx) {
      take("tool");
      const call = parseToolCall(args);
      return await tools.call(call.name, call.arguments, toolContext(ctx));
    },
    async confirm(args) {
      take("tool");
      const answer = parseAnswer(args);
      return await tools.confirm(answer.id, answer.approved);
    },
    pending: () =>
      sync(() => {
        take("poll");
        return { confirm: toolset?.pending() ?? null };
      }),
    async remember(args, ctx) {
      take("memory");
      if (!toolset || !tools.features().memory) throw memoryOff();
      const turn = parseTurn(args);
      await toolset.memory.remember(turn, await keys.get(ctx));
      return { ok: true } as const;
    },
    memories: () =>
      sync(() => {
        take("memory");
        return toolset?.memory.list() ?? [];
      }),
    forget: (args) =>
      sync(() => {
        take("memory");
        return { forgotten: toolset?.memory.forget(parseMemoryId(args)) ?? false };
      }),
    forgetAll: () =>
      sync(() => {
        take("memory");
        return { forgotten: toolset?.memory.forgetAll() ?? 0 };
      }),
  };
}
