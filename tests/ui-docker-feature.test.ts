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
import { deriveCsrf, UI_COOKIE, UI_CSRF_FIELD, UI_CSRF_HEADER } from "../src/ui/security.ts";
import { dockerPanel } from "../src/ui/features/docker.ts";
import type { UiContext } from "../src/ui/html.ts";
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
  csrf: string;
}

async function ui(options: { readOnly?: boolean; spa?: boolean } = {}): Promise<Harness> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_docker_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  if (options.spa) {
    await Deno.writeTextFile(join(dir, "denext.config.ts"), `export default { mode: "spa" };\n`);
  }
  const server = await startUiServer({ dir, port: 0, readOnly: options.readOnly });
  return {
    server,
    dir,
    base: `http://127.0.0.1:${server.port}`,
    csrf: await deriveCsrf(server.token),
  };
}

async function stop(h: Harness): Promise<void> {
  await h.server.shutdown();
  await Deno.remove(h.dir, { recursive: true });
}

/** A `GET` past the token gate. */
function get(h: Harness, path: string): Promise<Response> {
  return fetch(`${h.base}${path}`, { headers: { cookie: `${UI_COOKIE}=${h.server.token}` } });
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
      cookie: `${UI_COOKIE}=${h.server.token}`,
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
      assertStringIncludes(body, `<option value="${detected}"  selected>`);
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
        cookie: `${UI_COOKIE}=${h.server.token}`,
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
      headers: { cookie: `${UI_COOKIE}=${h.server.token}`, accept: "text/html-fragment" },
    });
    const body = await res.text();
    assert(body.trimStart().startsWith('<section id="panel"'), body.slice(0, 80));
    assert(!body.includes("<!doctype html>"));
  } finally {
    await stop(h);
  }
});
