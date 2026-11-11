// Which voice turns Loopy remembers: a turn is finished once the user's words are transcribed and
// Loopy's reply is done (every tool round included). Then its two transcripts go to the backend
// (`remember`), which keeps them only while memory is on. A turn cut short (a new turn, a
// cancelled or failed reply) is not kept. Pure, so it is unit-tested.
//
// Server events used: `conversation.item.input_audio_transcription.completed` (the user's words),
// `response.output_audio_transcript.done` (each reply's transcript) and `response.done`.

import { functionCalls, type ServerEvent } from "./voice-machine.ts";

/** A finished turn. */
export interface FinishedTurn {
  readonly user: string;
  readonly assistant: string;
}

/** Follows one turn at a time. */
export interface TurnRecorder {
  /** A new turn starts (whatever the last one had is dropped). */
  start(): void;
  /** Feed a server event; returns the turn the moment it is finished, once. */
  onEvent(event: ServerEvent): FinishedTurn | null;
}

/** One turn as it is followed. */
interface TurnState {
  /** The user's words, once transcribed. */
  user: string | null;
  /** Loopy's reply so far. */
  assistant: string;
  /** The reply is done. */
  replied: boolean;
  /** The turn was kept, or dropped. */
  done: boolean;
}

/** `value` when it is a string, else "". */
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

/** How each server event the recorder reads changes the turn. */
const STEPS: Readonly<Record<string, (t: TurnState, e: ServerEvent) => void>> = {
  "conversation.item.input_audio_transcription.completed": (t, e) => {
    t.user = text(e.transcript);
  },
  "response.output_audio_transcript.done": (t, e) => {
    const said = text(e.transcript);
    if (said) t.assistant = t.assistant ? `${t.assistant} ${said}` : said;
  },
  "response.done": (t, e) => {
    if (functionCalls(e).length > 0) return; // a tool round: the reply goes on
    if (e.response?.status === "completed") t.replied = true;
    else t.done = true; // cancelled or failed: not kept
  },
};

/** The turn, the moment it is finished (and marks it kept). */
function finished(t: TurnState): FinishedTurn | null {
  if (t.done || t.user === null || !t.replied) return null;
  t.done = true;
  return t.user === "" ? null : { user: t.user, assistant: t.assistant };
}

/** A recorder. */
export function createTurnRecorder(): TurnRecorder {
  let turn: TurnState = { user: null, assistant: "", replied: false, done: false };
  return {
    start() {
      turn = { user: null, assistant: "", replied: false, done: false };
    },
    onEvent(event) {
      const step = Object.hasOwn(STEPS, event.type) ? STEPS[event.type] : undefined;
      if (turn.done || !step) return null;
      step(turn, event);
      return finished(turn);
    },
  };
}
