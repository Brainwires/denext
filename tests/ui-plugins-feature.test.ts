// The `denext ui` plugin manager (`/plugins`, `/api/plugins`): the first-party catalog with this
// project's installed state, the diff preview every mutation goes through, the confirmed
// `deno add`/`deno remove` + config write, the honest bail on a config that cannot be spliced,
// and the refusals (unknown package, read-only).
//
// `deno add` / `deno remove` are stubbed through `setProcRunner`, so the suite never installs
// anything and never reaches the network.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startUiServer, type UiServer } from "../src/ui/server.ts";
import { deriveCsrf, UI_COOKIE, UI_CSRF_HEADER } from "../src/ui/security.ts";
import { setProcRunner } from "../src/ui/features/plugins.ts";
import type { ProcResult, RunDenoOptions } from "../src/ui/proc.ts";

/** The catalogued specs the tests exercise (kept in sync by tests/plugin-catalog.test.ts). */
const OPENAPI = "@denext/openapi";
const HTMX = "@denext/htmx";

interface Harness {
  server: UiServer;
  base: string;
  dir: string;
  csrf: string;
  ran: string[][];
}

/** A `denext.config.ts` wiring htmx, plus an import map pinning it. */
const WIRED_CONFIG = `import { htmx } from "@denext/htmx";

export default {
  plugins: [htmx()],
};
`;

async function ui(
  files: Record<string, string>,
  options: { readOnly?: boolean } = {},
): Promise<Harness> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_plugins_" });
  for (const [name, body] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, name), body);
  }
  const server = await startUiServer({ dir, port: 0, ...options });
  const ran: string[][] = [];
  setProcRunner((args: string[], opts: RunDenoOptions): Promise<ProcResult> => {
    ran.push(args);
    opts.onLine?.(`stub: deno ${args.join(" ")}`);
    return Promise.resolve({
      code: 0,
      stdout: `stubbed deno ${args[0]}\n`,
      stderr: "",
      json: () => null,
    });
  });
  return {
    server,
    dir,
    base: `http://127.0.0.1:${server.port}`,
    csrf: await deriveCsrf(server.token),
    ran,
  };
}

async function stop(h: Harness): Promise<void> {
  setProcRunner();
  await h.server.shutdown();
  await Deno.remove(h.dir, { recursive: true });
}

/** GET a UI path with the session cookie. */
function get(h: Harness, path: string, accept?: string): Promise<Response> {
  const headers: Record<string, string> = { cookie: `${UI_COOKIE}=${h.server.token}` };
  if (accept) headers.accept = accept;
  return fetch(`${h.base}${path}`, { headers });
}

/** POST a mutation with the session cookie, a same-origin `Origin` and the CSRF token. */
function post(
  h: Harness,
  path: string,
  fields: Record<string, string>,
  accept?: string,
): Promise<Response> {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const headers: Record<string, string> = {
    cookie: `${UI_COOKIE}=${h.server.token}`,
    origin: h.base,
    [UI_CSRF_HEADER]: h.csrf,
  };
  if (accept) headers.accept = accept;
  return fetch(`${h.base}${path}`, { method: "POST", headers, body, redirect: "manual" });
}

/** The project's config text. */
function config(h: Harness): Promise<string> {
  return Deno.readTextFile(join(h.dir, "denext.config.ts"));
}

/**
 * Markup with the renderer's named entity references decoded, so an assertion can quote text as
 * written. The component views emit `&quot;`/`&#39;`/`&lt;`/`&gt;` where the string views
 * emitted numeric ones (or none, for quotes in template text) — the same characters to a browser.
 */
