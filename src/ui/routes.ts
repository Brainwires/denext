// The complete `denext ui` route table. One `Record<path, UiRoute>` — table dispatch, never an
// if-chain — so the set of reachable paths is data the server, the tests and (later) an MCP
// front-end all read from one place.
//
// Every feature path has an `/api/…` twin served by the same handler with `ctx.json` set, so the
// HTML UI and a machine client exercise identical code. Anything not `GET`/`HEAD` is a mutation
// and passes the origin + CSRF + `--read-only` gates in `server.ts` before arriving here.

import { basename } from "@std/path";
import { sseStream } from "../build/sse.ts";
import { pinnedDenextCli, pinnedVersion } from "../cli/self-exec.ts";
import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { readDevInfo } from "../mcp/dev-client.ts";
import {
  jsonResponse,
  panelResponder,
  UI_CRON_PREVIEW_PATH,
  UI_EVENTS_PATH,
  UI_NAV_SECTIONS,
  type UiContext,
  type UiHandler,
  type UiRoute,
} from "./html.ts";
import { type NavItem, UI_CSS_PATH, UI_JS_PATH } from "./layout.ts";
import { Badge, Mono, Note, Panel } from "./components.ts";
import { renderView } from "./view.ts";
import { UI_CSS } from "./styles.ts";
import { UI_JS } from "./client.ts";
import { broadcast, sseProcess } from "./events.ts";
import { runDeno } from "./proc.ts";
import { OFFLINE_REFUSALS, OFFLINE_STATUS } from "./offline.ts";
import { readDenoConfig, taskMap } from "./tasks.ts";
import { configPanel } from "./features/config.ts";
import { CONFIG_GROUPS } from "./features/config-groups.ts";
import { cronPreviewPanel } from "./features/config-cron.ts";
import { pluginsPanel } from "./features/plugins.ts";
import { pluginOptionsPanel } from "./features/plugin-options.ts";
import { generatePanel } from "./features/generate.ts";
import { dockerPanel } from "./features/docker.ts";
import { desktopPanel } from "./features/desktop.ts";
import { devPanel } from "./features/dev.ts";
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
  // One route per config view, derived from the group list so the two cannot drift: adding a
  // group gives it a page (and its `/api` twin) without anything here being edited.
  ...CONFIG_GROUPS.map((group) => ({
    path: `/config/${group}`,
    methods: ["GET", "POST"],
    handle: configPanel,
  })),
  { path: "/config/next", methods: ["GET"], handle: configPanel },
  { path: "/config/cron", methods: ["GET", "POST"], handle: configPanel },
  { path: "/plugins", methods: ["GET", "POST", "DELETE"], handle: pluginsPanel },
  { path: "/plugins/options", methods: ["GET", "POST"], handle: pluginOptionsPanel },
  { path: "/generate", methods: ["GET", "POST"], handle: generatePanel },
  { path: "/docker", methods: ["GET", "POST"], handle: dockerPanel },
  { path: "/desktop", methods: ["GET"], handle: desktopPanel },
  { path: "/dev", methods: ["GET", "POST"], handle: devPanel },
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
    [UI_CRON_PREVIEW_PATH]: { methods: ["GET"], handle: cronPreviewPanel },
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

// ── `/` ──────────────────────────────────────────────────────────────────────

/** What each card on the overview says. */
const CARD_LEAD: Record<string, string> = {
  "/config": "Edit denext.config.ts through schema-driven widgets, one view per subject.",
  "/plugins": "Browse the catalog; add or remove plugins.",
  "/generate": "Scaffold pages, routes, layouts, components, actions.",
  "/docker": "Edit docker-compose.yml in place, or regenerate the Docker files with a diff.",
  "/desktop": "Set up code signing for a packaged desktop build.",
  "/dev": "Start and stop the project's dev server, and watch its output.",
  "/wizard": "Take a fresh clone to a running dev server.",
  "/commands": "Run this project's own denext verbs.",
};

/** What the overview says under `--offline`. */
const OFFLINE_OVERVIEW = "Offline mode — nothing the UI starts reaches the network: denext " +
  "verbs run with --deny-net --cached-only, and deno task, denext dev and plugin add/remove " +
  "are refused.";

/** One overview card: a panel's name, and what it does. */
function Card({ item }: { readonly item: NavItem }): VNode {
  return h(
    "a",
    { class: "card", href: item.href },
    h("strong", null, item.label),
    h("span", null, CARD_LEAD[item.href] ?? ""),
  );
}

/**
 * What the overview offers: one card per destination, with a whole nav SECTION standing as a
 * single card.
 *
 * Configuration's card points at `/config`, which is itself a page of cards — one per view. Five
 * of them here would bury the panels they sit beside, and would leave `/config` with nothing
 * linking to it, since the sidebar lists those views directly.
 *
 * @returns The cards, in navigation order.
 */
function overviewCards(): NavItem[] {
  const out: NavItem[] = [];
  for (const section of UI_NAV_SECTIONS) {
    if (section.label !== undefined) {
      out.push({ href: "/config", label: section.label });
      continue;
    }
    for (const item of section.items) if (item.href !== "/") out.push(item);
  }
  return out;
}

/**
 * What the overview's status block says about the project — read from its files alone. No
 * subprocess and no HTTP probe: the page must open instantly, and whether the dev server
 * `dev.json` names is really answering is the Wizard's job to find out.
 */
