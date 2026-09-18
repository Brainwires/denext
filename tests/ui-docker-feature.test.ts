// `denext ui` → the `/docker` panel: auto-detected mode, the per-file diff preview, the
// sentinel-guarded write, the hand-edited refusal, input validation, read-only mode and the
// `/api/docker` JSON twin — plus the template module both the panel and `denext generate docker`
// render from.
//
// The panel is driven through the real loopback server (so it passes the same origin/token/CSRF
// chain a browser does) plus one direct handler call for the read-only branch.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startUiServer, type UiServer } from "../src/ui/server.ts";
import { UI_CSRF_FIELD, UI_CSRF_HEADER } from "../src/ui/security.ts";
import { uiHandshake } from "./helpers/ui-session.ts";
import { dockerPanel } from "../src/ui/features/docker.ts";
import type { UiContext } from "../src/ui/html.ts";
import { applyComposeEdits, readCompose } from "../src/build/compose-edit.ts";
import {
  detectDockerMode,
  DOCKER_SENTINEL,
  dockerPlan,
  isGeneratedDockerFile,
  renderCompose,
  renderDockerfile,
  renderDockerignore,
} from "../src/build/docker-template.ts";

const FILES = ["Dockerfile", "docker-compose.yml", ".dockerignore"] as const;

interface Harness {
  server: UiServer;
  base: string;
  dir: string;
  /** The session cookie the handshake minted (never the launch token). */
  cookie: string;
  /** The CSRF token derived from that cookie. */
  csrf: string;
}

async function ui(options: { readOnly?: boolean; spa?: boolean } = {}): Promise<Harness> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_docker_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  if (options.spa) {
    await Deno.writeTextFile(join(dir, "denext.config.ts"), `export default { mode: "spa" };\n`);
  }
  const server = await startUiServer({ dir, port: 0, readOnly: options.readOnly });
  const { cookie, csrf } = await uiHandshake(server);
  return { server, dir, base: `http://127.0.0.1:${server.port}`, cookie, csrf };
}

async function stop(h: Harness): Promise<void> {
  await h.server.shutdown();
  await Deno.remove(h.dir, { recursive: true });
}

/** A `GET` past the token gate. */
function get(h: Harness, path: string): Promise<Response> {
  return fetch(`${h.base}${path}`, { headers: { cookie: h.cookie } });
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

/** The three files' contents, keyed by name (`null` when absent). */
async function onDisk(dir: string): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const name of FILES) {
    try {
      out[name] = await Deno.readTextFile(join(dir, name));
    } catch {
      out[name] = null;
    }
  }
  return out;
}

// ── the template module ──────────────────────────────────────────────────────

Deno.test("every rendered Docker file carries the sentinel, and options flow into all three", () => {
  for (
    const text of [
      renderDockerfile({ mode: "server" }),
      renderDockerfile({ mode: "static" }),
      renderCompose({ mode: "server" }),
      renderDockerignore(),
    ]
  ) {
    assertStringIncludes(text, DOCKER_SENTINEL);
    assert(isGeneratedDockerFile(text));
  }
  assertEquals(isGeneratedDockerFile("# mine\nFROM scratch\n"), false);

  // Defaults render today's files: the bare `deno task start`, port 3000, the pinned version.
  const server = renderDockerfile({ mode: "server" });
  assertStringIncludes(server, `FROM denoland/deno:${Deno.version.deno}`);
  assertStringIncludes(server, `CMD ["deno", "task", "start"]`);
  assertStringIncludes(server, "EXPOSE 3000");

  // Options: port, tag and Postgres.
  const tuned = renderDockerfile({ mode: "server", port: 8080, denoTag: "2.5.1" });
  assertStringIncludes(tuned, "FROM denoland/deno:2.5.1");
  assertStringIncludes(tuned, "EXPOSE 8080");
  assertStringIncludes(tuned, `CMD ["deno", "task", "start", "--", "--port", "8080"]`);
  const spa = renderDockerfile({ mode: "static", port: 8080 });
  assertStringIncludes(spa, "RUN deno task export");
  assertStringIncludes(spa, `"--port", "8080"`);
});

Deno.test("the compose file's Postgres service is commented out unless it is asked for", () => {
  const off = renderCompose({ mode: "server" });
  assertStringIncludes(off, `      - "3000:3000"`);
  assertStringIncludes(off, "  # Example Postgres service");
  assertStringIncludes(off, "  #   image: postgres:16-alpine");
  assertStringIncludes(off, "# volumes:");
  assert(!off.includes("DATABASE_URL="), "no DATABASE_URL until Postgres is switched on");

  const on = renderCompose({ mode: "server", port: 8080, postgres: true });
  assertStringIncludes(on, `      - "8080:8080"`);
  assertStringIncludes(on, "  db:\n    image: postgres:16-alpine");
  assertStringIncludes(on, "      - DATABASE_URL=postgres://denext:denext@db:5432/denext");
  assertStringIncludes(
    on,
    `      - "127.0.0.1:5432:5432"`,
    "the database is published to loopback, not to every interface the host is on",
  );
  assert(!on.includes(`- "5432:5432"`), "no all-interfaces publish for postgres");
  assertStringIncludes(off, `  #     - "127.0.0.1:5432:5432"`, "the example is bound too");
  assertStringIncludes(on, "    depends_on:\n      - db");
  assertStringIncludes(on, "volumes:\n  denext-db:");
  assert(!on.includes("# Example Postgres service"), "the example is replaced, not duplicated");
});

