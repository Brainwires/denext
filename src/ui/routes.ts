// The complete `denext ui` route table. One `Record<path, UiRoute>` — table dispatch, never an
// if-chain — so the set of reachable paths is data the server, the tests and (later) an MCP
// front-end all read from one place.
//
// Every feature path has an `/api/…` twin served by the same handler with `ctx.json` set, so the
// HTML UI and a machine client exercise identical code. Anything not `GET`/`HEAD` is a mutation
// and passes the origin + CSRF + `--read-only` gates in `server.ts` before arriving here.

import { parse as parseJsonc } from "@std/jsonc";
import { join } from "@std/path";
import { type SseClients, sseSend, sseStream } from "../build/sse.ts";
import {
  html,
  htmlResponse,
  jsonResponse,
  layout,
  renderPage,
  UI_CSS_PATH,
  UI_EVENTS_PATH,
  UI_JS_PATH,
  UI_NAV,
  type UiContext,
  type UiHandler,
  type UiRoute,
} from "./html.ts";
import { UI_CSS } from "./styles.ts";
import { UI_JS } from "./client.ts";
import { runDeno } from "./proc.ts";
import { configPanel } from "./features/config.ts";
import { pluginsPanel } from "./features/plugins.ts";
import { generatePanel } from "./features/generate.ts";
import { dockerPanel } from "./features/docker.ts";
import { wizardPanel } from "./features/wizard.ts";
import { commandsPanel } from "./features/commands.ts";

/** One feature panel: its HTML path, the methods it answers, and its module's handler. */
interface FeatureRoute {
  /** The HTML path (its JSON twin is `/api` + this). */
  readonly path: string;
  /** The methods it answers. */
  readonly methods: readonly string[];
  /** The feature module's handler. */
  readonly handle: UiHandler;
}

/** Every feature panel, in navigation order. */
const FEATURES: readonly FeatureRoute[] = [
  { path: "/config", methods: ["GET", "POST"], handle: configPanel },
  { path: "/config/next", methods: ["GET"], handle: configPanel },
  { path: "/plugins", methods: ["GET", "POST", "DELETE"], handle: pluginsPanel },
  { path: "/generate", methods: ["GET", "POST"], handle: generatePanel },
  { path: "/docker", methods: ["GET", "POST"], handle: dockerPanel },
  { path: "/wizard", methods: ["GET", "POST"], handle: wizardPanel },
  { path: "/commands", methods: ["GET", "POST"], handle: commandsPanel },
];

/** A static same-origin asset route (`text/css`, `text/javascript`). */
function assetRoute(body: string, type: string): UiRoute {
  return {
    methods: ["GET", "HEAD"],
    handle: (_request, _ctx) =>
      Promise.resolve(new Response(body, { headers: { "content-type": type } })),
  };
}

/**
 * Build the complete route table.
 *
 * @returns Every path the UI serves, keyed by pathname.
 */
function buildRoutes(): Record<string, UiRoute> {
  const table: Record<string, UiRoute> = {
    "/": { methods: ["GET", "HEAD"], handle: home },
    "/api/overview": { methods: ["GET"], handle: home },
    "/tasks/run": { methods: ["POST"], handle: runTask },
    "/api/tasks/run": { methods: ["POST"], handle: runTask },
    [UI_CSS_PATH]: assetRoute(UI_CSS, "text/css; charset=utf-8"),
    [UI_JS_PATH]: assetRoute(UI_JS, "text/javascript; charset=utf-8"),
    [UI_EVENTS_PATH]: {
      methods: ["GET"],
      handle: (_request, ctx) => Promise.resolve(sseStream(ctx.events)),
    },
  };
  for (const feature of FEATURES) {
    table[feature.path] = { methods: feature.methods, handle: feature.handle };
    table["/api" + feature.path] = { methods: feature.methods, handle: feature.handle };
  }
  return table;
}

/** Every path `denext ui` serves, keyed by pathname. */
export const UI_ROUTES: Record<string, UiRoute> = buildRoutes();

/**
 * Push a JSON event to every open UI page.
 *
 * @param clients The `/_ui/events` subscribers.
 * @param event A JSON-serialisable payload.
 */
export function broadcast(clients: SseClients, event: unknown): void {
  sseSend(clients, JSON.stringify(event));
}

// ── `/` ──────────────────────────────────────────────────────────────────────

/** What each card on the overview says. */
const CARD_LEAD: Record<string, string> = {
  "/config": "Edit denext.config.ts through schema-driven widgets.",
  "/config/next": "Read a compat app's next.config and translate it.",
  "/plugins": "Browse the catalog; add or remove plugins.",
  "/generate": "Scaffold pages, routes, layouts, components, actions.",
  "/docker": "Regenerate the Dockerfile and compose file with a diff.",
  "/wizard": "Take a fresh clone to a running dev server.",
  "/commands": "Run this project's own denext verbs.",
};

/** The overview page: where the UI is pointed, and a card per panel. */
function home(_request: Request, ctx: UiContext): Promise<Response> {
  const cards = UI_NAV.filter((item) => item.href !== "/").map((item) =>
    html`<a class="card" href="${item.href}"><strong>${item.label}</strong><span>${
      CARD_LEAD[item.href] ?? ""
    }</span></a>`
  );
  const body = html`<section id="panel"><h1>Project</h1>
<p class="lead mono">${ctx.dir}</p>
${ctx.readOnly ? html`<p class="note">Read-only mode — every change is refused.</p>` : ""}
<div class="cards">${cards}</div></section>`;
  if (ctx.json) {
    return Promise.resolve(
      jsonResponse({
        ok: true,
        dir: ctx.dir,
        readOnly: ctx.readOnly,
        routes: Object.keys(UI_ROUTES),
      }),
    );
  }
  return Promise.resolve(htmlResponse(
    renderPage(layout, { title: "Project", nav: UI_NAV, body, csrf: ctx.csrf, active: "/" }),
  ));
}

// ── `/tasks/run` ─────────────────────────────────────────────────────────────

/**
 * Run one `deno task` and stream its output back as SSE frames. The task name is never trusted:
 * it must appear in the project's own `deno.json`/`deno.jsonc` `tasks` map, and it is passed as
 * an argv element — never through a shell.
 */
async function runTask(request: Request, ctx: UiContext): Promise<Response> {
  const name = String(ctx.form?.get("task") ?? new URL(request.url).searchParams.get("task") ?? "");
  const tasks = await projectTasks(ctx.dir);
  if (!tasks.includes(name)) {
    return jsonResponse({ ok: false, reason: `unknown task "${name}"`, tasks }, 400);
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const frame = (line: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${line.replace(/\r?\n/g, " ")}\n\n`));
        } catch { /* the page navigated away */ }
      };
      runDeno(["task", name], { cwd: ctx.dir, onLine: frame })
        .then((r) => frame(`— exited ${r.code}`))
        .catch((e) => frame(`— failed: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => {
          broadcast(ctx.events, { type: "task-done", task: name });
          controller.close();
        });
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

/**
 * The task names declared in the project's `deno.json` / `deno.jsonc`.
 *
 * @param dir The project directory.
 * @returns The declared task names (empty when there is no config, or it is unreadable).
 */
export async function projectTasks(dir: string): Promise<string[]> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      const parsed = parseJsonc(await Deno.readTextFile(join(dir, name)));
      const tasks = (parsed as { tasks?: Record<string, unknown> } | null)?.tasks;
      if (tasks && typeof tasks === "object") return Object.keys(tasks);
    } catch { /* absent or malformed — try the next name */ }
  }
  return [];
}
