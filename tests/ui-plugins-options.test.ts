// The `denext ui` plugin-options sub-panel (`/plugins/options?name=…`, `/api/plugins/options`)
// and third-party discovery on JSR (`/plugins?q=…`, `op=add-jsr`): the form rendered from a
// catalogued plugin's `optionsSchema` with the config's current values, code-valued options shown
// read-only, the preview → confirm discipline, deletes, bails, stale confirms and the JSON twin;
// then the JSR search box, its offline/read-only behaviour and the add-jsr validation order.
//
// `deno add` is stubbed through `setProcRunner` and the registry through `setJsrClient`, so the
// suite never installs anything and never reaches the network.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startUiServer, type UiServer } from "../src/ui/server.ts";
import { UI_CSRF_HEADER } from "../src/ui/security.ts";
import { uiHandshake } from "./helpers/ui-session.ts";
import { setProcRunner } from "../src/ui/features/plugins.ts";
import { setJsrClient } from "../src/ui/features/plugin-search.ts";
import { sanitizeOptionsSchema } from "../src/ui/features/third-party-options.ts";
import type { ProcResult, RunDenoOptions } from "../src/ui/proc.ts";
import type { JsrMetaResult, JsrSearchResult } from "../src/ui/jsr.ts";

const OPENAPI = "@denext/openapi";
const OPTIONS = `/plugins/options?name=${encodeURIComponent(OPENAPI)}`;

/** A config wiring openapi with two data options and one code-valued option. */
const CONFIG = `// Project config — this comment must survive every edit.
import { openapi } from "@denext/openapi";

export default {
  plugins: [openapi({ path: "/spec.json", ui: "scalar", toJsonSchema: (schema) => schema })],
};
`;

/** Every field a browser posts for the untouched options form over {@linkcode CONFIG}. */
const UNTOUCHED: Record<string, string> = {
  "o.path": "/spec.json",
  "o.docs~branch": "0",
  "o.docs": "",
  "o.ui": "scalar",
  "o.cdn": "",
  "o.info.title": "",
  "o.info.version": "",
  "o.info.description": "",
  "o.expose": "",
  "o.outFile~branch": "0",
  "o.outFile": "",
};

/** The stubbed JSR search page (one hostile description, one archived package). */
const SEARCH: JsrSearchResult = {
  ok: true,
  total: 2,
  hits: [
    {
      scope: "acme",
      name: "cool-plugin",
      version: "1.2.3",
      description: "A <script>alert(1)</script> plugin",
      archived: false,
    },
    { scope: "acme", name: "old-plugin", version: "0.1.0", description: "", archived: true },
  ],
};

interface Harness {
  server: UiServer;
  base: string;
  dir: string;
  /** The session cookie the handshake minted (never the launch token). */
  cookie: string;
  /** The CSRF token derived from that cookie. */
  csrf: string;
  /** Every stubbed `deno` argv. */
  ran: string[][];
  /** Every stubbed JSR search query. */
  searches: string[];
  /** Every stubbed JSR meta lookup (`@scope/name`). */
  metas: string[];
}

interface HarnessOptions {
  readOnly?: boolean;
  offline?: boolean;
  meta?: JsrMetaResult;
}

async function ui(files: Record<string, string>, options: HarnessOptions = {}): Promise<Harness> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_plugin_opts_" });
  for (const [name, body] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, name), body);
  }
  const server = await startUiServer({
    dir,
    port: 0,
    readOnly: options.readOnly,
    offline: options.offline,
  });
  const { cookie, csrf } = await uiHandshake(server);
  const h: Harness = {
    server,
    dir,
    base: `http://127.0.0.1:${server.port}`,
    cookie,
    csrf,
    ran: [],
    searches: [],
    metas: [],
  };
  setProcRunner((args: string[], _opts: RunDenoOptions): Promise<ProcResult> => {
    h.ran.push(args);
    return Promise.resolve({ code: 0, stdout: "stubbed\n", stderr: "", json: () => null });
  });
  setJsrClient({
    search: (query) => {
      h.searches.push(query);
      return Promise.resolve(SEARCH);
    },
    meta: (scope, name) => {
      h.metas.push(`@${scope}/${name}`);
      return Promise.resolve(options.meta ?? { ok: true, latest: "1.2.3" });
    },
  });
  return h;
}

