// The `denext ui` kernel: loopback binding, the asset routes, every feature route's HTML page
// and its `/api/*` JSON twin, the broadcast channel, task-name validation, clean shutdown — and
// the standing guarantee that the UI's module graph never reaches the bundler.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startUiServer, type UiServer } from "../src/ui/server.ts";
import { cliInvocation } from "../src/ui/proc.ts";
import { projectTasks, UI_ROUTES } from "../src/ui/routes.ts";
import { UI_CSRF_HEADER } from "../src/ui/security.ts";
import { uiHandshake } from "./helpers/ui-session.ts";
import { toHtml, UI_NAV, UI_TITLE_HEADER } from "../src/ui/html.ts";
import { Fragment, h } from "../src/jsx/jsx-runtime.ts";
import { DiffBlock, OpForm } from "../src/ui/components.ts";
import { Raw, renderView } from "../src/ui/view.ts";
import { decodePatch } from "../src/ui/features/config.ts";
import { readWidget, renderWidget } from "../src/ui/form/render.ts";
import { branchFor, itemSchema, loadConfigSchema, resolveAt } from "../src/ui/form/schema.ts";
import { widgetFor } from "../src/ui/form/widget.ts";
import { control } from "../src/ui/form/control.ts";
import { decode, encode } from "../src/ui/form/value.ts";
import { OVERRIDES } from "../src/ui/form/schema-overrides.ts";

interface Harness {
  server: UiServer;
  base: string;
  dir: string;
  /** The session cookie the handshake minted (never the launch token). */
  headers: Record<string, string>;
  /** The CSRF token derived from that cookie. */
  csrf: string;
}

/**
 * A UI server over a fresh project. `denoJson` is the project's `deno.json` text — the default
 * declares one task — and `null` leaves the project with no config file at all.
 */
async function ui(
  { denoJson = '{ "tasks": { "hello": "eval console.log(1)" } }', ...options }: {
    offline?: boolean;
    denoJson?: string | null;
  } = {},
): Promise<Harness> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_srv_" });
  if (denoJson !== null) await Deno.writeTextFile(join(dir, "deno.json"), denoJson);
  const server = await startUiServer({ dir, port: 0, ...options });
  const { cookie, csrf } = await uiHandshake(server);
  return { server, dir, base: `http://127.0.0.1:${server.port}`, headers: { cookie }, csrf };
}

/** POST `/tasks/run` for `task`, as the wizard's no-JS form would. */
async function postTask(h: Harness, task: string): Promise<Response> {
  const form = new FormData();
  form.set("task", task);
  return await fetch(`${h.base}/tasks/run`, {
    method: "POST",
    headers: { ...h.headers, origin: h.base, [UI_CSRF_HEADER]: h.csrf },
    body: form,
  });
}

async function stop(h: Harness): Promise<void> {
  await h.server.shutdown();
  await Deno.remove(h.dir, { recursive: true });
}

Deno.test("the server binds loopback only and hands back its URL + token", async () => {
  const h = await ui();
  try {
    assertEquals(h.server.hostname, "127.0.0.1");
    assert(h.server.port > 0);
    // 127.0.0.1 by name, never `localhost`: a loopback cookie is shared across every port of
    // its host, and `localhost` is the name every other local server is reached at.
    assertEquals(h.server.url, `http://127.0.0.1:${h.server.port}/?t=${h.server.token}`);
    assert(h.server.token.length >= 43, "the launch token carries 256 bits of entropy");
  } finally {
    await stop(h);
  }
});

Deno.test("the overview page renders the shell, the nav and the project dir", async () => {
  const h = await ui();
  try {
    const res = await fetch(`${h.base}/`, { headers: h.headers });
    assertEquals(res.status, 200);
    assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
    const body = await res.text();
    assertStringIncludes(body, "<!doctype html>");
    assertStringIncludes(body, '<link rel="stylesheet" href="/_ui/ui.css">');
    assertStringIncludes(body, '<script type="module" src="/_ui/ui.js">');
    assertStringIncludes(body, 'name="denext-csrf"');
    for (const item of UI_NAV) assertStringIncludes(body, `href="${item.href}"`);
    assert(!body.includes("<script>"), "the UI ships no inline script");
  } finally {
    await stop(h);
  }
});

