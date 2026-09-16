// `denext ui`'s setup wizard (J9): the nine steps, the previews that precede every write, the
// env scan's lexical honesty, the doctor seam, and the refusals (`--read-only`, an unknown
// operation, a task name the project never declared).
//
// Everything runs against a real server on loopback, driven the way a browser with JavaScript
// disabled would drive it: real form posts, `303` back to the step anchor.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startUiServer, type UiServer } from "../src/ui/server.ts";
import { deriveCsrf, UI_COOKIE, UI_CSRF_HEADER } from "../src/ui/security.ts";
import { type DoctorCheck, setDoctorRunner } from "../src/ui/features/wizard.ts";
import { envExampleSource, envNamesIn, scanEnvUsage } from "../src/ui/env-scan.ts";
import { readDenoConfig, taskMap } from "../src/ui/tasks.ts";
import { FEATURES } from "../src/cli/commands/create.ts";

/** The step ids, in the order the wizard must present them. */
const STEP_IDS = [
  "detect",
  "runtime",
  "denojson",
  "deps",
  "env",
  "doctor",
  "features",
  "tasks",
  "finish",
];

interface Harness {
  server: UiServer;
  base: string;
  dir: string;
  csrf: string;
  headers: Record<string, string>;
}

/** Start the UI on a temp dir, optionally seeded with files. */
async function ui(
  files: Record<string, string> = {},
  opts: { readOnly?: boolean; offline?: boolean } = {},
): Promise<Harness> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_wizard_" });
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    await Deno.mkdir(join(abs, ".."), { recursive: true });
    await Deno.writeTextFile(abs, content);
  }
  const server = await startUiServer({ dir, port: 0, ...opts });
  return {
    server,
    dir,
    base: `http://127.0.0.1:${server.port}`,
    csrf: await deriveCsrf(server.token),
    headers: { cookie: `${UI_COOKIE}=${server.token}` },
  };
}

async function stop(h: Harness): Promise<void> {
  await h.server.shutdown();
  await Deno.remove(h.dir, { recursive: true });
}

