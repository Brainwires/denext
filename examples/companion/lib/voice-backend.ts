// The page's way to Loopy's voice backend (voice/service.ts): in the desktop app the `loopyVoice`
// capability over the runtime's bridge, in a browser (`denext task dev`) `POST /api/voice`. Both
// answer the same operations. The API key goes in through `setKey` and never comes back out:
// `status` says only whether one is set. This module is the dev route's side and the shared shapes;
// lib/voice-bridge.ts adds the desktop one.

/** Whether a key is set, and where it lives. */
export interface KeyStatus {
  readonly hasKey: boolean;
  /** `keychain`: settable here; `env`: the dev server's `OPENAI_API_KEY`. */
  readonly keySource: "keychain" | "env";
}

/** Which tool features are on (lib/voice-settings.ts keeps them). */
export interface VoiceFeatures {
  readonly webSearch: boolean;
  readonly browser: boolean;
  readonly memory: boolean;
}

/** A link a tool found, shown under the reply. */
export interface SourceLink {
  readonly title: string;
  readonly url: string;
}

/** What a tool call answers: the model's output and what the page shows. */
export interface ToolAnswer {
  readonly output: string;
  readonly mood?: string;
  readonly sources?: readonly SourceLink[];
  /** Ask the user this first; the call finishes through `confirm`. */
  readonly confirm?: { readonly id: string; readonly prompt: string };
}

/** A kept memory, as the settings list shows it. */
export interface MemoryItem {
  readonly id: number;
  readonly createdAt: number;
  readonly user: string;
  readonly assistant: string;
}

/** What `configure` answers: what to send in a `session.update`. */
export interface SessionUpdate {
  readonly tools: readonly unknown[];
  readonly instructions: string;
}

/** The backend's operations, as the page calls them. */
export interface VoiceBackend {
  status(): Promise<KeyStatus>;
  setKey(key: string): Promise<KeyStatus>;
  clearKey(): Promise<KeyStatus>;
  /** An ephemeral client secret for one Realtime session, with the features' tools. */
  session(features: VoiceFeatures): Promise<{ readonly value: string; readonly expiresAt: number }>;
  /** Switch features on or off; answers the tools and instructions for a `session.update`. */
  configure(features: VoiceFeatures): Promise<SessionUpdate>;
  /** Run one function call the model made. */
  tool(call: { readonly name: string; readonly arguments: string }): Promise<ToolAnswer>;
  /** The user's answer to a tool's question. */
  confirm(id: string, approved: boolean): Promise<ToolAnswer>;
  /** A question to ask without a tool call (data a page sent after Loopy's last action). */
  pending(): Promise<{ readonly confirm: { readonly id: string; readonly prompt: string } | null }>;
  /** Keep a finished turn (refused while memory is off). */
  remember(turn: { readonly user: string; readonly assistant: string }): Promise<unknown>;
  /** The kept memories, newest first. */
  memories(): Promise<MemoryItem[]>;
  forget(id: number): Promise<unknown>;
  forgetAll(): Promise<unknown>;
}

/** A refusal from the backend: its code (`no_key`, `rate_limited`, …) and a message to show. */
export class VoiceBackendError extends Error {
  override readonly name = "VoiceBackendError";
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Where the dev route is. */
export const VOICE_ROUTE = "/api/voice";

/** A backend error from a refusal's `code` and `message` (either may be missing). */
export function backendError(
  e: { code?: unknown; message?: unknown } | null | undefined,
  fallback: string,
) {
  return new VoiceBackendError(
    typeof e?.code === "string" ? e.code : "failed",
    typeof e?.message === "string" ? e.message : fallback,
  );
}

/** The backend over the dev route (`fetchFn` for tests). */
export function routeBackend(fetchFn: typeof fetch = fetch): VoiceBackend {
  const call = async <T>(op: string, body: Record<string, unknown> = {}): Promise<T> => {
    const res = await fetchFn(VOICE_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, op }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const e = (data as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      throw backendError(e, `Loopy's voice backend answered ${res.status}.`);
    }
    return data as T;
  };
  return {
    status: () => call("status"),
    setKey: (key) => call("setKey", { key }),
    clearKey: () => call("clearKey"),
    session: (features) => call("session", { features }),
    configure: (features) => call("configure", { features }),
    tool: (c) => call("tool", { name: c.name, arguments: c.arguments }),
    confirm: (id, approved) => call("confirm", { id, approved }),
    pending: () => call("pending"),
    remember: (turn) => call("remember", { user: turn.user, assistant: turn.assistant }),
    memories: () => call("memories"),
    forget: (id) => call("forget", { id }),
    forgetAll: () => call("forgetAll"),
  };
}
