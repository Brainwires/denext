// `/dev` — the project's dev server: whether one is running, starting and stopping it, and the
// console its output streams into.
//
// This was the wizard's last step. It is a page of its own because it is not a step: nothing
// about it is finished once, and a server you started yesterday is the thing you come back to.
//
// The console is the panel's ONE `<pre class="out">`. `ui.js` finds it generically
// (`#panel pre.out`) and appends every `dev-output` frame the server broadcasts, so the page
// needs no client code of its own — and the output survives a panel swap because `refresh()`
// carries it across.
//
// Hard rule of the UI process, obeyed here: no project module is imported. `denext dev` runs as
// a subprocess through `runDeno`, and stopping one needs no handle at all — the dev server wrote
// its own pid into `.denext/dev.json`, which is what lets a restarted UI still stop it.
//
// Everything works with JavaScript disabled: Start and Stop are real `<form method="post">`s and
// the page re-renders in place. A `303` would be wrong here — it would destroy the output sink
// the run is streaming into.

import { type DevInfo, readDevInfo } from "../../mcp/dev-client.ts";
import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { jsonResponse, panelResponder, type UiContext, type UiHandler } from "../html.ts";
import { Badge, Note, OpForm, Out, Panel } from "../components.ts";
import { renderView } from "../view.ts";
import { broadcast, exitLine } from "../events.ts";
import { cliInvocation, runDeno } from "../proc.ts";
import { clearDevLog, devLogText, recordDevLine } from "../dev-log.ts";
import { stopDevServer } from "../dev-stop.ts";
import { OFFLINE_REFUSALS, OFFLINE_STATUS } from "../offline.ts";

/** One request's reading of the dev server. */
interface DevState {
  /** The project directory. */
  readonly dir: string;
  /** The running dev server's published address, when there is one. */
  readonly dev: DevInfo | null;
  /** What the server has printed so far (kept in memory, so a reload still shows it). */
  readonly log: string;
}

/** Read the dev server's state: one file, and the log this process has been keeping. */
async function readDevState(dir: string): Promise<DevState> {
  return { dir, dev: await readDevInfo(dir), log: devLogText(dir) };
}

/** What an operation answers with. */
interface DevOutcome {
  /** Whether it succeeded. */
  readonly ok: boolean;
  /** A one-line message. */
  readonly message: string;
  /** The status to answer with instead of the default (a refusal under `--offline` is a `503`). */
  readonly status?: number;
}

/** An operation implementation. */
type DevOp = (ctx: UiContext, state: DevState) => Promise<DevOutcome>;

/** One error as a message. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start `denext dev` in the background and stream it to every open page.
 * Refused under `--offline` with a `503`: a dev server needs net permission to listen.
 */
function opStartDev(ctx: UiContext, state: DevState): Promise<DevOutcome> {
  if (ctx.offline === true) {
    return Promise.resolve({ ok: false, status: OFFLINE_STATUS, message: OFFLINE_REFUSALS.dev });
  }
  if (state.dev !== null) {
    return Promise.resolve({ ok: true, message: `Already running at ${state.dev.origin}.` });
  }
  const started = startDevServer(ctx);
  return Promise.resolve({
    ok: true,
    message: started
      ? "Starting denext dev — its output is streaming to this page."
      : "denext dev is already starting — its output is streaming to this page.",
  });
}

/**
 * Stop the dev server this project published.
 *
 * Nothing here needs the child's process handle, which is exactly what lets it work after
 * `denext ui` was restarted: the dev server wrote its own pid into `.denext/dev.json`, so a UI
 * that never spawned it can still stop it. `../dev-stop.ts` carries the two hazards that shape
 * the order of operations there (a reused pid, and children left holding the port).
 *
 * Deliberately NOT refused under `--offline`: the liveness probe is a loopback request to an
 * address this project published, needing no network the UI does not already have, and refusing
 * to stop a server the panel is actively showing as running would be indefensible.
 */
async function opStopDev(ctx: UiContext): Promise<DevOutcome> {
  const outcome = await stopDevServer(ctx.dir);
  // Keep a failed stop's log: it is the only evidence of why the server would not go.
  if (outcome.status === "stopped") clearDevLog(ctx.dir);
  // Every other open page is still offering to stop a server that is now gone.
  broadcast(ctx.events, { type: "dev-stopped" });
  return {
    ok: outcome.status !== "failed" && outcome.status !== "unsupported" &&
      outcome.status !== "mismatch",
    message: outcome.message,
  };
}

/** Every operation `/dev` accepts. An `op` outside this table never reaches a subprocess. */
const OPS: Record<string, DevOp> = {
  dev: opStartDev,
  stop: (ctx) => opStopDev(ctx),
};

/**
 * The projects this process has already started a `denext dev` for. Two quick POSTs (a
 * double-click, or a no-JS submit the user repeated) would otherwise race two dev servers onto
 * the same project, the second one falling forward onto a different port.
 */
const devStarting = new Set<string>();

/**
 * Spawn `denext dev` (the framework's own `cli.ts`, in whatever scheme denext itself runs
 * under), stream its output to every open UI page, and announce the address as soon as the
 * dev server publishes `.denext/dev.json`. Deliberately not awaited: the request returns
 * immediately and the page follows the SSE channel.
 *
 * The child is tied to the UI's own shutdown signal, so Ctrl+C on `denext ui` takes the dev
 * server with it rather than leaving it running with nothing to stop it.
 *
 * @param ctx The request context.
 * @returns Whether a dev server was started (`false` when one is already coming up).
 */
