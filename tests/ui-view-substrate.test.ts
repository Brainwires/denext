// The component substrate of `denext ui` (src/ui/view.ts, the page shell in src/ui/layout.ts and
// the shared pieces in src/ui/components.ts): a rendered fragment nests inside a component tree
// without double escaping, attacker text is escaped in children and attributes, `renderPage`
// takes every view shape, a throwing view is the server's hardened 500, the layout and the shared
// components render their golden markup (captured from the retired string helpers' component
// twins), and the flip added no client code and (almost) no modules.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { htmlResponse, type RawHtml, renderPage, toHtml, UI_NAV_SECTIONS } from "../src/ui/html.ts";
import {
  DiffBlock,
  FileDetails,
  Input,
  Note,
  OpForm,
  Out,
  Panel,
  ResultList,
  SourceBlock,
  Table,
} from "../src/ui/components.ts";
import { layout, type LayoutOptions, UI_CSS_PATH, UI_JS_PATH } from "../src/ui/layout.ts";
import { Raw, renderView } from "../src/ui/view.ts";
import { UI_ROUTES } from "../src/ui/routes.ts";
import { startUiServer } from "../src/ui/server.ts";
import { UI_COOKIE } from "../src/ui/security.ts";
import { UI_JS } from "../src/ui/client.ts";

/** The named references the renderer (or literal markup) emits. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** Decode numeric (`&#38;`, `&#x26;`) and named (`&amp;`) character references to characters. */
function normaliseEntities(markup: string): string {
  return markup.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] !== "#") return NAMED[ref.toLowerCase()] ?? whole;
    const hex = ref[1] === "x" || ref[1] === "X";
    return String.fromCodePoint(parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}

/** A page body spelled with numeric references, which the layout must insert verbatim. */
const BODY: RawHtml = {
  __html: '<section id="panel"><h1>A &#38; &#60;b&#62; &#34;q&#34; &#39;x&#39;</h1></section>',
};

/** The golden document shell: everything around the per-test head tags, nav and body. */
function shell(head: string, nav: string, main: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' + head +
    `<link rel="stylesheet" href="${UI_CSS_PATH}"></head><body>` +
    '<input type="checkbox" id="nav-toggle" class="nav-toggle" aria-label="Navigation">' +
    `<aside class="sidebar"><span class="brand">denext\u00a0ui</span>` +
    '<label for="nav-toggle" class="nav-burger" aria-hidden="true">\u2630</label>' +
    `<nav>${nav}</nav></aside>` +
    `<main id="main">${main}</main><script type="module" src="${UI_JS_PATH}"></script>` +
    "</body></html>";
}

Deno.test("the layout renders its golden document, the body inserted verbatim", () => {
  const options: LayoutOptions = {
    title: `Config <&"'>`,
    nav: UI_NAV_SECTIONS,
    body: BODY,
    csrf: `tok"&<'>`,
    active: "/config/routing",
  };
  const nav = UI_NAV_SECTIONS.map((section) => {
    // An item under a heading carries `nested`, which is what indents it.
    const cls = section.label === undefined ? "" : ' class="nested"';
    return (section.label === undefined
      ? ""
      : `<span class="nav-section">${section.label}</span>`) +
      section.items.map((item) =>
        item.href === "/config/routing"
          ? `<a href="${item.href}"${cls} aria-current="page">${item.label}</a>`
          : `<a href="${item.href}"${cls}>${item.label}</a>`
      ).join("");
  }).join("");
  const head = '<meta name="denext-csrf" content="tok&quot;&amp;&lt;&#39;&gt;">' +
    "<title>Config &lt;&amp;&quot;&#39;&gt; · denext ui</title>";
  // The body fragment is inserted verbatim: its own numeric references survive untouched.
  assertEquals(renderPage(layout, options), shell(head, nav, toHtml(BODY)));
});

Deno.test("the layout escapes an attacker title and nav label, with no entry current", () => {
  const options: LayoutOptions = {
    title: "</title><script>alert(1)</script>",
    nav: [{ items: [{ href: '/x"onmouseover="alert(1)', label: "<img src=x>" }] }],
    body: { __html: "" },
    csrf: "c",
  };
  const page = renderPage(layout, options);
  const head = '<meta name="denext-csrf" content="c">' +
    "<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; · denext ui</title>";
  const nav = '<a href="/x&quot;onmouseover=&quot;alert(1)">&lt;img src=x&gt;</a>';
  assertEquals(page, shell(head, nav, ""));
  assert(!page.includes("aria-current"), "no entry is current");
  assert(!page.includes("<script>alert"), "the title is escaped");
  assert(!page.includes("<img"), "a nav label is escaped");
});