Deno.test("dockerPlan reports each file's on-disk state", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_docker_plan_" });
  try {
    const fresh = await dockerPlan(dir, { mode: "server" });
    assertEquals(fresh.map((f) => f.generated), [false, false, false]);
    assertEquals(fresh.map((f) => f.existing), [undefined, undefined, undefined]);

    await Deno.writeTextFile(join(dir, "Dockerfile"), renderDockerfile({ mode: "server" }));
    await Deno.writeTextFile(join(dir, "docker-compose.yml"), "# mine\n");
    const second = await dockerPlan(dir, { mode: "server" });
    assertEquals(second.map((f) => f.generated), [true, false, false]);
    assertEquals(second[1].existing, "# mine\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── the panel ────────────────────────────────────────────────────────────────

Deno.test("the panel prefills the mode detectDockerMode picks, for a server and a SPA project", async () => {
  for (const spa of [false, true]) {
    const h = await ui({ spa });
    try {
      const detected = await detectDockerMode(h.dir);
      assertEquals(detected, spa ? "static" : "server");
      const body = await (await get(h, "/docker")).text();
      assertStringIncludes(body, `<option value="${detected}" selected>`);
      assert(!body.includes("Not implemented yet"), "the stub is gone");
      assert(!body.includes("<script>"), "no inline script");
      assertStringIncludes(body, `name="${UI_CSRF_FIELD}"`);
      assertStringIncludes(body, 'name="op" value="preview"');
      assertStringIncludes(body, 'name="confirm" value="1"');
      for (const name of FILES) assertStringIncludes(body, `<code>${name}</code>`);
      assertStringIncludes(body, "not present — will be created");

      const payload = await (await get(h, "/api/docker")).json();
      assertEquals(payload.ok, true);
      assertEquals(payload.mode, detected);
      assertEquals(payload.files.map((f: { path: string }) => f.path), [...FILES]);
      assertEquals(payload.files.map((f: { state: string }) => f.state), [
        "absent",
        "absent",
        "absent",
      ]);
    } finally {
      await stop(h);
    }
  }
});

Deno.test("preview diffs all three files as new, and writes nothing", async () => {
  const h = await ui();
  try {
    const res = await post(h, "/docker", { mode: "server", op: "preview" });
    assertEquals(res.status, 200);
    const body = await res.text();
    assertStringIncludes(body, "Preview");
    for (const name of FILES) assertStringIncludes(body, `--- ${name}`);
    assertStringIncludes(body, "will be created");
    assertStringIncludes(body, "+FROM denoland/deno:");
    assertEquals(await onDisk(h.dir), {
      ...{},
      ...Object.fromEntries(FILES.map((f) => [f, null])),
    });

    const payload = await (await post(h, "/api/docker", { mode: "server", op: "preview" })).json();
    assertEquals(payload.ok, true);
    assertEquals(payload.mode, "server");
    assertEquals(payload.written, undefined, "a preview never reports writes");
    for (const file of payload.files) {
      assertEquals(file.state, "absent");
      assertStringIncludes(file.diff, "@@ -0,0 +1,");
    }
  } finally {
    await stop(h);
  }
});

Deno.test("a write creates all three files with the sentinel and redirects to the result", async () => {
  const h = await ui();
  try {
    const res = await post(h, "/docker", { mode: "server", confirm: "1" });
    assertEquals(res.status, 303);
    await res.body?.cancel();
    const location = res.headers.get("location") ?? "";
    assertStringIncludes(location, "/docker?");
    assertStringIncludes(decodeURIComponent(location), "w=Dockerfile");

    const files = await onDisk(h.dir);
    for (const name of FILES) {
      assert(files[name] !== null, name);
      assert(isGeneratedDockerFile(files[name] as string), `${name} carries the sentinel`);
    }
    assertStringIncludes(files["Dockerfile"] as string, "RUN deno task build");

    // The redirect target reports the write and now shows every file as regenerable.
    const page = await (await get(h, location)).text();
    assertStringIncludes(page, "Result");
    assertStringIncludes(page, "generated — safe to regenerate");
  } finally {
    await stop(h);
  }
});

Deno.test("a second write with a new port regenerates the files and carries the port everywhere", async () => {
  const h = await ui();
  try {
    await post(h, "/docker", { mode: "server", confirm: "1" });
    const res = await post(h, "/docker", { mode: "server", port: "8080", confirm: "1" });
    assertEquals(res.status, 303);
    await res.body?.cancel();

    const files = await onDisk(h.dir);
    const dockerfile = files["Dockerfile"] as string;
    assertStringIncludes(dockerfile, "EXPOSE 8080");
    assertStringIncludes(dockerfile, `CMD ["deno", "task", "start", "--", "--port", "8080"]`);
    assertStringIncludes(files["docker-compose.yml"] as string, `      - "8080:8080"`);
    assert(!dockerfile.includes("EXPOSE 3000"), "the old port is gone");

    // And the Postgres toggle lands in the same regeneration.
    await post(h, "/docker", { mode: "server", port: "8080", postgres: "on", confirm: "1" });
    const compose = await Deno.readTextFile(join(h.dir, "docker-compose.yml"));
    assertStringIncludes(compose, "  db:\n    image: postgres:16-alpine");
  } finally {
    await stop(h);
  }
});

Deno.test("a hand-edited file is refused, with its diff still shown", async () => {
  const h = await ui();
  try {
    await post(h, "/docker", { mode: "server", confirm: "1" });
    const mine = '# my own image\nFROM denoland/deno:2.0.0\nCMD ["deno", "task", "start"]\n';
    await Deno.writeTextFile(join(h.dir, "Dockerfile"), mine);

    // The preview flags it and still hands over the diff to copy.
    const preview = await (await post(h, "/docker", { mode: "server", op: "preview" })).text();
    assertStringIncludes(preview, "hand-edited — will not be overwritten");
    assertStringIncludes(preview, "will not overwrite — copy the diff");
    assertStringIncludes(preview, "-FROM denoland/deno:2.0.0");

    // The write leaves it alone and regenerates only the sentinel-bearing files.
    const payload = await (await post(h, "/api/docker", {
      mode: "server",
      port: "4000",
      confirm: "1",
    })).json();
    assertEquals(payload.ok, true);
    assertEquals(payload.refused, ["Dockerfile"]);
    assertEquals(payload.written, ["docker-compose.yml", ".dockerignore"]);
    assertEquals(payload.files[0].state, "edited");
    assertEquals(await Deno.readTextFile(join(h.dir, "Dockerfile")), mine);
    assertStringIncludes(
      await Deno.readTextFile(join(h.dir, "docker-compose.yml")),
      `      - "4000:4000"`,
    );
  } finally {
    await stop(h);
  }
});

Deno.test("an invalid port, tag or mode is a 400 and nothing is written", async () => {
  const h = await ui();
  try {
    const cases: [Record<string, string>, string][] = [
      [{ mode: "server", port: "70000" }, "invalid port"],
      [{ mode: "server", port: "80.5" }, "invalid port"],
      [{ mode: "server", tag: "2.5.1; rm -rf /" }, "invalid Deno tag"],
      [{ mode: "kubernetes" }, "unknown mode"],
    ];
    for (const [fields, reason] of cases) {
      const res = await post(h, "/api/docker", { ...fields, confirm: "1" });
      assertEquals(res.status, 400, reason);
      const payload = await res.json();
      assertEquals(payload.ok, false);
      assertStringIncludes(payload.reason, reason);
    }
    // The HTML panel says so against the form instead of failing the request.
    const page = await post(h, "/docker", { mode: "server", port: "0", op: "preview" });
    assertEquals(page.status, 400);
    assertStringIncludes(await page.text(), "invalid port");

    assertEquals(await onDisk(h.dir), Object.fromEntries(FILES.map((f) => [f, null])));
  } finally {
    await stop(h);
  }
});

Deno.test("--read-only refuses the write and says so on the page", async () => {
  const h = await ui({ readOnly: true });
  try {
    const refused = await post(h, "/api/docker", { mode: "server", confirm: "1" });
    assertEquals(refused.status, 403);
    assertEquals((await refused.json()).reason, "read-only");
    assertEquals(await onDisk(h.dir), Object.fromEntries(FILES.map((f) => [f, null])));

    const page = await (await get(h, "/docker")).text();
    assertStringIncludes(page, "Read-only mode");
    assertStringIncludes(page, 'value="1" class="ghost" disabled');

    // The kernel refuses every POST in read-only mode, preview included — the panel is still
    // fully readable, it just cannot be submitted.
    const preview = await post(h, "/docker", { mode: "server", op: "preview" });
    assertEquals(preview.status, 403);
    assertStringIncludes(page, "Current files");
  } finally {
    await stop(h);
  }
});

Deno.test("the handler itself refuses a write in read-only mode (403, no write)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_docker_ro_" });
  try {
    const form = new FormData();
    form.set("mode", "server");
    form.set("confirm", "1");
    const ctx: UiContext = {
      dir,
      url: new URL("http://127.0.0.1/api/docker"),
      method: "POST",
      readOnly: true,
      csrf: "csrf",
      json: true,
      fragment: false,
      form,
      events: new Set(),
    };
    const res = await dockerPanel(new Request("http://127.0.0.1/api/docker"), ctx);
    assertEquals(res.status, 403);
    assertEquals((await res.json()).reason, "read-only");
    assertEquals(await onDisk(dir), Object.fromEntries(FILES.map((f) => [f, null])));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the JSON twin accepts a JSON body and answers the documented shape", async () => {
  const h = await ui({ spa: true });
  try {
    const res = await fetch(`${h.base}/api/docker`, {
      method: "POST",
      headers: {
        cookie: h.cookie,
        origin: h.base,
        [UI_CSRF_HEADER]: h.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ port: 9000, postgres: true, confirm: "1" }),
    });
    const payload = await res.json();
    assertEquals(Object.keys(payload).sort(), ["files", "mode", "ok", "refused", "written"]);
    assertEquals(payload.ok, true);
    assertEquals(payload.mode, "static", "an empty mode auto-detects the SPA config");
    assertEquals(payload.written, [...FILES]);
    assertEquals(payload.refused, []);
    assertEquals(payload.files.length, 3);
    const dockerfile = await Deno.readTextFile(join(h.dir, "Dockerfile"));
    assertStringIncludes(dockerfile, "RUN deno task export");
    assertStringIncludes(dockerfile, `"--port", "9000"`);
  } finally {
    await stop(h);
  }
});

