// The `denext ui` kernel: loopback binding, the asset routes, every feature route's HTML page
// and its `/api/*` JSON twin, the broadcast channel, task-name validation, clean shutdown — and
// the standing guarantee that the UI's module graph never reaches the bundler.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startUiServer, type UiServer } from "../src/ui/server.ts";
import { projectTasks, UI_ROUTES } from "../src/ui/routes.ts";
import { UI_COOKIE, UI_CSRF_HEADER } from "../src/ui/security.ts";
import { deriveCsrf } from "../src/ui/security.ts";
import { esc, html, raw, stubSection, toHtml, UI_NAV } from "../src/ui/html.ts";
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
  headers: Record<string, string>;
}

async function ui(): Promise<Harness> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_srv_" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    '{ "tasks": { "hello": "eval console.log(1)" } }',
  );
  const server = await startUiServer({ dir, port: 0 });
  return {
    server,
    dir,
    base: `http://127.0.0.1:${server.port}`,
    headers: { cookie: `${UI_COOKIE}=${server.token}` },
  };
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
    assertStringIncludes(h.server.url, `:${h.server.port}/?t=${h.server.token}`);
    assert(/^https?:\/\/(localhost|127\.0\.0\.1)/.test(h.server.url), h.server.url);
    assert(h.server.token.length >= 43, "the session token carries 256 bits of entropy");
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
    assertStringIncludes(await css.text(), "prefers-color-scheme");

    const js = await fetch(`${h.base}/_ui/ui.js`, { headers: h.headers });
    assertEquals(js.status, 200);
    assertStringIncludes(js.headers.get("content-type") ?? "", "javascript");
    const source = await js.text();
    assertStringIncludes(source, "DOMParser");
    assertStringIncludes(source, "/_ui/events");
    assert(!source.includes(".innerHTML ="), "untrusted text is never innerHTML'd");
  } finally {
    await stop(h);
  }
});

/** Feature panels not yet implemented — each ships as a 501 stub until its own job lands. */
const STILL_STUBBED = new Set(["/config", "/config/next", "/docker"]);

Deno.test("every feature route serves a page; the unfinished ones a placeholder + 501 JSON twin", async () => {
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
      const body = await page.text();
      assertStringIncludes(body, '<section id="panel"', path);
      if (!STILL_STUBBED.has(path)) continue;
      assertStringIncludes(body, "Not implemented yet", path);

      const api = await fetch(`${h.base}/api${path}`, { headers: h.headers });
      assertEquals(api.status, 501, `/api${path}`);
      const payload = await api.json();
      assertEquals(payload.ok, false, `/api${path}`);
      assertEquals(payload.reason, "not implemented", `/api${path}`);
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

Deno.test("/tasks/run refuses a task the project does not declare", async () => {
  const h = await ui();
  try {
    const form = new FormData();
    form.set("task", "rm -rf /");
    const res = await fetch(`${h.base}/tasks/run`, {
      method: "POST",
      headers: {
        ...h.headers,
        origin: h.base,
        [UI_CSRF_HEADER]: await deriveCsrf(h.server.token),
      },
      body: form,
    });
    assertEquals(res.status, 400);
    const payload = await res.json();
    assertEquals(payload.ok, false);
    assertStringIncludes(payload.reason, "unknown task");
    assertEquals(payload.tasks, ["hello"]);
  } finally {
    await stop(h);
  }
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

Deno.test("the UI module graph never reaches the bundler", async () => {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", "src/ui/server.ts"],
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
    .filter((s) => /esbuild|dev-server\/manifest|dev-unbundled/.test(s));
  assertEquals(
    forbidden,
    [],
    "denext ui must never load the bundler — everything runs as a subprocess (src/ui/proc.ts)",
  );
});

// ── the view layer ───────────────────────────────────────────────────────────

Deno.test("the html tag escapes interpolations and passes raw() through", () => {
  const name = '<img src=x onerror="alert(1)">';
  assertStringIncludes(toHtml(html`<p>${name}</p>`), "&#60;img");
  assertEquals(toHtml(html`<p>${raw("<b>ok</b>")}</p>`), "<p><b>ok</b></p>");
  assertEquals(toHtml(html`${null}${undefined}${false}`), "");
  assertEquals(toHtml(html`${[1, 2, 3]}`), "123");
  assertEquals(esc(`&<>"'`), "&#38;&#60;&#62;&#34;&#39;");
});

Deno.test("stubSection renders the swappable panel a feature stub answers with", () => {
  const markup = toHtml(stubSection({ title: "Docker", lead: "lead text", job: "J8" }));
  assertStringIncludes(markup, '<section id="panel"');
  assertStringIncludes(markup, "Docker");
  assertStringIncludes(markup, "lead text");
  assertStringIncludes(markup, "J8");
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
