// Loopy's voice turn as a pure reducer: the session's phase (connecting, listening, thinking,
// speaking), the live transcripts for the speech bubble, and the mood the model set. The page
// (lib/use-voice.ts) feeds it its own events (a turn starts, is sent, the connection opens or
// fails) and the Realtime API's server events from the data channel, then draws Loopy from it.
//
// Server events used (https://developers.openai.com/api/reference/resources/realtime/server-events):
// `conversation.item.input_audio_transcription.delta` / `.completed` (what the user said),
// `response.output_audio_transcript.delta` (what Loopy says), `output_audio_buffer.started` /
// `.stopped` / `.cleared` (Loopy's voice playing), `response.done` and `error`.

import { isVisible, type LoopyEvent, type LoopyMood, type LoopyState } from "./loopy-machine.ts";

/** Where a voice session is. */
export type VoicePhase =
  | "off" // no session
  | "connecting" // minting a secret, opening the microphone and the WebRTC connection
  | "ready" // connected, waiting for a turn
  | "listening" // the microphone is on: the user is talking
  | "thinking" // the turn was sent; waiting for Loopy's reply
  | "speaking"; // Loopy's voice is playing

/** The voice state the page draws. */
export interface VoiceModel {
  readonly phase: VoicePhase;
  /** What the user said this turn (live transcription). */
  readonly user: string;
  /** What Loopy is saying (live transcript of its audio). */
  readonly assistant: string;
  /** The mood the model set with `set_mood`, or `null` before it set one. */
  readonly mood: LoopyMood | null;
  /** The last problem, worded for the user, or `null`. */
  readonly error: string | null;
}