Deno.test("a fragment request returns only the panel section ui.js swaps", async () => {
  const h = await ui();
  try {
    const res = await fetch(`${h.base}/docker`, {
      headers: { cookie: h.cookie, accept: "text/html-fragment" },
    });
    const body = await res.text();
    assert(body.trimStart().startsWith('<section id="panel"'), body.slice(0, 80));
    assert(!body.includes("<!doctype html>"));
  } finally {
    await stop(h);
  }
});

// ── the compose editor ───────────────────────────────────────────────────────

const COMPOSE = "docker-compose.yml";
const GENERATED = renderCompose({ mode: "server" });

/** A hand-written compose file the editor can follow (no sentinel). */
const HAND = `# my stack
services:
  api:
    image: nginx:1.27 # pinned
    restart: always
    environment:
      LOG: info
  cache:
    image: redis:7
`;

/** A compose file the editor cannot follow (an anchor + a merge key). */
const ANCHORED = "x-base: &base\n  image: nginx\nservices:\n  web:\n    <<: *base\n";
/** Two YAML documents in one file — a shape the editor cannot follow. */
const OPAQUE = "services:\n  web:\n    image: a\n---\nservices:\n  b:\n    image: y\n";

/** The compose file on disk. */
function composeOnDisk(h: Harness): Promise<string> {
  return Deno.readTextFile(join(h.dir, COMPOSE));
}

