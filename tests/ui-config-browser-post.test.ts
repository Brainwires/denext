// The config editor, driven with EXACTLY what a browser posts.
//
// Every other suite hands the editor a body it built by hand, or through `encode`, and that is
// how the bug this file exists for shipped: the renderer emitted a presence marker for every list
// and a hidden `off` for every toggle, so a browser posting an untouched form for a key the file
// never set decoded it to `[]` / `false` — and one save of Rendering → Images wrote
// `deviceSizes: []`, `qualities: []`, `unoptimized: false` into a config that had never mentioned
// them, and an empty width allowlist refuses every image. `browserPost` here scrapes the rendered
// form the way a browser reads it (checked boxes only, the selected option, no disabled control,
// the textarea's first newline dropped), so these tests can only pass if the whole loop — render,
// post, decode, plan, diff, confirm, write — agrees about what "untouched" means.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { SseClients } from "../src/build/sse.ts";
import type { UiContext } from "../src/ui/html.ts";
import { configPanel } from "../src/ui/features/config.ts";
import { browserPost, formsWith, unescapeAttr as unescape } from "./helpers/browser-form.ts";

/** A config that sets a few keys in every view, and one key the schema does not know. */
const POPULATED = `// the project config
export default {
  // legacy spelling, still honoured — and unknown to the editor's schema
  experimental: { cacheComponents: true, features: { A: true } },
  streaming: true,
  basePath: "/docs",
  i18n: { locales: ["en", "fr"], defaultLocale: "en", localeDetection: false },
  images: { remotePatterns: [{ protocol: "https", hostname: "a.example" }], minimumCacheTTL: 0 },
};
`;

/** A temp project holding `source` as its config. */
async function project(source: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_browser_" });
  await Deno.writeTextFile(join(dir, "denext.config.ts"), source);
  return dir;
}

/** The config file as it stands on disk. */
async function onDisk(dir: string): Promise<string> {
  return await Deno.readTextFile(join(dir, "denext.config.ts"));
}

/** One request against the panel, with the kernel's context already assembled. */
async function call(dir: string, path: string, fields?: readonly (readonly [string, string])[]) {
  const url = new URL(`http://127.0.0.1:5177${path}`);
  const form = fields === undefined ? undefined : new FormData();
  for (const [name, value] of fields ?? []) form?.append(name, value);
  const ctx: UiContext = {
    dir,
    url,
    method: form ? "POST" : "GET",
    readOnly: false,
    csrf: "csrf-token",
    json: false,
    fragment: false,
    form,
    events: new Set() as SseClients,
  };
  const res = await configPanel(new Request(url, { method: ctx.method }), ctx);
  return { status: res.status, body: await res.text() };
}

/** Every editor form on a page: `method="post"` and carrying the editor's `_base` stamp. */
function editorForms(body: string): { action: string; markup: string }[] {
  return formsWith(body, 'name="_base"').filter((form) => !form.markup.includes('name="raw"'));
}

/** The posted fields with one control's value replaced (or added when the form lacks it). */
function edited(fields: [string, string][], name: string, value: string): [string, string][] {
  const found = fields.some(([field]) => field === name);
  const next = fields.map(([field, held]): [string, string] =>
    field === name ? [field, value] : [field, held]
  );
  return found ? next : [...next, [name, value]];
}

/** Only the changed lines of the diff a preview shows (none when it shows no diff). */
function changed(body: string): string[] {
  const open = body.indexOf('<pre class="out">');
  if (open < 0) return [];
  const text = body.slice(open, body.indexOf("</pre>", open)).replace(/<[^>]+>/g, "");
  return unescape(text).split("\n").filter((line) => /^[+-](?![+-])/.test(line));
}

/** The message of the page's alert, if it shows one. */
function alertOf(body: string): string | undefined {
  return /role="alert"[^>]*>([\s\S]*?)<\/(?:p|div)>/.exec(body)?.[1];
}

/** Every editor form on every view and tab, as `[href, action, fields]`. */
async function everyForm(dir: string): Promise<[string, string, [string, string][]][]> {
  const out: [string, string, [string, string][]][] = [];
  for (const view of ["routing", "rendering", "security", "advanced"]) {
    const page = (await call(dir, `/config/${view}`)).body;
    const tabs = [...page.matchAll(/href="(\/config\/[a-z]+\?key=[^"]+)"/g)]
      .map((match) => unescape(match[1]));
    for (const href of [`/config/${view}`, ...new Set(tabs)]) {
      const body = href === `/config/${view}` ? page : (await call(dir, href)).body;
      for (const form of editorForms(body)) out.push([href, form.action, browserPost(form.markup)]);
    }
  }
  return out;
}

