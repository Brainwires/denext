// `/dev` — the project's dev server as its own page: what it reports, starting and stopping it,
// and the console its output streams into.
//
// This was the wizard's ninth step. The behaviours that mattered there matter here unchanged:
// starting answers IN PLACE (a `303` would destroy the output sink), the console is always on
// the page so streamed lines have somewhere to land, stopping a server that is already gone
// clears its `dev.json` without signalling the pid, and `--offline` refuses a start with a 503.
//
// Driven the way a browser with JavaScript disabled would drive it: real form posts on loopback.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { exists, fakeDevJson, type Harness, postTo, stopUi, uiOn } from "./helpers/ui-panel.ts";

/** Start the UI on a temp project. */
function ui(
  files: Record<string, string> = {},
  opts: { readOnly?: boolean; offline?: boolean } = {},
): Promise<Harness> {
  return uiOn(files, opts, "denext_ui_dev_");
}

/** Post one dev operation the way a no-JS form would. */
function post(h: Harness, fields: Record<string, string>, path = "/dev"): Promise<Response> {
  return postTo(h, fields, path);
}

/** The page's markup, the way a no-JS browser would read it. */
async function devPage(h: Harness): Promise<string> {
  return await (await fetch(`${h.base}/dev`, { headers: h.headers })).text();
}

Deno.test("starting the dev server answers in place — a 303 would destroy the output sink", async () => {
  const h = await ui();
  try {
    await fakeDevJson(h.dir);
    const res = await post(h, { op: "dev" });
    // The regression this pins: the branch used to answer `303`, which navigates, rebuilds the
    // document, and takes `ui.js`'s one EventSource and the <pre class="out"> with it — so every
    // streamed line was broadcast to nobody and starting a dev server looked like it did nothing.
    assertEquals(res.status, 200, "the dev op must render in place, not redirect");
    assertEquals(res.headers.get("location"), null, "no Location header — nothing navigates");
    const body = await res.text();
    assertStringIncludes(body, "Already running at");
    assertMatch(body, /<pre class="out">/, "the output sink must survive the answer");
  } finally {
    await stopUi(h);
  }
});

Deno.test("a running dev server is offered a Stop button instead of Start", async () => {
  const h = await ui();
  try {
    await fakeDevJson(h.dir);
    const payload = await (await fetch(`${h.base}/api/dev`, { headers: h.headers })).json();
    assertEquals(payload.ok, true);
    assertEquals(payload.running, true, "the twin reports a running server");
    assert(typeof payload.origin === "string" && payload.origin.length > 0);
    assertMatch(await devPage(h), /<button[^>]*>Stop denext dev<\/button>/);
  } finally {
    await stopUi(h);
  }
});

Deno.test("with nothing running, the page offers Start and says so", async () => {
  const h = await ui();
  try {
    const payload = await (await fetch(`${h.base}/api/dev`, { headers: h.headers })).json();
    assertEquals([payload.ok, payload.running, payload.origin], [true, false, null]);
    const body = await devPage(h);
    assertMatch(body, /<button[^>]*>Start denext dev<\/button>/);
    assertStringIncludes(body, "No dev server is running");
  } finally {
    await stopUi(h);
  }
});

Deno.test("the page always renders the console, so streamed output has somewhere to land", async () => {
  const h = await ui();
  try {
    // With no dev server at all, the sink must still be on the page: `ui.js` appends streamed
    // lines into `#panel pre.out`, and it can only do that if the element is already there.
    assertMatch(await devPage(h), /<pre class="out">/);
  } finally {
    await stopUi(h);
  }
});

Deno.test("stopping clears a dev.json whose server is already gone, and never signals its pid", async () => {
  const h = await ui();
  try {
    const devJson = await fakeDevJson(h.dir);
    const res = await post(h, { op: "stop" }, "/api/dev");
    assertEquals(res.status, 200);
    const { outcome } = await res.json();
    assertEquals(outcome.ok, true);
    assertStringIncludes(outcome.message, "stale");
    assertEquals(await exists(devJson), false, "the stale dev.json must be cleared");
  } finally {
    await stopUi(h);
  }
});

Deno.test("an operation outside the table never runs", async () => {
  const h = await ui();
  try {
    const res = await post(h, { op: "rm -rf /" }, "/api/dev");
    assertEquals(res.status, 400);
    assertStringIncludes((await res.json()).reason, 'unknown dev operation "rm -rf /"');
  } finally {
    await stopUi(h);
  }
});

Deno.test("--offline refuses a start with a 503, and renders the button disabled", async () => {
  const h = await ui({}, { offline: true });
  try {
    const res = await post(h, { op: "dev" }, "/api/dev");
    assertEquals(res.status, 503);
    const { outcome } = await res.json();
    assertEquals(outcome.ok, false);
    assertStringIncludes(outcome.message, "a dev server needs net permission to listen");

    const page = await post(h, { op: "dev" });
    assertEquals(page.status, 503, "the no-JS answer carries the same status");
    const body = await page.text();
    assertStringIncludes(body, "denext dev is unavailable — the UI runs --offline");
    assertMatch(body, /<button[^>]*\sdisabled[^>]*>Start denext dev<\/button>/);
  } finally {
    await stopUi(h);
  }
});

Deno.test("online, the Start button stays live and carries no offline note", async () => {
  const h = await ui();
  try {
    const body = await devPage(h);
    assertMatch(body, /<button type="submit">Start denext dev<\/button>/);
    assert(!body.includes("--offline"));
  } finally {
    await stopUi(h);
  }
});

Deno.test("--read-only refuses the write and says so on the page", async () => {
  const h = await ui({}, { readOnly: true });
  try {
    const body = await devPage(h);
    assertStringIncludes(body, "Read-only mode");
    assertMatch(body, /<button[^>]*\sdisabled[^>]*>Start denext dev<\/button>/);
  } finally {
    await stopUi(h);
  }
});