/** A JSON-body `POST` past every gate. */
function postJson(h: Harness, path: string, body: unknown): Promise<Response> {
  return fetch(`${h.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: h.cookie,
      origin: h.base,
      [UI_CSRF_HEADER]: h.csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** The `_base` stamp the page is rendered with (from the JSON twin). */
async function baseOf(h: Harness): Promise<string> {
  return (await (await get(h, "/api/docker")).json()).base;
}

/** The named references the component renderer writes (`&#39;` and the rest stay numeric). */
const NAMED_ENTITIES: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">" };

/** The hidden fields of the form that carries `ops` (the preview's confirm form), decoded. */
function confirmFields(markup: string): Record<string, string> {
  const form = /<form[^>]*>(?:(?!<\/form>)[\s\S])*name="ops"[\s\S]*?<\/form>/.exec(markup);
  assert(form, "the preview carries a confirm form");
  const decode = (text: string) =>
    text.replace(
      /&(#\d+|quot|amp|lt|gt);/g,
      (_, ref: string) =>
        ref.startsWith("#") ? String.fromCharCode(Number(ref.slice(1))) : NAMED_ENTITIES[ref],
    );
  const fields: Record<string, string> = {};
  for (const input of form[0].match(/<input\b[^>]*>/g) ?? []) {
    const name = /\bname="([^"]*)"/.exec(input)?.[1];
    const value = /\bvalue="([^"]*)"/.exec(input)?.[1];
    if (name !== undefined && value !== undefined) fields[decode(name)] = decode(value);
  }
  return fields;
}

/** Preview one service-form submit (as a browser posts it) and return the page. */
async function previewEdit(h: Harness, fields: Record<string, string>): Promise<string> {
  const res = await post(h, "/docker", { editor: "compose", _base: await baseOf(h), ...fields });
  assertEquals(res.status, 200);
  return await res.text();
}

Deno.test("compose editor: a generated file lists every service in source order, editable", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, COMPOSE), GENERATED);
    const body = await (await get(h, "/docker?tab=services")).text();
    assertStringIncludes(body, "Edit docker-compose.yml");
    const web = body.indexOf('id="compose-web"');
    const db = body.indexOf('id="compose-db"');
    assert(web > 0 && db > web, "one form per service, in source order");
    assertStringIncludes(body, 'name="editor" type="hidden" value="compose"');
    assertStringIncludes(
      body,
      '<input name="port.0" aria-label="Port mapping 1" type="text" value="3000:3000">',
    );
    assertStringIncludes(
      body,
      '<input name="env.0" aria-label="Value of NODE_ENV" type="text" value="production">',
    );
    assertStringIncludes(body, '<option value="unless-stopped" selected>');
    assertStringIncludes(body, "commented out · line");
    assertStringIncludes(body, 'value="toggle"');
    assertStringIncludes(body, 'value="remove:0:ports"');
    assertStringIncludes(body, "still carries the generated-file header");

    const payload = await (await get(h, "/api/docker")).json();
    assertEquals(payload.files[1].state, "generated");
    assertEquals(
      payload.model.services.map((s: { name: string; commented: boolean }) => [
        s.name,
        s.commented,
      ]),
      [["web", false], ["db", true]],
    );
    assert(/^[0-9a-f]{64}$/.test(payload.base), payload.base);
  } finally {
    await stop(h);
  }
});