Deno.test("the same-origin assets are served with the right content types", async () => {
  const h = await ui();
  try {
    const css = await fetch(`${h.base}/_ui/ui.css`, { headers: h.headers });
    assertEquals(css.status, 200);
    assertStringIncludes(css.headers.get("content-type") ?? "", "text/css");
    const sheet = await css.text();
    assertStringIncludes(sheet, "prefers-color-scheme");
    // A panel waiting on the server is drawn as such — dimmed, a progress cursor and a bar —
    // and the bar holds still for someone who asked for no motion.
    assertStringIncludes(sheet, '#panel[aria-busy="true"]');
    assertStringIncludes(sheet, "cursor: progress");
    assertStringIncludes(sheet, "@keyframes ui-busy");
    assertStringIncludes(sheet, "prefers-reduced-motion");

    const js = await fetch(`${h.base}/_ui/ui.js`, { headers: h.headers });
    assertEquals(js.status, 200);
    assertStringIncludes(js.headers.get("content-type") ?? "", "javascript");
    const source = await js.text();
    assertStringIncludes(source, "DOMParser");
    assertStringIncludes(source, "/_ui/events");
    assert(!source.includes(".innerHTML ="), "untrusted text is never innerHTML'd");
    // It is a string in `client.ts`, so nothing else parses it: do it here.
    new Function(source);
    // While a fragment is in flight the panel (and a submitting form) says so, and the mark is
    // taken off again — a swap replaces the panel, and the form is cleared by hand.
    assertStringIncludes(source, 'setAttribute("aria-busy", "true")');
    assertStringIncludes(source, 'removeAttribute("aria-busy")');
    // A GET form inside the panel (the cron builder, a filter) keeps its place on screen across
    // the swap it asked for; only a navigation link scrolls to the top.
    assertStringIncludes(source, "globalThis.scrollY");
    assertStringIncludes(source, 'form.closest("#panel") ? anchorOf(form) : null');
    assertStringIncludes(
      source,
      "if (anchor) restoreAnchor(anchor);\n  else if (push) globalThis.scrollTo(0, 0);",
    );
    // Every frame the panels push is dispatched (an unknown one is ignored, not thrown on).
    const frames = [
      "reload",
      "plugins-changed",
      "command-done",
      "task-done",
      "dev-output",
      "dev-exit",
      "dev-ready",
      "dev-stopped",
    ];
    for (const type of frames) assertStringIncludes(source, type);
  } finally {
    await stop(h);
  }
});

Deno.test("every feature route serves a page with the panel ui.js swaps", async () => {
  const h = await ui();
  try {
    const pages = Object.entries(UI_ROUTES)
      .filter(([path, route]) =>
        !path.startsWith("/api/") && !path.startsWith("/_ui/") && path !== "/" &&
        route.methods.includes("GET")
      );
    assert(pages.length >= 7, `expected the seven feature panels, saw ${pages.length}`);
    for (const [path] of pages) {
      const page = await fetch(`${h.base}${path}`, { headers: h.headers });
      assertEquals(page.status, 200, path);
      assertStringIncludes(await page.text(), '<section id="panel"', path);
    }
  } finally {
    await stop(h);
  }
});

Deno.test("a fragment request returns only the section ui.js swaps", async () => {
  const h = await ui();
  try {
    const res = await fetch(`${h.base}/plugins`, {
      headers: { ...h.headers, accept: "text/html-fragment" },
    });
    const body = await res.text();
    assert(!body.includes("<!doctype html>"));
    assertStringIncludes(body, '<section id="panel"');
  } finally {
    await stop(h);
  }
});

