// `/config` and `/config/next` — the configuration editor: the two buckets (an editable widget
// tree vs a read-only code cell), the diff-then-confirm write, the list-editor round trip
// (add → type → reorder → the file still has its comments and its `() => [ … ]` wrapper),
// inline validation, the raw-file escape hatch, and the next.config read + translate panel.
//
// The handler is driven directly with a hand-built context — the kernel's own gates (origin,
// CSRF, read-only, method) are `tests/ui-server.test.ts`'s subject, not this file's.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { SseClients } from "../src/build/sse.ts";
import type { UiContext } from "../src/ui/html.ts";
import { configPanel } from "../src/ui/features/config.ts";
import { type NextConfigRead, setNextConfigEvaluator } from "../src/ui/features/config-next.ts";
import { loadConfigSchema, resolveAt } from "../src/ui/form/schema.ts";
import { widgetFor } from "../src/ui/form/widget.ts";
import { encode } from "../src/ui/form/value.ts";

const CONFIG = `import { openapi } from "@denext/openapi";

export default {
  basePath: "/docs",
  trailingSlash: true,
  // the legacy URLs
  redirects: () => [
    { source: "/old", destination: "/new", permanent: true }, // keep this comment
    { source: "/a", destination: "/b", permanent: false },
  ],
  plugins: [openapi()],
};
`;

/** A temp project, optionally carrying a `denext.config.ts`. */
async function project(source: string | null = CONFIG): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_config_" });
  if (source !== null) await Deno.writeTextFile(join(dir, "denext.config.ts"), source);
  return dir;
}

/** The config file as it stands on disk. */
async function onDisk(dir: string): Promise<string> {
  return await Deno.readTextFile(join(dir, "denext.config.ts"));
}

/** One request against the panel, with the kernel's context already assembled. */
async function call(
  dir: string,
  path: string,
  init: { form?: Record<string, string | string[]>; readOnly?: boolean } = {},
): Promise<Response> {
  const url = new URL(`http://127.0.0.1:5177${path}`);
  const form = init.form === undefined ? undefined : new FormData();
  // A list posts one name MORE THAN ONCE, which is what a browser does for a toggle: the hidden
  // companion and then the checkbox. `decodeToggle` reads every value and takes the last.
  for (const [key, value] of Object.entries(init.form ?? {})) {
    for (const one of Array.isArray(value) ? value : [value]) form?.append(key, one);
  }
  const ctx: UiContext = {
    dir,
    url,
    method: form ? "POST" : "GET",
    readOnly: init.readOnly === true,
    csrf: "csrf-token",
    json: url.pathname.startsWith("/api/"),
    fragment: false,
    form,
    events: new Set() as SseClients,
  };
  return await configPanel(new Request(url, { method: ctx.method }), ctx);
}

/** The fields a browser would post for one section's current value. */
function fieldsFor(key: string, value: unknown): Record<string, string> {
  const spec = widgetFor(resolveAt(loadConfigSchema(), [key]), [key], false);
  return Object.fromEntries(encode(spec, value).map((entry) => [entry.name, entry.value]));
}

/** Whether the markup carries a control named `name` holding `value` (attribute order free). */
function hasField(body: string, name: string, value: string): boolean {
  const quoted = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`name="${quoted(name)}"[^>]*value="${quoted(value)}"`).test(body);
}

/** The rendered diff block's text, with the per-line classing markup taken back off. */
function diffText(body: string): string {
  const open = body.indexOf('<pre class="out">');
  return body.slice(open, body.indexOf("</pre>", open)).replace(/<[^>]+>/g, "");
}