Deno.test("compose editor: a hand-written file without the sentinel is 'edited' and editable", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, COMPOSE), HAND);
    const payload = await (await get(h, "/api/docker")).json();
    assertEquals(payload.files[1].state, "edited");
    assertEquals(payload.model.sentinel, false);

    const body = await (await get(h, "/docker?tab=services")).text();
    assertStringIncludes(body, 'id="compose-api"');
    assertStringIncludes(body, 'id="compose-cache"');
    assertStringIncludes(body, '<option value="always" selected>always</option>');
    assertStringIncludes(body, '<option value="cache">cache</option>', "depends_on offers peers");
    assertStringIncludes(body, "environment (map form)");
    assert(!body.includes("generated-file header"), "no regeneration warning without a sentinel");
  } finally {
    await stop(h);
  }
});

Deno.test("compose editor: an opaque file is read-only with the regeneration diff; edits are 400", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, COMPOSE), OPAQUE);
    const payload = await (await get(h, "/api/docker")).json();
    assertEquals(payload.files[1].state, "opaque");
    assertEquals(payload.model, null);

    // The file's STATE is a Files-tab badge; the reason the editor bailed belongs with the
    // editor, under Services. An opaque file has to say both, on the view that owns each.
    const files = await (await get(h, "/docker")).text();
    assertStringIncludes(
      files,
      "YAML the editor cannot follow — read-only, will not be overwritten",
    );

    const body = await (await get(h, "/docker?tab=services")).text();
    assertStringIncludes(body, "cannot follow it line by line: the file does not parse");
    assertStringIncludes(body, "Regeneration diff");
    assertStringIncludes(body, `+${DOCKER_SENTINEL}`);
    assert(!body.includes('id="compose-web"'), "no edit form for an opaque file");

    const res = await post(h, "/docker", {
      editor: "compose",
      service: "web",
      op: "apply",
      "port.new": "1:1",
    });
    assertEquals(res.status, 400);
    assertStringIncludes(await res.text(), "cannot follow");
    const json = await postJson(h, "/api/docker", {
      editor: "compose",
      ops: [{ op: "toggleService", service: "web" }],
    });
    assertEquals(json.status, 400);
    assertEquals((await json.json()).ok, false);
    assertEquals(await composeOnDisk(h), OPAQUE);
  } finally {
    await stop(h);
  }
});

Deno.test("compose editor: a long-syntax port's keys and a dependency's condition post through", async () => {
  const h = await ui();
  try {
    const text = "services:\n  web:\n    image: x\n    ports:\n      - target: 80\n" +
      '        published: "8080"\n    depends_on:\n      - db\n  db:\n    image: pg\n';
    await Deno.writeTextFile(join(h.dir, COMPOSE), text);
    const body = await (await get(h, "/docker?tab=services")).text();
    assertStringIncludes(body, 'name="port.0.published"');
    assertStringIncludes(body, 'name="dep.0.condition"');
    const res = await post(h, "/docker", {
      editor: "compose",
      service: "web",
      op: "apply",
      "port.0.target": "80",
      "port.0.published": "9090",
      "dep.0.condition": "service_healthy",
    });
    assertEquals(res.status, 200);
    const preview = await res.text();
    assertStringIncludes(preview, "9090");
    assertStringIncludes(preview, "condition: service_healthy");
    const bad = await postJson(h, "/api/docker", {
      editor: "compose",
      ops: [{ op: "entry", service: "web", field: "ports", index: 0, key: "target", value: "x" }],
    });
    assertEquals(bad.status, 400);
    assertStringIncludes((await bad.json()).reason, "target needs a integer value");
    const json = await postJson(h, "/api/docker", {
      editor: "compose",
      ops: [
        { op: "entry", service: "web", field: "ports", index: 0, key: "published", value: "9090" },
        { op: "condition", service: "web", value: "db", condition: "service_healthy" },
      ],
      confirm: true,
    });
    assertEquals(json.status, 200);
    const disk = await composeOnDisk(h);
    assertStringIncludes(disk, '        published: "9090"\n');
    assertStringIncludes(disk, "      db:\n        condition: service_healthy\n");
  } finally {
    await stop(h);
  }
});