Deno.test('every panel GET answers a fragment request with the bare <section id="panel"> and a title header', async () => {
  const h = await ui();
  try {
    // A config wiring a catalogued plugin, so its options sub-panel has something to render.
    await Deno.writeTextFile(
      join(h.dir, "denext.config.ts"),
      'import { openapi } from "@denext/openapi";\nexport default { plugins: [openapi()] };\n',
    );
    // Every navigable panel in the route table (the overview included), plus the one sub-panel
    // that needs a query to name its subject. `/_ui/*` is the client's own machinery and
    // `/api/*` the JSON twins — neither is a panel ui.js swaps.
    const panels = Object.entries(UI_ROUTES)
      .filter(([path, route]) =>
        !path.startsWith("/api/") && !path.startsWith("/_ui/") && route.methods.includes("GET")
      )
      .map(([path]) => path);
    panels.push(`/plugins/options?name=${encodeURIComponent("@denext/openapi")}`);
    for (const view of ["", "routing", "rendering", "security", "advanced", "cron", "next"]) {
      assert(panels.includes(`/config${view && `/${view}`}`), `/config/${view} is a route`);
    }
    for (
      const path of [
        "/",
        "/plugins",
        "/generate",
        "/docker",
        "/desktop",
        "/wizard",
        "/dev",
        "/commands",
      ]
    ) {
      assert(panels.includes(path), `${path} is a route`);
    }
    for (const path of panels) {
      const res = await fetch(`${h.base}${path}`, {
        headers: { ...h.headers, accept: "text/html-fragment" },
      });
      const body = await res.text();
      assertEquals(res.status, 200, path);
      assertStringIncludes(res.headers.get("content-type") ?? "", "text/html", path);
      assert(
        body.startsWith('<section id="panel"'),
        `${path} starts with the panel: ${body.slice(0, 80)}`,
      );
      assert(
        !/<html|<!doctype|<head>|<body|<script|<link /i.test(body),
        `${path} carries no document shell`,
      );
      assertEquals(body.match(/<section id="panel"/g)?.length, 1, `${path} has ONE panel`);
      const title = res.headers.get(UI_TITLE_HEADER);
      assert(title, `${path} names its title in ${UI_TITLE_HEADER}`);
      assertStringIncludes(decodeURIComponent(title), "denext", path);
      // The same GET without the header is the full document around that very panel.
      const page = await fetch(`${h.base}${path}`, { headers: h.headers });
      const doc = await page.text();
      assertStringIncludes(doc, "<!doctype html>", path);
      assertStringIncludes(doc, '<section id="panel"', path);
    }
  } finally {
    await stop(h);
  }
});

Deno.test("the overview's JSON twin reports the project and the route table", async () => {
  const h = await ui();
  try {
    const res = await fetch(`${h.base}/api/overview`, { headers: h.headers });
    assertEquals(res.status, 200);
    const payload = await res.json();
    assertEquals(payload.ok, true);
    assertEquals(payload.dir, h.dir);
    assertEquals(payload.readOnly, false);
    for (const path of ["/", "/config", "/api/config", "/tasks/run", "/_ui/events"]) {
      assert(payload.routes.includes(path), path);
      assert(Object.keys(UI_ROUTES).includes(path), path);
    }
  } finally {
    await stop(h);
  }
});

Deno.test("the overview names the project, its pinned denext and the dev server dev.json says is up", async () => {
  const h = await ui({
    denoJson: '{ "name": "@acme/shop", "imports": { "denext": "jsr:@denext/denext@^2.5.0" } }',
  });
  try {
    await Deno.mkdir(join(h.dir, ".denext"));
    await Deno.writeTextFile(
      join(h.dir, ".denext", "dev.json"),
      JSON.stringify({
        origin: "http://127.0.0.1:3456",
        port: 3456,
        hostname: "127.0.0.1",
        pid: 2147483646,
        startedAt: Date.now(),
      }),
    );
    const body = await (await fetch(`${h.base}/`, { headers: h.headers })).text();
    assertStringIncludes(body, '<dl class="status">');
    assertStringIncludes(body, "<dt>Project</dt><dd>@acme/shop</dd>");
    assertStringIncludes(body, '<dt>denext</dt><dd><code class="mono">^2.5.0</code></dd>');
    // Nothing here probes the address: the page says what the file says, and offers the Wizard
    // — whose Stop is what finds out whether the server is really there.
    assertStringIncludes(body, "says running at ");
    assertStringIncludes(body, '<a href="http://127.0.0.1:3456">http://127.0.0.1:3456</a>');
    assertStringIncludes(body, '<a href="/dev">Stop it from Dev</a>');
    assert(!body.includes("Not running"), "a published address is not reported as absent");
    // The status block sits above the cards, so it is read first.
    assert(body.indexOf('<dl class="status">') < body.indexOf('<div class="cards">'));

    // The JSON twin carries the same three facts.
    const twin = await (await fetch(`${h.base}/api/overview`, { headers: h.headers })).json();
    assertEquals(twin.name, "@acme/shop");
    assertEquals(twin.denext, "^2.5.0");
    assertEquals(twin.dev, "http://127.0.0.1:3456");
  } finally {
    await stop(h);
  }
});