async function stop(h: Harness): Promise<void> {
  setProcRunner();
  setJsrClient();
  await h.server.shutdown();
  await Deno.remove(h.dir, { recursive: true });
}

/** GET a UI path with the session cookie. */
function get(h: Harness, path: string): Promise<Response> {
  return fetch(`${h.base}${path}`, { headers: { cookie: h.cookie } });
}

/** The session headers every mutation carries. */
function mutationHeaders(h: Harness): Record<string, string> {
  return { cookie: h.cookie, origin: h.base, [UI_CSRF_HEADER]: h.csrf };
}

/** POST a form with the session cookie, a same-origin `Origin` and the CSRF token. */
function post(h: Harness, path: string, fields: Record<string, string>): Promise<Response> {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return fetch(`${h.base}${path}`, {
    method: "POST",
    headers: mutationHeaders(h),
    body,
    redirect: "manual",
  });
}

/** POST a JSON body. */
function postJson(h: Harness, path: string, body: unknown): Promise<Response> {
  return fetch(`${h.base}${path}`, {
    method: "POST",
    headers: { ...mutationHeaders(h), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The project's config text. */
function config(h: Harness): Promise<string> {
  return Deno.readTextFile(join(h.dir, "denext.config.ts"));
}

/** Markup with the renderer's named entity references decoded, so assertions quote plain text. */
function normaliseEntities(markup: string): string {
  return markup.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** The value of the hidden input `name` in a rendered page (entities decoded). */
function hiddenValue(body: string, name: string): string {
  const match = body.match(new RegExp(`name="${name}" value="([^"]*)"`));
  assert(match, `no hidden ${name} field`);
  return normaliseEntities(match[1]);
}

/** Preview `fields`, then confirm exactly what the preview carried; returns the confirm response. */
async function previewThenConfirm(h: Harness, fields: Record<string, string>): Promise<Response> {
  const preview = await post(h, OPTIONS, fields);
  assertEquals(preview.status, 200);
  const body = await preview.text();
  return await post(h, OPTIONS, {
    sets: hiddenValue(body, "sets"),
    _base: hiddenValue(body, "_base"),
    confirm: "1",
  });
}

// ── the options form ─────────────────────────────────────────────────────────

Deno.test("the options form renders from the plugin's optionsSchema with the config's values", async () => {
  const h = await ui({ "denext.config.ts": CONFIG });
  try {
    const res = await get(h, OPTIONS);
    assertEquals(res.status, 200);
    const body = await res.text();
    assertStringIncludes(body, '<section id="panel"');
    assertStringIncludes(body, `action="${OPTIONS}"`);
    assertStringIncludes(body, 'name="o.path" id="f-o-path" type="text" value="/spec.json"');
    // An enum → radios with the file's value checked; a nested object → a group; an array of
    // objects → a list editor. `servers` is not in the file, so it carries NO presence marker: an
    // untouched save must post nothing for it, not an empty list.
    assertStringIncludes(body, 'type="radio" value="scalar" checked');
    assertStringIncludes(body, 'name="o.info.title"');
    assertStringIncludes(body, 'value="add:0:o.servers"');
    assert(!body.includes('name="o.servers~n"'), "an unset list has no marker to post");
    assertStringIncludes(body, 'name="_base"');
    assertStringIncludes(body, ">Preview<");
  } finally {
    await stop(h);
  }
});

Deno.test("a code-valued option and code-shaped schema fields are read-only", async () => {
  const h = await ui({ "denext.config.ts": CONFIG });
  try {
    const body = await (await get(h, OPTIONS)).text();
    assertStringIncludes(body, "Code-valued options");
    assertStringIncludes(normaliseEntities(body), "(schema) => schema");
    assert(!body.includes('name="o.toJsonSchema"'), "a code option gets no control");
    // `tags` is a function-wrapped list and `securitySchemes` holds opaque values: shown, disabled.
    assertStringIncludes(body, 'name="o.tags" id="f-o-tags" disabled');
    assertStringIncludes(body, 'name="o.securitySchemes" id="f-o-securitySchemes" disabled');
  } finally {
    await stop(h);
  }
});

Deno.test("an untouched form previews no change and offers nothing to apply", async () => {
  const h = await ui({ "denext.config.ts": CONFIG });
  try {
    const res = await post(h, OPTIONS, UNTOUCHED);
    assertEquals(res.status, 200);
    const body = await res.text();
    assertStringIncludes(body, "No change — the file already says this.");
    assert(!body.includes('name="sets"'), body);
  } finally {
    await stop(h);
  }
});

Deno.test("a preview writes nothing and shows the diff with the confirm form", async () => {
  const h = await ui({ "denext.config.ts": CONFIG });
  try {
    const res = await post(h, OPTIONS, { ...UNTOUCHED, "o.info.title": "My API" });
    assertEquals(res.status, 200);
    const raw = await res.text();
    const body = normaliseEntities(raw);
    assertStringIncludes(body, `info: { title: "My API" }`);
    assertStringIncludes(body, ">Apply<");
    assertEquals(JSON.parse(hiddenValue(raw, "sets")), [
      { path: ["info"], value: { title: "My API" } },
    ]);
    assertEquals(await config(h), CONFIG, "the preview writes nothing");
    assertEquals(h.ran, []);
  } finally {
    await stop(h);
  }
});

Deno.test("a confirm writes exactly the one key, and the leading comment survives", async () => {
  const h = await ui({ "denext.config.ts": CONFIG });
  try {
    const res = await previewThenConfirm(h, { ...UNTOUCHED, "o.info.title": "My API" });
    await res.body?.cancel();
    assertEquals(res.status, 303);
    assertEquals(res.headers.get("location"), OPTIONS);
    const source = await config(h);
    assert(source.startsWith("// Project config — this comment must survive every edit.\n"));
    assertStringIncludes(source, `info: { title: "My API" }`);
    assertStringIncludes(source, "toJsonSchema: (schema) => schema");
    const twin = await (await get(h, `/api${OPTIONS}`)).json();
    assertEquals(twin.values, { path: "/spec.json", ui: "scalar", info: { title: "My API" } });
    assertEquals(twin.codeKeys, ["toJsonSchema"]);
  } finally {
    await stop(h);
  }
});

Deno.test("clearing a field deletes its key", async () => {
  const h = await ui({ "denext.config.ts": CONFIG });
  try {
    const res = await previewThenConfirm(h, { ...UNTOUCHED, "o.path": "" });
    await res.body?.cancel();
    assertEquals(res.status, 303);
    const source = await config(h);
    assert(!source.includes("path:"), source);
    assertStringIncludes(source, `ui: "scalar"`);
    assertStringIncludes(source, "toJsonSchema: (schema) => schema");
  } finally {
    await stop(h);
  }
});

Deno.test("a call the writer cannot own bails with the reason and writes nothing", async () => {
  const spread = `import { openapi } from "@denext/openapi";
const base = { path: "/x" };
export default { plugins: [openapi({ ...base, ui: "scalar" })] };
`;
  const h = await ui({ "denext.config.ts": spread });
  try {
    const page = await get(h, OPTIONS);
    assertEquals(page.status, 422);
    const body = normaliseEntities(await page.text());
    assertStringIncludes(body, "spreads another object");
    assertStringIncludes(body, `openapi({ ...base, ui: "scalar" })`);
    assert(!body.includes('name="o.path"'), "no form over a call that cannot be written");
    const res = await post(h, OPTIONS, { ...UNTOUCHED, "o.path": "/y" });
    assertEquals(res.status, 422);
    await res.body?.cancel();
    assertEquals(await config(h), spread);
  } finally {
    await stop(h);
  }
});

Deno.test("a plugin that is not wired, or has no options schema, is a 404", async () => {
  const htmxOnly = `import { htmx } from "@denext/htmx";\nexport default { plugins: [htmx()] };\n`;
  const h = await ui({ "denext.config.ts": htmxOnly });
  try {
    const page = await get(h, OPTIONS);
    assertEquals(page.status, 404);
    assertStringIncludes(await page.text(), "is not wired into denext.config.ts");
    const library = await get(h, `/api/plugins/options?name=${encodeURIComponent("@denext/avif")}`);
    assertEquals(library.status, 404);
    const payload = await library.json();
    assertEquals(payload.ok, false);
    assertStringIncludes(payload.reason, "no options schema");
    const write = await post(h, OPTIONS, UNTOUCHED);
    assertEquals(write.status, 404);
    await write.body?.cancel();
    // The index lists the editable plugins, linking only the wired one.
    const index = await (await get(h, "/plugins/options")).text();
    assertStringIncludes(index, `href="/plugins/options?name=%40denext%2Fhtmx"`);
    assertStringIncludes(index, "not wired");
  } finally {
    await stop(h);
  }
});

Deno.test("the JSON twin reads the options and applies carried writes", async () => {
  const h = await ui({ "denext.config.ts": CONFIG });
  try {
    const read = await (await get(h, `/api${OPTIONS}`)).json();
    assertEquals(read.ok, true);
    assertEquals(read.callee, "openapi");
    assertEquals(read.values, { path: "/spec.json", ui: "scalar" });
    assertEquals(read.codeKeys, ["toJsonSchema"]);
    assert(read.schema.properties.info, "the schema travels with the twin");

    const sets = [{ path: ["info", "title"], value: "T" }, { path: ["ui"] }];
    const preview = await (await postJson(h, `/api${OPTIONS}`, { sets })).json();
    assertEquals(preview.ok, true);
    assertEquals(preview.applied, false);
    assertStringIncludes(preview.diff, `info: { title: "T" }`);
    assertEquals(preview.values, { path: "/spec.json", info: { title: "T" } });
    assertEquals(await config(h), CONFIG);

    const applied = await (await postJson(h, `/api${OPTIONS}`, { sets, confirm: true })).json();
    assertEquals(applied.applied, true);
    assertEquals(applied.values, { path: "/spec.json", info: { title: "T" } });
    assertStringIncludes(await config(h), `info: { title: "T" }`);

    // A write aimed at a code-valued option is refused before the writer runs.
    const code = await postJson(h, `/api${OPTIONS}`, {
      sets: [{ path: ["toJsonSchema"], value: 1 }],
    });
    assertEquals(code.status, 400);
    assertEquals((await code.json()).ok, false);
  } finally {
    await stop(h);
  }
});

Deno.test("a confirm against a file edited since the preview is a 409 and writes nothing", async () => {
  const h = await ui({ "denext.config.ts": CONFIG });
  try {
    const preview = await (await post(h, OPTIONS, { ...UNTOUCHED, "o.path": "/new.json" })).text();
    const edited = CONFIG.replace("/spec.json", "/elsewhere.json");
    await Deno.writeTextFile(join(h.dir, "denext.config.ts"), edited);
    const res = await post(h, OPTIONS, {
      sets: hiddenValue(preview, "sets"),
      _base: hiddenValue(preview, "_base"),
      confirm: "1",
    });
    assertEquals(res.status, 409);
    assertStringIncludes(await res.text(), "changed on disk");
    assertEquals(await config(h), edited);
  } finally {
    await stop(h);
  }
});

Deno.test("a list row button re-renders the draft with the new row and writes nothing", async () => {
  const h = await ui({ "denext.config.ts": CONFIG });
  try {
    const res = await post(h, OPTIONS, { ...UNTOUCHED, op: "add:0:o.servers" });
    assertEquals(res.status, 200);
    const body = await res.text();
    assertStringIncludes(body, 'name="o.servers[0].url"');
    assertStringIncludes(body, 'name="o.servers~n" type="hidden" value="1"');
    assert(!body.includes('name="sets"'), "a row button is not a preview");
    assertEquals(await config(h), CONFIG);
  } finally {
    await stop(h);
  }
});

// ── the catalogue's allowlist and JSR discovery ──────────────────────────────

Deno.test("op=add still refuses a package outside the catalog", async () => {
  const h = await ui({ "denext.config.ts": CONFIG });
  try {
    const res = await post(h, "/plugins", { name: "@acme/cool-plugin", op: "add" });
    assertEquals(res.status, 400);
    assertStringIncludes(await res.text(), "unknown plugin");
    assertEquals(h.ran, []);
  } finally {
    await stop(h);
  }
});

Deno.test("op=add-jsr refuses a bad spec or export with 400 before any lookup or subprocess", async () => {
  const h = await ui({ "denext.config.ts": CONFIG });
  try {
    for (const spec of ["evil; rm -rf /", "@Acme/Cool", "jsr:@acme/cool-plugin", "@a/b", ""]) {
      const res = await postJson(h, "/api/plugins", { op: "add-jsr", spec, confirm: true });
      assertEquals(res.status, 400, spec);
      assertStringIncludes((await res.json()).reason, "not a JSR package name");
    }
    for (const bad of ["cool-plugin", "1st", "delete", "a b"]) {
      const res = await post(h, "/plugins", {
        op: "add-jsr",
        spec: "@acme/cool-plugin",
        export: bad,
      });
      assertEquals(res.status, 400, bad);
      assertStringIncludes(await res.text(), "bad factory export");
    }
    assertEquals(h.ran, [], "no subprocess");
    assertEquals(h.metas, [], "no registry lookup");
    assertEquals(await config(h), CONFIG);
  } finally {
    await stop(h);
  }
});

Deno.test("op=add-jsr pins the registry's latest version, never the browser's", async () => {
  const h = await ui({ "denext.config.ts": CONFIG });
  try {
    const fields = { op: "add-jsr", spec: "@acme/cool-plugin", version: "9.9.9" };
    const preview = normaliseEntities(await (await post(h, "/plugins", fields)).text());
    assertStringIncludes(preview, "deno add jsr:@acme/cool-plugin@^1.2.3");
    assertStringIncludes(preview, `+import { coolPlugin } from "@acme/cool-plugin";`);
    assert(!preview.includes("9.9.9"), "the posted version is ignored");
    assertEquals(h.ran, []);

    const res = await post(h, "/plugins", { ...fields, export: "coolPlugin", confirm: "1" });
    await res.body?.cancel();
    assertEquals(res.status, 303);
    assertEquals(h.ran, [["add", "jsr:@acme/cool-plugin@^1.2.3"]]);
    assertEquals(h.metas, ["@acme/cool-plugin", "@acme/cool-plugin"], "one lookup per request");
    const source = await config(h);
    assertStringIncludes(source, `import { coolPlugin } from "@acme/cool-plugin";`);
    assertStringIncludes(source, "coolPlugin(), openapi(");
    // A wired third-party plugin is listed, with the reason it has no options panel.
    const panel = await (await get(h, "/plugins")).text();
    assertStringIncludes(panel, "<h2>Third-party</h2>");
    assertStringIncludes(panel, "publishes no options schema");
  } finally {
    await stop(h);
  }
});

Deno.test("op=add-jsr answers 502 when the registry lookup fails, and runs nothing", async () => {
  const h = await ui({ "denext.config.ts": CONFIG }, { meta: { ok: false, reason: "HTTP 404" } });
  try {
    const res = await postJson(h, "/api/plugins", {
      op: "add-jsr",
      spec: "@acme/gone",
      confirm: true,
    });
    assertEquals(res.status, 502);
    assertStringIncludes((await res.json()).reason, "HTTP 404");
    assertEquals(h.ran, []);
    assertEquals(await config(h), CONFIG);
  } finally {
    await stop(h);
  }
});

Deno.test("a JSR search renders escaped results with an Add form each", async () => {
  const h = await ui({ "denext.config.ts": CONFIG });
  try {
    const body = await (await get(h, "/plugins?q=cool")).text();
    assertEquals(h.searches, ["cool"]);
    assertStringIncludes(body, 'name="q" value="cool"');
    assertStringIncludes(body, "<strong>@acme/cool-plugin</strong>");
    assertStringIncludes(body, "&lt;script&gt;alert(1)&lt;/script&gt;");
    assert(!body.includes("<script>alert"), "registry text is escaped");
    assertStringIncludes(body, '<span class="badge warn">archived</span>');
    assertStringIncludes(body, 'name="op" value="add-jsr"');
    assertStringIncludes(body, 'name="export" value="coolPlugin"');
    const twin = await (await get(h, "/api/plugins?q=cool")).json();
    assertEquals(twin.jsr.available, true);
    assertEquals(twin.jsr.search.hits.length, 2);
  } finally {
    await stop(h);
  }
});

Deno.test("--offline disables the search box, fetches nothing, and refuses add-jsr", async () => {
  const h = await ui({ "denext.config.ts": CONFIG }, { offline: true });
  try {
    const body = await (await get(h, "/plugins?q=cool")).text();
    assertStringIncludes(body, 'name="q" value="cool" placeholder="Search JSR packages"');
    assertStringIncludes(body, 'aria-label="Search JSR packages" disabled');
    assertStringIncludes(body, "JSR search is unavailable");
    const res = await postJson(h, "/api/plugins", { op: "add-jsr", spec: "@acme/cool-plugin" });
    assertEquals(res.status, 503);
    await res.body?.cancel();
    assertEquals(h.searches, [], "no search");
    assertEquals(h.metas, [], "no lookup");
  } finally {
    await stop(h);
  }
});

Deno.test("--read-only still searches (a GET) but refuses both adds and every options write", async () => {
  const h = await ui({ "denext.config.ts": CONFIG }, { readOnly: true });
  try {
    const page = await get(h, "/plugins?q=cool");
    assertEquals(page.status, 200);
    assertStringIncludes(await page.text(), "@acme/cool-plugin");
    assertEquals(h.searches, ["cool"]);
    const refusals = [
      await post(h, "/plugins", { op: "add-jsr", spec: "@acme/cool-plugin", confirm: "1" }),
      await post(h, "/plugins", { name: OPENAPI, op: "add", confirm: "1" }),
      await post(h, OPTIONS, { ...UNTOUCHED, "o.path": "/y" }),
    ];
    for (const res of refusals) {
      assertEquals(res.status, 403);
      assertEquals((await res.json()).reason, "read-only");
    }
    assertEquals(h.ran, []);
    assertEquals(h.metas, []);
    assertEquals(await config(h), CONFIG);
    // The form still renders, every control disabled.
    assertStringIncludes(
      await (await get(h, OPTIONS)).text(),
      'name="o.path" id="f-o-path" disabled',
    );
  } finally {
    await stop(h);
  }
});

Deno.test("a plugin imported under another name gets its options form, written through the alias", async () => {
  const aliased = CONFIG.replace("import { openapi } from", "import { openapi as oa } from")
    .replace("plugins: [openapi(", "plugins: [oa(");
  const h = await ui({ "denext.config.ts": aliased });
  try {
    const res = await get(h, OPTIONS);
    assertEquals(res.status, 200);
    assertStringIncludes(
      await res.text(),
      'name="o.path" id="f-o-path" type="text" value="/spec.json"',
    );
    const done = await previewThenConfirm(h, { ...UNTOUCHED, "o.path": "/api.json" });
    assert(done.status < 400, `confirm answered ${done.status}`);
    const source = await config(h);
    assertStringIncludes(source, 'oa({ path: "/api.json"');
    assert(!source.includes("openapi("), "no call under the exported name");
  } finally {
    await stop(h);
  }
});

// ── third-party plugins: a published options schema ─────────────────────────

const COOL = `/plugins/options?name=${encodeURIComponent("@acme/cool")}`;
const COOL_CONFIG = `import { cool } from "jsr:@acme/cool@^1.0.0";\n` +
  `export default { plugins: [cool({ mode: "a" })] };\n`;
const COOL_LOCK = JSON.stringify({
  version: "5",
  specifiers: { "jsr:@acme/cool@^1.0.0": "1.4.2" },
});
const COOL_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["a", "b"], description: "<b>Which</b> mode" },
    depth: { type: "number", minimum: 1, maximum: 5 },
  },
};

/** Stub the registry's config call; returns the `@scope/name@version`s it was asked for. */
function publishes(schema: unknown): string[] {
  const asked: string[] = [];
  setJsrClient({
    meta: () => Promise.resolve({ ok: true, latest: "9.9.9" }),
    config: (scope, name, version) => {
      asked.push(`@${scope}/${name}@${version}`);
      const value = schema === undefined
        ? { name }
        : { denext: { catalog: { optionsSchema: schema } } };
      return Promise.resolve({ ok: true, value });
    },
  });
  return asked;
}

Deno.test("sanitizeOptionsSchema keeps only the keys the form reads, checked and bounded", () => {
  const cleaned = sanitizeOptionsSchema({
    type: "object",
    $ref: "#/nope",
    properties: { mode: { type: "string", enum: ["a"], onclick: "x" } },
  });
  assertEquals(cleaned, { type: "object", properties: { mode: { type: "string", enum: ["a"] } } });
  assertEquals(
    sanitizeOptionsSchema(
      JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'),
    ),
    null,
  );
  assertEquals(
    sanitizeOptionsSchema({ type: "string" }),
    null,
    "the root must be an object with properties",
  );
  assertEquals(sanitizeOptionsSchema({ type: "object", properties: { a: { enum: [{}] } } }), null);
  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 10; i++) deep = { type: "object", properties: { a: deep } };
  assertEquals(sanitizeOptionsSchema(deep), null, "too deep");
});

Deno.test("a wired JSR plugin that publishes an options schema gets a form, written through its call", async () => {
  const h = await ui({ "denext.config.ts": COOL_CONFIG, "deno.lock": COOL_LOCK });
  const asked = publishes(COOL_SCHEMA);
  try {
    const res = await get(h, COOL);
    assertEquals(res.status, 200);
    const body = await res.text();
    assertStringIncludes(body, 'type="radio" value="a" checked');
    assert(!body.includes("<b>Which</b>"), "a published description is escaped");
    assertEquals(asked, ["@acme/cool@1.4.2"], "the lockfile's version, not the latest");

    const preview = await post(h, COOL, { "o.mode": "b" });
    assertEquals(preview.status, 200);
    const text = await preview.text();
    const done = await post(h, COOL, {
      sets: hiddenValue(text, "sets"),
      _base: hiddenValue(text, "_base"),
      confirm: "1",
    });
    assert(done.status < 400, `confirm answered ${done.status}`);
    assertStringIncludes(await config(h), 'cool({ mode: "b" })');

    const panel = await (await get(h, "/plugins")).text();
    assertStringIncludes(panel, `href="${COOL.replace("?", "?")}"`);
  } finally {
    await stop(h);
  }
});

Deno.test("a JSR plugin that publishes nothing is a 404; offline it is a 503", async () => {
  const bare =
    `import { bare } from "jsr:@acme/bare@^1.0.0";\nexport default { plugins: [bare()] };\n`;
  const h = await ui({ "denext.config.ts": bare });
  publishes(undefined);
  try {
    const res = await get(h, `/api/plugins/options?name=${encodeURIComponent("@acme/bare")}`);
    assertEquals(res.status, 404);
    assertStringIncludes((await res.json()).reason, "publishes no denext.catalog.optionsSchema");
  } finally {
    await stop(h);
  }
  const off = await ui({ "denext.config.ts": COOL_CONFIG }, { offline: true });
  publishes(COOL_SCHEMA);
  try {
    const res = await get(off, `/api/plugins/options?name=${encodeURIComponent("@acme/cool")}`);
    assertEquals(res.status, 503);
    assertStringIncludes((await res.json()).reason, "cannot reach");
  } finally {
    await stop(off);
  }
});