/** A server event from the data channel (the fields read here). */
export interface ServerEvent {
  readonly type: string;
  readonly delta?: unknown;
  readonly transcript?: unknown;
  readonly response?: { readonly status?: unknown; readonly output?: readonly unknown[] };
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

/** What can happen to a voice session. */
export type VoiceEvent =
  | { readonly type: "connect" }
  | { readonly type: "connected" }
  | { readonly type: "listen" }
  | { readonly type: "send" }
  | { readonly type: "cancel" }
  | { readonly type: "mood"; readonly mood: LoopyMood }
  | { readonly type: "failed"; readonly message: string; readonly closed: boolean }
  | { readonly type: "closed" }
  | { readonly type: "clear" }
  | { readonly type: "server"; readonly event: ServerEvent };

/** No session yet. */
export const INITIAL_VOICE: VoiceModel = {
  phase: "off",
  user: "",
  assistant: "",
  mood: null,
  error: null,
};

/** The most transcript text kept per side (the bubble shows the end of a long one). */
export const MAX_TRANSCRIPT = 1_000;

/** `text` cut to its last {@linkcode MAX_TRANSCRIPT} characters. */
const tail = (text: string) =>
  text.length > MAX_TRANSCRIPT ? `…${text.slice(-MAX_TRANSCRIPT + 1)}` : text;

/** `value` when it is a string, else "". */
const str = (value: unknown) => typeof value === "string" ? value : "";

/** Whether a session is busy with a turn (or opening for one). */
export function voiceBusy(phase: VoicePhase): boolean {
  return phase === "connecting" || phase === "listening" || phase === "thinking" ||
    phase === "speaking";
}

/** The model's function calls in a `response.done` event. */
export function functionCalls(
  event: ServerEvent,
): { readonly name: string; readonly callId: string; readonly arguments: string }[] {
  const output = event.type === "response.done" ? event.response?.output ?? [] : [];
  return output.flatMap((item) => {
    const i = item as { type?: unknown; name?: unknown; call_id?: unknown; arguments?: unknown };
    return i?.type === "function_call" && typeof i.name === "string" &&
        typeof i.call_id === "string"
      ? [{ name: i.name, callId: i.call_id, arguments: str(i.arguments) }]
      : [];
  });
}

/** What an `error` server event means to the user. */
function serverError(event: ServerEvent): string {
  const code = str(event.error?.code);
  if (code === "input_audio_buffer_commit_empty") return "I didn't catch that. Try again?";
  const message = str(event.error?.message);
  return message ? `Voice error: ${message.slice(0, 200)}` : "Something went wrong with the voice.";
}

/** A finished response: back to waiting, unless it asked for tools (the relay continues it). */
function responseDone(model: VoiceModel, event: ServerEvent): VoiceModel {
  if (functionCalls(event).length > 0) return model;
  const status = str(event.response?.status);
  if (status === "cancelled" || status === "failed" || model.phase === "thinking") {
    return { ...model, phase: model.phase === "speaking" ? "speaking" : "ready" };
  }
  return model;
}

/** How each server event the page reads changes the model (others change nothing). */
const SERVER_EVENTS: Readonly<Record<string, (m: VoiceModel, e: ServerEvent) => VoiceModel>> = {
  "conversation.item.input_audio_transcription.delta": (m, e) => ({
    ...m,
    user: tail(m.user + str(e.delta)),
  }),
  "conversation.item.input_audio_transcription.completed": (m, e) => ({
    ...m,
    user: tail(str(e.transcript)),
  }),
  "response.output_audio_transcript.delta": (m, e) => ({
    ...m,
    assistant: tail(m.assistant + str(e.delta)),
  }),
  "output_audio_buffer.started": (m) => m.phase === "listening" ? m : { ...m, phase: "speaking" },
  "output_audio_buffer.stopped": (m) => m.phase === "speaking" ? { ...m, phase: "ready" } : m,
  "output_audio_buffer.cleared": (m) => m.phase === "speaking" ? { ...m, phase: "ready" } : m,
  "response.done": responseDone,
  error: (m, e) => ({
    ...m,
    error: serverError(e),
    phase: m.phase === "listening" ? m.phase : "ready",
  }),
};

/** The next model for a server event. */
function onServer(model: VoiceModel, event: ServerEvent): VoiceModel {
  const handle = Object.hasOwn(SERVER_EVENTS, event.type) ? SERVER_EVENTS[event.type] : undefined;
  return handle ? handle(model, event) : model;
}

/** The next voice model for `event`. */
export function voiceReducer(model: VoiceModel, event: VoiceEvent): VoiceModel {
  switch (event.type) {
    case "connect":
      return { ...model, phase: "connecting", error: null };
    case "connected":
      return model.phase === "connecting" ? { ...model, phase: "ready" } : model;
    case "listen":
      return { ...model, phase: "listening", user: "", assistant: "", error: null };
    case "send":
      return model.phase === "listening" ? { ...model, phase: "thinking" } : model;
    case "cancel":
      return model.phase === "off" ? model : { ...model, phase: "ready" };
    case "mood":
      return { ...model, mood: event.mood };
    case "failed":
      return { ...model, phase: event.closed ? "off" : "ready", error: event.message };
    case "closed":
      return { ...model, phase: "off" };
    case "clear":
      return { ...model, user: "", assistant: "", error: null };
    case "server":
      return onServer(model, event.event);
  }
}

/** How Loopy looks for a voice phase: its `data-voice` attribute, and whether it thinks. */
export function voiceLook(
  phase: VoicePhase,
): { readonly voice?: "listening" | "thinking" | "speaking"; readonly think: boolean } {
  switch (phase) {
    case "listening":
      return { voice: "listening", think: false };
    case "connecting":
    case "thinking":
      return { voice: "thinking", think: true };
    case "speaking":
      return { voice: "speaking", think: false };
    default:
      return { think: false };
  }
}

/** Whether a turn, or its transcript, is on screen (it owns the bubble and Loopy's look). */
export function voiceOnScreen(voice: VoiceModel): boolean {
  return voiceBusy(voice.phase) || voice.user !== "" || voice.assistant !== "" ||
    voice.error !== null;
}

/**
 * How Loopy is drawn with a voice turn going on: thinking while the reply is on its way (when it
 * is on screen), the model's mood while the turn is up, and the `data-voice` look.
 *
 * @param voice The voice state.
 * @param state Loopy's move from the companion machine.
 * @param message The message on screen, if any (its mood is Loopy's outside a turn).
 */
export function voiceStage(
  voice: VoiceModel,
  state: LoopyState,
  message?: { readonly mood: LoopyMood },
) {
  const messageMood = message?.mood;
  const voiceUp = voiceOnScreen(voice);
  const look = voiceLook(voice.phase);
  return {
    voiceUp,
    state: look.think && isVisible(state) ? "think" as const : state,
    mood: voiceUp && voice.mood ? voice.mood : messageMood,
    voice: look.voice,
  };
}

/**
 * What Loopy's machine should hear when the voice phase changes: `show` when a turn starts while
 * Loopy is folded away, `settle` when one ends on a held move (a thinking or attention mood) with
 * no message waiting, else nothing.
 */
export function voiceNudge(
  phase: VoicePhase,
  state: LoopyState,
  messageUp: boolean,
): LoopyEvent | null {
  if (voiceBusy(phase)) return isVisible(state) ? null : { type: "show" };
  const held = state === "think" || state === "point";
  return held && !messageUp ? { type: "settle" } : null;
}