Deno.test("the overview falls back to the directory name, 'not pinned' and 'not running'", async () => {
  const h = await ui({ denoJson: null });
  try {
    const body = await (await fetch(`${h.base}/`, { headers: h.headers })).text();
    assertStringIncludes(body, `<dt>Project</dt><dd>${h.dir.split("/").pop()}</dd>`);
    assertStringIncludes(
      body,
      '<dt>denext</dt><dd><span class="badge warn">not pinned</span></dd>',
    );
    assertStringIncludes(body, "<dt>Dev server</dt><dd>Not running · ");
    assertStringIncludes(body, '<a href="/dev">Start it from Dev</a>');
    assert(!body.includes("says running at"), "no dev.json, no address");

    // An unversioned `jsr:@denext/denext` is a pin to the latest release — `deno run` resolves it
    // to one — so it is named as such rather than counted as no pin.
    await Deno.writeTextFile(
      join(h.dir, "deno.jsonc"),
      '{ /* comments are fine */ "imports": { "denext": "jsr:@denext/denext" } }',
    );
    const again = await (await fetch(`${h.base}/`, { headers: h.headers })).text();
    assertStringIncludes(again, '<dt>denext</dt><dd><code class="mono">latest</code></dd>');
  } finally {
    await stop(h);
  }
});

Deno.test("/tasks/run refuses a task the project does not declare", async () => {
  const h = await ui();
  try {
    const res = await postTask(h, "rm -rf /");
    assertEquals(res.status, 400);
    const payload = await res.json();
    assertEquals(payload.ok, false);
    assertStringIncludes(payload.reason, "unknown task");
    assertEquals(payload.tasks, ["hello"]);
  } finally {
    await stop(h);
  }
});

Deno.test("--offline: a declared task is a 503, an undeclared one still a 400, and the overview says so", async () => {
  const h = await ui({ offline: true });
  try {
    const refused = await postTask(h, "hello");
    assertEquals(refused.status, 503);
    assertStringIncludes((await refused.json()).reason, "deno task is unavailable");
    const unknown = await postTask(h, "rm -rf /");
    assertEquals(unknown.status, 400);
    await unknown.body?.cancel();
    const overview = await (await fetch(`${h.base}/`, { headers: h.headers })).text();
    assertStringIncludes(overview, "Offline mode — nothing the UI starts reaches the network");
  } finally {
    await stop(h);
  }
});

Deno.test("cliInvocation adds --deny-net --cached-only after -A only when offline", () => {
  const online = cliInvocation();
  assertEquals(online.slice(0, 2), ["run", "-A"]);
  assertEquals(online.length, 3);
  assertEquals(cliInvocation({ offline: false }), online);
  assertEquals(cliInvocation({ offline: true }), [
    "run",
    "-A",
    "--deny-net",
    "--cached-only",
    online[2],
  ]);
});

Deno.test("cliInvocation's dir only decides the CLI version for a compiled binary", () => {
  // `dir` exists so a binary hands each child the denext THAT PROJECT pins rather than its own
  // (cliModule in src/ui/proc.ts). Running from a checkout there is nothing to choose — the CLI
  // and the framework are the same package — so the directory must not perturb the argv at all.
  // The four call sites in features/commands.ts and features/wizard.ts pass it unconditionally.
  const online = cliInvocation();
  assertEquals(cliInvocation({ dir: Deno.cwd() }), online);
  assertEquals(cliInvocation({ dir: "/nonexistent/project" }), online);
  assertEquals(
    cliInvocation({ offline: true, dir: Deno.cwd() }),
    cliInvocation({ offline: true }),
  );
});

Deno.test("/_ui/events is an event stream", async () => {
  const h = await ui();
  try {
    const res = await fetch(`${h.base}/_ui/events`, { headers: h.headers });
    assertEquals(res.status, 200);
    assertStringIncludes(res.headers.get("content-type") ?? "", "text/event-stream");
    await res.body?.cancel();
  } finally {
    await stop(h);
  }
});

Deno.test("shutdown releases the port", async () => {
  const h = await ui();
  const port = h.server.port;
  await h.server.shutdown();
  await Deno.remove(h.dir, { recursive: true });
  // Rebinding the same port proves the listener was released.
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  listener.close();
});

