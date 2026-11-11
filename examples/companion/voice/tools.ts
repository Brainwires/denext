// The tools Loopy's voice model can call, server side. The model's function calls arrive on the
// page's data channel; the page relays each one here (lib/tool-relay.ts → the desktop extension or
// the dev route), the registry runs it, and the page sends the result back to the model as a
// `function_call_output` item. A tool may also hand the page an effect to show (a mood).
//
// `set_mood` is always on. The others (web search, the browser, memory recall; voice/toolset.ts)
// each belong to a feature the user can switch off in Loopy's settings at any time: a switched-off
// tool leaves the session's declarations and answers every call with a refusal. A tool that must
// ask the user first (a form submit in the browser) answers with a confirmation instead of an
// output; the page shows it and the call finishes through `confirm` (voice/confirm.ts).

import { type LoopyMood, MOODS } from "../lib/loopy-machine.ts";
import type { Confirmations, ConfirmRequest } from "./confirm.ts";

/** A function tool as the Realtime session declares it. */
export interface ToolDefinition {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** A link a tool found (web-search sources), shown in the bubble. */
export interface ToolSource {
  readonly title: string;
  readonly url: string;
}

/** What a tool returns: the output for the model, and what the page should show. */
export interface ToolResult {
  /** JSON-serialisable output for the model. */
  readonly output: unknown;
  /** A mood for Loopy to take. */
  readonly mood?: LoopyMood;
  /** Links to show under the reply. */
  readonly sources?: readonly ToolSource[];
  /** Ask the user first: the output comes once they answer (voice/confirm.ts). */
  readonly confirm?: ConfirmRequest;
}

/** The switchable features, each a group of tools. */
export type ToolFeature = "webSearch" | "browser" | "memory";

/** Which features are on. */
export type ToolFeatures = Readonly<Record<ToolFeature, boolean>>;

/** Every feature off: what the backend assumes until the page says otherwise. */
export const NO_FEATURES: ToolFeatures = { webSearch: false, browser: false, memory: false };

/** What a tool run gets besides its arguments. */
export interface ToolContext {
  /** The OpenAI key, read when needed (never returned to the page). */
  readonly apiKey: () => Promise<string | null>;
}

/** One tool: its declaration and its implementation (`args` is the parsed JSON arguments). */
export interface VoiceTool {
  readonly definition: ToolDefinition;
  /** The feature it belongs to (always on when unset). */
  readonly feature?: ToolFeature;
  readonly run: (args: unknown, ctx: ToolContext) => ToolResult | Promise<ToolResult>;
}

/** What a relayed call answers: the output as the JSON string the model reads, and the effects. */
export interface ToolCallResult {
  readonly output: string;
  readonly mood?: LoopyMood;
  readonly sources?: readonly ToolSource[];
  /** The user must answer this before the call has an output. */
  readonly confirm?: ConfirmRequest;
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
  /** The declarations for the session: the always-on tools and those of the features on. */
  definitions(): ToolDefinition[];
  /** Which features are on. */
  features(): ToolFeatures;
  /** Turn features on or off (a call to a tool whose feature is off is refused). */
  configure(features: ToolFeatures): void;
  /**
   * Run tool `name` with the model's JSON `args`. Never throws: an unknown or switched-off tool,
   * unparseable arguments or a failing tool become an `{ ok: false, error }` output the model can
   * read.
   */
  call(name: string, args: string, ctx?: ToolContext): Promise<ToolCallResult>;
  /** Finish a call that asked the user first, with their answer. Never throws. */
  confirm(id: string, approved: boolean): Promise<ToolCallResult>;
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

/** A tool's result as the page receives it. */
function toCallResult(result: ToolResult): ToolCallResult {
  return {
    output: JSON.stringify(result.output ?? null),
    ...(result.mood ? { mood: result.mood } : {}),
    ...(result.sources?.length ? { sources: result.sources } : {}),
    ...(result.confirm ? { confirm: result.confirm } : {}),
  };
}

/** A context whose key is never there (calls made without one). */
const NO_CONTEXT: ToolContext = { apiKey: () => Promise.resolve(null) };

/** The words a refusal for a switched-off feature uses. */
const FEATURE_NAMES: Readonly<Record<ToolFeature, string>> = {
  webSearch: "Web search",
  browser: "The browser",
  memory: "Memory",
};

/** What {@linkcode createToolRegistry} takes besides the tools. */
export interface RegistryOptions {
  /** The confirmations the tools ask through (a call's `confirm` is finished here). */
  readonly confirmations?: Confirmations;
  /** Called after the features change (the browser closes when it is switched off). */
  readonly onConfigure?: (features: ToolFeatures) => void;
}

/**
 * A registry over `tools`.
 *
 * @param tools The tools (default: `set_mood` alone).
 * @param options The confirmations and the feature hook.
 */
export function createToolRegistry(
  tools: readonly VoiceTool[] = [setMoodTool],
  options: RegistryOptions = {},
): ToolRegistry {
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  let features: ToolFeatures = NO_FEATURES;
  const enabled = (t: VoiceTool) => t.feature === undefined || features[t.feature];
  return {
    definitions: () => tools.filter(enabled).map((t) => t.definition),
    features: () => features,
    configure(next) {
      features = { ...NO_FEATURES, ...next };
      options.onConfigure?.(features);
    },
    async call(name, args, ctx = NO_CONTEXT) {
      const tool = byName.get(name);
      if (!tool) return failed(`unknown tool: ${name.slice(0, 64)}`);
      if (!enabled(tool)) {
        return failed(`${FEATURE_NAMES[tool.feature!]} is turned off in Loopy's settings.`);
      }
      if (args.length > MAX_ARGUMENTS) return failed("arguments too long");
      const parsed = parseArgs(args);
      if (!parsed) return failed("arguments are not JSON");
      try {
        return toCallResult(await tool.run(parsed.value, ctx));
      } catch {
        return failed(`${name} failed`);
      }
    },
    async confirm(id, approved) {
      if (!options.confirmations) return failed("nothing is waiting for an answer");
      try {
        return toCallResult(await options.confirmations.answer(id, approved));
      } catch {
        return failed("the confirmed action failed");
      }
    },
  };
}