interface ProjectStatus {
  /** The `name` in `deno.json`, else the directory's own name. */
  readonly name: string;
  /**
   * The denext the import map pins, as written (`^2.5.0`; `latest` for an unversioned
   * `jsr:@denext/denext`), or null when the project pins none.
   */
  readonly denext: string | null;
  /** The origin `.denext/dev.json` names, or null when there is no such file. */
  readonly dev: string | null;
}

/** Where the dev server is started and stopped. */
const DEV_PAGE = "/dev";

/**
 * Read the project's status for the overview: three cheap file reads, nothing spawned.
 *
 * The pin follows the rules `deno run` would (`pinnedDenextCli`: `deno.jsonc`, an `importMap`
 * file, a workspace root), so the overview and a compiled binary name the same denext.
 *
 * @param dir The project directory.
 * @returns The status.
 */
async function projectStatus(dir: string): Promise<ProjectStatus> {
  const name = (await readDenoConfig(dir))?.data?.name;
  const cli = pinnedDenextCli(dir);
  const dev = await readDevInfo(dir);
  return {
    name: typeof name === "string" && name !== "" ? name : basename(dir),
    denext: cli === null ? null : pinnedVersion(cli) ?? "latest",
    dev: dev === null ? null : dev.origin,
  };
}

/** The overview's status block: the project's name, its denext, and its dev server. */
function StatusBlock({ status }: { readonly status: ProjectStatus }): VNode {
  return h(
    "dl",
    { class: "status" },
    h("dt", null, "Project"),
    h("dd", null, status.name),
    h("dt", null, "denext"),
    h(
      "dd",
      null,
      status.denext === null
        ? h(Badge, { tone: "warn" }, "not pinned")
        : h(Mono, null, status.denext),
    ),
    h("dt", null, "Dev server"),
    h(
      "dd",
      null,
      status.dev === null ? ["Not running · ", h("a", { href: DEV_PAGE }, "Start it from Dev")] : [
        h(Mono, null, ".denext/dev.json"),
        " says running at ",
        h("a", { href: status.dev }, status.dev),
        " · ",
        h("a", { href: DEV_PAGE }, "Stop it from Dev"),
      ],
    ),
  );
}

/** The overview panel: where the UI is pointed, what the project is, and a card per panel. */
function Overview(
  { ctx, status }: { readonly ctx: UiContext; readonly status: ProjectStatus },
): VNode {
  const cards = overviewCards().map((item) => h(Card, { key: item.href, item }));
  return h(
    Panel,
    { title: "Project" },
    h("p", { class: "lead mono" }, ctx.dir),
    ctx.readOnly ? h(Note, { tone: "warn" }, "Read-only mode — every change is refused.") : null,
    ctx.offline === true ? h(Note, { tone: "warn" }, OFFLINE_OVERVIEW) : null,
    h(StatusBlock, { status }),
    h("div", { class: "cards" }, cards),
  );
}

/**
 * The overview's responder — the same one every other panel answers through.
 *
 * It used to render the whole document unconditionally, alone among the panels. That was
 * invisible until `ui.js` began swapping panels in place: a nav click to the overview fetched an
 * ENTIRE document, `swapPanel` dug the `<section id="panel">` back out of it, and the page looked
 * right while shipping a shell nobody used and carrying no title for the tab to take.
 */
const homeResponse = panelResponder("Project", "/");

/** The overview page, the bare panel for a swap, or its JSON twin (the status included). */
async function home(_request: Request, ctx: UiContext): Promise<Response> {
  const status = await projectStatus(ctx.dir);
  if (ctx.json) {
    return jsonResponse({
      ok: true,
      dir: ctx.dir,
      readOnly: ctx.readOnly,
      ...status,
      routes: Object.keys(UI_ROUTES),
    });
  }
  return homeResponse(ctx, renderView(h(Overview, { ctx, status })));
}

// ── `/tasks/run` ─────────────────────────────────────────────────────────────

/**
 * Run one `deno task` and stream its output back as SSE frames. The task name is never trusted:
 * it must appear in the project's own `deno.json`/`deno.jsonc` `tasks` map, and it is passed as
 * an argv element — never through a shell. The child is tied to the stream: it dies when the
 * page disconnects and when the UI server shuts down, so no task is left running as an orphan.
 * Under `--offline` a declared task is refused with a `503`: a task is arbitrary shell, and no
 * flag can keep it off the network.
 */
async function runTask(request: Request, ctx: UiContext): Promise<Response> {
  const name = String(ctx.form?.get("task") ?? new URL(request.url).searchParams.get("task") ?? "");
  const tasks = await projectTasks(ctx.dir);
  if (!tasks.includes(name)) {
    return jsonResponse({ ok: false, reason: `unknown task "${name}"`, tasks }, 400);
  }
  if (ctx.offline === true) {
    return jsonResponse({ ok: false, reason: OFFLINE_REFUSALS.task }, OFFLINE_STATUS);
  }
  return sseProcess(
    async (line, signal) =>
      (await runDeno(["task", name], { cwd: ctx.dir, onLine: line, signal })).code,
    {
      signal: ctx.signal,
      settled: () => broadcast(ctx.events, { type: "task-done", task: name }),
    },
  );
}

/**
 * The task names declared in the project's `deno.json` / `deno.jsonc` — the only names
 * `/tasks/run` will spawn.
 *
 * @param dir The project directory.
 * @returns The declared task names (empty when there is no config, or it is unreadable).
 */
export async function projectTasks(dir: string): Promise<string[]> {
  return Object.keys(taskMap(await readDenoConfig(dir)));
}
