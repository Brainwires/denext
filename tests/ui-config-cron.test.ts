// `/config/cron` — the Cron tab's two pure parts: reading a child's JSON document back, and
// working out when a cron expression next fires.
//
// The panel itself is driven end-to-end by the integration suite (it spawns a real discovery
// child); what is unit-tested here is the logic that would be expensive to reach that way — a
// sparse schedule's horizon, and the noise a child writes around its document.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { SseClients } from "../src/build/sse.ts";
import type { UiContext } from "../src/ui/html.ts";
import { parseJsonDocument } from "../src/ui/child-json.ts";
import { cronPanel, nextRuns } from "../src/ui/features/config-cron.ts";
import { readTaskHistory, taskHistoryRecorder } from "../src/server/task-history.ts";

/** A project with a denext config, a tasks/ directory, and an app — enough for discovery. */
async function project(
  config: string,
  tasks: Record<string, string> = {},
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_cron_" });
  const mod = new URL("../mod.ts", import.meta.url).pathname;
  const root = new URL("../", import.meta.url).pathname;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ imports: { denext: mod, "denext/": root } }),
  );
  await Deno.writeTextFile(join(dir, "denext.config.ts"), config);
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  await Deno.writeTextFile(join(dir, "app/page.tsx"), "export default () => null;\n");
  for (const [name, body] of Object.entries(tasks)) {
    await Deno.mkdir(join(dir, "tasks"), { recursive: true });
    await Deno.writeTextFile(join(dir, `tasks/${name}.ts`), body);
  }
  return dir;
}

/** A `defineTask` module, optionally declaring its own schedule. */
function task(extra = ""): string {
  const server = new URL("../src/server/tasks.ts", import.meta.url).href;
  return `import { defineTask } from "${server}";\n` +
    `export default defineTask({ handler: () => {}, ${extra} });\n`;
}

/** One request against the panel, with the kernel's context already assembled. */
async function call(
  dir: string,
  init: {
    form?: Record<string, string>;
    rows?: Array<[string, string]>;
    readOnly?: boolean;
    query?: string;
    json?: boolean;
  } = {},
): Promise<Response> {
  const path = init.json === true ? "/api/config/cron" : "/config/cron";
  const url = new URL(`http://127.0.0.1:5177${path}${init.query ?? ""}`);
  const posting = init.form !== undefined || init.rows !== undefined;
  const form = posting ? new FormData() : undefined;
  for (const [cron, name] of init.rows ?? []) {
    form?.append("cron", cron);
    form?.append("task", name);
  }
  for (const [key, value] of Object.entries(init.form ?? {})) form?.set(key, value);
  const ctx: UiContext = {
    dir,
    url,
    method: posting ? "POST" : "GET",
    readOnly: init.readOnly === true,
    csrf: "csrf-token",
    json: init.json === true,
    fragment: false,
    form,
    events: new Set() as SseClients,
  };
  return await cronPanel(new Request(url, { method: ctx.method }), ctx);
}

/** The `_base` stamp the editor rendered, which a write has to post back. */
function stampIn(markup: string): string {
  return /name="_base" value="([0-9a-f]{64})"/.exec(markup)?.[1] ?? "";
}

/** The value the preview's confirm form carries. */
function carriedIn(markup: string): string {
  return (/name="value" value="([^"]*)"/.exec(markup)?.[1] ?? "")
    .replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

Deno.test("a child's JSON document survives the noise Deno writes around it", () => {
  const doc = '{\n  "tasks": [],\n  "denoCron": false\n}';
  assertEquals(parseJsonDocument<{ denoCron: boolean }>(doc)?.denoCron, false);
  // Deno's own lines before and after the document are dropped.
  const noisy = `Download https://jsr.io/@denext/denext/meta.json\n${doc}\nWarning something`;
  assertEquals(parseJsonDocument<{ denoCron: boolean }>(noisy)?.denoCron, false);
  // Windows line endings, and a document that is the only thing printed.
  assertEquals(parseJsonDocument<{ a: number }>('{\r\n  "a": 1\r\n}')?.a, 1);
});

Deno.test("no parsable document reads as null rather than throwing", () => {
  assertEquals(parseJsonDocument("no json here"), null);
  assertEquals(parseJsonDocument(""), null);
  assertEquals(parseJsonDocument("{\nnot valid json\n}"), null);
  assertEquals(parseJsonDocument("}\n{"), null, "a closing brace before the opening one");
  // A bare array is a valid JSON document but not the object shape every caller expects.
  assertEquals(parseJsonDocument("[1, 2]"), null);
});