Deno.test("the UI module graph never reaches the bundler or npm", async () => {
  // Rooted at the VERB, not the kernel: `denext ui` is what the user runs, and a stray import
  // in the command module (or anything it reaches) counts just as much as one in the server.
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", "src/cli/commands/ui.ts"],
    cwd: new URL("../", import.meta.url).pathname,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(output.success, new TextDecoder().decode(output.stderr));
  const graph = JSON.parse(new TextDecoder().decode(output.stdout)) as {
    modules: { specifier: string }[];
  };
  const forbidden = graph.modules
    .map((m) => m.specifier)
    .filter((s) => /esbuild|dev-server\/manifest|dev-unbundled|^npm:/.test(s));
  assertEquals(
    forbidden,
    [],
    "denext ui must never load the bundler or an npm dependency — everything that needs the " +
      "project runs as a subprocess (src/ui/proc.ts)",
  );
});

/**
 * A project whose config — and whose plugin `setup()` — each write a marker file naming the pid
 * that executed them. Evaluated in the UI process, the markers would carry the UI's own pid.
 */
const MARKER_CONFIG = `await Deno.writeTextFile(
  new URL("./config-ran.txt", import.meta.url),
  String(Deno.pid),
);
export default {
  plugins: [{
    name: "marker",
    async setup(ctx) {
      await Deno.writeTextFile(
        new URL("./setup-ran.txt", import.meta.url),
        String(Deno.pid),
      );
      ctx.addCommand({ name: "marked", summary: "a plugin verb", run: () => {} });
    },
  }],
};
`;

/** Read a marker's pid, or null when the file was never written. */
async function markerPid(dir: string, name: string): Promise<number | null> {
  try {
    return Number(await Deno.readTextFile(join(dir, name)));
  } catch {
    return null;
  }
}