Deno.test("the sidebar names the modes that change what every panel will do", () => {
  const base = { title: "t", nav: UI_NAV_SECTIONS, body: { __html: "" } as RawHtml, csrf: "c" };
  // No mode on: no footer at all. The shell does not invent status it does not have.
  assert(!renderPage(layout, base).includes('class="mode"'), "no footer without a mode");
  // `--read-only` used to be announced only on the Overview, so on every other panel a refused
  // write looked like a bug rather than the mode it is.
  assert(
    renderPage(layout, { ...base, readOnly: true }).includes(
      '<p class="mode"><span class="badge warn">read-only</span></p>',
    ),
    "read-only is named in the shell",
  );
  assert(
    renderPage(layout, { ...base, readOnly: true, offline: true }).includes(
      '<p class="mode"><span class="badge warn">read-only</span>' +
        '<span class="badge info">offline</span></p>',
    ),
    "both modes render, in order, with no key attribute leaking",
  );
});

Deno.test("Raw nests a rendered fragment inside a component without escaping it twice", () => {
  const fragment: RawHtml = { __html: '<b title="&#34;">&#60;i&#62;</b>' };
  const out = toHtml(renderView(h("div", { id: "d" }, h(Raw, { html: fragment }))));
  assertEquals(out, '<div id="d"><b title="&#34;">&#60;i&#62;</b></div>');
  // A trusted markup string works too, and the marker element never survives the render.
  const page = toHtml(renderView(h("p", null, "a", h(Raw, { html: "<br>" }), "b")));
  assertEquals(page, "<p>a<br>b</p>");
  assert(
    !renderPage(layout, { title: "t", nav: UI_NAV_SECTIONS, body: BODY, csrf: "c" }).includes(
      "denext-ui-raw",
    ),
  );
});

Deno.test("a rendered view nests inside another view through Raw without escaping", () => {
  const inner = renderView(h("em", { title: 'a"b' }, "x & y"));
  assertEquals(
    toHtml(renderView(h("p", null, h(Raw, { html: inner })))),
    '<p><em title="a&quot;b">x &amp; y</em></p>',
  );
  // Several rendered views nest element-wise, like any other children.
  const items = ["<1>", "<2>"].map((n) => h(Raw, { key: n, html: renderView(h("li", null, n)) }));
  assertEquals(
    toHtml(renderView(h("ul", null, items))),
    "<ul><li>&lt;1&gt;</li><li>&lt;2&gt;</li></ul>",
  );
});

Deno.test("attacker text is escaped in component children and attributes", () => {
  const evil = `"><script>alert(1)</script>&'`;
  const out = toHtml(renderView(h("a", {
    href: "javascript:alert(1)",
    title: evil,
    "data-x": evil,
    onclick: "alert(1)",
  }, evil)));
  assert(!out.includes("<script>"), out);
  assert(!out.includes("javascript:"), "a script URL is dropped from href");
  assert(!out.includes("onclick"), "an on* attribute is never emitted");
  const escaped = "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&#39;";
  assertStringIncludes(out, `title="${escaped}"`);
  assertStringIncludes(out, `data-x="${escaped}"`);
  assertStringIncludes(out, `>${escaped}</a>`);
  assertEquals(normaliseEntities(/>([^<]*)<\/a>$/.exec(out)?.[1] ?? ""), evil);
});

Deno.test("boolean attributes render bare or not at all; void elements get no slash", () => {
  const out = toHtml(renderView(h(
    "form",
    { method: "post", action: "/x" },
    h("input", { type: "hidden", name: "_csrf", value: "tok" }),
    h("input", { type: "checkbox", name: "c", checked: false, disabled: true }),
    h("br", null),
    h("button", { type: "submit", disabled: true, hidden: false }, "Apply"),
    h("div", { "aria-busy": true, "aria-hidden": false }),
  )));
  // Void elements: no closing tag, no self-closing slash — as every form's hidden fields are.
  assertStringIncludes(out, '<input type="hidden" name="_csrf" value="tok">');
  assertStringIncludes(out, "<br><button");
  // A true boolean is bare, a false one is absent — `OpForm`'s `<button … disabled>`.
  assertStringIncludes(out, '<input type="checkbox" name="c" disabled>');
  assertStringIncludes(out, '<button type="submit" disabled>Apply</button>');
  // The documented delta: aria-*/data-* booleans serialise as the strings React writes.
  assertStringIncludes(out, '<div aria-busy="true" aria-hidden="false"></div>');
});

