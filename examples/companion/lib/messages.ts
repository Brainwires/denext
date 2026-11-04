// What another program can ask Loopy to say (`POST /api/loopy/say`), validated before it reaches
// the page. Shared by the inbox (inbox/handler.ts), the page and the CLI (scripts/loopy-say.ts).

import { type LoopyMood, MOODS } from "./loopy-machine.ts";

/** A button under a message. */
export interface LoopyAction {
  /** What the sender gets back when it is pressed (`wait: true`). */
  readonly id: string;
  /** The button's text. */
  readonly label: string;
}

/** A message as a sender posts it. */
export interface SayRequest {
  /** What Loopy says (1–500 characters). */
  readonly text: string;
  /** How Loopy looks while it says it (default `neutral`). */
  readonly mood?: LoopyMood;
  /** Up to three buttons. */
  readonly actions?: readonly LoopyAction[];
  /**
   * How long the bubble stays up, in milliseconds (1000–120000). `0` keeps it until the user
   * closes it. Default: by length, or until closed when there are actions.
   */
  readonly timeoutMs?: number;
  /** Hold the response until a button is pressed or the bubble closes (at most two minutes). */
  readonly wait?: boolean;
}

/** A validated message, as the page receives it. */
export interface LoopyMessage {
  /** Random per message; the page answers a button press with it. */
  readonly id: string;
  readonly text: string;
  readonly mood: LoopyMood;
  readonly actions: readonly LoopyAction[];
  /** Milliseconds before the bubble closes itself, or `0` for never. */
  readonly timeoutMs: number;
}

/** The longest message. */
export const MAX_TEXT = 500;
/** The most buttons. */
const MAX_ACTIONS = 3;
/** The longest button label. */
const MAX_LABEL = 40;
/** The longest a bubble may be asked to stay (and a `wait` may hold the response). */
export const MAX_TIMEOUT_MS = 120_000;

const ACTION_ID = /^[A-Za-z0-9_.-]{1,40}$/;

/** A validation failure: the message the inbox answers 400 with. */
export class SayError extends Error {}

/** The default bubble time for `text`: four seconds plus a little per character, at most 15 s. */
export function readingTimeMs(text: string): number {
  return Math.min(15_000, 4_000 + text.length * 50);
}

/** One action, validated. */
function parseAction(raw: unknown, index: number): LoopyAction {
  if (typeof raw !== "object" || raw === null) {
    throw new SayError(`actions[${index}] must be an object`);
  }
  const { id, label } = raw as { id?: unknown; label?: unknown };
  if (typeof id !== "string" || !ACTION_ID.test(id)) {
    throw new SayError(`actions[${index}].id must be 1-40 letters, digits, '_', '.' or '-'`);
  }
  if (typeof label !== "string" || !label.trim() || label.length > MAX_LABEL) {
    throw new SayError(`actions[${index}].label must be 1-${MAX_LABEL} characters`);
  }
  return { id, label: label.trim() };
}

/** The `actions` field, validated (ids unique). */
function parseActions(raw: unknown): LoopyAction[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ACTIONS) {
    throw new SayError(`actions must be an array of at most ${MAX_ACTIONS}`);
  }
  const actions = raw.map(parseAction);
  if (new Set(actions.map((a) => a.id)).size !== actions.length) {
    throw new SayError("actions ids must be unique");
  }
  return actions;
}

/** The `timeoutMs` field, validated, or the default for the text and actions. */
function parseTimeout(raw: unknown, text: string, hasActions: boolean): number {
  if (raw === undefined) return hasActions ? 0 : readingTimeMs(text);
  if (
    typeof raw !== "number" || !Number.isInteger(raw) ||
    (raw !== 0 && (raw < 1_000 || raw > MAX_TIMEOUT_MS))
  ) {
    throw new SayError(`timeoutMs must be 0 or an integer from 1000 to ${MAX_TIMEOUT_MS}`);
  }
  return raw;
}

/**
 * Validate a posted body into the message the page shows. Throws {@linkcode SayError} with a
 * reason a sender can act on.
 *
 * @param raw The parsed JSON body.
 * @param id The message id to give it (random by default).
 * @returns The message and whether the sender waits for an answer.
 */
export function parseSayRequest(
  raw: unknown,
  id: string = crypto.randomUUID(),
): { message: LoopyMessage; wait: boolean } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SayError("the body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_TEXT) throw new SayError(`text must be 1-${MAX_TEXT} characters`);
  const mood = body.mood ?? "neutral";
  if (!MOODS.includes(mood as LoopyMood)) {
    throw new SayError(`mood must be one of ${MOODS.join(", ")}`);
  }
  if (body.wait !== undefined && typeof body.wait !== "boolean") {
    throw new SayError("wait must be a boolean");
  }
  const actions = parseActions(body.actions);
  const timeoutMs = parseTimeout(body.timeoutMs, text, actions.length > 0);
  return {
    message: { id, text, mood: mood as LoopyMood, actions, timeoutMs },
    wait: body.wait === true,
  };
}