Deno.test("compose editor: services are added and removed, and names declared, through the forms", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, COMPOSE), GENERATED);
    // Adding a service and declaring a name are two different views now: a service is added
    // beside the services it joins, a volume/network is declared where every one of them is.
    const page = await (await get(h, "/docker?tab=services")).text();
    assertStringIncludes(page, 'id="compose-new-service"');
    assertStringIncludes(page, 'name="build.dockerfile"');
    const names = await (await get(h, "/docker?tab=names")).text();
    assertStringIncludes(names, 'id="compose-declarations"');
    const added = await previewEdit(h, {
      op: "addService",
      "new.name": "cache",
      "new.image": "redis:7",
    });
    assertStringIncludes(added, "+  cache:");
    assertEquals(JSON.parse(confirmFields(added).ops), [
      { op: "addService", service: "cache", image: "redis:7" },
    ]);
    const declared = await previewEdit(h, {
      scope: "top",
      op: "apply",
      "declare.volumes.new": "data",
    });
    assertStringIncludes(declared, "+volumes:");
    assertStringIncludes(declared, "+  data:");
    const built = await previewEdit(h, {
      service: "web",
      op: "apply",
      "build.dockerfile": "Dockerfile.prod",
    });
    assertStringIncludes(built, "+      dockerfile: Dockerfile.prod");
    // Every operation is checked against the file as it stands, so a service is added and
    // removed in two requests, not one.
    const json = await postJson(h, "/api/docker", {
      editor: "compose",
      ops: [
        { op: "addService", service: "cache", image: "redis:7" },
        { op: "declare", kind: "networks", action: "add", name: "backend" },
      ],
      confirm: true,
    });
    assertEquals(json.status, 200);
    assertStringIncludes(await composeOnDisk(h), "networks:\n  backend:\n");
    const dropped = await postJson(h, "/api/docker", {
      editor: "compose",
      ops: [{ op: "removeService", service: "cache" }],
      confirm: true,
    });
    assertEquals(dropped.status, 200);
    const disk = await composeOnDisk(h);
    assertStringIncludes(disk, "networks:\n  backend:\n");
    assert(!disk.includes("cache:"), "the added service was removed again");
    const refused = await postJson(h, "/api/docker", {
      editor: "compose",
      ops: [{ op: "declare", kind: "volumes", action: "remove", name: "nope" }],
    });
    assertEquals(refused.status, 400);
  } finally {
    await stop(h);
  }
});

Deno.test("compose editor: a merge key's fields are shown as inherited, and a set overrides them", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, COMPOSE), ANCHORED);
    const body = await (await get(h, "/docker?tab=services")).text();
    assertStringIncludes(body, 'id="compose-web"');
    assertStringIncludes(body, "takes image from its merge key (&lt;&lt;)");
    const json = await postJson(h, "/api/docker", {
      editor: "compose",
      ops: [{ op: "set", service: "web", field: "image", value: "caddy" }],
      confirm: true,
    });
    assertEquals(json.status, 200);
    assertEquals((await json.json()).model.services[0].image, "caddy");
    assertEquals(
      await composeOnDisk(h),
      "x-base: &base\n  image: nginx\nservices:\n  web:\n    image: caddy\n    <<: *base\n",
    );
  } finally {
    await stop(h);
  }
});

Deno.test("compose editor: adding a port previews a diff and writes nothing", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, COMPOSE), GENERATED);
    const body = await previewEdit(h, {
      service: "web",
      op: "apply",
      image: "",
      restart: "unless-stopped",
      "port.0": "3000:3000",
      "env.0": "production",
      "port.new": "9229:9229",
    });
    assertStringIncludes(body, "Nothing has been written yet");
    assertStringIncludes(body, "+      - &quot;9229:9229&quot;");
    assertStringIncludes(body, "Write docker-compose.yml");
    assertEquals(JSON.parse(confirmFields(body).ops), [
      { op: "ports", service: "web", action: "add", value: "9229:9229" },
    ]);
    assertEquals(await composeOnDisk(h), GENERATED);
  } finally {
    await stop(h);
  }
});

Deno.test("compose editor: confirm writes exactly the previewed change, every other byte kept", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, COMPOSE), GENERATED);
    const preview = await previewEdit(h, { service: "web", op: "apply", "port.new": "9229:9229" });
    const res = await post(h, "/docker", confirmFields(preview));
    assertEquals(res.status, 303);
    await res.body?.cancel();
    assertEquals(res.headers.get("location"), "/docker?tab=services&saved=compose");

    const after = await composeOnDisk(h);
    const expected = applyComposeEdits(GENERATED, [
      { op: "ports", service: "web", action: "add", value: "9229:9229" },
    ]);
    assert(expected.ok);
    assertEquals(after, expected.source);
    const lines = after.split("\n");
    const added = lines.indexOf('      - "9229:9229"');
    assertEquals(lines[added - 1], '      - "3000:3000"');
    lines.splice(added, 1);
    assertEquals(lines.join("\n"), GENERATED, "comments and the db example are byte-identical");

    const page = await (await get(h, "/docker?saved=compose")).text();
    assertStringIncludes(page, "Saved docker-compose.yml.");
  } finally {
    await stop(h);
  }
});

Deno.test("compose editor: env edits keep the list form; a row's ✕ removes just that row", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, COMPOSE), GENERATED);
    const preview = await previewEdit(h, {
      service: "web",
      op: "apply",
      "env.0": "development",
      "env.new.key": "DEBUG",
      "env.new.value": "1",
    });
    await (await post(h, "/docker", confirmFields(preview))).body?.cancel();
    const after = await composeOnDisk(h);
    assertStringIncludes(
      after,
      "    environment:\n      - NODE_ENV=development\n      - DEBUG=1\n",
    );
    assertEquals(readCompose(after)?.services[0].envForm, "list");

    // The ✕ button posts `remove:<row>:<list>` — a real submit, no JavaScript needed.
    const removal = await previewEdit(h, { service: "web", op: "remove:1:environment" });
    assertStringIncludes(removal, "-      - DEBUG=1");
    assertEquals(JSON.parse(confirmFields(removal).ops), [
      { op: "env", service: "web", action: "delete", key: "DEBUG" },
    ]);
  } finally {
    await stop(h);
  }
});