Deno.test("renderPage takes a component tree, a rendered fragment, or a markup string", () => {
  const props = { n: "<n>" };
  assertEquals(renderPage((p: typeof props) => h("p", null, p.n), props), "<p>&lt;n&gt;</p>");
  // A fragment or a string is already markup: it passes through untouched.
  const fragment: RawHtml = { __html: "<p>&#60;n&#62;</p>" };
  assertEquals(renderPage(() => fragment, props), "<p>&#60;n&#62;</p>");
  assertEquals(renderPage(() => "<p>x</p>", props), "<p>x</p>");
  // The layout through the seam is exactly its own rendered tree.
  const options = { title: "t", nav: UI_NAV_SECTIONS, body: BODY, csrf: "c", active: "/" };
  assertEquals(renderPage(layout, options), toHtml(renderView(layout(options))));
});

Deno.test("OpForm renders its golden markup: token, hidden fields, extras, button", () => {
  const options = {
    action: '/wizard?a="b"',
    label: "Apply <this> & that",
    fields: { op: "denojson", confirm: "1", odd: `"'<>&` },
    className: "op",
    disabled: true,
  };
  const extra = h("input", { type: "hidden", name: "task", value: "build" });
  assertEquals(
    toHtml(renderView(h(OpForm, { csrf: `tok"&`, ...options, extra }))),
    '<form method="post" action="/wizard?a=&quot;b&quot;" class="op">' +
      '<input type="hidden" name="_csrf" value="tok&quot;&amp;">' +
      '<input type="hidden" name="op" value="denojson">' +
      '<input type="hidden" name="confirm" value="1">' +
      '<input type="hidden" name="odd" value="&quot;&#39;&lt;&gt;&amp;">' +
      '<input type="hidden" name="task" value="build">' +
      '<button type="submit" disabled>Apply &lt;this&gt; &amp; that</button></form>',
  );
  // Enabled, with no class and no extra: the attributes it omits, it omits exactly.
  assertEquals(
    toHtml(renderView(h(OpForm, { csrf: "c", action: "/x", label: "Go" }))),
    '<form method="post" action="/x"><input type="hidden" name="_csrf" value="c">' +
      '<button type="submit">Go</button></form>',
  );
});

Deno.test("DiffBlock renders its golden markup, every newline kept as content", () => {
  const diff = '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-was <b> & "q"\n+now\n ctx\n\n+last';
  const component = toHtml(renderView(h(DiffBlock, { diff })));
  // No whitespace normalisation here: inside <pre> every newline is content.
  assertEquals(
    component,
    '<pre class="out"><code class="diff"><span class="meta">--- a/x</span>\n' +
      '<span class="meta">+++ b/x</span>\n<span class="meta">@@ -1,2 +1,2 @@</span>\n' +
      '<span class="del">-was &lt;b&gt; &amp; &quot;q&quot;</span>\n' +
      '<span class="add">+now</span>\n ctx\n\n<span class="add">+last</span></code></pre>',
  );
  assertStringIncludes(component, '<span class="del">-was &lt;b&gt; &amp; &quot;q&quot;</span>');
  assertStringIncludes(component, "\n ctx\n\n<span");
});

Deno.test("Note and Out render the panels' note and output block", () => {
  assertEquals(toHtml(renderView(h(Note, null, "a <b>"))), '<p class="note">a &lt;b&gt;</p>');
  assertEquals(
    toHtml(renderView(h(Note, { role: "alert" }, "a"))),
    '<p class="note" role="alert">a</p>',
  );
  assertEquals(toHtml(renderView(h(Out, null))), '<pre class="out"></pre>');
  assertEquals(toHtml(renderView(h(Out, null, "x\n<y>"))), '<pre class="out">x\n&lt;y&gt;</pre>');
});

