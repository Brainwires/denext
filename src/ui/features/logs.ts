// `/database/logs` — the stack's logs, in the Database section: one service or every one, the
// last N lines within a time window, at a level and above, containing some text. A GET form of
// fixed choices (a service list read from the source, levels, windows, line counts) and one
// plain-text search box, so it works with JavaScript disabled and nothing in it is a pattern a
// caller could make the server run. Where the lines come from is `../logs/source.ts`; every line
// is redacted before it is rendered.

import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { jsonResponse, panelResponder, type UiContext } from "../html.ts";
import { Input, Mono, Note } from "../components.ts";
import { renderView } from "../view.ts";
import {
  filterLines,
  knownSecrets,
  LOG_DEADLINE_MS,
  LOG_LEVELS,
  LOG_SERVICE_NAME,
  type LogLine,
  type LogSource,
  pickLogSource,
} from "../logs/source.ts";
import { DbPanel, readOnlyNote } from "./database-views.ts";
import { Choice } from "./database-admin-views.ts";

/** The windows offered, in seconds (`""`: as far back as the line count reaches). */
const WINDOWS = [
  { value: "", label: "Any time" },
  { value: "300", label: "Last 5 minutes" },
  { value: "900", label: "Last 15 minutes" },
  { value: "3600", label: "Last hour" },
  { value: "21600", label: "Last 6 hours" },
  { value: "86400", label: "Last 24 hours" },
  { value: "604800", label: "Last 7 days" },
];

/** The line counts offered. */
const TAILS = ["100", "500", "1000", "5000"].map((v) => ({ value: v, label: `${v} lines` }));

/** The levels offered. */
const LEVELS = LOG_LEVELS.map((l) => ({ value: l, label: `${l} and above` }));

/** What the page was asked for, every field one of its fixed choices. */
interface LogsState {
  readonly service: string;
  readonly tail: number;
  readonly since: string;
  readonly level: typeof LOG_LEVELS[number];
  readonly text: string;
}

/** The page's state from the query (anything off the lists falls back to the default). */
function stateOf(url: URL): LogsState {
  const q = url.searchParams;
  const pick = (name: string, options: readonly { value: string }[], fallback: string) => {
    const v = q.get(name) ?? fallback;
    return options.some((o) => o.value === v) ? v : fallback;
  };
  const service = q.get("service") ?? "";
  return {
    service: LOG_SERVICE_NAME.test(service) ? service : "",
    tail: Number(pick("tail", TAILS, "500")),
    since: pick("since", WINDOWS, "3600"),
    level: pick("level", LEVELS, "info") as typeof LOG_LEVELS[number],
    text: (q.get("q") ?? "").slice(0, 200),
  };
}

const panelResponse = panelResponder("Database", "/database");

/** The filter form: a GET of fixed choices and one plain-text box. */
function LogsForm(
  { state, services }: { readonly state: LogsState; readonly services: readonly string[] },
): VNode {
  const serviceOptions = [
    { value: "", label: "Every service" },
    ...services.map((s) => ({ value: s, label: s })),
  ];
  return h(
    "form",
    { method: "get", action: "/database/logs", class: "filter", role: "search" },
    h(Choice, { name: "service", label: "Service", options: serviceOptions, value: state.service }),
    h(Choice, { name: "level", label: "Level", options: LEVELS, value: state.level }),
    h(Choice, { name: "since", label: "Window", options: WINDOWS, value: state.since }),
    h(Choice, { name: "tail", label: "Lines", options: TAILS, value: String(state.tail) }),
    h(Input, {
      type: "search",
      name: "q",
      value: state.text,
      placeholder: "Contains text",
      ariaLabel: "Contains text",
    }),
    h("button", { type: "submit" }, "Show"),
  );
}

/** The lines, newest last. */
function LogLines({ lines }: { readonly lines: readonly LogLine[] }): VNode {
  if (lines.length === 0) return h(Note, null, "No lines match.");
  return h(
    "pre",
    { class: "out log-lines" },
    lines.map((line) => `${line.time ?? ""} ${line.service} | ${line.text}\n`).join(""),
  );
}

/** Read what `state` asks for. */
async function readPage(
  source: LogSource,
  state: LogsState,
  signal: AbortSignal,
): Promise<{ services: string[]; lines: LogLine[] }> {
  const services = await source.services(signal);
  const service = services.includes(state.service) ? state.service : "";
  const lines = await source.read({
    service,
    tail: state.tail,
    ...(state.since ? { sinceSeconds: Number(state.since) } : {}),
  }, signal);
  return { services, lines };
}

/**
 * Serve `/database/logs` (and its `/api` twin).
 *
 * @param ctx The request.
 * @returns The page.
 */
export async function logsPanel(ctx: UiContext): Promise<Response> {
  const state = stateOf(ctx.url);
  const source = await pickLogSource(ctx.dir, ctx.logs);
  const view = (children: VNode | VNode[]) =>
    panelResponse(
      ctx,
      renderView(
        h(
          DbPanel,
          { tab: "/database/logs", dashboard: ctx.dashboard === true },
          readOnlyNote({ csrf: ctx.csrf, readOnly: ctx.readOnly }),
          children,
        ),
      ),
    );
  if (!source) {
    const reason = "No log source: the project has no compose file (denext generate docker), " +
      "and no dashboard-logs relay is configured.";
    return ctx.json ? jsonResponse({ ok: false, reason }, 404) : view(h(Note, null, reason));
  }
  const signal = ctx.signal
    ? AbortSignal.any([ctx.signal, AbortSignal.timeout(LOG_DEADLINE_MS)])
    : AbortSignal.timeout(LOG_DEADLINE_MS);
  let read: { services: string[]; lines: LogLine[] };
  try {
    read = await readPage(source, state, signal);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (ctx.json) return jsonResponse({ ok: false, reason }, 502);
    return view([h(LogsForm, { state, services: [] }), h(Note, { role: "alert" }, reason)]);
  }
  const lines = filterLines(read.lines, state, await knownSecrets(ctx.dir));
  if (ctx.json) {
    return jsonResponse({ ok: true, source: source.label, services: read.services, lines });
  }
  return view([
    h(
      "p",
      { key: "lead", class: "lead" },
      "From ",
      h(Mono, null, source.label),
      ". Secrets and connection-string passwords are masked.",
    ),
    h(LogsForm, { key: "form", state, services: read.services }),
    h(Fragment, { key: "lines" }, h(LogLines, { lines })),
  ]);
}
