// `/tasks` — the project's `deno task` scripts as their own page.
//
// This was the wizard's eighth step. The page only LISTS; `/tasks/run` is the only route that
// spawns, and the guarantees that matter are its: a name the project never declared is refused
// before any spawn, and `--offline` refuses a declared one because a task is arbitrary shell.
//
// Driven the way a browser with JavaScript disabled would drive it: real form posts on loopback.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { type Harness, postTo, stopUi, uiOn } from "./helpers/ui-panel.ts";

/** A `deno.json` declaring two tasks. */
const DENO_JSON = `{
  "tasks": {
    "build": "deno run -A jsr:@denext/denext/cli build .",
    "start": "deno run -A jsr:@denext/denext/cli start ."
  }
}
`;

/** Start the UI on a temp project. */
function ui(
  files: Record<string, string> = { "deno.json": DENO_JSON },
  opts: { readOnly?: boolean; offline?: boolean } = {},
): Promise<Harness> {
  return uiOn(files, opts, "denext_ui_tasks_");
}

/** The page's markup, the way a no-JS browser would read it. */
async function tasksPage(h: Harness): Promise<string> {
  return await (await fetch(`${h.base}/tasks`, { headers: h.headers })).text();
}

Deno.test("every declared task is listed, with the command it runs and a button", async () => {
  const h = await ui();
  try {
    const body = await tasksPage(h);
    for (const name of ["build", "start"]) {
      assertStringIncludes(body, `deno task ${name}`);
      assertStringIncludes(body, `name="task" value="${name}"`);
    }
    // The buttons post to the runner, never to this page: one route spawns, and it is that one.
    assertStringIncludes(body, 'action="/tasks/run"');
    assertStringIncludes(body, "jsr:@denext/denext/cli build .", "the command is shown");
    assertMatch(body, /<pre class="out">/, "the output sink must be on the page");
  } finally {
    await stopUi(h);
  }
});

Deno.test("the JSON twin reports the declared task names", async () => {
  const h = await ui();
  try {
    const payload = await (await fetch(`${h.base}/api/tasks`, { headers: h.headers })).json();
    assertEquals(payload.ok, true);
    assertEquals(payload.tasks, ["build", "start"]);
  } finally {
    await stopUi(h);
  }
});

Deno.test("a project with no tasks says so instead of rendering an empty list", async () => {
  const h = await ui({ "deno.json": "{}\n" });
  try {
    const body = await tasksPage(h);
    assertStringIncludes(body, "declares no tasks");
    assert(!body.includes('action="/tasks/run"'), "nothing to run, so nothing to post");
  } finally {
    await stopUi(h);
  }
});

Deno.test("a task name the project does not declare is refused before any spawn", async () => {
  const h = await ui();
  try {
    const res = await postTo(h, { task: "rm -rf /" }, "/tasks/run");
    assertEquals(res.status, 400);
    const payload = await res.json();
    assertStringIncludes(payload.reason, 'unknown task "rm -rf /"');
    assertEquals(payload.tasks, ["build", "start"], "and it says what it would have run");
  } finally {
    await stopUi(h);
  }
});

Deno.test("--offline refuses a declared task with a 503, and renders the buttons disabled", async () => {
  const h = await ui({ "deno.json": DENO_JSON }, { offline: true });
  try {
    const res = await postTo(h, { task: "build" }, "/tasks/run");
    assertEquals(res.status, 503, "a declared task is refused, not spawned");
    assertStringIncludes((await res.json()).reason, "a task is arbitrary shell");

    const body = await tasksPage(h);
    assertStringIncludes(body, "deno task is unavailable — the UI runs --offline");
    assertMatch(body, /<button[^>]*\sdisabled[^>]*>deno task build<\/button>/);
  } finally {
    await stopUi(h);
  }
});

Deno.test("online, the buttons stay live and carry no offline note", async () => {
  const h = await ui();
  try {
    const body = await tasksPage(h);
    assertMatch(body, /<button type="submit">deno task build<\/button>/);
    assert(!body.includes("--offline"));
  } finally {
    await stopUi(h);
  }
});

Deno.test("--read-only refuses a run and says so on the page", async () => {
  const h = await ui({ "deno.json": DENO_JSON }, { readOnly: true });
  try {
    const body = await tasksPage(h);
    assertStringIncludes(body, "Read-only mode");
    assertMatch(body, /<button[^>]*\sdisabled[^>]*>deno task build<\/button>/);
  } finally {
    await stopUi(h);
  }
});
