// The page's half of Loopy's tools: the model's function calls arrive in a `response.done` event on
// the data channel; each is relayed to the backend (the `loopyVoice` capability on desktop, the dev
// route in a browser), which runs it in Deno (voice/tools.ts). Its output goes back to the model as
// a `function_call_output` item, then a `response.create` asks for the rest of the reply. A tool's
// effect (a mood) is handed to the page. Pure apart from what it is handed, so it is unit-tested.
//
// https://developers.openai.com/api/docs/guides/realtime-conversations#function-calling

import { type LoopyMood, MOODS } from "./loopy-machine.ts";
import { functionCalls, type ServerEvent } from "./voice-machine.ts";

/** Runs a tool call on the backend. */
export type ToolCaller = (
  call: { readonly name: string; readonly arguments: string },
) => Promise<{ readonly output: string; readonly mood?: string }>;

/** The most tool rounds one user turn may take before Loopy stops asking for more. */
export const MAX_TOOL_ROUNDS = 4;

/** What {@linkcode relayToolCalls} needs. */
export interface RelayOptions {
  /** Runs a call in the backend. */
  readonly call: ToolCaller;
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
    const result = await options.call({ name: c.name, arguments: c.arguments }).catch((err) => ({
      output: JSON.stringify({ ok: false, error: (err as Error)?.message ?? "tool failed" }),
      mood: undefined,
    }));
    if (result.mood && (MOODS as readonly string[]).includes(result.mood)) {
      options.onMood(result.mood as LoopyMood);
    }
    options.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: c.callId, output: result.output },
    });
  }
  if (spoke(event) || options.round >= MAX_TOOL_ROUNDS) return false;
  options.send({ type: "response.create" });
  return true;
}
