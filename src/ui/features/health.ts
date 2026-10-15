// `/database/health` — the stack's health, as `denext stack health` prints it: each service's
// compose health check (from `docker compose ps`, or inside the stack from the `dashboard-logs`
// relay), the app's own `/_denext/health` readiness checks (the `services` supervision check
// among them), and the `services/` supervision tree — the running app's (through the backend's
// admin endpoint), else the last snapshot a server wrote (`.denext/services.json`).
//
// It refreshes itself: a `<noscript>` meta refresh with scripting off, an in-place swap with it on
// (`data-refresh`, read by `ui.js`). The interval is one of a fixed list, picked in a GET form.
// Read-only: every value it shows is redacted like the Logs page, an error message included.

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { jsonResponse, panelResponder, type UiContext } from "../html.ts";
import { Badge, Mono, Note, Table } from "../components.ts";
import { renderView } from "../view.ts";
import type { ServiceHealth } from "../../cli/commands/stack-health.ts";
import { knownSecrets, LOG_DEADLINE_MS, pickLogSource, redact } from "../logs/source.ts";
import {
  type AdminChildStatus,
  adminStatus,
  type AppProbe,
  appProbe,
  appTarget,
} from "../app-admin.ts";
import type { SupervisorStatus } from "../../server/supervise.ts";
import { DbPanel, readOnlyNote } from "./database-views.ts";
import { Choice } from "./database-admin-views.ts";
import { readServicesState, SupervisorTable } from "./services.ts";

/** The refresh intervals offered, in seconds (`0`: off). */
const REFRESH = [
  { value: "0", label: "No refresh" },
  { value: "5", label: "Every 5 seconds" },
  { value: "15", label: "Every 15 seconds" },
  { value: "30", label: "Every 30 seconds" },
  { value: "60", label: "Every minute" },
];

/** The interval the query asks for (anything off the list is 15 s). */
function refreshOf(url: URL): number {
  const value = url.searchParams.get("refresh") ?? "15";
  return REFRESH.some((r) => r.value === value) ? Number(value) : 15;
}

/** The refresh picker: a GET form of fixed choices. */
function RefreshForm(
  { action, seconds }: { readonly action: string; readonly seconds: number },
): VNode {
  return h(
    "form",
    { method: "get", action, class: "filter" },
    h(Choice, { name: "refresh", label: "Refresh", options: REFRESH, value: String(seconds) }),
    h("button", { type: "submit" }, "Apply"),
  );
}

/** What the page shows. */
interface HealthState {
  /** Each service, or why they could not be read (`null`: no compose file and no relay). */
  readonly services: ServiceHealth[] | string | null;
  /** The app's probe, or `null` with no app to probe. */
  readonly probe: (AppProbe & { readonly url: string }) | null;
  /** The supervision tree, and where it came from. */
  readonly supervision: { readonly source: string; readonly tree: SupervisorStatus[] } | null;
}

/** A verdict as a badge. */
function Verdict({ ok, label }: { readonly ok: boolean; readonly label: string }): VNode {
  return h(Badge, { tone: ok ? "ok" : "fail" }, label);
}

/** The services table. */
function ServicesTable({ services }: { readonly services: HealthState["services"] }): VNode {
  if (services === null) {
    return h(Note, null, "No compose file and no dashboard-logs relay: no services to read.");
  }
  if (typeof services === "string") return h(Note, { role: "alert" }, services);
  if (services.length === 0) return h(Note, null, "The stack is not running (denext stack up).");
  const rows = services.map((s) =>
    h(
      "tr",
      { key: s.name },
      h("td", null, h(Mono, null, s.name)),
      h("td", null, s.state),
      h("td", null, s.health),
      h("td", null, h(Verdict, { ok: s.ok, label: s.ok ? "ok" : "unhealthy" })),
    )
  );
  return h(Table, { head: ["Service", "State", "Health check", ""], rows });
}