function normaliseEntities(markup: string): string {
  return markup.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** One catalogue card's markup: from its anchor to the end of its `<article>`. */
function card(body: string, name: string): string {
  const start = body.indexOf(`id="${name}"`);
  return body.slice(start, body.indexOf("</article>", start));
}

Deno.test("the catalog renders in two groups with each package's installed state", async () => {
  const h = await ui({
    "denext.config.ts": WIRED_CONFIG,
    "deno.json": `{ "imports": { "@denext/htmx": "jsr:@denext/htmx@^2.0.11" } }`,
  });
  try {
    const body = await (await get(h, "/plugins")).text();
    assertStringIncludes(body, "<h2>Plugins</h2>");
    assertStringIncludes(body, "<h2>Libraries</h2>");
    assertStringIncludes(body, `id="${HTMX}"`);
    assertStringIncludes(body, `id="${OPENAPI}"`);
    assertStringIncludes(body, "https://denext.dev/docs/openapi");
    // htmx is wired and pinned → the row offers "Remove"; openapi is untouched → "Add".
    const htmxRow = body.slice(body.indexOf(`id="${HTMX}"`), body.indexOf(`id="${HTMX}"`) + 900);
    assertStringIncludes(htmxRow, "wired");
    assertStringIncludes(htmxRow, ">Remove<");
    const openapiRow = body.slice(
      body.indexOf(`id="${OPENAPI}"`),
      body.indexOf(`id="${OPENAPI}"`) + 900,
    );
    assertStringIncludes(openapiRow, "available");
    assertStringIncludes(openapiRow, ">Add<");
    // A wired plugin with an options schema links to its options sub-panel; an unwired one does not.
    assertStringIncludes(card(body, HTMX), `href="/plugins/options?name=%40denext%2Fhtmx"`);
    assert(!card(body, OPENAPI).includes("/plugins/options"), "openapi is not wired");
    assert(!body.includes("Not implemented yet"), "the panel is implemented");
  } finally {
    await stop(h);
  }
});

Deno.test("the JSON twin reports the catalog, the installed set and each row's state", async () => {
  const h = await ui({
    "denext.config.ts": WIRED_CONFIG,
    "deno.json": `{ "imports": { "@denext/htmx": "jsr:@denext/htmx@^2.0.11" } }`,
  });
  try {
    const res = await get(h, "/api/plugins");
    assertEquals(res.status, 200);
    const payload = await res.json();
    assertEquals(payload.ok, true);
    assertEquals(payload.config, "denext.config.ts");
    assertEquals(payload.installed, [HTMX]);
    assert(payload.catalog.length >= 12, `catalog has ${payload.catalog.length} rows`);
    const htmx = payload.catalog.find((row: { name: string }) => row.name === HTMX);
    assertEquals(htmx.wired, true);
    assertEquals(htmx.dependency, true);
    assertEquals(htmx.kind, "plugin");
    assertEquals(htmx.factory, "htmx");
    assertEquals(htmx.docs, "https://denext.dev/docs/htmx");
    assertStringIncludes(htmx.spec, "jsr:@denext/htmx@^");
    assertEquals(htmx.options, "/plugins/options?name=%40denext%2Fhtmx");
    const openapi = payload.catalog.find((row: { name: string }) => row.name === OPENAPI);
    assertEquals(openapi.wired, false);
    assertEquals(openapi.dependency, false);
    assertEquals(openapi.options, null);
    assertEquals(payload.jsr.query, "", "no search ran without ?q=");
  } finally {
    await stop(h);
  }
});

Deno.test("an add previews the diff and the command without touching disk", async () => {
  const h = await ui({ "denext.config.ts": WIRED_CONFIG });
  try {
    const res = await post(h, "/plugins", { name: OPENAPI, op: "add" });
    assertEquals(res.status, 200);
    const body = await res.text();
    assertStringIncludes(body, "deno add jsr:@denext/openapi@");
    assertStringIncludes(body, "+import { openapi } from ");
    assertStringIncludes(body, "openapi(), htmx()");
    assertStringIncludes(body, ">Apply<");
    assertEquals(await config(h), WIRED_CONFIG, "the preview writes nothing");
    assertEquals(h.ran, [], "the preview runs no subprocess");
  } finally {
    await stop(h);
  }
});

Deno.test("a confirmed add runs deno add and wires the config", async () => {
  const h = await ui({ "denext.config.ts": WIRED_CONFIG });
  try {
    const res = await post(h, "/plugins", { name: OPENAPI, op: "add", confirm: "1" });
    await res.body?.cancel();
    assertEquals(res.status, 303);
    assertEquals(res.headers.get("location"), `/plugins#${OPENAPI}`);
    assertEquals(h.ran.length, 1);
    assertEquals(h.ran[0][0], "add");
    assertStringIncludes(h.ran[0][1], "jsr:@denext/openapi@^");
    const source = await config(h);
    assertStringIncludes(source, `import { openapi } from "@denext/openapi";`);
    assertStringIncludes(source, "plugins: [openapi(), htmx()]");
  } finally {
    await stop(h);
  }
});

Deno.test("a confirmed add answered as a fragment shows the outcome — and a failed deno remove", async () => {
  const h = await ui({ "denext.config.ts": WIRED_CONFIG });
  try {
    const ok = await post(
      h,
      "/plugins",
      { name: OPENAPI, op: "add", confirm: "1" },
      "text/html-fragment",
    );
    assertEquals(ok.status, 200);
    const okText = await ok.text();
    assertStringIncludes(okText, `Added ${OPENAPI} and updated denext.config.ts.`);
    assertStringIncludes(okText, "stubbed deno add");

    setProcRunner((): Promise<ProcResult> =>
      Promise.resolve({ code: 1, stdout: "", stderr: "boom\n", json: () => null })
    );
    const failed = await post(
      h,
      "/plugins",
      { name: HTMX, op: "remove", confirm: "1" },
      "text/html-fragment",
    );
    const failedText = await failed.text();
    assertStringIncludes(failedText, "exited 1.");
    assert(!failedText.includes("Removed"), "a failed deno remove is not reported as done");
  } finally {
    await stop(h);
  }
});

Deno.test("a confirmed add creates denext.config.ts when the project has none", async () => {
  const h = await ui({ "deno.json": "{}" });
  try {
    const preview = await (await post(h, "/api/plugins", { name: OPENAPI, op: "add" })).json();
    assertEquals(preview.ok, true);
    assertEquals(preview.applied, false);
    assertStringIncludes(preview.command, "deno add jsr:@denext/openapi@");
    assertStringIncludes(preview.diff, `+import { openapi } from "@denext/openapi";`);
    assertEquals(preview.config, null);

    const applied = await (await post(h, "/api/plugins", {
      name: OPENAPI,
      op: "add",
      confirm: "1",
    })).json();
    assertEquals(applied.ok, true);
    assertEquals(applied.applied, true);
    assertEquals(applied.wrote, true);
    assertEquals(applied.installed, [OPENAPI]);
    assertStringIncludes(await config(h), "plugins: [openapi()]");
  } finally {
    await stop(h);
  }
});

Deno.test("a confirmed remove unwires the config and runs deno remove", async () => {
  const h = await ui({
    "denext.config.ts": WIRED_CONFIG,
    "deno.json": `{ "imports": { "@denext/htmx": "jsr:@denext/htmx@^2.0.11" } }`,
  });
  try {
    const preview = await (await post(h, "/plugins", { name: HTMX, op: "remove" })).text();
    assertStringIncludes(preview, "deno remove @denext/htmx");
    assertStringIncludes(preview, "-import { htmx } from ");

    const res = await post(h, "/plugins", { name: HTMX, op: "remove", confirm: "1" });
    await res.body?.cancel();
    assertEquals(res.status, 303);
    assertEquals(h.ran, [["remove", HTMX]]);
    const source = await config(h);
    assert(!source.includes("htmx"), source);
  } finally {
    await stop(h);
  }
});

Deno.test("a config whose default export is not an object literal bails with instructions", async () => {
  const factoryConfig = `export default function config() {\n  return { plugins: [] };\n}\n`;
  const h = await ui({ "denext.config.ts": factoryConfig });
  try {
    const body = normaliseEntities(
      await (await post(h, "/plugins", {
        name: OPENAPI,
        op: "add",
        confirm: "1",
      })).text(),
    );
    assertStringIncludes(body, "not an object literal");
    assertStringIncludes(body, `import { openapi } from "@denext/openapi";`);
    assertStringIncludes(body, "openapi() to the default export");
    assertEquals(await config(h), factoryConfig, "a bail never writes");
    assertEquals(h.ran, [], "a bail never installs");

    const json = await (await post(h, "/api/plugins", { name: OPENAPI, op: "add" })).json();
    assertEquals(json.ok, false);
    assertEquals(json.bailed, true);
  } finally {
    await stop(h);
  }
});

Deno.test("a package outside the catalog is refused with 400, in both shapes", async () => {
  const h = await ui({ "denext.config.ts": WIRED_CONFIG });
  try {
    const page = await post(h, "/plugins", { name: "evil-plugin; rm -rf /", op: "add" });
    assertEquals(page.status, 400);
    assertStringIncludes(await page.text(), "unknown plugin");

    const api = await post(h, "/api/plugins", { name: "evil-plugin", op: "add", confirm: "1" });
    assertEquals(api.status, 400);
    const payload = await api.json();
    assertEquals(payload.ok, false);
    assertStringIncludes(payload.reason, "unknown plugin");
    assert(Array.isArray(payload.catalog), "a refusal still carries the catalog");

    const badOp = await post(h, "/api/plugins", { name: OPENAPI, op: "purge" });
    assertEquals(badOp.status, 400);
    assertStringIncludes((await badOp.json()).reason, "unknown operation");
    assertEquals(h.ran, []);
  } finally {
    await stop(h);
  }
});

Deno.test("--read-only refuses every plugin mutation", async () => {
  const h = await ui({ "denext.config.ts": WIRED_CONFIG }, { readOnly: true });
  try {
    const res = await post(h, "/plugins", { name: OPENAPI, op: "add", confirm: "1" });
    assertEquals(res.status, 403);
    assertEquals((await res.json()).reason, "read-only");
    assertEquals(await config(h), WIRED_CONFIG);
    assertEquals(h.ran, []);
    assertStringIncludes(await (await get(h, "/plugins")).text(), "Read-only mode");
  } finally {
    await stop(h);
  }
});

Deno.test("a stream-capable client gets the deno output as SSE frames", async () => {
  const h = await ui({ "denext.config.ts": WIRED_CONFIG });
  try {
    const res = await post(h, "/plugins", {
      name: OPENAPI,
      op: "add",
      confirm: "1",
    }, "text/event-stream");
    assertEquals(res.status, 200);
    assertStringIncludes(res.headers.get("content-type") ?? "", "text/event-stream");
    const text = await res.text();
    assertStringIncludes(text, "data: $ deno add jsr:@denext/openapi@");
    assertStringIncludes(text, "data: stub: deno add");
    assertStringIncludes(text, "— exited 0, wrote denext.config.ts");
    assertStringIncludes(await config(h), "openapi()");
  } finally {
    await stop(h);
  }
});

// ── containment ──────────────────────────────────────────────────────────────

Deno.test("a denext.config.ts symlinked out of the project is never read or rewritten", async () => {
  const outside = await Deno.makeTempDir({ prefix: "denext_plug_out_" });
  const victim = join(outside, "victim.ts");
  await Deno.writeTextFile(victim, WIRED_CONFIG);
  const h = await ui({ "deno.json": "{}" });
  try {
    await Deno.symlink(victim, join(h.dir, "denext.config.ts"));

    const payload = await (await get(h, "/api/plugins")).json();
    assertEquals(payload.config, null, "the linked file is not this project's config");
    assertEquals(payload.installed, [], "nothing outside the project is reported as installed");

    const res = await post(h, "/plugins", { name: OPENAPI, op: "add", confirm: "1" });
    await res.body?.cancel();
    assertEquals(res.status, 403, "the write is refused, not attempted");
    assertEquals(await Deno.readTextFile(victim), WIRED_CONFIG, "the outside file is untouched");
  } finally {
    await stop(h);
    await Deno.remove(outside, { recursive: true });
  }
});