Deno.test("compose editor: enabling the commented db service warns about its undeclared volume", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, COMPOSE), GENERATED);
    const preview = await previewEdit(h, { service: "db", op: "toggle" });
    assertStringIncludes(preview, "+  db:");
    assertStringIncludes(preview, "named volume &quot;denext-db&quot;");
    const res = await post(h, "/docker", confirmFields(preview));
    assertEquals(res.status, 303);
    await res.body?.cancel();

    const after = await composeOnDisk(h);
    assertStringIncludes(after, "  db:\n    image: postgres:16-alpine\n");
    assertStringIncludes(
      after,
      "# volumes:\n#   denext-db:",
      "the top-level volume stays commented",
    );
    const model = readCompose(after);
    assertEquals(model?.services.map((s) => s.commented), [false, false]);
    const page = await (await get(h, "/docker?tab=services")).text();
    assertStringIncludes(page, "named volume &quot;denext-db&quot;");
  } finally {
    await stop(h);
  }
});

Deno.test("compose editor: a file changed between preview and confirm is refused (409), untouched", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, COMPOSE), GENERATED);
    const preview = await previewEdit(h, { service: "web", op: "apply", "port.new": "9229:9229" });
    const touched = GENERATED + "# edited in another window\n";
    await Deno.writeTextFile(join(h.dir, COMPOSE), touched);
    const res = await post(h, "/docker", confirmFields(preview));
    assertEquals(res.status, 409);
    assertStringIncludes(await res.text(), "changed on disk since this page was rendered");
    assertEquals(await composeOnDisk(h), touched);
  } finally {
    await stop(h);
  }
});

Deno.test("compose editor: a service, key or dependency the model did not report is a 400", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, COMPOSE), GENERATED);
    const res = await post(h, "/docker", {
      editor: "compose",
      service: "nope",
      op: "apply",
      "port.new": "1:1",
    });
    assertEquals(res.status, 400);
    assertStringIncludes(await res.text(), "unknown service");
    const cases: [unknown, string][] = [
      [{ op: "set", service: "ghost", field: "image", value: "x" }, "unknown service"],
      [{ op: "env", service: "web", action: "delete", key: "NOPE" }, "has no NOPE"],
      [{ op: "dependsOn", service: "web", action: "add", value: "ghost" }, "not another service"],
      [{ op: "ports", service: "web", action: "remove", index: 7 }, "no entry #7"],
      [{ op: "set", service: "web", field: "restart", value: "sometimes" }, "restart policy"],
      [{ op: "set", service: "db", field: "image", value: "x" }, "enable it first"],
      [{ op: "rm", service: "web" }, "unknown compose operation"],
    ];
    for (const [op, reason] of cases) {
      const reply = await postJson(h, "/api/docker", { editor: "compose", ops: [op] });
      assertEquals(reply.status, 400, reason);
      assertStringIncludes((await reply.json()).reason, reason);
    }
    assertEquals(await composeOnDisk(h), GENERATED);
  } finally {
    await stop(h);
  }
});

Deno.test("compose editor: --read-only refuses the confirm (403) and leaves the file untouched", async () => {
  const h = await ui({ readOnly: true });
  try {
    await Deno.writeTextFile(join(h.dir, COMPOSE), GENERATED);
    const ops = JSON.stringify([{ op: "ports", service: "web", action: "add", value: "1:1" }]);
    const res = await post(h, "/docker", { editor: "compose", ops, confirm: "1" });
    assertEquals(res.status, 403);
    await res.body?.cancel();
    const page = await (await get(h, "/docker?tab=services")).text();
    assertStringIncludes(page, "Read-only mode — editing is refused.");
    assertStringIncludes(page, 'name="op" value="apply" disabled');
  } finally {
    await stop(h);
  }
  // The handler refuses on its own, too (a context built by hand, past no kernel gate).
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_compose_ro_" });
  try {
    await Deno.writeTextFile(join(dir, COMPOSE), GENERATED);
    const form = new FormData();
    form.set("editor", "compose");
    form.set("ops", JSON.stringify([{ op: "toggleService", service: "db" }]));
    form.set("confirm", "1");
    const ctx: UiContext = {
      dir,
      url: new URL("http://127.0.0.1/api/docker"),
      method: "POST",
      readOnly: true,
      csrf: "csrf",
      json: true,
      fragment: false,
      form,
      events: new Set(),
    };
    const refused = await dockerPanel(new Request("http://127.0.0.1/api/docker"), ctx);
    assertEquals(refused.status, 403);
    assertEquals((await refused.json()).reason, "read-only");
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), GENERATED);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("compose editor: the JSON twin previews, then applies, and returns the model", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, COMPOSE), HAND);
    const ops = [
      { op: "set", service: "api", field: "image", value: "nginx:1.28" },
      { op: "dependsOn", service: "api", action: "add", value: "cache" },
    ];
    const preview = await (await postJson(h, "/api/docker", { editor: "compose", ops })).json();
    assertEquals(Object.keys(preview).sort(), [
      "applied",
      "base",
      "diff",
      "model",
      "ok",
      "warnings",
    ]);
    assertEquals([preview.ok, preview.applied], [true, false]);
    assertStringIncludes(preview.diff, "+    image: nginx:1.28 # pinned");
    assertEquals(preview.model.services[0].dependsOn, ["cache"]);
    assertEquals(await composeOnDisk(h), HAND, "a preview writes nothing");

    const applied = await (await postJson(h, "/api/docker", {
      editor: "compose",
      ops,
      base: preview.base,
      confirm: true,
    })).json();
    assertEquals([applied.ok, applied.applied], [true, true]);
    assertEquals(applied.model.services[0].image, "nginx:1.28");
    const after = await composeOnDisk(h);
    assertStringIncludes(after, "# my stack\n");
    assertStringIncludes(after, "    image: nginx:1.28 # pinned\n");
    assertStringIncludes(after, "    depends_on:\n      - cache\n");
  } finally {
    await stop(h);
  }
});

