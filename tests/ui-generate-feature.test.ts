// `denext ui` → the `/generate` panel: the kind picker, the dry-run preview, the real write,
// the containment refusal, read-only mode, and the `/api/generate` JSON twin.
//
// The panel is driven through the real loopback server (so it passes the same origin/token/CSRF
// chain a browser does) plus one direct handler call for the read-only branch. `Deno.exit` is
// stubbed throughout: the UI must never take the server down the way the CLI verb does on bad
// input.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startUiServer, type UiServer } from "../src/ui/server.ts";
import { UI_CSRF_FIELD, UI_CSRF_HEADER } from "../src/ui/security.ts";
import { uiHandshake } from "./helpers/ui-session.ts";
import { generatePanel } from "../src/ui/features/generate.ts";
import type { UiContext } from "../src/ui/html.ts";
import { GENERATE_KINDS } from "../src/build/generate.ts";
import { stubExit } from "./_cli-coverage-helpers.ts";

interface Harness {
  server: UiServer;
  base: string;
  dir: string;
  /** The session cookie the handshake minted (never the launch token). */
  cookie: string;
  /** The CSRF token derived from that cookie. */
  csrf: string;
  exits: number[];
  restore: () => void;
}

async function ui(options: { readOnly?: boolean } = {}): Promise<Harness> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_gen_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  const server = await startUiServer({ dir, port: 0, readOnly: options.readOnly });
  const exit = stubExit();
  const { cookie, csrf } = await uiHandshake(server);
  return {
    server,
    dir,
    base: `http://127.0.0.1:${server.port}`,
    cookie,
    csrf,
    exits: exit.calls,
    restore: exit.restore,
  };
}

async function stop(h: Harness): Promise<void> {
  h.restore();
  await h.server.shutdown();
  await Deno.remove(h.dir, { recursive: true });
}

/** A `GET` past the token gate. */
function get(h: Harness, path: string, accept?: string): Promise<Response> {
  const headers: Record<string, string> = { cookie: h.cookie };
  if (accept) headers.accept = accept;
  return fetch(`${h.base}${path}`, { headers });
}