for (const [label, source] of [["an empty", "export default {};\n"], ["a populated", POPULATED]]) {
  Deno.test(`saving every view and tab of ${label} config untouched proposes nothing and writes nothing`, async () => {
    const dir = await project(source);
    try {
      const forms = await everyForm(dir);
      assert(forms.length > 20, `the sweep found ${forms.length} forms`);
      for (const [href, action, fields] of forms) {
        const res = await call(dir, action, fields);
        const where = `${href} → ${action}`;
        assertEquals(res.status, 200, `${where}: ${alertOf(res.body) ?? res.status}`);
        assertEquals(changed(res.body), [], `${where} proposed a change nobody made`);
        assertEquals(alertOf(res.body), undefined, `${where} refused an untouched form`);
      }
      assertEquals(await onDisk(dir), source, "the sweep wrote nothing");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("ticking one image format writes that key alone — no `[]` for the allowlists it never set", async () => {
  const dir = await project(POPULATED);
  try {
    const page = (await call(dir, "/config/rendering?key=images")).body;
    const [form] = editorForms(page);
    // The avif box is unticked; a browser posts it under its indexed name when ticked.
    const avif = /<input\b[^>]*name="(images\.formats\[\d+\])"[^>]*value="image\/avif"/.exec(page);
    assert(avif, "the avif box is rendered");
    const preview = await call(dir, form.action, [...browserPost(form.markup), [
      avif[1],
      "image/avif",
    ]]);
    assertEquals(preview.status, 200, alertOf(preview.body));
    const lines = changed(preview.body);
    assert(lines.some((line) => line.includes('formats: ["image/avif"]')), lines.join("\n"));
    for (const key of ["deviceSizes", "imageSizes", "qualities", "localPatterns", "unoptimized"]) {
      assert(
        !lines.some((line) => line.includes(key)),
        `${key} was never set: ${lines.join("\n")}`,
      );
    }
    // Confirm with the fields the preview's own form carries, plus the confirm flag.
    const [confirm] = editorForms(preview.body).filter((f) => f.markup.includes('name="confirm"'));
    assert(confirm, "the preview offers a confirm form");
    const applied = await call(dir, confirm.action, [...browserPost(confirm.markup), [
      "confirm",
      "1",
    ]]);
    assertEquals(applied.status, 303, alertOf(applied.body));
    const written = await onDisk(dir);
    assertStringIncludes(written, 'formats: ["image/avif"]');
    assert(!written.includes("deviceSizes"), written);
    assertStringIncludes(written, "// the project config", "the file's comments survive");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("clearing a scalar on a view is applied on confirm, not silently dropped", async () => {
  const dir = await project(POPULATED);
  try {
    const page = (await call(dir, "/config/routing")).body;
    const [band] = editorForms(page);
    const preview = await call(dir, band.action, edited(browserPost(band.markup), "basePath", ""));
    assertEquals(preview.status, 200, alertOf(preview.body));
    assert(changed(preview.body).some((line) => line.startsWith("-") && line.includes("basePath")));
    const [confirm] = editorForms(preview.body).filter((f) => f.markup.includes('name="confirm"'));
    assert(confirm, "the preview offers a confirm form");
    const applied = await call(dir, confirm.action, [...browserPost(confirm.markup), [
      "confirm",
      "1",
    ]]);
    assertEquals(applied.status, 303, alertOf(applied.body));
    assert(!(await onDisk(dir)).includes("basePath"), "the key is gone");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("saving a group keeps the keys the editor's schema does not know", async () => {
  const dir = await project(POPULATED);
  try {
    const page = (await call(dir, "/config/advanced?key=experimental")).body;
    const [form] = editorForms(page);
    const reactCompiler =
      /<input\b[^>]*name="(experimental\.reactCompiler)"[^>]*type="checkbox"[^>]*value="([^"]*)"/
        .exec(page);
    assert(reactCompiler, "the reactCompiler box is rendered");
    const fields = [
      ...browserPost(form.markup),
      [reactCompiler[1], reactCompiler[2]] as [string, string],
    ];
    const preview = await call(dir, form.action, fields);
    assertEquals(preview.status, 200, alertOf(preview.body));
    const lines = changed(preview.body);
    assert(lines.some((line) => line.includes("reactCompiler")), lines.join("\n"));
    // The object is rewritten as one literal, so the diff replaces the line — and the line it
    // proposes still carries the key the schema does not know.
    const proposed = lines.filter((line) => line.startsWith("+"));
    assert(proposed.some((line) => line.includes("cacheComponents: true")), lines.join("\n"));
    const [confirm] = editorForms(preview.body).filter((f) => f.markup.includes('name="confirm"'));
    const applied = await call(dir, confirm.action, [...browserPost(confirm.markup), [
      "confirm",
      "1",
    ]]);
    assertEquals(applied.status, 303, alertOf(applied.body));
    const written = await onDisk(dir);
    assertStringIncludes(written, "cacheComponents: true", "the unknown key survived the save");
    assertStringIncludes(written, "reactCompiler");
    assertStringIncludes(written, "A: true");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("+ Add on an unset list hands back a blank row without complaint; saving writes that row alone", async () => {
  const dir = await project("export default {};\n");
  try {
    const page = (await call(dir, "/config/rendering?key=images")).body;
    const [form] = editorForms(page);
    const add = /value="(add:\d+:images\.remotePatterns)"/.exec(page);
    assert(add, "the list offers + Add");
    const draft = await call(dir, form.action, [...browserPost(form.markup), ["op", add[1]]]);
    assertEquals(draft.status, 200, alertOf(draft.body));
    assertEquals(alertOf(draft.body), undefined, "a blank row is not an error yet");
    assertStringIncludes(draft.body, 'name="images.remotePatterns[0].hostname"');
    assertEquals(await onDisk(dir), "export default {};\n");

    // Fill in the row and Save: the diff is the one pattern, and nothing else about images.
    const [next] = editorForms(draft.body);
    const filled = edited(
      browserPost(next.markup),
      "images.remotePatterns[0].hostname",
      "cdn.example",
    );
    const preview = await call(dir, next.action, filled);
    assertEquals(preview.status, 200, alertOf(preview.body));
    const lines = changed(preview.body);
    assert(lines.some((line) => line.includes('hostname: "cdn.example"')), lines.join("\n"));
    assert(!lines.some((line) => /deviceSizes|qualities|unoptimized/.test(line)), lines.join("\n"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
