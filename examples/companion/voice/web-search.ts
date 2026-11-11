// `web_search`: the voice model asks a question, and the Deno side answers it with OpenAI's
// Responses API and its built-in `web_search` tool, on the same key (it never reaches the page).
// The answer goes back to the voice model short, wrapped as untrusted web data, with its sources;
// the page shows the sources as links under the reply. `fetch` is injected, so tests never reach
// the network.
//
// Docs: https://developers.openai.com/api/docs/guides/tools-web-search (the `web_search` tool,
// `include: ["web_search_call.action.sources"]`, `url_citation` annotations),
// https://developers.openai.com/api/docs/models/gpt-6-luna (web search on the Responses API).

import { VoiceError } from "./realtime.ts";
import type { ToolSource, VoiceTool } from "./tools.ts";
import { clip, UNTRUSTED_NOTE, wrapUntrusted } from "./untrusted.ts";

/** Where a response is created. */
export const RESPONSES_URL = "https://api.openai.com/v1/responses";

/** The model that searches: the most efficient current one with web search on the Responses API. */
export const WEB_SEARCH_MODEL = "gpt-6-luna";

/** The most sources passed on. */
export const MAX_SEARCH_SOURCES = 5;

/** The longest answer passed on. */
const MAX_ANSWER = 1_500;

/** The longest query accepted. */
export const MAX_QUERY = 500;

/** How long a search may take. */
const SEARCH_TIMEOUT_MS = 30_000;

/** What the searching model is told. */
const SEARCH_INSTRUCTIONS = "Search the web and answer the question for a voice assistant: two " +
  "to four short plain sentences, no lists, no markdown, no URLs in the text.";

/** A search's answer. */
export interface SearchAnswer {
  readonly answer: string;
  readonly sources: readonly ToolSource[];
}

/** The request body for `query`. */
export function searchRequest(query: string): Record<string, unknown> {
  return {
    model: WEB_SEARCH_MODEL,
    instructions: SEARCH_INSTRUCTIONS,
    input: query,
    tools: [{ type: "web_search", search_context_size: "low" }],
    include: ["web_search_call.action.sources"],
    reasoning: { effort: "low" },
    store: false,
  };
}

/** `value` as an http(s) URL string, or `null`. */
function webUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** A source from a citation or a consulted-source entry, or `null`. */
function source(entry: unknown): ToolSource | null {
  const e = entry as { url?: unknown; title?: unknown } | null;
  const url = webUrl(e?.url);
  if (!url) return null;
  const title = typeof e?.title === "string" && e.title.trim() ? e.title.trim() : new URL(url).host;
  return { title: clip(title, 120), url };
}

/** The output items of a response. */
const outputItems = (body: unknown): unknown[] => {
  const output = (body as { output?: unknown } | null)?.output;
  return Array.isArray(output) ? output : [];
};

/** The `output_text` parts of the response's messages. */
function textParts(body: unknown): { text?: unknown; annotations?: unknown }[] {
  return outputItems(body).flatMap((item) => {
    const i = item as { type?: unknown; content?: unknown } | null;
    if (i?.type !== "message" || !Array.isArray(i.content)) return [];
    return i.content.filter((c) => (c as { type?: unknown } | null)?.type === "output_text");
  });
}

/** The URLs the searches consulted (`action.sources`). */
function consulted(body: unknown): unknown[] {
  return outputItems(body).flatMap((item) => {
    const i = item as { type?: unknown; action?: { sources?: unknown } } | null;
    return i?.type === "web_search_call" && Array.isArray(i.action?.sources)
      ? i.action.sources
      : [];
  });
}

/**
 * The answer and its sources in a Responses API body: the message text, the `url_citation`
 * annotations first, then the consulted sources, each URL once, at most {@linkcode MAX_SEARCH_SOURCES}.
 */
export function parseSearchResponse(body: unknown): SearchAnswer {
  const parts = textParts(body);
  const answer = parts.map((p) => typeof p.text === "string" ? p.text : "").join("").trim();
  const citations = parts.flatMap((p) => Array.isArray(p.annotations) ? p.annotations : [])
    .filter((a) => (a as { type?: unknown } | null)?.type === "url_citation");
  const seen = new Set<string>();
  const sources: ToolSource[] = [];
  for (const entry of [...citations, ...consulted(body)]) {
    const s = source(entry);
    if (!s || seen.has(s.url) || sources.length >= MAX_SEARCH_SOURCES) continue;
    seen.add(s.url);
    sources.push(s);
  }
  return { answer: clip(answer, MAX_ANSWER), sources };
}

/** The refusal for an unsuccessful answer (its body is never passed on). */
function searchError(status: number): VoiceError {
  if (status === 401 || status === 403) {
    return new VoiceError("bad_key", "OpenAI refused the API key.", 401);
  }
  if (status === 429) {
    return new VoiceError("rate_limited", "OpenAI is rate-limiting this key.", 429);
  }
  return new VoiceError("upstream", `The web search failed (${status}).`, 502);
}

/** What {@linkcode searchWeb} needs. */
export interface SearchOptions {
  readonly apiKey: string;
  readonly query: string;
  readonly fetch?: typeof fetch;
}

/**
 * Search the web through the Responses API.
 *
 * @throws {VoiceError} `bad_key`, `rate_limited` or `upstream`.
 */
export async function searchWeb(options: SearchOptions): Promise<SearchAnswer> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(RESPONSES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(searchRequest(options.query)),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch {
    throw new VoiceError("upstream", "Could not reach OpenAI for the web search.", 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw searchError(response.status);
  }
  return parseSearchResponse(await response.json().catch(() => null));
}

/** The query in the tool's arguments, or `null`. */
function queryOf(args: unknown): string | null {
  const q = (args as { query?: unknown } | null)?.query;
  if (typeof q !== "string") return null;
  const trimmed = q.trim();
  return trimmed === "" || trimmed.length > MAX_QUERY ? null : trimmed;
}

/**
 * The `web_search` tool.
 *
 * @param fetchFn The fetch OpenAI is called with (tests pass a fake).
 */
export function webSearchTool(fetchFn?: typeof fetch): VoiceTool {
  return {
    feature: "webSearch",
    definition: {
      type: "function",
      name: "web_search",
      description: "Search the web for current or factual information you don't know. Returns " +
        "a short answer and its sources (the user sees the sources as links).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for, as a full question." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const query = queryOf(args);
      if (!query) {
        return { output: { ok: false, error: `query must be 1–${MAX_QUERY} characters` } };
      }
      const apiKey = await ctx.apiKey();
      if (!apiKey) return { output: { ok: false, error: "no OpenAI key is set" } };
      try {
        const { answer, sources } = await searchWeb({ apiKey, query, fetch: fetchFn });
        return {
          output: {
            ok: true,
            note: UNTRUSTED_NOTE,
            answer: wrapUntrusted("web search", answer || "(no answer)"),
            sources: sources.map((s) => s.title),
          },
          sources,
        };
      } catch (err) {
        const message = err instanceof VoiceError ? err.message : "The web search failed.";
        return { output: { ok: false, error: message } };
      }
    },
  };
}