/** Post one wizard operation the way a no-JS form would. */
function post(
  h: Harness,
  fields: Record<string, string>,
  path = "/wizard",
): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return fetch(`${h.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { ...h.headers, origin: h.base, [UI_CSRF_HEADER]: h.csrf },
    body: form,
  });
}

/** A `deno.json` with every wizard-managed key except the `dev` task, and comments. */
const DENO_JSON_WITHOUT_DEV = `{
  // the framework, pinned
  "imports": {
    "denext": "jsr:@denext/denext@^2",
    "denext/jsx-runtime": "jsr:@denext/denext@^2/jsx-runtime",
    "denext/jsx-dev-runtime": "jsr:@denext/denext@^2/jsx-dev-runtime",
    "denext/server": "jsr:@denext/denext@^2/server",
    "denext/client": "jsr:@denext/denext@^2/client"
  },
  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "denext" },
  "tasks": {
    // no dev task yet — the wizard adds it
    "build": "deno run -A jsr:@denext/denext/cli build .",
    "start": "deno run -A jsr:@denext/denext/cli start ."
  }
}
`;

// ── the nine steps ───────────────────────────────────────────────────────────

Deno.test("an empty directory gets nine steps in order, and is offered a scaffold", async () => {
  const h = await ui();
  try {
    const res = await fetch(`${h.base}/api/wizard`, { headers: h.headers });
    assertEquals(res.status, 200);
    const payload = await res.json();
    assertEquals(payload.ok, true);
    assertEquals(payload.dir, h.dir);
    assertEquals(payload.kind, "empty");
    assertEquals(payload.steps.map((s: { id: string }) => s.id), STEP_IDS);

    const features = payload.steps.find((s: { id: string }) => s.id === "features");
    assertEquals(features.status, "todo");
    assert(features.actions.includes("scaffold"), "an empty dir is offered the scaffold");
    const denojson = payload.steps.find((s: { id: string }) => s.id === "denojson");
    assert(denojson.actions.includes("denojson"), "a dir with no deno.json is offered one");
    for (const step of payload.steps) {
      assert(typeof step.summary === "string" && step.summary.length > 0, step.id);
      assert(["ok", "todo", "warn", "info"].includes(step.status), step.status);
    }
  } finally {
    await stop(h);
  }
});

Deno.test("the HTML wizard renders one section per step, each with a status pill", async () => {
  const h = await ui({ "deno.json": DENO_JSON_WITHOUT_DEV });
  try {
    const res = await fetch(`${h.base}/wizard`, { headers: h.headers });
    assertEquals(res.status, 200);
    const body = await res.text();
    assertStringIncludes(body, '<section id="panel"');
    for (const id of STEP_IDS) assertStringIncludes(body, `id="step-${id}"`);
    assertStringIncludes(body, '<span class="badge">');
    assertStringIncludes(body, '<form method="post" action="/wizard"');
    assert(!body.includes("<script>"), "the wizard ships no inline script");
    assert(!body.includes("Not implemented yet"), "the stub is gone");
    // Every feature toggle the CLI offers is offered here too.
    for (const feature of FEATURES) assertStringIncludes(body, feature.label);
  } finally {
    await stop(h);
  }
});

// ── step 3: the deno.json merge ──────────────────────────────────────────────

Deno.test("a missing dev task previews as a merge that adds only that key", async () => {
  const h = await ui({ "deno.json": DENO_JSON_WITHOUT_DEV });
  try {
    const before = await readDenoConfig(h.dir);
    assertEquals(Object.keys(taskMap(before)), ["build", "start"]);

    const preview = await post(h, { op: "denojson" });
    assertEquals(preview.status, 200, "a preview is rendered, never written");
    const body = await preview.text();
    assertStringIncludes(body, "Review the change to deno.json");
    assertStringIncludes(body, 'name="confirm" value="1"');
    // The diff introduces exactly one key. The preceding member is re-emitted only because it
    // gains a comma, so it shows up on both sides and cancels out; nothing else moves.
    // The rendered diff classes each line, so the markup comes off before the +/- is read.
    const lines = body.replace(/<[^>]+>/g, "").split("\n");
    const keysOn = (sign: string): string[] =>
      lines
        .filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3)))
        .flatMap((l) => [...l.matchAll(/&quot;([\w./-]+)&quot;\s*:/g)].map((m) => m[1]));
    const introduced = keysOn("+").filter((key) => !keysOn("-").includes(key));
    assertEquals(introduced, ["dev"], `expected only "dev", saw ${introduced.join(", ")}`);
    assertEquals(keysOn("-").filter((key) => !keysOn("+").includes(key)), [], "nothing is lost");
    assertEquals(
      await Deno.readTextFile(join(h.dir, "deno.json")),
      DENO_JSON_WITHOUT_DEV,
      "a preview never touches the file",
    );

    const applied = await post(h, { op: "denojson", confirm: "1" });
    assertEquals(applied.status, 303);
    assertEquals(applied.headers.get("location"), "/wizard#step-denojson");
    await applied.body?.cancel();

    const after = await Deno.readTextFile(join(h.dir, "deno.json"));
    assertStringIncludes(after, "// the framework, pinned", "comments survive the splice");
    assertStringIncludes(after, "// no dev task yet", "inner comments survive too");
    assertStringIncludes(after, '"build": "deno run -A jsr:@denext/denext/cli build ."');
    assertStringIncludes(after, '"dev":');
    assertEquals(Object.keys(taskMap(await readDenoConfig(h.dir))).sort(), [
      "build",
      "dev",
      "start",
    ]);
  } finally {
    await stop(h);
  }
});

// ── step 5: the environment scan ─────────────────────────────────────────────

Deno.test("a variable read in source but declared nowhere lands in .env.example", async () => {
  const h = await ui({
    "deno.json": DENO_JSON_WITHOUT_DEV,
    "app/page.tsx": "export default function Page() {\n" +
      '  return <p>{Deno.env.get("FOO")}</p>;\n}\n',
  });
  try {
    const scan = await scanEnvUsage(h.dir);
    assertEquals(scan.used, ["FOO"]);
    assertEquals(scan.missing, ["FOO"]);
    assertEquals(scan.files, [], "the project has no .env files");

    const page = await fetch(`${h.base}/api/wizard`, { headers: h.headers });
    const env = (await page.json()).steps.find((s: { id: string }) => s.id === "env");
    assertEquals(env.status, "todo");
    assertStringIncludes(env.summary, "FOO");

    const preview = await post(h, { op: "envexample" });
    assertEquals(preview.status, 200);
    assertStringIncludes(await preview.text(), "FOO=");
    assertEquals(await exists(join(h.dir, ".env.example")), false, "the preview wrote nothing");

    const applied = await post(h, { op: "envexample", confirm: "1" });
    assertEquals(applied.status, 303);
    assertEquals(applied.headers.get("location"), "/wizard#step-env");
    await applied.body?.cancel();

    assertStringIncludes(await Deno.readTextFile(join(h.dir, ".env.example")), "FOO=");
    assertEquals(await exists(join(h.dir, ".env")), false, "the wizard never writes .env");
  } finally {
    await stop(h);
  }
});

Deno.test("a declared variable is not reported as missing", async () => {
  const h = await ui({
    "lib/db.ts": 'export const url = Deno.env.get("DATABASE_URL");\n',
    ".env": "DATABASE_URL=postgres://localhost/x\n",
  });
  try {
    const scan = await scanEnvUsage(h.dir);
    assertEquals(scan.used, ["DATABASE_URL"]);
    assertEquals(scan.declared, ["DATABASE_URL"]);
    assertEquals(scan.files, [".env"]);
    assertEquals(scan.missing, []);
  } finally {
    await stop(h);
  }
});

Deno.test("a Deno.env.get inside a comment or a string literal is never reported", () => {
  assertEquals(envNamesIn('const a = Deno.env.get("REAL");'), ["REAL"]);
  assertEquals(envNamesIn('// Deno.env.get("COMMENTED")\nconst a = 1;'), []);
  assertEquals(envNamesIn('/* Deno.env.get("BLOCK") */'), []);
  assertEquals(envNamesIn('const doc = "call Deno.env.get(\\"QUOTED\\") here";'), []);
  assertEquals(envNamesIn("const doc = `Deno.env.get('TEMPLATE')`;"), []);
  assertEquals(envNamesIn("const p = process.env.NODE_ENV;"), ["NODE_ENV"]);
  assertEquals(envNamesIn('const p = process.env["API_KEY"];'), ["API_KEY"]);
  // Real code after a decoy still registers.
  assertEquals(
    envNamesIn('// Deno.env.get("X")\nconst a = Deno.env.get("Y");'),
    ["Y"],
  );
});

Deno.test("envExampleSource appends only what the file does not already document", () => {
  assertEquals(envExampleSource("A=1\n", ["A"]), "A=1\n");
  assertStringIncludes(envExampleSource("A=1\n", ["B"]), "B=");
  assertStringIncludes(envExampleSource(null, ["B"]), "B=");
  assertStringIncludes(envExampleSource(null, ["B"]), "# Environment variables");
  assertEquals(envExampleSource("A=1", ["B"]), "A=1\nB=\n");
});

// ── step 6: the doctor seam ──────────────────────────────────────────────────

Deno.test("the doctor panel renders an injected report without spawning anything", async () => {
  const fixture: DoctorCheck[] = [
    { name: "deno version", ok: true, detail: "2.9.5", critical: true },
    { name: "app dir", ok: false, detail: "no app/ directory", critical: true },
  ];
  let askedFor = "";
  setDoctorRunner((dir) => {
    askedFor = dir;
    return Promise.resolve(fixture);
  });
  const h = await ui({ "deno.json": DENO_JSON_WITHOUT_DEV });
  try {
    const res = await post(h, { op: "doctor" });
    assertEquals(res.status, 200);
    const body = await res.text();
    assertEquals(askedFor, h.dir, "the runner is asked about the project the UI was opened on");
    assertStringIncludes(body, "1 of 2 checks failed");
    assertStringIncludes(body, "deno version");
    assertStringIncludes(body, "no app/ directory");
    // The failing app-dir check offers the repair.
    assertStringIncludes(body, 'name="op" value="scaffold-page"');

    const api = await fetch(`${h.base}/api/wizard`, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...h.headers,
        origin: h.base,
        [UI_CSRF_HEADER]: h.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    // A JSON body carries no `op`, so the operation table refuses it.
    assertEquals(api.status, 400);
    assertStringIncludes((await api.json()).reason, "unknown wizard operation");
  } finally {
    setDoctorRunner(null);
    await stop(h);
  }
});

// ── refusals ────────────────────────────────────────────────────────────────

Deno.test("a task name the project does not declare is refused before any spawn", async () => {
  const h = await ui({ "deno.json": DENO_JSON_WITHOUT_DEV });
  try {
    const res = await post(h, { task: "rm -rf /" }, "/tasks/run");
    assertEquals(res.status, 400);
    const payload = await res.json();
    assertEquals(payload.ok, false);
    assertStringIncludes(payload.reason, "unknown task");
    assertEquals(payload.tasks, ["build", "start"]);

    // The step only ever offers names that are in the file.
    const page = await fetch(`${h.base}/wizard`, { headers: h.headers });
    const body = await page.text();
    assertStringIncludes(body, 'name="task" value="build"');
    assertStringIncludes(body, 'action="/tasks/run"');
    assert(!body.includes('value="rm -rf /"'));
  } finally {
    await stop(h);
  }
});

Deno.test("an operation outside the table never runs", async () => {
  const h = await ui();
  try {
    for (const op of ["", "nope", "constructor", "__proto__", "toString"]) {
      const res = await post(h, { op });
      assertEquals(res.status, 400, op);
      assertStringIncludes((await res.json()).reason, "unknown wizard operation");
    }
  } finally {
    await stop(h);
  }
});

Deno.test("--read-only refuses every wizard write and says so on the page", async () => {
  const h = await ui({ "deno.json": DENO_JSON_WITHOUT_DEV }, { readOnly: true });
  try {
    for (
      const op of [
        "denojson",
        "install",
        "envexample",
        "doctor",
        "scaffold-page",
        "scaffold",
        "dev",
      ]
    ) {
      const res = await post(h, { op, confirm: "1" });
      assertEquals(res.status, 403, op);
      assertEquals((await res.json()).reason, "read-only");
    }
    assertEquals(
      await Deno.readTextFile(join(h.dir, "deno.json")),
      DENO_JSON_WITHOUT_DEV,
      "nothing was written",
    );
    const page = await fetch(`${h.base}/wizard`, { headers: h.headers });
    const body = await page.text();
    assertStringIncludes(body, "Read-only mode");
    assertStringIncludes(body, '<button type="submit" disabled>');
  } finally {
    await stop(h);
  }
});

// ── the JSON twin ────────────────────────────────────────────────────────────

Deno.test("the JSON twin reports { id, status, summary, actions } per step", async () => {
  const h = await ui({ "deno.json": DENO_JSON_WITHOUT_DEV, "app/page.tsx": "export default 1;\n" });
  try {
    const res = await fetch(`${h.base}/api/wizard`, { headers: h.headers });
    const payload = await res.json();
    assertEquals(payload.kind, "denext");
    for (const step of payload.steps) {
      assertEquals(Object.keys(step).sort(), ["actions", "id", "status", "summary"]);
      assert(Array.isArray(step.actions));
      for (const action of step.actions) assertEquals(typeof action, "string");
    }
    const denojson = payload.steps.find((s: { id: string }) => s.id === "denojson");
    assertEquals(denojson.status, "todo");
    assertStringIncludes(denojson.summary, "tasks.dev");
    const tasks = payload.steps.find((s: { id: string }) => s.id === "tasks");
    assertEquals(tasks.status, "ok");
    assertStringIncludes(tasks.summary, "build, start");
    const finish = payload.steps.find((s: { id: string }) => s.id === "finish");
    assertEquals(finish.actions, ["dev"]);
  } finally {
    await stop(h);
  }
});

Deno.test("a Next.js drop-in is detected from its package.json", async () => {
  const h = await ui({
    "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
    "app/page.tsx": "export default function Page() { return null; }\n",
  });
  try {
    const payload = await (await fetch(`${h.base}/api/wizard`, { headers: h.headers })).json();
    assertEquals(payload.kind, "compat");
    const detect = payload.steps.find((s: { id: string }) => s.id === "detect");
    assertStringIncludes(detect.summary, "Next.js");
  } finally {
    await stop(h);
  }
});

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// ── --offline ────────────────────────────────────────────────────────────────

/** The JSON outcome of one wizard operation. */
/** The wizard page's markup, the way a no-JS browser would read it. */
async function wizardPage(h: Harness): Promise<string> {
  return await (await fetch(`${h.base}/wizard`, { headers: h.headers })).text();
}

async function outcomeOf(h: Harness, op: string): Promise<{ ok: boolean; message: string }> {
  return (await (await post(h, { op }, "/api/wizard")).json()).outcome;
}

Deno.test("--offline refuses denext dev and every task with a 503, and renders them disabled", async () => {
  const h = await ui({ "deno.json": DENO_JSON_WITHOUT_DEV }, { offline: true });
  try {
    const dev = await post(h, { op: "dev" }, "/api/wizard");
    assertEquals(dev.status, 503);
    const { outcome } = await dev.json();
    assertEquals([outcome.ok, outcome.step], [false, "finish"]);
    assertStringIncludes(outcome.message, "a dev server needs net permission to listen");

    const task = await post(h, { task: "build" }, "/tasks/run");
    assertEquals(task.status, 503, "a declared task is refused, not spawned");
    assertStringIncludes((await task.json()).reason, "a task is arbitrary shell");

    const page = await post(h, { op: "dev" });
    assertEquals(page.status, 503, "the no-JS answer carries the same status");
    const body = await page.text();
    assertStringIncludes(body, "denext dev is unavailable — the UI runs --offline");
    assertStringIncludes(body, "deno task is unavailable — the UI runs --offline");
    assertMatch(body, /<button[^>]*\sdisabled[^>]*>deno task build<\/button>/);
    assertMatch(body, /<button[^>]*\sdisabled[^>]*>Start denext dev<\/button>/);
  } finally {
    await stop(h);
  }
});

Deno.test("online, the task and dev buttons stay live and carry no offline note", async () => {
  const h = await ui({ "deno.json": DENO_JSON_WITHOUT_DEV });
  try {
    const body = await (await fetch(`${h.base}/wizard`, { headers: h.headers })).text();
    assertMatch(body, /<button type="submit">deno task build<\/button>/);
    assertMatch(body, /<button type="submit">Start denext dev<\/button>/);
    assert(!body.includes("--offline"));
  } finally {
    await stop(h);
  }
});

Deno.test("the Dependencies step separates 'nothing to install' from 'not installed yet'", async () => {
  // No imports at all: `deno install` has nothing to resolve and writes no lockfile, so the step
  // must not sit on a to-do no run can ever satisfy.
  const bare = await ui({ "deno.json": "{}\n" });
  // An import map with no lockfile yet: that IS a to-do, and the action belongs there.
  const pending = await ui({
    "deno.json": '{ "imports": { "@std/assert": "jsr:@std/assert@^1" } }\n',
  });
  try {
    const empty = await wizardPage(bare);
    assertStringIncludes(empty, "Nothing to install");
    assert(!empty.includes("No deno.lock yet"), "the dead-end wording is gone");
    assert(!empty.includes("Run deno install"), "and so is the button that cannot help");

    const todo = await wizardPage(pending);
    assertStringIncludes(todo, "No deno.lock yet");
    assertStringIncludes(todo, "Run deno install");
  } finally {
    await stop(bare);
    await stop(pending);
  }
});

Deno.test("--offline runs doctor through a no-net child and deno install --cached-only", async () => {
  const seen: boolean[] = [];
  setDoctorRunner((_dir, offline) => {
    seen.push(offline);
    return Promise.resolve([{ name: "config", ok: true, detail: "found", critical: true }]);
  });
  const online = await ui({ "deno.json": "{}\n" });
  const offline = await ui({ "deno.json": "{}\n" }, { offline: true });
  try {
    await outcomeOf(online, "doctor");
    await outcomeOf(offline, "doctor");
    assertEquals(seen, [false, true], "the doctor runner is told when to deny net");
    // A real `deno install` of a project with nothing to fetch — offline, it is --cached-only.
    assertEquals((await outcomeOf(online, "install")).message, "deno install finished.");
    assertEquals(
      (await outcomeOf(offline, "install")).message,
      "deno install --cached-only finished.",
    );
  } finally {
    setDoctorRunner(null);
    await stop(online);
    await stop(offline);
  }
});
