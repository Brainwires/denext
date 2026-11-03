// The tools Loopy's voice model can call, server side. The model's function calls arrive on the
// page's data channel; the page relays each one here (lib/tool-relay.ts → the desktop extension or
// the dev route), the registry runs it, and the page sends the result back to the model as a
// `function_call_output` item. A tool may also hand the page an effect to show (a mood).
//
// P1 has one tool, `set_mood`. Later ones (web search, a browser, memory) register here the same
// way, so they run in the Deno process, never in the page.

import { type LoopyMood, MOODS } from "../lib/loopy-machine.ts";

/** A function tool as the Realtime session declares it. */
export interface ToolDefinition {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** What a tool returns: the output for the model, and what the page should show. */
export interface ToolResult {
  /** JSON-serialisable output for the model. */
  readonly output: unknown;
  /** A mood for Loopy to take. */
  readonly mood?: LoopyMood;
}

/** One tool: its declaration and its implementation (`args` is the parsed JSON arguments). */
export interface VoiceTool {
  readonly definition: ToolDefinition;
  readonly run: (args: unknown) => ToolResult | Promise<ToolResult>;
}

/** What a relayed call answers: the output as the JSON string the model reads, and the effect. */
export interface ToolCallResult {
  readonly output: string;
  readonly mood?: LoopyMood;
}

/** The longest arguments string accepted. */
export const MAX_ARGUMENTS = 16 * 1024;

/** `set_mood`: the model sets Loopy's mood (its face, wire tint and move) as it talks. */
export const setMoodTool: VoiceTool = {
  definition: {
    type: "function",
    name: "set_mood",
    description: "Set Loopy's facial expression for the reply you are about to speak. Call it " +
      "once per reply, before speaking.",
    parameters: {
      type: "object",
      properties: {
        mood: {
          type: "string",
          enum: [...MOODS],
          description: "The mood that fits the reply.",
        },
      },
      required: ["mood"],
      additionalProperties: false,
    },
  },
  run(args) {
    const mood = (args as { mood?: unknown } | null)?.mood;
    if (typeof mood !== "string" || !(MOODS as readonly string[]).includes(mood)) {
      return { output: { ok: false, error: `mood must be one of: ${MOODS.join(", ")}` } };
    }
    return { output: { ok: true }, mood: mood as LoopyMood };
  },
};

/** The tools and how to call them. */
export interface ToolRegistry {
  /** The declarations for the session. */
  definitions(): ToolDefinition[];
  /**
   * Run tool `name` with the model's JSON `args`. Never throws: an unknown tool, unparseable
   * arguments or a failing tool become an `{ ok: false, error }` output the model can read.
   */
  call(name: string, args: string): Promise<ToolCallResult>;
}

/** An error output for the model. */
const failed = (error: string): ToolCallResult => ({
  output: JSON.stringify({ ok: false, error }),
});

/** `args` parsed, or `undefined` when it is not JSON. */
function parseArgs(args: string): { value: unknown } | undefined {
  try {
    return { value: args.trim() === "" ? {} : JSON.parse(args) };
  } catch {
    return undefined;
  }
}

/**
 * A registry over `tools`.
 *
 * @param tools The tools (default: Loopy's P1 set, `set_mood`).
 */
export function createToolRegistry(tools: readonly VoiceTool[] = [setMoodTool]): ToolRegistry {
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return {
    definitions: () => tools.map((t) => t.definition),
    async call(name, args) {
      const tool = byName.get(name);
      if (!tool) return failed(`unknown tool: ${name.slice(0, 64)}`);
      if (args.length > MAX_ARGUMENTS) return failed("arguments too long");
      const parsed = parseArgs(args);
      if (!parsed) return failed("arguments are not JSON");
      try {
        const result = await tool.run(parsed.value);
        return {
          output: JSON.stringify(result.output ?? null),
          ...(result.mood ? { mood: result.mood } : {}),
        };
      } catch {
        return failed(`${name} failed`);
      }
    },
  };
}