Deno.test("nextRuns reports the next firings in UTC", () => {
  const from = new Date("2026-09-16T00:00:00Z");
  assertEquals(nextRuns("0 3 * * *", 2, from), ["2026-09-16 03:00 UTC", "2026-09-17 03:00 UTC"]);
  assertEquals(nextRuns("*/15 * * * *", 2, from), ["2026-09-16 00:15 UTC", "2026-09-16 00:30 UTC"]);
  // Monday, per Vixie day-of-week.
  assertEquals(nextRuns("0 0 * * 1", 1, from), ["2026-09-21 00:00 UTC"]);
});

Deno.test("a sparse schedule still resolves, and a malformed one yields nothing", () => {
  const from = new Date("2026-09-16T00:00:00Z");
  // Once a year: the search has to look far enough ahead without running forever.
  assertEquals(nextRuns("0 6 1 1 *", 1, from), ["2027-01-01 06:00 UTC"]);
  // Asking for more than the horizon holds returns what it found, not a hang.
  assert(nextRuns("0 6 1 1 *", 5, from).length <= 2);
  // A malformed expression never fires, so there is nothing to show.
  assertEquals(nextRuns("99 * * * *", 3, from), []);
  assertEquals(nextRuns("* * *", 3, from), []);
});

// ── the editor ───────────────────────────────────────────────────────────────
//
// These spawn one real discovery child each (`denext task --list --json`), which is what makes
// the panel honest about which schedules exist — so they cost about a second apiece.

const CONFIG = `export default {
  // this comment must survive every write
  basePath: "/app",
  scheduledTasks: { "0 3 * * *": "cleanup" },
};
`;

