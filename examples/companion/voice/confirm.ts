// Asking the user before Loopy does something it can't take back (a form submit, a click on a
// "Place order" button, a navigation that posts data). A tool that needs a yes answers with a
// confirmation — an id and a question — instead of an output; the page shows the question in
// Loopy's bubble with Yes / No buttons and sends the answer back (`confirm`), and only a Yes runs
// the held action. The model can't answer on the user's behalf: no tool takes an id, and the page
// sends `confirm` only from the buttons. One question waits at a time; an unanswered one expires.
// Pure apart from the clock it is handed, so it is unit-tested.

import type { ToolResult } from "./tools.ts";

/** A question for the user, as the page receives it. */
export interface ConfirmRequest {
  /** Names this question in the answer. */
  readonly id: string;
  /** What Loopy asks (shown in the bubble). */
  readonly prompt: string;
}

/** How long a question waits for an answer. */
const CONFIRM_TTL_MS = 2 * 60_000;

/** The longest question shown. */
const MAX_PROMPT = 200;

/** What a held action does on each answer. */
export interface HeldAction {
  /** Runs on Yes: its result is the tool call's output. */
  readonly run: () => Promise<ToolResult>;
  /** Runs on No, on expiry, and when another question replaces this one. */
  readonly cancel?: () => Promise<void> | void;
}

/** The questions waiting for the user. */
export interface Confirmations {
  /** Hold `action` and answer the tool call with a question. Replaces a question still waiting. */
  ask(prompt: string, action: HeldAction): ToolResult;
  /** The user's answer: runs the action on Yes, cancels it on No. */
  answer(id: string, approved: boolean): Promise<ToolResult>;
  /** Cancel whatever is waiting (the browser closed, the feature was switched off). */
  cancelAll(): Promise<void>;
}

/** What the model hears when the user says no. */
export const DECLINED = {
  ok: false,
  declined: true,
  error: "The user said no. Don't do it, and don't try again unless they ask.",
} as const;

/** What the model hears for an unknown or expired question. */
const EXPIRED = { ok: false, error: "That question expired; ask the user again." } as const;

/**
 * The confirmations.
 *
 * @param now The clock (tests pass a fake).
 * @param ttlMs How long a question waits.
 */
export function createConfirmations(
  now: () => number = Date.now,
  ttlMs: number = CONFIRM_TTL_MS,
): Confirmations {
  let pending: { id: string; action: HeldAction; expires: number } | null = null;
  const drop = async () => {
    const held = pending;
    pending = null;
    await held?.action.cancel?.();
  };
  return {
    ask(prompt, action) {
      void drop();
      const id = crypto.randomUUID();
      pending = { id, action, expires: now() + ttlMs };
      const question = prompt.length > MAX_PROMPT ? `${prompt.slice(0, MAX_PROMPT - 1)}…` : prompt;
      return {
        output: { ok: false, waiting: "Loopy asked the user to confirm." },
        confirm: { id, prompt: question },
      };
    },
    async answer(id, approved) {
      if (pending === null || pending.id !== id) return { output: EXPIRED };
      if (now() > pending.expires) {
        await drop();
        return { output: EXPIRED };
      }
      if (!approved) {
        await drop();
        return { output: DECLINED };
      }
      const { action } = pending;
      pending = null;
      return await action.run();
    },
    cancelAll: drop,
  };
}