/** Only the changed lines of a unified diff. */
function changed(diff: string): string[] {
  return diff.split("\n").filter((line) =>
    (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") &&
    !line.startsWith("---")
  );
}

/** The two rules the fixture starts with. */
const RULES = [
  { source: "/old", destination: "/new", permanent: true },
  { source: "/a", destination: "/b", permanent: false },
];

Deno.test("a view shows its scalars inline and its groupings as tabs, nothing collapsed", async () => {
  const dir = await project();
  try {
    const res = await call(dir, "/config/routing");
    assertEquals(res.status, 200);
    const body = await res.text();
    assertStringIncludes(body, '<section id="panel"');
    // Nothing in the editor is a disclosure any more: a view used to read as a list of words
    // with pills, each of which had to be opened before it said anything.
    assert(!body.includes("<details"), "the config editor collapses nothing");
    // ONE strip, and it lists the keys of THIS view — the views themselves are the sidebar's
    // job, so nothing here repeats them.
    assertStringIncludes(body, 'class="panel-head"');
    // ONE strip inside the panel. The views are the sidebar's job, and the sidebar is part of
    // this document — so the question has to be asked of the panel alone.
    const panel = body.slice(body.indexOf('<section id="panel"'));
    assert(!panel.includes('href="/config/rendering"'), "no second strip repeating the views");
    // The plain scalars share the first tab rather than floating above the strip.
    assertStringIncludes(body, 'href="/config/routing?key=general"');
    assert(hasField(body, "basePath", "/docs"));
    assert(hasField(body, "trailingSlash", "on"));
    assertStringIncludes(body, 'class="band"');
    // The groupings follow it, each saying whether its key is set.
    assertStringIncludes(body, 'href="/config/routing?key=redirects"');
    assertStringIncludes(body, 'href="/config/routing?key=i18n"');
    // A view opens on General, so only its fields are rendered — a grouping's form arrives when
    // its own tab is asked for.
    assert(!hasField(body, "redirects[0].source", "/old"), "only the selected tab renders a form");
    const rows = await (await call(dir, "/config/routing?key=redirects")).text();
    assert(hasField(rows, "redirects[0].source", "/old"));
    assert(hasField(rows, "redirects[1].destination", "/b"));
    assertStringIncludes(rows, 'value="up:1:redirects"');

    // `mode` is one control, so it joins the band rather than taking a tab of its own.
    const rendering = await (await call(dir, "/config/rendering")).text();
    assert(hasField(rendering, "mode", "") || rendering.includes('name="mode"'));
    assertStringIncludes(rendering, 'class="band"');
    // The heading names the view; "Config" on all of them said nothing the sidebar had not.
    assertStringIncludes(rendering, "<h1>Rendering</h1>");

    // `plugins` is shown, never edited here — on its own tab.
    const plugins = await (await call(dir, "/config/advanced?key=plugins")).text();
    assertStringIncludes(plugins, "plugins panel</a> owns this key");
    assertStringIncludes(plugins, "openapi()");
    // The escape hatch is a tab of the same strip, carrying the whole file.
    const raw = await (await call(dir, "/config/advanced?key=raw-file")).text();
    assertStringIncludes(raw, 'name="raw"');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a scalar change previews a diff touching only that value, then writes on confirm", async () => {
  const dir = await project();
  try {
    const fields = { basePath: "/site" };
    const preview = await call(dir, "/config?section=basePath", { form: fields });
    assertEquals(preview.status, 200);
    const body = await preview.text();
    assertStringIncludes(body, "Nothing has been written yet");
    const lines = changed(diffText(body));
    assertEquals(lines.length, 2, lines.join("\n"));
    assert(lines.every((line) => line.includes("basePath")), lines.join("\n"));
    assertEquals(await onDisk(dir), CONFIG, "a preview never touches the file");

    const applied = await call(dir, "/config?section=basePath", {
      form: { ...fields, confirm: "1" },
    });
    assertEquals(applied.status, 303);
    // An inline scalar lives on the General tab, so that is where the write lands — on the
    // field you just edited, not merely on the view that contains it.
    assertEquals(applied.headers.get("location"), "/config/routing?key=general");
    assertStringIncludes(await onDisk(dir), 'basePath: "/site",');
    assertStringIncludes(await onDisk(dir), "// keep this comment");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a list op previews the new row, and confirming keeps comments, wrapper and order", async () => {
  const dir = await project();
  try {
    // + Add at the end: the preview shows a third row, nothing is written.
    const added = await call(dir, "/config?section=redirects", {
      form: { ...fieldsFor("redirects", RULES), op: "add:2:redirects" },
    });
    assertEquals(added.status, 200);
    const preview = await added.text();
    assertStringIncludes(preview, 'name="redirects[2].source"');
    assertEquals(await onDisk(dir), CONFIG);

    // Type into the new row and move it up — one submit, exactly what the browser posts.
    const typed = [...RULES, { source: "/c", destination: "/d", permanent: false }];
    const form = { ...fieldsFor("redirects", typed), op: "up:2:redirects" };
    const moved = await call(dir, "/config?section=redirects", { form });
    assertEquals(moved.status, 200);
    assert(hasField(await moved.text(), "redirects[1].source", "/c"));

    const applied = await call(dir, "/config?section=redirects", {
      form: { ...form, confirm: "1" },
    });
    assertEquals(applied.status, 303);
    const written = await onDisk(dir);
    assertStringIncludes(written, "redirects: () => [", "the thunk wrapper is left alone");
    assertStringIncludes(written, "// keep this comment");
    assertStringIncludes(written, "// the legacy URLs");
    const order = [...written.matchAll(/source: "([^"]+)"/g)].map((m) => m[1]);
    assertEquals(order, ["/old", "/c", "/a"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a partial save touches only the keys it carried — silence never deletes", async () => {
  const dir = await project();
  try {
    // A browser posts every control the band rendered, so this cannot arise there. The `/api`
    // twin takes whatever a caller sends, and a cleared field and an unsent one both decode to
    // `undefined` — reading the second as a deletion let an EMPTY body propose dropping every
    // scalar in the view.
    const empty = await call(dir, "/api/config", { form: {} });
    assertEquals(empty.status, 200);
    assertEquals((await empty.json()).diff, "", "an empty body proposes nothing at all");

    // A field that WAS sent, cleared, still removes its key — that is the real gesture.
    const cleared = await call(dir, "/api/config", { form: { basePath: "" } });
    assertStringIncludes((await cleared.json()).diff, "-  basePath:");

    // And a partial body leaves the keys it never mentioned exactly where they were.
    const partial = await call(dir, "/api/config", {
      form: { trailingSlash: "on", confirm: "1" },
    });
    assertEquals(partial.status, 200);
    const after = await onDisk(dir);
    assertStringIncludes(after, 'basePath: "/docs"', "an unmentioned key survives the save");
    assertStringIncludes(after, "// keep this comment");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a no-op save never offers to create the config it did not need", async () => {
  // The case the first version of this guard missed: with no `denext.config.ts`, a save with
  // nothing to write still diffed the absent file against the scaffold the writer starts from,
  // and answered by offering to CREATE it. Nothing to write is nothing to propose — and
  // creating the file is `?create=1`'s job, not a side effect of saving a view.
  const dir = await project(null);
  try {
    const res = await call(dir, "/api/config", { form: {} });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals([body.ok, body.applied, body.diff], [true, false, ""]);
    assertEquals(
      await Deno.stat(join(dir, "denext.config.ts")).catch(() => null),
      null,
      "and nothing was written",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an invalid value is a 422 with the validator's message against its field", async () => {
  const dir = await project();
  try {
    const res = await call(dir, "/config?section=i18n", {
      form: fieldsFor("i18n", { locales: ["en", "fr"], defaultLocale: "de" }),
    });
    assertEquals(res.status, 422);
    const body = await res.text();
    assertStringIncludes(body, "`i18n.defaultLocale` must be one of i18n.locales");
    assertStringIncludes(body, 'role="alert"');
    // The message is rendered against the field that caused it, with the posted value kept.
    assert(hasField(body, "i18n.defaultLocale", "de"));
    assertEquals(await onDisk(dir), CONFIG);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a section form tracks edits: Save waits, and Clear is named for what it does", async () => {
  const dir = await project();
  try {
    // A grouping's tab, because "Remove key" belongs to a grouping's own form; a scalar on
    // General is removed by clearing its field instead.
    const body = await (await call(dir, "/config/routing?key=redirects")).text();
    // `ui.js` disables Save until something changes and adds Discard; the server must not
    // render Save disabled, or a browser with JavaScript off could never save at all.
    assertStringIncludes(body, 'data-dirty-track="1"');
    assert(!/<button type="submit"[^>]*disabled[^>]*>Save</.test(body), "Save ships enabled");
    // The destructive submit says what it removes, rather than reading like "clear the field".
    // It belongs to a grouping's own form; a band scalar is removed by clearing its field.
    assertStringIncludes(body, ">Remove key<");
    assertStringIncludes(body, 'title="Delete redirects from the config"');
    assert(!body.includes(">Clear<"), "the old label is gone");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a config shape the writer cannot own bails honestly, and writes nothing", async () => {
  const source = 'const config = { basePath: "/x" };\nexport default config;\n';
  const dir = await project(source);
  try {
    const page = await call(dir, "/config/routing");
    assertStringIncludes(await page.text(), "cannot be edited key by key");

    const res = await call(dir, "/config?section=basePath", { form: { basePath: "/site" } });
    assertEquals(res.status, 422);
    const body = await res.text();
    assertStringIncludes(body, "no editable config object found");
    assertStringIncludes(body, "export default config;");
    assertEquals(await onDisk(dir), source, "a bail never writes");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the raw escape hatch refuses a file that no longer parses as a config", async () => {
  const dir = await project();
  try {
    const res = await call(dir, "/config?raw=1", { form: { raw: "this is not a module {{{" } });
    assertEquals(res.status, 422);
    assertStringIncludes(await res.text(), "no editable config object");
    assertEquals(await onDisk(dir), CONFIG);

    const ok = await call(dir, "/config?raw=1", {
      form: { raw: 'export default {\n  basePath: "/raw",\n};\n', confirm: "1" },
    });
    assertEquals(ok.status, 303);
    assertStringIncludes(await onDisk(dir), '"/raw"');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** The five references the page's renderer may emit, back to their characters. */
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/**
 * The raw editor's `<textarea>` content as a browser parses and posts it back: the ONE newline
 * the HTML parser drops right after the start tag removed, entities decoded.
 */
function textareaText(body: string): string {
  const content = body.match(/<textarea name="raw"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? "";
  return content.replace(/^\n/, "").replace(/&(?:amp|lt|gt|quot|#39);/g, (ref) => ENTITIES[ref]);
}

Deno.test("the raw editor carries the file byte for byte, markup characters included", async () => {
  const source = CONFIG.replace("// the legacy URLs", `// <b>a & b</b> "quoted" 'single' &amp;`);
  const dir = await project(source);
  try {
    // The whole-file escape hatch lives on Advanced, with the keys denext does not describe.
    const body = await (await call(dir, "/config/advanced?key=raw-file")).text();
    assert(!body.includes("<b>a & b</b>"), "the file's markup is escaped, never live");
    const text = textareaText(body);
    assertEquals(text, source);

    // Posting the textarea straight back is a no-op, not a diff.
    const res = await call(dir, "/config?raw=1", { form: { raw: text } });
    assertEquals(res.status, 200);
    assertStringIncludes(await res.text(), "No change — the file already says this.");
    assertEquals(await onDisk(dir), source);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the raw editor keeps a file's leading blank lines through the textarea", async () => {
  const source = "\n\n" + CONFIG;
  const dir = await project(source);
  try {
    const body = await (await call(dir, "/config/advanced?key=raw-file")).text();
    // The newline the parser drops after `<textarea>`, then the file's own two.
    assertMatch(body, /<textarea name="raw"[^>]*>\n\n\nimport /);
    const text = textareaText(body);
    assertEquals(text, source);
    const res = await call(dir, "/config?raw=1", { form: { raw: text } });
    assertStringIncludes(await res.text(), "No change — the file already says this.");
    assertEquals(await onDisk(dir), source);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("read-only refuses every write, confirmed or not", async () => {
  const dir = await project();
  try {
    const res = await call(dir, "/config?section=basePath", {
      form: { basePath: "/site", confirm: "1" },
      readOnly: true,
    });
    assertEquals(res.status, 403);
    assertStringIncludes(await res.text(), "read-only");
    assertEquals(await onDisk(dir), CONFIG);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a project with no config is offered one, previewed before it is created", async () => {
  const dir = await project(null);
  try {
    const page = await call(dir, "/config/routing");
    assertStringIncludes(await page.text(), "This project has no denext config");

    const preview = await call(dir, "/config?create=1", { form: {} });
    assertEquals(preview.status, 200);
    assertStringIncludes(await preview.text(), "+export default {");
    assertEquals(await Deno.stat(join(dir, "denext.config.ts")).catch(() => null), null);

    const created = await call(dir, "/config?create=1", { form: { confirm: "1" } });
    assertEquals(created.status, 303);
    assertEquals(await onDisk(dir), "export default {\n};\n");

    // The fresh file is immediately writable through the ordinary section path.
    await call(dir, "/config?section=basePath", { form: { basePath: "/new", confirm: "1" } });
    assertStringIncludes(await onDisk(dir), 'basePath: "/new"');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the JSON twin reports the file, its form and every key's bucket", async () => {
  const dir = await project();
  try {
    const res = await call(dir, "/api/config");
    assertEquals(res.status, 200);
    const payload = await res.json();
    assertEquals(payload.ok, true);
    assertEquals(payload.file, "denext.config.ts");
    assertEquals(payload.form, "object");
    assertEquals(payload.keys.basePath, { kind: "editable", value: "/docs" });
    assertEquals(payload.keys.redirects.kind, "editable");
    assertEquals(payload.keys.redirects.value, RULES);
    assertEquals(payload.keys.plugins.kind, "managed");
    assertEquals(payload.schema, undefined, "the schema is opt-in");
    assert(Object.keys((await (await call(dir, "/api/config?schema")).json()).schema).length > 0);

    const mutation = await call(dir, "/api/config?section=basePath", { form: { basePath: "/x" } });
    assertEquals(mutation.status, 200);
    const preview = await mutation.json();
    assertEquals(preview.applied, false);
    assertStringIncludes(preview.diff, '+  basePath: "/x",');

    const applied = await call(dir, "/api/config?section=basePath", {
      form: { basePath: "/x", confirm: "1" },
    });
    assertEquals((await applied.json()).applied, true);
    assertStringIncludes(await onDisk(dir), '"/x"');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an unknown, managed or cron-owned section is refused before anything", async () => {
  const dir = await project();
  try {
    const unknown = await call(dir, "/api/config?section=nope", { form: {} });
    assertEquals(unknown.status, 400);
    assertStringIncludes((await unknown.json()).reason, 'unknown config section "nope"');

    const managed = await call(dir, "/api/config?section=plugins", { form: {} });
    assertEquals(managed.status, 400);
    assertStringIncludes((await managed.json()).reason, "managed by the plugins panel");

    // The cron keys are written by the Cron page. A second editor here would mean two forms and
    // two `_base` stamps against one key — which is how two tabs quietly overwrite each other.
    for (const key of ["scheduledTasks", "tasks"]) {
      const cron = await call(dir, `/api/config?section=${key}`, { form: {} });
      assertEquals(cron.status, 400, key);
      assertStringIncludes((await cron.json()).reason, "/config/cron");
    }
    assertEquals(await onDisk(dir), CONFIG);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("next.config is offered only to a compat app, on every render", async () => {
  // `next.config` is a VIEW of this project's configuration, so it is a tab on /config rather
  // than a seventh item in the top navigation. Two things have to hold: a native app is never
  // offered a tab that would only say "there is nothing here", and a compat app keeps the tab
  // on EVERY render — a refusal and a 422 render the panel just as a GET does, and threading
  // the compat flag from the handler once left those POST paths rendering without it.
  const native = await project();
  try {
    const body = await (await call(native, "/config/routing")).text();
    assertStringIncludes(body, 'class="panel-head"');
    assert(!body.includes('href="/config/next"'), "a native app is offered no next.config link");
  } finally {
    await Deno.remove(native, { recursive: true });
  }

  const compat = await project();
  try {
    await Deno.writeTextFile(
      join(compat, "package.json"),
      '{ "dependencies": { "next": "15.0.0" } }',
    );
    for (
      const [label, init] of [
        ["a plain GET", {}],
        ["a read-only refusal", { readOnly: true, form: { section: "basePath" } }],
        ["an unknown section", { form: { section: "nope" } }],
      ] as const
    ) {
      const res = await call(compat, "/config/routing", init);
      assertStringIncludes(
        await res.text(),
        'href="/config/next"',
        `the next.config tab is missing on ${label} (${res.status})`,
      );
    }
  } finally {
    await Deno.remove(compat, { recursive: true });
  }
});

// ── /config/next ─────────────────────────────────────────────────────────────

Deno.test("/config/next says plainly that a native denext app has no next.config", async () => {
  const dir = await project();
  try {
    const res = await call(dir, "/config/next");
    assertEquals(res.status, 200);
    const body = await res.text();
    assertStringIncludes(body, "not a Next.js compat app");
    assertStringIncludes(body, "denext.config.ts</a>");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("/config/next tables a compat app's config and offers to translate what denext honors", async () => {
  const dir = await project();
  try {
    await Deno.writeTextFile(join(dir, "package.json"), '{ "dependencies": { "next": "15.0.0" } }');
    await Deno.writeTextFile(join(dir, "next.config.mjs"), "export default {};\n");
    const read: NextConfigRead = {
      file: "next.config.mjs",
      fields: { basePath: "/docs", trailingSlash: true },
      rules: { redirects: [{ source: "/old", destination: "/new", permanent: true }] },
      other: ["webpack", "env"],
      failed: false,
    };
    setNextConfigEvaluator(() => Promise.resolve(read));
    try {
      const res = await call(dir, "/config/next");
      const body = await res.text();
      assertStringIncludes(body, 'denext never loads <code class="mono">next.config');
      assertStringIncludes(body, "package.json depends on next");
      assertStringIncludes(body, "basePath");
      assertStringIncludes(body, 'action="/config?section=basePath"');
      assert(hasField(body, "redirects[0].source", "/old"));
      assertStringIncludes(body, "publicEnv"); // the `env` drop note
      assertStringIncludes(body, "no denext equivalent"); // webpack

      const payload = await (await call(dir, "/api/config/next")).json();
      assertEquals(payload.compat, true);
      assertEquals(payload.file, "next.config.mjs");
      assertEquals(payload.honored.basePath, "/docs");
      assertEquals(payload.dropped[0].key, "webpack");
    } finally {
      setNextConfigEvaluator();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("/config/next evaluates a real next.config in a subprocess (piped, not a file)", async () => {
  const dir = await project();
  try {
    await Deno.writeTextFile(join(dir, "package.json"), '{ "dependencies": { "next": "15.0.0" } }');
    await Deno.writeTextFile(
      join(dir, "next.config.mjs"),
      'export default {\n  basePath: "/shop",\n  webpack: (c) => c,\n' +
        '  redirects: () => [{ source: "/old", destination: "/new", permanent: true }],\n};\n',
    );
    const payload = await (await call(dir, "/api/config/next")).json();
    assertEquals(payload.failed, false);
    assertEquals(payload.honored.basePath, "/shop");
    assertEquals(payload.rules.redirects, [{
      source: "/old",
      destination: "/new",
      permanent: true,
    }]);
    assertEquals(payload.dropped[0].key, "webpack");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("/config/next reports a config it could not evaluate instead of guessing", async () => {
  const dir = await project();
  try {
    await Deno.writeTextFile(join(dir, "package.json"), '{ "devDependencies": { "next": "15" } }');
    await Deno.writeTextFile(join(dir, "next.config.js"), "throw new Error('boom');\n");
    const res = await call(dir, "/config/next");
    assertStringIncludes(await res.text(), "Could not evaluate");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── containment and lost updates ─────────────────────────────────────────────

Deno.test("a denext.config.ts symlinked out of the project is neither read nor written", async () => {
  const outside = await Deno.makeTempDir({ prefix: "denext_cfg_out_" });
  const dir = await Deno.makeTempDir({ prefix: "denext_cfg_link_" });
  try {
    const secret = join(outside, "credentials.ts");
    await Deno.writeTextFile(secret, "export default { AWS_SECRET: 'AKIA-not-yours' };\n");
    await Deno.symlink(secret, join(dir, "denext.config.ts"));

    const payload = await (await call(dir, "/api/config")).json();
    assertEquals(payload.file, null, "the linked file is not treated as this project's config");
    assert(!JSON.stringify(payload).includes("AKIA-not-yours"), "nothing outside leaks in");

    const write = await call(dir, "/config?raw=1", {
      form: { raw: "export default { basePath: '/pwned' };\n", confirm: "1" },
    });
    assertEquals(write.status, 403);
    await write.body?.cancel();
    assertEquals(
      await Deno.readTextFile(secret),
      "export default { AWS_SECRET: 'AKIA-not-yours' };\n",
      "the file outside the project is untouched",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("a write against a stale _base is a 409 and changes nothing", async () => {
  const dir = await project();
  try {
    const page = await (await call(dir, "/config/routing?key=redirects")).text();
    const base = page.match(/name="_base"[^>]*value="([0-9a-f]{64})"/)?.[1];
    assert(base, "every form carries the source's SHA-256 as _base");

    // Someone edits the file in a real editor while the page is open.
    const edited = CONFIG.replace('basePath: "/docs"', 'basePath: "/edited-elsewhere"');
    await Deno.writeTextFile(join(dir, "denext.config.ts"), edited);

    const res = await call(dir, "/config?section=basePath", {
      form: { ...fieldsFor("basePath", "/mine"), _base: base, confirm: "1" },
    });
    assertEquals(res.status, 409);
    assertStringIncludes(await res.text(), "changed on disk");
    assertEquals(await onDisk(dir), edited, "the editor's version survived");

    // Re-rendering hands out the fresh stamp, and the same write then applies.
    const fresh = (await (await call(dir, "/config/routing?key=redirects")).text())
      .match(/name="_base"[^>]*value="([0-9a-f]{64})"/)?.[1];
    assert(fresh && fresh !== base);
    const ok = await call(dir, "/config?section=basePath", {
      form: { ...fieldsFor("basePath", "/mine"), _base: fresh, confirm: "1" },
    });
    await ok.body?.cancel();
    assertStringIncludes(await onDisk(dir), 'basePath: "/mine"');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the /api twin, which posts no _base, opts out of the base-version check", async () => {
  const dir = await project();
  try {
    const res = await call(dir, "/api/config?section=basePath", {
      form: { ...fieldsFor("basePath", "/api-written"), confirm: "1" },
    });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).applied, true);
    assertStringIncludes(await onDisk(dir), 'basePath: "/api-written"');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("each Config view names itself in the document title", async () => {
  const dir = await project();
  try {
    // The five groups all rendered "Config · denext ui", so a browser could not tell two open
    // views of this panel apart. The label is what ships, not the group key.
    const titles: string[] = [];
    for (const group of ["routing", "security", "advanced"]) {
      const body = await (await call(dir, `/config/${group}`)).text();
      titles.push(/<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "");
    }
    assertEquals(titles, [
      "Config · Routing · denext ui",
      "Config · Security · denext ui",
      "Config · Advanced · denext ui",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a key that is on by default can finally be turned off", async () => {
  const dir = await project();
  try {
    // The band is scoped to ONE view, so the write goes to the view that owns the key —
    // `streaming` lives on Rendering, not on the default Routing page.
    //
    // `streaming` is absent from the fixture and on unless you say otherwise. Ticking Disable
    // posts the hidden "on" and then the checkbox "off" — the pair a browser sends — which
    // decodes to `false`. That used to be discarded as "an absent key with a false", so the key
    // could not be turned off from the editor at all.
    const off = await call(dir, "/api/config/rendering", { form: { streaming: ["on", "off"] } });
    assertEquals(off.status, 200);
    assertStringIncludes(
      (await off.json()).diff,
      "streaming",
      "opting out of a default-on key has to reach the file",
    );

    // Left alone, the box posts only its hidden companion: `true`, which is what the key already
    // is. That must propose nothing, or every untouched opt-out toggle would write noise.
    const left = await call(dir, "/api/config/rendering", { form: { streaming: ["on"] } });
    assertEquals((await left.json()).diff, "", "a key left at its default proposes nothing");

    // And an absent opt-in key, unticked, behaves exactly as it always did.
    const optIn = await call(dir, "/api/config/rendering", { form: { cacheComponents: ["off"] } });
    assertEquals((await optIn.json()).diff, "", "an absent opt-in key stays absent");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("/config is the Configuration index, and its twin is still the editor", async () => {
  const dir = await project();
  try {
    // The page is a front door: a card per view, and no editor of its own. It does not even
    // read the config file — the views do that.
    const index = await call(dir, "/config");
    assertEquals(index.status, 200);
    const body = await index.text();
    for (const view of ["routing", "rendering", "security", "advanced", "cron"]) {
      assertStringIncludes(body, `href="/config/${view}"`, `${view} needs a card`);
    }
    assert(!body.includes("<form"), "the index offers cards, not a form");

    // The twin is NOT the index. Scripts call `/api/config` for the editor's payload, and that
    // contract predates the page being split into views — it must not move because a page did.
    const twin = await call(dir, "/api/config");
    assertEquals(twin.status, 200);
    const payload = await twin.json();
    assertEquals(payload.ok, true);
    assertEquals(payload.file, "denext.config.ts");
    assertEquals(payload.form, "object");
    assertEquals(payload.keys.basePath, { kind: "editable", value: "/docs" });

    // And a write still posts to `/config`, which is why the page keeps its POST.
    const wrote = await call(dir, "/config?section=basePath", {
      form: { basePath: "/site", confirm: "1" },
    });
    assertEquals(wrote.status, 303);
    assertEquals(wrote.headers.get("location"), "/config/routing?key=general");
    assertStringIncludes(await onDisk(dir), 'basePath: "/site"');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