Deno.test({
  name: "project code never runs in the UI process — discovery is a separate pid",
  // The real (unstubbed) discovery path spawns `denext commands --json`, which imports the
  // project's config for real.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_ui_marker_" });
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    await Deno.writeTextFile(join(dir, "denext.config.ts"), MARKER_CONFIG);
    // read-only: the UI refuses every write of its own, and a GET still lists verbs — the
    // discovery CHILD is allowed to execute the project, which is the whole point of the split.
    const server = await startUiServer({ dir, port: 0, readOnly: true });
    const { headers } = await uiHandshake(server);
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const page = await fetch(`${base}/commands`, { headers });
      assertEquals(page.status, 200);
      assertStringIncludes(await page.text(), "denext dev", "read-only still lists verbs");

      const api = await fetch(`${base}/api/commands`, { headers });
      assertEquals(api.status, 200);
      const body = await api.json() as { commands: { name: string; source: string }[] };
      assert(
        body.commands.some((c) => c.name === "marked" && c.source === "plugin"),
        `the project's plugin verb was discovered: ${
          JSON.stringify(body.commands.map((c) => c.name))
        }`,
      );

      // The markers exist — the project DID run — but in the child, never here.
      const config = await markerPid(dir, "config-ran.txt");
      const setup = await markerPid(dir, "setup-ran.txt");
      assert(config !== null && setup !== null, "the discovery child evaluated the project");
      assert(config !== Deno.pid, `denext.config.ts ran in the UI process (pid ${Deno.pid})`);
      assert(setup !== Deno.pid, `the plugin setup ran in the UI process (pid ${Deno.pid})`);
    } finally {
      await server.shutdown();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ── the view layer ───────────────────────────────────────────────────────────

Deno.test("a view escapes text and attributes, and Raw passes trusted markup through", () => {
  const name = '<img src=x onerror="alert(1)">';
  assertStringIncludes(toHtml(renderView(h("p", null, name))), "&lt;img");
  assertEquals(toHtml(renderView(h("p", null, h(Raw, { html: "<b>ok</b>" })))), "<p><b>ok</b></p>");
  assertEquals(toHtml(renderView(h(Fragment, null, null, undefined, false))), "");
  assertEquals(toHtml(renderView(h(Fragment, null, [1, 2, 3]))), "123");
  assertEquals(
    toHtml(renderView(h("p", { title: `&<>"'` }, `&<>"'`))),
    '<p title="&amp;&lt;&gt;&quot;&#39;">&amp;&lt;&gt;&quot;&#39;</p>',
  );
});

Deno.test("OpForm renders the CSRF token, the hidden fields and the button", () => {
  const markup = toHtml(renderView(h(OpForm, {
    csrf: "tok",
    action: "/wizard",
    label: "Apply",
    fields: { op: "denojson", confirm: "1" },
    className: "op",
    disabled: true,
  })));
  assertStringIncludes(markup, 'action="/wizard"');
  assertStringIncludes(markup, 'class="op"');
  assertStringIncludes(markup, 'name="_csrf" value="tok"');
  assertStringIncludes(markup, 'name="op" value="denojson"');
  assertStringIncludes(markup, 'name="confirm" value="1"');
  assertStringIncludes(markup, '<button type="submit" disabled>Apply</button>');
});

Deno.test("DiffBlock classes a unified diff's lines, escaping every one of them", () => {
  const diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-was <b>\n+now\n ctx";
  const markup = toHtml(renderView(h(DiffBlock, { diff })));
  assertStringIncludes(markup, '<pre class="out"><code class="diff">');
  assertStringIncludes(markup, '<span class="del">-was &lt;b&gt;</span>');
  assertStringIncludes(markup, '<span class="add">+now</span>');
  assertStringIncludes(markup, '<span class="meta">@@ -1 +1 @@</span>');
  assertStringIncludes(markup, "\n ctx</code></pre>", "context lines are left unclassed");
});

Deno.test("projectTasks reads deno.json and deno.jsonc, and tolerates neither", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_tasks_" });
  try {
    assertEquals(await projectTasks(dir), []);
    await Deno.writeTextFile(
      join(dir, "deno.jsonc"),
      '{ /* comments are fine */ "tasks": { "dev": "x", "build": "y" } }',
    );
    assertEquals(await projectTasks(dir), ["dev", "build"]);
    await Deno.writeTextFile(join(dir, "deno.json"), '{ "tasks": { "only": "z" } }');
    assertEquals(await projectTasks(dir), ["only"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── the schema-driven form modules (J4c) ─────────────────────────────────────

Deno.test("the form modules turn the committed schema into typed controls", () => {
  assertEquals(OVERRIDES, {}, "schema-overrides.ts ships empty on purpose");
  const schema = loadConfigSchema();
  const node = resolveAt(schema, ["images", "formats"]);
  const spec = widgetFor(node, ["images", "formats"], false);
  assertEquals(spec.kind, "multi-select");
  assertEquals(itemSchema(node).enum, ["image/webp", "image/avif"]);
  assertEquals(branchFor(resolveAt(schema, ["csp"]), "strict").enum, ["strict"]);
  assertEquals(encode(spec, ["image/avif"]), [
    { name: "images.formats~n", value: "1" },
    { name: "images.formats[1]", value: "image/avif" },
  ]);
  assertEquals(decode(spec, encode(spec, ["image/avif"])), ["image/avif"]);
  assertStringIncludes(
    toHtml(renderWidget(spec, ["image/avif"], { csrf: "tok" })),
    'value="image/avif" checked',
  );
  assertStringIncludes(toHtml(control({ tag: "input", name: "x", value: "y" })), 'name="x"');
  assertEquals(readWidget(schema, "trailingSlash", "on"), true);
});

Deno.test("decodePatch walks the posted fields through the widget codec", () => {
  const form = new FormData();
  form.set("_csrf", "ignored");
  form.set("trailingSlash", "on");
  assertEquals(decodePatch(form, loadConfigSchema()), { trailingSlash: true });
  assertEquals(decodePatch(new FormData(), { type: "object" }), {});
});

Deno.test("the cron preview answers one block for one expression, never a panel", async () => {
  const h = await ui();
  try {
    const ask = (expr: string) =>
      fetch(`${h.base}/_ui/cron-preview?expr=${encodeURIComponent(expr)}`, { headers: h.headers });

    const ok = await ask("0 3 * * *");
    assertEquals(ok.status, 200);
    const body = await ok.text();
    assertStringIncludes(body, "data-cron-preview");
    // The reading is the server's own `describeCron`, which is why the live preview and the
    // saved page can never say different things about the same expression.
    assertStringIncludes(body, "every day at 03:00 UTC");
    assert(!body.includes('<section id="panel"'), "the preview is a block, not a panel");
    assert(!body.includes("<!doctype html>"), "the preview is not a whole document");

    // A malformed expression is refused in words, not described.
    assertStringIncludes(await (await ask("99 * * * *")).text(), "out of range");

    // An empty field has nothing true to say yet — which is not the same as an error.
    const empty = await (await ask("")).text();
    assert(!empty.includes("field-error"), "an empty expression is not an error");

    // `nextRuns` walks minute by minute to a one-year horizon, and this runs on a keystroke:
    // something far too long to be an expression must never be walked.
    assertStringIncludes(await (await ask("* ".repeat(200))).text(), "too long");
  } finally {
    await stop(h);
  }
});
