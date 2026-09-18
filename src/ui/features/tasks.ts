// `/tasks` — the project's own `deno task` scripts, each runnable from the page.
//
// This was the wizard's eighth step. It is a page of its own because running a task is not part
// of setting a project up: it is what you do with the project afterwards, repeatedly.
//
// The buttons do not post here. Each posts to `/tasks/run`, the kernel's SSE task runner, which
// is the only thing that spawns: it refuses any name the project's own `deno.json` does not
// declare, passes it as an argv element rather than through a shell, and ties the child to the
// stream so a closed page takes the task with it. This page only lists what that route will run.
//
// NOT to be confused with the Cron page's tasks. These are `deno.json` scripts; those are
// `tasks/<name>.ts` modules registered with `defineTask` and run on a schedule.
//
// Everything works with JavaScript disabled: each button is a real `<form method="post">`.

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { jsonResponse, panelResponder, type UiContext, type UiHandler } from "../html.ts";
import { Note, OpForm, Out, Panel } from "../components.ts";
import { renderView } from "../view.ts";
import { OFFLINE_REFUSALS } from "../offline.ts";
import { readDenoConfig, taskMap } from "../tasks.ts";

/** One request's reading of the project's declared tasks. */
interface TasksState {
  /** The project directory. */
  readonly dir: string;
  /** The declared tasks, `name → command`, in the order the file declares them. */
  readonly tasks: Record<string, string>;
  /** The config file's name, when the project has one. */
  readonly config: string | null;
}

/** Read the `deno.json` tasks map. Nothing here evaluates project code. */
async function readTasksState(dir: string): Promise<TasksState> {
  const deno = await readDenoConfig(dir);
  return { dir, tasks: taskMap(deno), config: deno?.name ?? null };
}

/** One task: its name, the command it runs, and the button that runs it. */
function TaskRow(
  { ctx, name, command }: {
    readonly ctx: UiContext;
    readonly name: string;
    readonly command: string;
  },
): VNode {
  return h(
    "div",
    { class: "field" },
    h("p", { class: "group-summary" }, `deno task ${name}`),
    h("p", { class: "lead mono" }, command),
    h(OpForm, {
      csrf: ctx.csrf,
      // The runner, not this page: it is the only route that spawns, and it checks the name
      // against the project's own declarations before it does.
      action: "/tasks/run",
      label: `deno task ${name}`,
      fields: { task: name },
      className: "op",
      disabled: ctx.readOnly || ctx.offline === true,
    }),
  );
}

/** The whole panel: every declared task, and the console their output streams into. */
function TasksPanel(
  { ctx, state }: { readonly ctx: UiContext; readonly state: TasksState },
): VNode {
  const names = Object.keys(state.tasks);
  return h(
    Panel,
    { name: "Tasks", title: "Tasks" },
    h(
      "p",
      { class: "lead" },
      "The scripts your ",
      h("code", null, "deno.json"),
      " declares. Running one streams its output below. ",
      h("a", { href: "https://denext.dev/docs/ui#tasks" }, "Tasks ↗"),
    ),
    h("p", { class: "lead mono" }, state.dir),
    ctx.readOnly ? h(Note, null, "Read-only mode — every run is refused.") : null,
    ctx.offline === true ? h(Note, null, OFFLINE_REFUSALS.task) : null,
    names.length === 0
      ? h(
        Note,
        null,
        state.config === null
          ? "This project has no deno.json, so it declares no tasks."
          : `${state.config} declares no tasks.`,
      )
      : names.map((name) => h(TaskRow, { key: name, ctx, name, command: state.tasks[name] })),
    // The sink `ui.js` streams into. Always rendered, so a run always has somewhere to land.
    h(Out, null),
  );
}

/** The panel shell: the bare section for `ui.js`, the whole document for a navigation. */
const panelResponse = panelResponder("Tasks", "/tasks");

/**
 * Serve the tasks panel.
 *
 * `GET` only: running a task is `/tasks/run`'s job, and giving this page a POST of its own
 * would be a second way to spawn — the thing that route exists to be the only one of.
 */
export const tasksPanel: UiHandler = async (
  _request: Request,
  ctx: UiContext,
): Promise<Response> => {
  const state = await readTasksState(ctx.dir);
  if (ctx.json) {
    return jsonResponse({ ok: true, dir: state.dir, tasks: Object.keys(state.tasks) });
  }
  return panelResponse(ctx, renderView(h(TasksPanel, { ctx, state })));
};
