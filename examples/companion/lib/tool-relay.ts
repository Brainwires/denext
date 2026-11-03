// The page's half of Loopy's tools: the model's function calls arrive in a `response.done` event on
// the data channel; each is relayed to the backend (the `loopyVoice` capability on desktop, the dev
// route in a browser), which runs it in Deno (voice/tools.ts). Its output goes back to the model as
// a `function_call_output` item, then a `response.create` asks for the rest of the reply. A tool's
// effects (a mood, source links) are handed to the page. A tool that must ask the user first (a
// form submit in the browser) answers with a question: the relay shows it with Yes / No, waits,
// and sends the answer back (`confirm`); the output the model gets is that call's. Pure apart from
// what it is handed, so it is unit-tested.
//
// https://developers.openai.com/api/docs/guides/realtime-conversations#function-calling

import { type LoopyMood, MOODS } from "./loopy-machine.ts";
import type { SourceLink, ToolAnswer } from "./voice-backend.ts";
import { functionCalls, type ServerEvent } from "./voice-machine.ts";

/** Runs a tool call on the backend. */
export type ToolCaller = (
  call: { readonly name: string; readonly arguments: string },
) => Promise<ToolAnswer>;

/**
 * The most tool rounds one user turn may take before Loopy stops asking for more (browsing takes a
 * few: open, read, click, read).
 */
export const MAX_TOOL_ROUNDS = 8;

/** The most questions one call may ask in a row. */
const MAX_QUESTIONS = 3;

/** What {@linkcode relayToolCalls} needs. */
export interface RelayOptions {
  /** Runs a call in the backend. */
  readonly call: ToolCaller;
  /** Sends the user's answer to a tool's question to the backend. */
  readonly confirm?: (id: string, approved: boolean) => Promise<ToolAnswer>;
  /** Asks the user (Loopy's bubble with Yes / No); resolves with their answer. */
  readonly ask?: (prompt: string) => Promise<boolean>;
  /** Shows the links a tool found. */
  readonly onSources?: (sources: readonly SourceLink[]) => void;
  /** Sends a client event on the data channel. */
  readonly send: (event: Record<string, unknown>) => void;
  /** Shows a mood a tool set. */
  readonly onMood: (mood: LoopyMood) => void;
  /** Which round of tool calls this is in the turn (1 for the first). */
  readonly round: number;
}

/** Whether a response already said something (so no follow-up response is needed). */
function spoke(event: ServerEvent): boolean {
  return (event.response?.output ?? []).some((item) =>
    (item as { type?: unknown } | null)?.type === "message"
  );
}

/** A failure as the model's output. */
const failure = (err: unknown): ToolAnswer => ({
  output: JSON.stringify({ ok: false, error: (err as Error)?.message || "tool failed" }),
});

/** What the model hears when nobody can be asked. */
const UNASKED: ToolAnswer = {
  output: JSON.stringify({ ok: false, error: "Loopy couldn't ask the user, so it didn't." }),
};

/** Run one call, asking the user whenever it asks a question, until it has an output. */
async function answer(
  options: RelayOptions,
  call: { readonly name: string; readonly arguments: string },
): Promise<ToolAnswer> {
  let result = await options.call(call).catch(failure);
  for (let i = 0; result.confirm && i < MAX_QUESTIONS; i++) {
    if (!options.ask || !options.confirm) return UNASKED;
    const approved = await options.ask(result.confirm.prompt).catch(() => false);
    result = await options.confirm(result.confirm.id, approved).catch(failure);
  }
  return result.confirm ? UNASKED : result;
}

/**
 * Relay the function calls in `event` (a `response.done`), send their outputs back, and ask for
 * the reply to continue when the response had nothing else in it.
 *
 * @returns Whether a follow-up `response.create` was sent.
 */
export async function relayToolCalls(event: ServerEvent, options: RelayOptions): Promise<boolean> {
  const calls = functionCalls(event);
  if (calls.length === 0) return false;
  for (const c of calls) {
    const result = await answer(options, { name: c.name, arguments: c.arguments });
    if (result.mood && (MOODS as readonly string[]).includes(result.mood)) {
      options.onMood(result.mood as LoopyMood);
    }
    if (result.sources?.length) options.onSources?.(result.sources);
    options.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: c.callId, output: result.output },
    });
  }
  if (spoke(event) || options.round >= MAX_TOOL_ROUNDS) return false;
  options.send({ type: "response.create" });
  return true;
}

/** What {@linkcode answerLateQuestion} needs. */
export interface LateQuestionOptions {
  /** Asks the user (Loopy's bubble with Yes / No). */
  readonly ask: (prompt: string) => Promise<boolean>;
  /** Sends the answer to the backend. */
  readonly confirm: (id: string, approved: boolean) => Promise<ToolAnswer>;
  /** Sends a client event on the data channel. */
  readonly send: (event: Record<string, unknown>) => void;
}

/**
 * Ask the user a question no tool call is waiting on (the browser holds data a page sent after
 * Loopy's last action), send the answer to the backend, and tell the model what happened.
 *
 * @returns The user's answer.
 */
export async function answerLateQuestion(
  question: { readonly id: string; readonly prompt: string },
  options: LateQuestionOptions,
): Promise<boolean> {
  const approved = await options.ask(question.prompt).catch(() => false);
  await options.confirm(question.id, approved).catch(failure);
  options.send({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "system",
      content: [{
        type: "input_text",
        text: `The user was asked "${question.prompt}" and answered ${approved ? "yes" : "no"}.`,
      }],
    },
  });
  return approved;
}