Deno.test("the editor renders one row per schedule, not a raw key/value map", async () => {
  const dir = await project(CONFIG, { cleanup: task(), digest: task() });
  try {
    const body = await (await call(dir)).text();
    // Two rows: the one the config declares, plus the blank one that adds another.
    assertEquals((body.match(/name="cron"/g) ?? []).length, 2);
    assertStringIncludes(body, 'value="0 3 * * *"');
    assertStringIncludes(body, "<option");
    assert(stampIn(body).length === 64, "the form carries the file's stamp");
    // The generic schema widget's spelling must not be what this page shows.
    assert(!body.includes("~key") && !body.includes("~branch"), "no raw map editor");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an edit previews a diff, writes nothing, then confirms exactly that", async () => {
  const dir = await project(CONFIG, { cleanup: task(), digest: task() });
  const file = join(dir, "denext.config.ts");
  try {
    const base = stampIn(await (await call(dir)).text());
    const preview = await (await call(dir, {
      rows: [["0 5 * * *", "cleanup"], ["0 0 * * 1", "digest"]],
      form: { _base: base, intent: "save" },
    })).text();
    assertStringIncludes(preview, "0 5 * * *");
    assertEquals(await Deno.readTextFile(file), CONFIG, "a preview writes nothing");

    const applied = await call(dir, {
      form: { value: carriedIn(preview), confirm: "1", intent: "save", _base: base },
    });
    assertEquals(applied.status, 303);
    await applied.body?.cancel();
    const after = await Deno.readTextFile(file);
    assertStringIncludes(after, '"0 5 * * *": "cleanup"');
    assertStringIncludes(after, '"0 0 * * 1": "digest"');
    assertStringIncludes(after, "// this comment must survive every write");
    assertStringIncludes(after, 'basePath: "/app"');

    // The write redirects with `?saved=1`, and the page it lands on has to SAY so — otherwise it
    // looks identical to the one the form was submitted from and the write reads as a no-op.
    assertEquals(applied.headers.get("location"), "/config/cron?saved=1");
    const landed = await (await call(dir, { query: "?saved=1" })).text();
    assertStringIncludes(landed, "Saved denext.config.ts.");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a schedule that could never fire is refused, not saved", async () => {
  const dir = await project(CONFIG, { cleanup: task() });
  try {
    const base = stampIn(await (await call(dir)).text());
    const bad = await call(dir, {
      rows: [["99 * * * *", "cleanup"]],
      form: { _base: base, intent: "save" },
    });
    assertEquals(bad.status, 422);
    assertStringIncludes(await bad.text(), "out of range");

    // The scheduler skips a schedule naming a task it cannot find; writing one is no service.
    const missing = await call(dir, {
      rows: [["0 3 * * *", "nope"]],
      form: { _base: base, intent: "save" },
    });
    assertEquals(missing.status, 422);
    assertStringIncludes(await missing.text(), "no task named");
    assertEquals(await Deno.readTextFile(join(dir, "denext.config.ts")), CONFIG);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("silence never deletes: only the button that says so removes every schedule", async () => {
  const dir = await project(CONFIG, { cleanup: task() });
  const file = join(dir, "denext.config.ts");
  try {
    const base = stampIn(await (await call(dir)).text());
    // A POST naming no action at all.
    assertEquals((await call(dir, { form: { _base: base } })).status, 400);
    // And one that says "save" but carries no rows, against a config that has some.
    const empty = await call(dir, { form: { _base: base, intent: "save" } });
    assertEquals(empty.status, 400);
    assertStringIncludes(await empty.text(), "Remove all schedules");
    assertEquals(await Deno.readTextFile(file), CONFIG, "nothing was written");

    const cleared = await call(dir, { form: { _base: base, intent: "clear", confirm: "1" } });
    assertEquals(cleared.status, 303);
    await cleared.body?.cancel();
    const after = await Deno.readTextFile(file);
    assert(!after.includes("scheduledTasks"), "the key is removed, not left as `{}`");
    assertStringIncludes(after, 'basePath: "/app"', "every other key is untouched");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a write against a file that moved underneath the form is a 409", async () => {
  const dir = await project(CONFIG, { cleanup: task() });
  const file = join(dir, "denext.config.ts");
  try {
    const base = stampIn(await (await call(dir)).text());
    await Deno.writeTextFile(file, 'export default { basePath: "/elsewhere" };\n');
    const stale = await call(dir, {
      rows: [["0 5 * * *", "cleanup"]],
      form: { _base: base, intent: "save" },
    });
    assertEquals(stale.status, 409);
    assertStringIncludes(await stale.text(), "changed on disk");
    assertStringIncludes(await Deno.readTextFile(file), "/elsewhere", "the other edit stands");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--read-only refuses the write before anything is computed", async () => {
  const dir = await project(CONFIG, { cleanup: task() });
  try {
    const refused = await call(dir, {
      rows: [["0 5 * * *", "cleanup"]],
      form: { intent: "save" },
      readOnly: true,
    });
    assertEquals(refused.status, 403);
    assertEquals(await Deno.readTextFile(join(dir, "denext.config.ts")), CONFIG);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── run history ──────────────────────────────────────────────────────────────

/** A config that turns run history on. */
const HISTORY_ON = `export default {
  tasks: { history: true },
};
`;

Deno.test("history off says so, and offers the switch rather than an empty table", async () => {
  const dir = await project(CONFIG, { cleanup: task() });
  try {
    const body = await (await call(dir)).text();
    assertStringIncludes(body, "Run history is off");
    assertStringIncludes(body, "Enable run history");
    // An empty table would be the failure: it reads as "nothing ran" rather than "nothing is
    // being recorded", and those are different facts.
    assert(!body.includes("Last result"), "no table when nothing is recorded");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("history on with nothing recorded does not look like history off", async () => {
  const dir = await project(HISTORY_ON, { cleanup: task() });
  try {
    const body = await (await call(dir)).text();
    // The whole reason `enabled` and `available` are separate fields.
    assert(!body.includes("Run history is off"), "it is not off");
    assertStringIncludes(body, "nothing has been recorded yet");
    // The restart is the part people would otherwise wait on forever. This is the SECTION's
    // wording; the `?saved=1` notice says the same thing in its own words, and the round-trip
    // test above pins that one.
    assertStringIncludes(body, "restart the app");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("enabling history previews a diff, writes nothing, then writes exactly that", async () => {
  const dir = await project(CONFIG, { cleanup: task() });
  const file = join(dir, "denext.config.ts");
  try {
    const preview = await call(dir, { form: { intent: "history", history: "on" } });
    assertEquals(preview.status, 200);
    assertStringIncludes(await preview.text(), "Review the change");
    assertEquals(await Deno.readTextFile(file), CONFIG, "a preview writes nothing");

    const applied = await call(dir, {
      form: { intent: "history", history: "on", confirm: "1" },
    });
    assertEquals(applied.status, 303);
    assertEquals(applied.headers.get("location"), "/config/cron?saved=1&history=on");
    await applied.body?.cancel();

    // The landing page has to say the easily-missed part: it is not live until a restart.
    const landed = await (await call(dir, { query: "?saved=1&history=on" })).text();
    assertStringIncludes(landed, "next time the app starts");

    const after = await Deno.readTextFile(file);
    assertStringIncludes(after, "tasks: { history: true }");
    // The key is created in a config that never had it, and everything else survives.
    assertStringIncludes(after, "// this comment must survive every write");
    assertStringIncludes(after, 'basePath: "/app"');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the JSON twin keeps 'enabled' and 'available' apart", async () => {
  const dir = await project(CONFIG, { cleanup: task() });
  try {
    const off = await (await call(dir, { json: true })).json();
    assertEquals(off.history.enabled, false);
    // Off is not the same claim as unreadable: nothing was opened, because nothing was asked for.
    assertEquals(off.history.available, false);
    assertEquals(off.history.windowDays, 7);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the history toggle is refused read-only, and when the file moved underneath", async () => {
  const dir = await project(CONFIG, { cleanup: task() });
  const file = join(dir, "denext.config.ts");
  try {
    const refused = await call(dir, {
      form: { intent: "history", history: "on" },
      readOnly: true,
    });
    assertEquals(refused.status, 403);
    assertEquals(await Deno.readTextFile(file), CONFIG);

    const stale = await call(dir, {
      form: { intent: "history", history: "on", _base: "0".repeat(64) },
    });
    assertEquals(stale.status, 409);
    assertStringIncludes(await stale.text(), "changed on disk");
    assertEquals(await Deno.readTextFile(file), CONFIG);

    // A toggle that names no value is a refusal, not a silent default.
    const empty = await call(dir, { form: { intent: "history" } });
    assertEquals(empty.status, 400);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Seed a couple of recorded runs into a project's history. */
function seedHistory(dir: string): string {
  const path = join(dir, ".denext", "tasks.db");
  const store = taskHistoryRecorder({ path });
  const now = Date.now();
  store.record({ name: "cleanup", trigger: "schedule", startedAt: now, durationMs: 5, ok: true });
  store.record({ name: "cleanup", trigger: "manual", startedAt: now, durationMs: 9, ok: false });
  store.close();
  return path;
}

Deno.test("clearing history takes two steps, and the second one can actually be reached", async () => {
  const dir = await project(HISTORY_ON, { cleanup: task() });
  const path = seedHistory(dir);
  try {
    const first = await call(dir, { form: { intent: "clear-history" } });
    assertEquals(first.status, 409);
    const asked = await first.text();
    assertStringIncludes(asked, "Delete every recorded run");
    // The regression this guards: the first step must render a form that CARRIES the confirm.
    // Saying "press again" while posting the same body is an unusable button and a false promise.
    assertStringIncludes(asked, 'name="confirm" value="1"');
    assertEquals(readTaskHistory({ path }).recent.length, 2, "step one deletes nothing");

    const second = await call(dir, { form: { intent: "clear-history", confirm: "1" } });
    assertEquals(second.status, 303);
    assertEquals(second.headers.get("location"), "/config/cron?cleared=1");
    await second.body?.cancel();

    // A DELETE, not an unlink — the app may hold this file open.
    const after = readTaskHistory({ path });
    assertEquals(after.available, true, "the database is still there");
    assertEquals(after.recent, []);

    const landed = await (await call(dir, { query: "?cleared=1" })).text();
    assertStringIncludes(landed, "Run history cleared");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("clearing history is refused read-only, and the runs survive", async () => {
  const dir = await project(HISTORY_ON, { cleanup: task() });
  const path = seedHistory(dir);
  try {
    const refused = await call(dir, {
      form: { intent: "clear-history", confirm: "1" },
      readOnly: true,
    });
    assertEquals(refused.status, 403);
    assertEquals(readTaskHistory({ path }).recent.length, 2, "nothing was deleted");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a schedule row says what the expression means, in English", async () => {
  const dir = await project(
    `export default {
  scheduledTasks: { "30 3 * * *": "cleanup", "0 8 * * 1": "cleanup" },
};
`,
    { cleanup: task() },
  );
  try {
    const body = await (await call(dir)).text();
    // The point of the describer: not having to decode five fields in your head.
    assertStringIncludes(body, "every day at 03:30 UTC");
    assertStringIncludes(body, "on Mondays at 08:00 UTC");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("last result is a task's fact, shown on every row that schedules it", async () => {
  const dir = await project(
    `export default {
  tasks: { history: true },
  scheduledTasks: { "30 3 * * *": "cleanup", "0 8 * * 1": "cleanup", "0 0 * * *": "digest" },
};
`,
    { cleanup: task(), digest: task() },
  );
  try {
    // Only cleanup has run, and its most recent run failed. digest has never run.
    const store = taskHistoryRecorder({ path: join(dir, ".denext", "tasks.db") });
    const now = Date.now();
    store.record({
      name: "cleanup",
      trigger: "schedule",
      startedAt: now,
      durationMs: 77,
      ok: false,
    });
    store.close();

    const body = await (await call(dir)).text();
    const table = body.slice(body.indexOf("<table"), body.indexOf("</table>") + 8);
    assertStringIncludes(table, "Last result");

    const rows = [...table.matchAll(/<tr>(?!<th)([\s\S]*?)<\/tr>/g)]
      .map((m) => m[1])
      .filter((r) => r.includes("mono"));
    assertEquals(rows.length, 3);

    // cleanup is scheduled TWICE and has ONE history, so both its rows say the same thing. That
    // is why the column is headed "Last result" rather than implying per-row history.
    const cleanupRows = rows.filter((r) => r.includes(">cleanup<"));
    assertEquals(cleanupRows.length, 2);
    for (const row of cleanupRows) assert(row.includes(">failed<"), row);

    // Never having run is not a failure, and must not read as one.
    const digestRow = rows.find((r) => r.includes(">digest<"))!;
    assertStringIncludes(digestRow, "not yet");
    assert(!digestRow.includes(">failed<"), "a task that never ran has not failed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("with history off there is no result column to mislead anyone", async () => {
  const dir = await project(CONFIG, { cleanup: task() });
  try {
    const body = await (await call(dir)).text();
    const table = body.slice(body.indexOf("<table"), body.indexOf("</table>") + 8);
    assert(!table.includes("Last result"), "no column when there is nothing to put in it");
    assert(!table.includes("not yet"), "and no placeholder cells either");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("presets fill the expression in, rather than competing with it", async () => {
  const dir = await project(CONFIG, { cleanup: task() });
  try {
    const plain = await (await call(dir)).text();
    assertStringIncludes(plain, "Start from a common schedule");
    assertEquals((plain.match(/preset=/g) ?? []).length, 5, "one link per preset");
    assert(/name="cron" value=""/.test(plain), "the add row starts empty");

    const daily = await (await call(dir, { query: "?preset=0%203%20*%20*%20*" })).text();
    assert(/name="cron" value="0 3 \* \* \*"/.test(daily), "the preset fills the field");
    // The same describer the schedules table uses, so the editor says what it will save.
    assertStringIncludes(daily, "every day at 03:00 UTC");
    // The one you are already on is not a link back to itself.
    assertStringIncludes(daily, "<strong>Daily</strong>");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("only a known preset is accepted, so nothing arbitrary reaches the field", async () => {
  const dir = await project(CONFIG, { cleanup: task() });
  try {
    const junk = await (await call(dir, {
      query: "?preset=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    })).text();
    assert(/name="cron" value=""/.test(junk), "an unknown preset leaves the row empty");
    assert(!junk.includes("alert(1)"), "and nothing is reflected into the page");

    // A valid expression that is not one of the five is still not a preset.
    const other = await (await call(dir, { query: "?preset=7%207%20*%20*%20*" })).text();
    assert(/name="cron" value=""/.test(other), "only the offered presets fill the field");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the editor row explains a valid expression and refuses a broken one", async () => {
  const dir = await project(
    `export default {
  scheduledTasks: { "0 8 * * 1": "cleanup" },
};
`,
    { cleanup: task() },
  );
  try {
    const body = await (await call(dir)).text();
    // An existing row describes what it does...
    assertStringIncludes(body, "on Mondays at 08:00 UTC");
    // ...and the blank add row describes nothing, because there is nothing to describe.
    const rowCount = (body.match(/name="cron"/g) ?? []).length;
    assertEquals(rowCount, 2, "one configured row plus the add row");

    // A malformed expression gets the error, not a description.
    const bad = await (await call(dir, {
      rows: [["99 * * * *", "cleanup"]],
      form: { _base: stampIn(body), intent: "save" },
    })).text();
    assertStringIncludes(bad, "out of range");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