/** The app's probe and its readiness checks. */
function ProbeBlock({ probe }: { readonly probe: HealthState["probe"] }): VNode {
  if (probe === null) {
    return h(Note, null, "No running app to probe: start the dev server (or the stack).");
  }
  const rows = Object.entries(probe.checks).map(([name, verdict]) =>
    h(
      "tr",
      { key: name },
      h("td", null, h(Mono, null, name)),
      h("td", null, h(Verdict, { ok: verdict === "ok", label: verdict })),
    )
  );
  return h(
    "div",
    null,
    h(
      "p",
      { class: "lead" },
      h(Mono, null, `${probe.url}/_denext/health`),
      ": ",
      h(Verdict, {
        ok: probe.status === "ok",
        label: probe.status + (probe.httpStatus ? ` (${probe.httpStatus})` : ""),
      }),
    ),
    rows.length ? h(Table, { head: ["Check", "Verdict"], rows }) : h(Note, null, "No checks."),
  );
}

/** A status tree with every error message redacted. */
function redacted<T extends AdminChildStatus>(node: T, secrets: readonly string[]): T {
  return {
    ...node,
    ...(node.lastError
      ? { lastError: { ...node.lastError, message: redact(node.lastError.message, secrets) } }
      : {}),
    ...(node.children ? { children: node.children.map((c) => redacted(c, secrets)) } : {}),
  };
}

/** Where the supervision tree comes from: the running app, else the last snapshot. */
async function supervision(
  ctx: UiContext,
  secrets: readonly string[],
  signal: AbortSignal,
): Promise<HealthState["supervision"]> {
  const target = await appTarget(ctx);
  const live = target ? await adminStatus(target, signal) : null;
  if (live && live.ok) {
    return {
      source: "the running app",
      tree: live.services.map((s) => redacted(s, secrets)) as unknown as SupervisorStatus[],
    };
  }
  const { snapshot } = await readServicesState(ctx.dir);
  if (!snapshot) return null;
  return {
    source: `the snapshot of ${new Date(snapshot.updatedAt).toISOString()}`,
    tree: snapshot.supervisors.map((s) => redacted(s, secrets)) as SupervisorStatus[],
  };
}

/** Read everything the page shows. */
async function readHealth(ctx: UiContext, signal: AbortSignal): Promise<HealthState> {
  const secrets = await knownSecrets(ctx.dir);
  const source = await pickLogSource(ctx.dir, ctx.logs);
  let services: HealthState["services"] = null;
  if (source) {
    try {
      services = await source.health(signal);
    } catch (error) {
      services = redact(error instanceof Error ? error.message : String(error), secrets);
    }
  }
  const target = await appTarget(ctx);
  const probe = target ? { url: target.url, ...await appProbe(target, signal) } : null;
  return { services, probe, supervision: await supervision(ctx, secrets, signal) };
}

const panelResponse = panelResponder("Database", "/database");

/** The page. */
function HealthView(
  { state, seconds }: { readonly state: HealthState; readonly seconds: number },
): VNode {
  const tree = state.supervision;
  return h(
    "div",
    { "data-refresh": seconds > 0 ? String(seconds) : undefined },
    h(RefreshForm, { action: "/database/health", seconds }),
    h("h2", null, "Services"),
    h(ServicesTable, { services: state.services }),
    h("h2", null, "The app"),
    h(ProbeBlock, { probe: state.probe }),
    h("h2", null, "Supervised services"),
    tree === null
      ? h(
        Note,
        null,
        "No supervision status: the project runs no services/ tree, or no server ran yet.",
      )
      : h(
        "div",
        null,
        h("p", { class: "lead" }, `From ${tree.source}.`),
        tree.tree.length === 0
          ? h(Note, null, "No supervisor is running.")
          : tree.tree.map((status) => h(SupervisorTable, { key: status.path, status })),
      ),
  );
}

/**
 * Serve `/database/health` (and its `/api` twin).
 *
 * @param ctx The request.
 * @returns The page.
 */
export async function healthPanel(ctx: UiContext): Promise<Response> {
  const seconds = refreshOf(ctx.url);
  const signal = ctx.signal
    ? AbortSignal.any([ctx.signal, AbortSignal.timeout(LOG_DEADLINE_MS)])
    : AbortSignal.timeout(LOG_DEADLINE_MS);
  const state = await readHealth(ctx, signal);
  if (ctx.json) return jsonResponse({ ok: true, ...state });
  const body = h(
    DbPanel,
    { tab: "/database/health", dashboard: ctx.dashboard === true },
    readOnlyNote({ csrf: ctx.csrf, readOnly: ctx.readOnly }),
    h(HealthView, { state, seconds }),
  );
  return panelResponse(ctx, renderView(body), 200, undefined, seconds);
}
