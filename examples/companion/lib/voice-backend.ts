// The page's way to Loopy's voice backend (voice/service.ts): in the desktop app the `loopyVoice`
// capability over the runtime's bridge, in a browser (`denext task dev`) `POST /api/voice`. Both
// answer the same five operations. The API key goes in through `setKey` and never comes back out:
// `status` says only whether one is set. This module is the dev route's side and the shared shapes;
// lib/voice-bridge.ts adds the desktop one.

/** Whether a key is set, and where it lives. */
export interface KeyStatus {
  readonly hasKey: boolean;
  /** `keychain`: settable here; `env`: the dev server's `OPENAI_API_KEY`. */
  readonly keySource: "keychain" | "env";
}

/** The backend's operations, as the page calls them. */
export interface VoiceBackend {
  status(): Promise<KeyStatus>;
  setKey(key: string): Promise<KeyStatus>;
  clearKey(): Promise<KeyStatus>;
  /** An ephemeral client secret for one Realtime session. */
  session(): Promise<{ readonly value: string; readonly expiresAt: number }>;
  /** Run one function call the model made. */
  tool(call: { readonly name: string; readonly arguments: string }): Promise<{
    readonly output: string;
    readonly mood?: string;
  }>;
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
    session: () => call("session"),
    tool: (c) => call("tool", { name: c.name, arguments: c.arguments }),
  };
}
