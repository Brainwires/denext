// Loopy's voice session on OpenAI's Realtime API, server side: the session configuration (model,
// voice, persona, push-to-talk turns, input transcription, tools) and the one call that mints an
// ephemeral client secret for it — `POST /v1/realtime/client_secrets` with the API key. The page
// gets only the secret and its expiry, connects over WebRTC with it (lib/realtime-client.ts), and
// never sees the key. Runs in the desktop app's Deno process (voice/extension.ts) or the dev
// server (app/api/voice/route.ts); `fetch` is injected, so tests never reach the network.
//
// Docs: https://developers.openai.com/api/docs/guides/voice-webrtc (the ephemeral-token flow),
// https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create

import type { ToolDefinition } from "./tools.ts";

/** The Realtime model: the newest generally available speech-to-speech model. */
export const REALTIME_MODEL = "gpt-realtime-2.1";

/** Loopy's voice (one of the built-in voices; `marin` and `cedar` are the recommended ones). */
export const REALTIME_VOICE = "marin";

/** The model that transcribes what the user said, for the speech bubble. */
export const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

/** Where a client secret is minted. */
export const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

/**
 * How long a minted secret can open a session, in seconds (the API takes 10 to 7200). It only has
 * to last until the page's WebRTC offer reaches OpenAI, a second or two later.
 */
export const SECRET_TTL_SECONDS = 60;

/** Loopy's persona. App-agnostic: Loopy helps with whatever the user is doing. */
export const LOOPY_INSTRUCTIONS = [
  "You are Loopy, a small, friendly paper-clip companion who lives in the corner of the user's",
  "desktop. Speak briefly: one to three short sentences, unless the user asks for more. Be warm",
  "and a little playful, never sarcastic or pushy. Help with whatever the user is doing without",
  "assuming any particular app. If you don't know something, say so plainly.",
  "Before each reply, call set_mood once with the mood that fits what you are about to say,",
  "then speak. Never say the mood's name aloud or mention the tool.",
].join(" ");

/** A minted secret, as the page receives it. */
export interface ClientSecret {
  /** The ephemeral secret (a Bearer token for `POST /v1/realtime/calls`). */
  readonly value: string;
  /** When it stops opening sessions, in seconds since the epoch. */
  readonly expiresAt: number;
}

/** A refusal with a code the page narrows on and a message safe to show (never the key). */
export class VoiceError extends Error {
  override readonly name = "VoiceError";
  /**
   * @param code What went wrong: `no_key`, `bad_key`, `rate_limited`, `upstream`, `validation`,
   *   `read_only`.
   * @param message A message safe to show the user.
   * @param status The HTTP status that carries it.
   */
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * The Realtime session Loopy talks in. Turns are the user's: `turn_detection: null` (no voice
 * activity detection), so the page commits the audio when the push-to-talk key is released or
 * Loopy is clicked again, and asks for the reply itself. Nothing the microphone hears between
 * turns is sent: the page disables its track outside a turn.
 *
 * @param tools The function tools the model may call (voice/tools.ts).
 * @param instructions Loopy's persona, with what the tools switched on add (voice/toolset.ts).
 * @returns The `session` object of a client-secret request.
 */
function realtimeSession(
  tools: readonly ToolDefinition[],
  instructions: string,
): Record<string, unknown> {
  return {
    type: "realtime",
    model: REALTIME_MODEL,
    instructions,
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: { model: TRANSCRIBE_MODEL },
        turn_detection: null,
        noise_reduction: { type: "near_field" },
      },
      output: { voice: REALTIME_VOICE },
    },
    tools,
    tool_choice: "auto",
  };
}

/** The request body for a client secret: the session and how long the secret lives. */
function clientSecretRequest(
  tools: readonly ToolDefinition[],
  instructions: string,
): Record<string, unknown> {
  return {
    expires_after: { anchor: "created_at", seconds: SECRET_TTL_SECONDS },
    session: realtimeSession(tools, instructions),
  };
}

/** The refusal for an unsuccessful answer from OpenAI. Its body is never passed on (it can quote
 * part of the key). */
function upstreamError(status: number): VoiceError {
  if (status === 401 || status === 403) {
    return new VoiceError("bad_key", "OpenAI refused the API key. Check it in Settings.", 401);
  }
  if (status === 429) {
    return new VoiceError("rate_limited", "OpenAI is rate-limiting this key; try again soon.", 429);
  }
  return new VoiceError("upstream", `OpenAI could not start a voice session (${status}).`, 502);
}

/** The secret in OpenAI's answer, or a refusal when the answer has none. */
function parseSecret(body: unknown): ClientSecret {
  const value = (body as { value?: unknown } | null)?.value;
  const expiresAt = (body as { expires_at?: unknown } | null)?.expires_at;
  if (typeof value !== "string" || value === "" || typeof expiresAt !== "number") {
    throw new VoiceError("upstream", "OpenAI's answer had no client secret.", 502);
  }
  return { value, expiresAt };
}

/** What {@linkcode mintClientSecret} needs. */
export interface MintOptions {
  /** The OpenAI API key (from the keychain, or the dev server's environment). */
  readonly apiKey: string;
  /** The function tools for the session. */
  readonly tools: readonly ToolDefinition[];
  /** The session's instructions (default {@linkcode LOOPY_INSTRUCTIONS}). */
  readonly instructions?: string;
  /** The fetch to use (tests pass a fake). */
  readonly fetch?: typeof fetch;
  /** Aborts the request. */
  readonly signal?: AbortSignal;
}

/**
 * Mint an ephemeral client secret for Loopy's session.
 *
 * @returns The secret and its expiry, nothing else from OpenAI's answer.
 * @throws {VoiceError} `bad_key`, `rate_limited` or `upstream`.
 */
export async function mintClientSecret(options: MintOptions): Promise<ClientSecret> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        clientSecretRequest(options.tools, options.instructions ?? LOOPY_INSTRUCTIONS),
      ),
      signal: options.signal,
    });
  } catch {
    throw new VoiceError("upstream", "Could not reach OpenAI. Are you online?", 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw upstreamError(response.status);
  }
  return parseSecret(await response.json().catch(() => null));
}