Deno.test("SourceBlock brings a sliced value's lines back to its own column", () => {
  const render = (source: string) => toHtml(renderView(h(SourceBlock, { source })));
  // The shape the config reader hands back for `plugins: [ … ]`: the span starts AT the bracket,
  // so line 1 arrives with no indent while the lines under it keep the file's. Rendered raw that
  // is the misalignment this component exists to undo.
  assertEquals(
    render("[\n    openapi(),\n  ]"),
    '<pre class="out">[\n  openapi(),\n]</pre>',
  );
  // One line has no continuation to move.
  assertEquals(render("true"), '<pre class="out">true</pre>');
  // A blank line inside the value does not get a vote on the common indent, and is not padded.
  assertEquals(
    render("[\n    a,\n\n    b,\n  ]"),
    '<pre class="out">[\n  a,\n\n  b,\n]</pre>',
  );
  // Lines sharing no prefix — a tab beside spaces — are left exactly as they arrived: showing
  // the value plainly beats guessing at what its author meant.
  const mixed = "{\n\ta: 1,\n  b: 2,\n}";
  assertEquals(render(mixed), '<pre class="out">' + mixed + "</pre>");
});

Deno.test("the shared panel pieces render one fixed markup each", () => {
  const render = (node: VNode) => toHtml(renderView(node));
  assertEquals(
    render(h(Panel, { title: "T" }, h("p", null, "x"))),
    '<section id="panel"><h1>T</h1><p>x</p></section>',
  );
  assertEquals(
    render(h(Panel, { name: "P", title: "T" })),
    '<section id="panel" data-panel="P"><h1>T</h1></section>',
  );
  assertEquals(
    render(h(Table, { head: ["k", ""], rows: [h("tr", null, h("td", null, "v"))] })),
    '<table class="table"><thead><tr><th>k</th><th></th></tr></thead>' +
      "<tbody><tr><td>v</td></tr></tbody></table>",
  );
  const groups = [{ marker: "+ ", paths: ["a"] }, { marker: "• ", paths: ["b", "c"] }];
  assertEquals(
    render(h(ResultList, { groups })),
    "<h2>Result</h2><ul><li>+ <code>a</code></li><li>• <code>b</code></li>" +
      "<li>• <code>c</code></li></ul>",
  );
  assertEquals(
    render(h(FileDetails, { path: "f", badge: "new", open: true }, "body")),
    '<details open><summary><code>f</code> <span class="badge">new</span></summary>body</details>',
  );
  // Input: attributes in one fixed order, a true boolean bare, an empty placeholder dropped.
  const input = { type: "text", name: "n", value: "v", maxLength: 9, id: "i" } as const;
  assertEquals(
    render(
      h(Input, { ...input, placeholder: "", ariaLabel: "A", required: true, disabled: false }),
    ),
    '<input type="text" name="n" value="v" maxlength="9" id="i" aria-label="A" required>',
  );
});

/** Serve one extra route on a live UI server, fetch it, and restore the table. */
async function fetchVia(path: string, view: () => unknown): Promise<Response[]> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_view_" });
  UI_ROUTES[path] = {
    methods: ["GET"],
    handle: () => Promise.resolve(htmlResponse(renderPage(view as () => string, undefined))),
  };
  const server = await startUiServer({ dir, port: 0 });
  const headers = { cookie: `${UI_COOKIE}=${server.token}` };
  const base = `http://127.0.0.1:${server.port}`;
  const logged = console.error;
  console.error = () => {};
  try {
    const failed = await fetch(`${base}${path}`, { headers });
    const after = await fetch(`${base}/`, { headers });
    return [new Response(await failed.text(), failed), new Response(await after.text(), after)];
  } finally {
    console.error = logged;
    delete UI_ROUTES[path];
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a view that throws mid-tree is the server's hardened 500, not a half page", async () => {
  function Boom(): never {
    throw new Error("view exploded");
  }
  const [failed, after] = await fetchVia(
    "/__boom",
    () => h("section", { id: "panel" }, h("p", null, "before"), h(Boom, null)),
  );
  assertEquals(failed.status, 500);
  assertEquals(await failed.json(), { ok: false, reason: "internal error" });
  assertEquals(after.status, 200, "the server keeps serving after a failed render");
  assertStringIncludes(await after.text(), "<!doctype html>");
});