Deno.test("compose editor: a compose.yaml is found, edited in place, and named everywhere", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, "compose.yaml"), GENERATED);
    const preview = await previewEdit(h, { service: "web", op: "apply", "port.new": "9229:9229" });
    assertStringIncludes(preview, "Write compose.yaml");
    assertStringIncludes(preview, "a/compose.yaml");
    const res = await post(h, "/docker", confirmFields(preview));
    assertEquals(res.status, 303);
    await res.body?.cancel();
    assertStringIncludes(await Deno.readTextFile(join(h.dir, "compose.yaml")), '- "9229:9229"');
    const created = await Deno.stat(join(h.dir, COMPOSE)).then(() => true, () => false);
    assertEquals(created, false, "no docker-compose.yml appears next to it");
    const page = await (await get(h, "/docker?saved=compose")).text();
    assertStringIncludes(page, "Saved compose.yaml.");
  } finally {
    await stop(h);
  }
});

Deno.test("compose editor: with two compose files, compose.yaml wins, as it does for Docker Compose", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, "compose.yaml"), HAND);
    await Deno.writeTextFile(join(h.dir, COMPOSE), GENERATED);
    const page = await (await get(h, "/docker?tab=services")).text();
    assertStringIncludes(page, "Edit compose.yaml");
    assertStringIncludes(page, "redis:7");
  } finally {
    await stop(h);
  }
});

Deno.test("dockerPlan regenerates an existing compose.yml rather than adding a docker-compose.yml", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_docker_plan_" });
  try {
    await Deno.writeTextFile(join(dir, "compose.yml"), GENERATED);
    const plan = await dockerPlan(dir, { mode: "server" });
    assertEquals(plan.map((file) => file.path.slice(dir.length + 1)), [
      "Dockerfile",
      "compose.yml",
      ".dockerignore",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("compose editor: a build field and a network row post through; an undeclared network warns", async () => {
  const h = await ui();
  try {
    await Deno.writeTextFile(join(h.dir, COMPOSE), GENERATED);
    const page = await (await get(h, "/docker?tab=services")).text();
    assertStringIncludes(page, 'name="build"');
    assertStringIncludes(page, 'name="network.new"');
    const body = await previewEdit(h, {
      service: "web",
      op: "apply",
      build: "./app",
      "network.new": "backend",
    });
    assertStringIncludes(body, "+    networks:");
    assertStringIncludes(body, "+      - backend");
    assertStringIncludes(body, "does not declare it");
    assertEquals(JSON.parse(confirmFields(body).ops), [
      { op: "set", service: "web", field: "build", value: "./app" },
      { op: "networks", service: "web", action: "add", value: "backend" },
    ]);
  } finally {
    await stop(h);
  }
});

Deno.test("each Docker tab names itself in the title; a fragment still carries none", async () => {
  const h = await ui();
  try {
    // All three tabs of this one panel rendered "Docker · denext ui", so two of them open
    // side by side in a browser were indistinguishable.
    const titles: string[] = [];
    for (const tab of ["files", "services", "names"]) {
      const body = await (await get(h, `/docker?tab=${tab}`)).text();
      titles.push(/<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "");
    }
    assertEquals(titles, [
      "Docker · Files · denext ui",
      "Docker · Services · denext ui",
      "Docker · Names · denext ui",
    ]);

    // `ui.js` swaps one `<section>`: the per-view title must not turn that into a document.
    const fragment = await (await fetch(`${h.base}/docker?tab=services`, {
      headers: { cookie: h.cookie, accept: "text/html-fragment" },
    })).text();
    assert(
      !fragment.includes("<title>"),
      `a fragment must stay a section: ${fragment.slice(0, 90)}`,
    );
  } finally {
    await stop(h);
  }
});