function startDevServer(ctx: UiContext): boolean {
  if (devStarting.has(ctx.dir)) return false;
  devStarting.add(ctx.dir);
  const push = (event: unknown): void => broadcast(ctx.events, event);
  runDeno([...cliInvocation({ dir: ctx.dir }), "dev", ctx.dir], {
    cwd: ctx.dir,
    onLine: (line) => {
      recordDevLine(ctx.dir, line);
      push({ type: "dev-output", line });
    },
    signal: ctx.signal,
  })
    .then((run) => {
      recordDevLine(ctx.dir, exitLine(run.code));
      push({ type: "dev-exit", code: run.code });
    })
    .catch((error) => {
      const line = `denext dev failed: ${reason(error)}`;
      recordDevLine(ctx.dir, line);
      push({ type: "dev-output", line });
    })
    .finally(() => devStarting.delete(ctx.dir));
  pollDevInfo(ctx.dir, push).catch(() => {/* the UI shut down */});
  return true;
}

/** Poll `.denext/dev.json` for at most 30 s, then push the address it published. */
async function pollDevInfo(dir: string, push: (event: unknown) => void): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const info = await readDevInfo(dir);
    if (info !== null) {
      push({ type: "dev-ready", url: info.origin });
      return;
    }
  }
}

/** The one control: Start when nothing is running, Stop when something is. */
function DevForm(
  { ctx, state }: { readonly ctx: UiContext; readonly state: DevState },
): VNode {
  const running = state.dev !== null;
  return h(OpForm, {
    csrf: ctx.csrf,
    action: "/dev",
    label: running ? "Stop denext dev" : "Start denext dev",
    fields: { op: running ? "stop" : "dev" },
    className: "op",
    // Stopping is never refused offline: it is a loopback probe of an address this project
    // published, and refusing to stop a server the page is showing as running is indefensible.
    disabled: ctx.readOnly || (ctx.offline === true && !running),
  });
}

/** The whole panel: what the dev server is doing, the control, and its console. */
function DevPanel(
  { ctx, state, outcome }: {
    readonly ctx: UiContext;
    readonly state: DevState;
    readonly outcome?: DevOutcome;
  },
): VNode {
  const running = state.dev !== null;
  return h(
    Panel,
    { name: "Dev", title: "Dev server" },
    h(
      "p",
      { class: "lead" },
      "Run the project's dev server from here and watch its output. ",
      h("a", { href: "https://denext.dev/docs/ui#the-dev-server" }, "The dev server ↗"),
    ),
    h("p", { class: "lead mono" }, state.dir),
    ctx.readOnly ? h(Note, null, "Read-only mode — every write is refused.") : null,
    h(
      "p",
      null,
      h(Badge, { tone: running ? "ok" : "todo" }, running ? "running" : "stopped"),
      " ",
      state.dev
        ? h(
          "span",
          null,
          "Dev server running at ",
          h("a", { href: state.dev.origin }, state.dev.origin),
          ` (pid ${state.dev.pid}).`,
        )
        : h(
          "span",
          null,
          "No dev server is running (no ",
          h("code", null, ".denext/dev.json"),
          ").",
        ),
    ),
    h(DevForm, { ctx, state }),
    ctx.offline === true && !running ? h(Note, null, OFFLINE_REFUSALS.dev) : null,
    outcome ? h(Note, { role: outcome.ok ? undefined : "alert" }, outcome.message) : null,
    // The sink `ui.js` streams into. Always rendered, so a run always has somewhere to land.
    h(Out, null, state.log),
  );
}

/** The panel shell: the bare section for `ui.js`, the whole document for a navigation. */
const panelResponse = panelResponder("Dev", "/dev");

/** Render the dev server as a page, a fragment, or the JSON twin. */
function respond(ctx: UiContext, state: DevState, outcome?: DevOutcome): Response {
  if (ctx.json) {
    return jsonResponse({
      ok: outcome?.ok ?? true,
      dir: state.dir,
      running: state.dev !== null,
      origin: state.dev?.origin ?? null,
      pid: state.dev?.pid ?? null,
      ...(outcome ? { outcome } : {}),
    }, outcome?.status ?? (outcome && !outcome.ok ? 400 : 200));
  }
  return panelResponse(ctx, renderView(h(DevPanel, { ctx, state, outcome })), outcome?.status);
}

/**
 * Serve the dev server panel: `GET` renders its state (or the JSON twin), `POST` starts or
 * stops it.
 *
 * A completed operation answers IN PLACE rather than with a `303`: the redirect would rebuild
 * the page and destroy the `<pre class="out">` the run is streaming into, which is the whole
 * point of the panel.
 */
export const devPanel: UiHandler = async (
  _request: Request,
  ctx: UiContext,
): Promise<Response> => {
  const state = await readDevState(ctx.dir);
  if (ctx.method !== "POST") return respond(ctx, state);
  const op = String(ctx.form?.get("op") ?? "");
  if (!Object.hasOwn(OPS, op)) {
    return jsonResponse({ ok: false, reason: `unknown dev operation "${op}"` }, 400);
  }
  const outcome = await OPS[op](ctx, state);
  return respond(ctx, await readDevState(ctx.dir), outcome);
};