Deno.test("an async component in a view is refused synchronously (500), never awaited", async () => {
  async function Slow(): Promise<never> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new Error("never reached");
  }
  const [failed] = await fetchVia("/__slow", () => h("div", null, h(Slow, null)));
  assertEquals(failed.status, 500);
  assertEquals((await failed.json()).reason, "internal error");
  // Let the swallowed floating promise settle so the op sanitizer sees no pending timer.
  await new Promise((resolve) => setTimeout(resolve, 10));
});

/** `deno info --json`'s shape, as far as the graph walk needs it. */
interface GraphJson {
  roots: string[];
  modules: {
    specifier: string;
    dependencies?: { code?: { specifier: string }; type?: { specifier: string } }[];
    /** An `@ts-self-types` / `X-TypeScript-Types` edge (a wasm binding's `.d.ts`). */
    typesDependency?: { dependency?: { specifier: string } };
  }[];
  redirects: Record<string, string>;
}

/** One module's outgoing edges: code, type, and `@ts-self-types` imports. */
function edgesOf(module: GraphJson["modules"][number] | undefined): string[] {
  const edges: string[] = [];
  for (const dep of module?.dependencies ?? []) {
    if (dep.code) edges.push(dep.code.specifier);
    if (dep.type) edges.push(dep.type.specifier);
  }
  const types = module?.typesDependency?.dependency;
  if (types) edges.push(types.specifier);
  return edges;
}

/** Every module reachable from the root without entering one of `cut`. */
function reachableWithout(graph: GraphJson, cut: (specifier: string) => boolean): Set<string> {
  const bySpecifier = new Map(graph.modules.map((m) => [m.specifier, m]));
  const seen = new Set<string>();
  const queue = [graph.roots[0]];
  while (queue.length > 0) {
    const at = queue.pop()!;
    const specifier = graph.redirects[at] ?? at;
    if (seen.has(specifier) || cut(specifier)) continue;
    seen.add(specifier);
    queue.push(...edgesOf(bySpecifier.get(specifier)));
  }
  return seen;
}

Deno.test("the flip adds exactly the three view modules to the UI server's graph", async () => {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", "src/ui/server.ts"],
    cwd: new URL("../", import.meta.url).pathname,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(output.success, new TextDecoder().decode(output.stderr));
  const graph = JSON.parse(new TextDecoder().decode(output.stdout)) as GraphJson;
  const all = graph.modules.map((m) => m.specifier);
  // Cut the edges into the view layer: everything it reaches (the JSX runtime, the string
  // renderer) must still be reached without it — so the flip added those two files and nothing
  // else, however the rest of the UI graph grows around them.
  const isView = (s: string) => /\/src\/ui\/(view|layout|components)\.ts$/.test(s);
  const without = reachableWithout(graph, isView);
  const added = all.filter((s) => !without.has(s)).map((s) => s.replace(/^.*\/src\//, "src/"));
  assertEquals(added.sort(), ["src/ui/components.ts", "src/ui/layout.ts", "src/ui/view.ts"]);
  assert(
    all.some((s) => s.endsWith("src/jsx/render-to-string.ts")),
    "the renderer was in the graph",
  );
  assert(
    all.length <= without.size + 3,
    `the view layer added ${all.length - without.size} modules (budget: 3)`,
  );
  assertEquals(all.filter((s) => /esbuild|^npm:/.test(s)), []);
});

Deno.test("the client module is unchanged by the flip: no JSX, no hydration", () => {
  assert(!/jsx|hydrat/i.test(UI_JS), "ui.js stays progressive enhancement only");
  assertStringIncludes(UI_JS, "DOMParser");
  // The unsaved-changes guard: its BEHAVIOUR is the e2e suite's subject (nightly, a real
  // browser), so this is the cheap always-run check that it is still there at all — and that it
  // is still built as nodes rather than assembled as markup, which is what keeps the strict CSP
  // and the no-innerHTML rule intact.
  assertStringIncludes(UI_JS, "nav-guard");
  assertStringIncludes(UI_JS, 'form[data-dirty-track][data-dirty="1"]');
  assertStringIncludes(UI_JS, "document.body.append(dialog)");
  // The word itself appears in swapPanel's comment, which is the rule being stated rather
  // than broken; what must never appear is an ASSIGNMENT.
  assert(!/\.innerHTML\s*=/.test(UI_JS), "nothing in ui.js is assigned as markup");
});
