// `/services` — the supervised `services/` tree: which service files the project has, and the
// status the running server last reported for each (running, restarting, failed; restart counts;
// the last error).
//
// The UI never runs project code in its own process, so it cannot ask a supervisor anything. It
// reads two things instead: the `services/` directory's file names (a walk, no import), and
// `.denext/services.json`, the snapshot a running `denext dev` / `denext start` keeps current
// whenever the tree changes. With no server running the snapshot is the last one written, and the
// page says when that was.
//
// Read-only: it has no form, so there is nothing for `--read-only` or `--offline` to refuse.

import { walk } from "@std/fs";
import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { jsonResponse, panelResponder, type UiContext, type UiHandler } from "../html.ts";
import { Badge, type BadgeTone, Note, Panel, Table } from "../components.ts";
import { renderView } from "../view.ts";
import { readContained, uiSafeJoin } from "../security.ts";
import type { ChildStatus, SupervisorStatus } from "../../server/supervise.ts";
import { SERVICES_SNAPSHOT, type ServicesSnapshot } from "../../server/service-loader.ts";

/** One request's reading of the project's services. */
interface ServicesState {
  /** The project directory. */
  readonly dir: string;
  /** The service files under `services/`, as paths without extension, sorted. */
  readonly files: readonly string[];
  /** The last snapshot a server wrote, or `null` (none yet, or unreadable). */
  readonly snapshot: ServicesSnapshot | null;
}

/** The service modules under `services/`: the names the server would give them. */
async function serviceFiles(dir: string): Promise<string[]> {
  let root: string;
  try {
    root = await uiSafeJoin(dir, "services");
    if (!(await Deno.stat(root)).isDirectory) return [];
  } catch {
    return [];
  }
  const names: string[] = [];
  try {
    for await (
      const entry of walk(root, {
        exts: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
        includeDirs: false,
        followSymlinks: false,
        skip: [/[/\\]\.[^/\\]+/, /[/\\]_/],
      })
    ) {
      const rel = entry.path.slice(root.length).replace(/^[/\\]/, "");
      names.push(rel.replace(/\.(tsx?|jsx?|mjs)$/, "").replace(/[/\\]/g, "/"));
    }
  } catch { /* an unreadable directory lists what it gave */ }
  return names.sort();
}

/** Whether `value` has the snapshot's shape (it is a file anything could have written). */
function isSnapshot(value: unknown): value is ServicesSnapshot {
  const v = value as Partial<ServicesSnapshot> | null;
  return typeof v === "object" && v !== null && typeof v.updatedAt === "number" &&
    Array.isArray(v.supervisors);
}

/** The snapshot, when there is a readable one. */
async function readSnapshot(dir: string): Promise<ServicesSnapshot | null> {
  const text = await readContained(dir, `.denext/${SERVICES_SNAPSHOT}`);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return isSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Read everything the page shows. Nothing here evaluates project code. */
async function readServicesState(dir: string): Promise<ServicesState> {
  const [files, snapshot] = await Promise.all([serviceFiles(dir), readSnapshot(dir)]);
  return { dir, files, snapshot };
}

/** How each state's badge reads. */
const STATE_TONE: Record<string, BadgeTone> = {
  running: "ok",
  restarting: "warn",
  stopping: "info",
  failed: "fail",
};

/** An epoch-ms time as an ISO string (the page renders on the server; no client clock). */
function when(ms: number | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

/** Every node of a supervisor's tree, depth first, with its depth. */
function flatten(
  node: ChildStatus | SupervisorStatus,
  depth: number,
  out: { node: ChildStatus; depth: number }[],
): { node: ChildStatus; depth: number }[] {
  out.push({ node, depth });
  const children = (node as Partial<SupervisorStatus>).children;
  if (Array.isArray(children)) { for (const child of children) flatten(child, depth + 1, out); }
  return out;
}

/** One row: the path (indented by depth), the state, restarts, the last error and since when. */
function StatusRow({ node, depth }: { readonly node: ChildStatus; readonly depth: number }): VNode {
  const state = String(node.state);
  const detail = node.state === "restarting" && node.retryAt
    ? `again at ${when(node.retryAt)}`
    : `since ${when(node.since)}`;
  return h(
    "tr",
    null,
    h("td", { class: "mono" }, `${"  ".repeat(depth)}${node.path}`),
    h("td", null, h(Badge, { tone: STATE_TONE[state] }, state)),
    h("td", null, String(node.restarts ?? 0)),
    h(
      "td",
      { class: "mono" },
      node.lastError ? `${node.lastError.message} (${when(node.lastError.at)})` : "",
    ),
    h("td", null, detail),
  );
}

/** One top-level supervisor's table. */
function SupervisorTable({ status }: { readonly status: SupervisorStatus }): VNode {
  const rows = flatten(status, 0, []).map(({ node, depth }) =>
    h(StatusRow, { key: node.path, node, depth })
  );
  return h(
    "div",
    { class: "field" },
    h(
      "p",
      { class: "group-summary" },
      `${status.path} — ${status.strategy}, at most ${status.intensity} restart(s) per ${status.period} ms`,
    ),
    h(Table, { head: ["Path", "State", "Restarts", "Last error", ""], rows }),
  );
}

/** The panel. */
function ServicesPanel({ state }: { readonly state: ServicesState }): VNode {
  const { files, snapshot } = state;
  return h(
    Panel,
    { name: "Services", title: "Services" },
    h(
      "p",
      { class: "lead" },
      "Long-lived server work under a supervisor: restarted with backoff when it crashes, " +
        "stopped in reverse order on shutdown. Restart semantics, not process isolation. ",
      h("a", { href: "https://denext.dev/docs/services" }, "Services ↗"),
    ),
    h("p", { class: "lead mono" }, state.dir),
    files.length === 0
      ? h(
        Note,
        null,
        "This project has no services/ directory. Add services/<name>.ts default-exporting " +
          "defineService(...) from denext/server.",
      )
      : h("p", { class: "lead" }, `services/: ${files.join(", ")}`),
    snapshot === null
      ? h(
        Note,
        null,
        "No status yet: a running denext dev or denext start writes .denext/services.json.",
      )
      : h(
        "div",
        null,
        h(
          "p",
          { class: "lead" },
          `Status as of ${when(snapshot.updatedAt)} (process ${snapshot.pid}). ` +
            "Start the dev server for a live view; a stopped server's last snapshot stays.",
        ),
        snapshot.supervisors.length === 0
          ? h(Note, null, "No supervisor is running.")
          : snapshot.supervisors.map((status) => h(SupervisorTable, { key: status.path, status })),
      ),
  );
}

/** The panel shell: the bare section for `ui.js`, the whole document for a navigation. */
const panelResponse = panelResponder("Services", "/services");

/**
 * Serve the services panel. `GET` only: the page changes nothing.
 */
export const servicesPanel: UiHandler = async (
  _request: Request,
  ctx: UiContext,
): Promise<Response> => {
  const state = await readServicesState(ctx.dir);
  if (ctx.json) {
    return jsonResponse({ ok: true, dir: state.dir, files: state.files, snapshot: state.snapshot });
  }
  return panelResponse(ctx, renderView(h(ServicesPanel, { state })));
};