/** A `POST` past the origin + token + CSRF gates, as a browser form submit. */
function post(h: Harness, path: string, fields: Record<string, string>): Promise<Response> {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  body.set(UI_CSRF_FIELD, h.csrf);
  return fetch(`${h.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: h.cookie,
      origin: h.base,
      [UI_CSRF_HEADER]: h.csrf,
    },
    body,
  });
}

/** Whether `path` exists under the harness project. */
async function exists(h: Harness, path: string): Promise<boolean> {
  try {
    await Deno.stat(join(h.dir, path));
    return true;
  } catch {
    return false;
  }
}

Deno.test("the panel offers every generate kind, with the CSRF field and both submits", async () => {
  const h = await ui();
  try {
    const res = await get(h, "/generate");
    assertEquals(res.status, 200);
    const body = await res.text();
    assertEquals(GENERATE_KINDS.length, 13);
    for (const kind of GENERATE_KINDS) {
      assertStringIncludes(body, `<option value="${kind}"`, kind);
    }
    assertStringIncludes(body, `name="${UI_CSRF_FIELD}"`);
    assertStringIncludes(body, 'name="op" value="preview"');
    assertStringIncludes(body, 'name="op" value="apply"');
    assertStringIncludes(body, '<form method="post" action="/generate">');
    assert(!body.includes("Not implemented yet"), "the stub is gone");
    assert(!body.includes("<script>"), "no inline script");
    assertEquals(h.exits, []);
  } finally {
    await stop(h);
  }
});

Deno.test("GET /api/generate lists every kind with its lead and name requirement", async () => {
  const h = await ui();
  try {
    const payload = await (await get(h, "/api/generate")).json();
    assertEquals(payload.ok, true);
    assertEquals(payload.kinds.length, GENERATE_KINDS.length);
    assertEquals(payload.kinds.map((k: { kind: string }) => k.kind), [...GENERATE_KINDS]);
    for (const entry of payload.kinds) assert(entry.lead.length > 0, entry.kind);
    const byKind = Object.fromEntries(
      payload.kinds.map((k: { kind: string; needsName: boolean }) => [k.kind, k.needsName]),
    );
    assertEquals(byKind.page, true);
    assertEquals(byKind.component, true);
    assertEquals(byKind.docker, false);
    assertEquals(byKind.middleware, false);
  } finally {
    await stop(h);
  }
});

Deno.test("preview lists the planned paths and their contents, and writes nothing", async () => {
  const h = await ui();
  try {
    const res = await post(h, "/generate", { kind: "page", name: "dashboard", op: "preview" });
    assertEquals(res.status, 200);
    const body = await res.text();
    assertStringIncludes(body, "Preview");
    assertStringIncludes(body, "app/dashboard/page.tsx");
    assertStringIncludes(body, "would be written");
    // The file's real contents are shown, HTML-escaped.
    assertStringIncludes(body, "function DashboardPage(");
    assertStringIncludes(body, "&lt;section&gt;");
    assertEquals(await exists(h, "app/dashboard/page.tsx"), false, "preview touches no disk");
    assertEquals(h.exits, []);
  } finally {
    await stop(h);
  }
});

Deno.test("preview marks a file that already exists as skipped", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, "Dockerfile"), "# mine\n");
    const body = await (await post(h, "/generate", { kind: "docker", op: "preview" })).text();
    assertStringIncludes(body, "exists — would be skipped");
    assertStringIncludes(body, "docker-compose.yml");
    assertEquals(await Deno.readTextFile(join(h.dir, "Dockerfile")), "# mine\n");
    assertEquals(await exists(h, "docker-compose.yml"), false);
  } finally {
    await stop(h);
  }
});

Deno.test("apply writes the artifact and redirects to the result", async () => {
  const h = await ui();
  try {
    const res = await post(h, "/generate", { kind: "component", name: "UserCard", op: "apply" });
    assertEquals(res.status, 303);
    await res.body?.cancel();
    const location = res.headers.get("location") ?? "";
    assertStringIncludes(location, "/generate?");
    assertStringIncludes(decodeURIComponent(location), "w=components/UserCard.tsx");
    const written = await Deno.readTextFile(join(h.dir, "components/UserCard.tsx"));
    assertStringIncludes(written, "export function UserCard()");

    // The redirect target renders the result list without re-scaffolding.
    const page = await (await get(h, location)).text();
    assertStringIncludes(page, "Result");
    assertStringIncludes(page, "components/UserCard.tsx");
    assertEquals(h.exits, []);
  } finally {
    await stop(h);
  }
});

Deno.test("a fragment request returns only the panel section ui.js swaps", async () => {
  const h = await ui();
  try {
    const body = await (await get(h, "/generate", "text/html-fragment")).text();
    assert(body.trimStart().startsWith('<section id="panel"'), body.slice(0, 80));
    assert(!body.includes("<!doctype html>"));
  } finally {
    await stop(h);
  }
});

Deno.test("a name containing .. is refused with 400 and nothing is written", async () => {
  const h = await ui();
  const outside = join(h.dir, "..", "denext_ui_escape.tsx");
  try {
    for (const op of ["preview", "apply"]) {
      const res = await post(h, "/generate", { kind: "page", name: "../escape", op });
      assertEquals(res.status, 400, op);
      assertStringIncludes(await res.text(), "outside the project");
    }
    assertEquals(await exists(h, "app/escape"), false);
    let escaped = true;
    try {
      await Deno.stat(outside);
    } catch {
      escaped = false;
    }
    assertEquals(escaped, false, "nothing was written outside the project");
    assertEquals(h.exits, [], "a bad name never calls Deno.exit");
  } finally {
    await stop(h);
  }
});

Deno.test("an unknown kind and a missing name are 400s, not exits", async () => {
  const h = await ui();
  try {
    const unknown = await post(h, "/api/generate", { kind: "widget", name: "x", op: "preview" });
    assertEquals(unknown.status, 400);
    assertStringIncludes((await unknown.json()).reason, 'unknown kind "widget"');

    const missing = await post(h, "/api/generate", { kind: "component", name: "", op: "preview" });
    assertEquals(missing.status, 400);
    assertStringIncludes((await missing.json()).reason, "missing name");
    assertEquals(h.exits, []);
  } finally {
    await stop(h);
  }
});

Deno.test("the JSON twin answers { ok, written, skipped, preview } for both ops", async () => {
  const h = await ui();
  try {
    const preview = await (await post(h, "/api/generate", {
      kind: "api",
      name: "users",
      op: "preview",
    })).json();
    assertEquals(preview.ok, true);
    assertEquals(preview.written, ["app/users/route.ts"]);
    assertEquals(preview.skipped, []);
    assertEquals(preview.preview.length, 1);
    assertEquals(preview.preview[0].path, "app/users/route.ts");
    assertStringIncludes(preview.preview[0].contents, "export function GET(");
    assertEquals(await exists(h, "app/users/route.ts"), false);

    const applied = await (await post(h, "/api/generate", {
      kind: "api",
      name: "users",
      op: "apply",
    })).json();
    assertEquals(applied.ok, true);
    assertEquals(applied.written, ["app/users/route.ts"]);
    assertEquals(applied.preview, undefined, "a real write carries no preview");
    assertEquals(await exists(h, "app/users/route.ts"), true);

    const again = await (await post(h, "/api/generate", {
      kind: "api",
      name: "users",
      op: "apply",
    })).json();
    assertEquals(again.written, []);
    assertEquals(again.skipped, ["app/users/route.ts"], "the panel never overwrites");
    assertEquals(h.exits, []);
  } finally {
    await stop(h);
  }
});

Deno.test("the JSON twin accepts a JSON body as well as a form", async () => {
  const h = await ui();
  try {
    const res = await fetch(`${h.base}/api/generate`, {
      method: "POST",
      headers: {
        cookie: h.cookie,
        origin: h.base,
        [UI_CSRF_HEADER]: h.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "task", name: "cleanup", op: "preview" }),
    });
    const payload = await res.json();
    assertEquals(payload.ok, true);
    assertEquals(payload.preview[0].path, "tasks/cleanup.ts");
    assertStringIncludes(payload.preview[0].contents, "defineTask");
  } finally {
    await stop(h);
  }
});

Deno.test("--read-only refuses the write and says so on the page", async () => {
  const h = await ui({ readOnly: true });
  try {
    // The kernel stops the mutation before the feature — but the panel still renders the
    // read-only note and disables its write button.
    const refused = await post(h, "/api/generate", { kind: "page", name: "x", op: "apply" });
    assertEquals(refused.status, 403);
    assertEquals((await refused.json()).reason, "read-only");
    assertEquals(await exists(h, "app/x/page.tsx"), false);

    const page = await (await get(h, "/generate")).text();
    assertStringIncludes(page, "Read-only mode");
    assertStringIncludes(page, 'value="apply" class="ghost" disabled');
    assertEquals(h.exits, []);
  } finally {
    await stop(h);
  }
});

Deno.test("the handler itself refuses an apply in read-only mode (403, no write)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_gen_ro_" });
  const exit = stubExit();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    const form = new FormData();
    form.set("kind", "page");
    form.set("name", "x");
    form.set("op", "apply");
    const ctx: UiContext = {
      dir,
      url: new URL("http://127.0.0.1/api/generate"),
      method: "POST",
      readOnly: true,
      csrf: "csrf",
      json: true,
      fragment: false,
      form,
      events: new Set(),
    };
    const res = await generatePanel(new Request("http://127.0.0.1/api/generate"), ctx);
    assertEquals(res.status, 403);
    assertEquals((await res.json()).reason, "read-only");
    assertEquals(exit.calls, []);
  } finally {
    exit.restore();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── containment: the plan, not just the name ─────────────────────────────────

/** Whether an absolute path exists. */
async function onDisk(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A JSON-twin POST against the panel, with the kernel's context already assembled. */
function genPost(dir: string, fields: Record<string, string>): Promise<Response> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const ctx: UiContext = {
    dir,
    url: new URL("http://127.0.0.1/api/generate"),
    method: "POST",
    readOnly: false,
    csrf: "csrf",
    json: true,
    fragment: false,
    form,
    events: new Set(),
  };
  return generatePanel(new Request("http://127.0.0.1/api/generate"), ctx);
}

Deno.test("an `app/` that is a symlink out of the project refuses the write", async () => {
  const outside = await Deno.makeTempDir({ prefix: "denext_gen_out_" });
  const dir = await Deno.makeTempDir({ prefix: "denext_gen_link_" });
  const exit = stubExit();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.symlink(outside, join(dir, "app"));

    const res = await genPost(dir, { kind: "page", name: "pwned", op: "apply" });
    assertEquals(res.status, 400);
    assertStringIncludes((await res.json()).reason, "outside the project");
    assertEquals(await onDisk(join(outside, "pwned", "page.tsx")), false);

    // The preview is refused on the same plan, so nothing is even shown.
    const preview = await genPost(dir, { kind: "page", name: "pwned", op: "preview" });
    assertEquals(preview.status, 400);
    await preview.body?.cancel();
    assertEquals(exit.calls, []);
  } finally {
    exit.restore();
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("an absolute name is refused, not silently made relative", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_gen_abs_" });
  const exit = stubExit();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    const res = await genPost(dir, { kind: "page", name: "/etc/pwned", op: "preview" });
    assertEquals(res.status, 400);
    assertStringIncludes((await res.json()).reason, "absolute path");
    assertEquals(await onDisk(join(dir, "app", "etc")), false);
    assertEquals(exit.calls, []);
  } finally {
    exit.restore();
    await Deno.remove(dir, { recursive: true });
  }
});
