// The component substrate of `denext ui` (src/ui/view.ts, the page shell in src/ui/layout.ts and
// the shared pieces in src/ui/components.ts): components and `html` fragments nest inside each
// other without double escaping, attacker text is escaped in children and attributes, `renderPage`
// takes every view shape, a throwing view is the server's hardened 500, the flipped layout and the
// shared components are their old string twins modulo entity spelling and inter-tag whitespace,
// and the flip added no client code and (almost) no modules.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  diffHtml,
  esc,
  html,
  htmlResponse,
  opForm,
  raw,
  renderPage,
  toHtml,
  UI_NAV,
} from "../src/ui/html.ts";
import { DiffBlock, Note, OpForm, Out } from "../src/ui/components.ts";
import { layout, type LayoutOptions, UI_CSS_PATH, UI_JS_PATH } from "../src/ui/layout.ts";
import { Raw, renderView } from "../src/ui/view.ts";
import { UI_ROUTES } from "../src/ui/routes.ts";
import { startUiServer } from "../src/ui/server.ts";
import { UI_COOKIE } from "../src/ui/security.ts";
import { UI_JS } from "../src/ui/client.ts";

/** The pre-flip string layout, verbatim — the golden the component layout is held to. */
function stringLayout(options: LayoutOptions): string {
  const nav = options.nav.map((item) =>
    html`
      <a href="${item.href}" ${item.href === options.active
        ? raw(' aria-current="page"')
        : ""}>${item.label}</a>
    `
  );
  return "<!doctype html>" + toHtml(html`
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="denext-csrf" content="${options.csrf}">
        <title>${options.title} · denext ui</title>
        <link rel="stylesheet" href="${UI_CSS_PATH}">
      </head>
      <body>
        <header class="topbar"><span class="brand">denext&nbsp;ui</span><nav>${nav}</nav></header>
        <main id="main">${options.body}</main>
        <script type="module" src="${UI_JS_PATH}"></script>
      </body>
    </html>
  `);
}

/** The named references either renderer (or the old literal markup) emits. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/**
 * Decode numeric (`&#38;`, `&#x26;`) and named (`&amp;`) character references to characters, so
 * `esc`'s numeric spelling and the component renderer's named spelling compare equal.
 */
function normaliseEntities(markup: string): string {
  return markup.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] !== "#") return NAMED[ref.toLowerCase()] ?? whole;
    const hex = ref[1] === "x" || ref[1] === "X";
    return String.fromCodePoint(parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}

/**
 * Entity-normalised markup with the template literal's indentation folded away: whitespace
 * between tags dropped, runs collapsed, none before a tag's `>`. ASCII whitespace only, so the
 * brand's no-break space still has to match exactly.
 */
function normalise(markup: string): string {
  return normaliseEntities(markup)
    .replace(/>[ \t\r\n]+</g, "><")
    .replace(/[ \t\r\n]+/g, " ")
    .replace(/ >/g, ">")
    .trim();
}

/** A page body with every character `esc` and the renderer spell differently. */
const BODY = html`
  <section id="panel">
    <h1>${`A & <b> "q" 'x'`}</h1>
  </section>
`;

Deno.test("the component layout is the string layout, modulo entity spelling and whitespace", () => {
  const options: LayoutOptions = {
    title: `Config <&"'>`,
    nav: UI_NAV,
    body: BODY,
    csrf: `tok"&<'>`,
    active: "/config",
  };
  const page = renderPage(layout, options);
  assertEquals(normalise(page), normalise(stringLayout(options)));
  assert(page.startsWith('<!doctype html><html lang="en">'), page.slice(0, 40));
  assertStringIncludes(page, '<a href="/config" aria-current="page">Config</a>');
  assertStringIncludes(page, '<span class="brand">denext\u00a0ui</span>');
  // The body fragment is inserted verbatim: its own numeric references survive untouched.
  assertStringIncludes(page, `<main id="main">${toHtml(BODY)}</main>`);
});

Deno.test("the component layout matches with no active entry and an attacker title", () => {
  const options: LayoutOptions = {
    title: "</title><script>alert(1)</script>",
    nav: [{ href: '/x"onmouseover="alert(1)', label: "<img src=x>" }],
    body: raw(""),
    csrf: "c",
  };
  const page = renderPage(layout, options);
  assertEquals(normalise(page), normalise(stringLayout(options)));
  assert(!page.includes("aria-current"), "no entry is current");
  assert(!page.includes("<script>alert"), "the title is escaped");
  assert(!page.includes("<img"), "a nav label is escaped");
  assertStringIncludes(page, 'href="/x&quot;onmouseover=&quot;alert(1)"');
});

Deno.test("Raw nests an html fragment inside component without escaping it twice", () => {
  const fragment = html`<b title="${'"'}">${"<i>"}</b>`;
  const out = toHtml(renderView(h("div", { id: "d" }, h(Raw, { html: fragment }))));
  assertEquals(out, '<div id="d"><b title="&#34;">&#60;i&#62;</b></div>');
  // A trusted markup string works too, and the marker element never survives the render.
  const page = toHtml(renderView(h("p", null, "a", h(Raw, { html: "<br>" }), "b")));
  assertEquals(page, "<p>a<br>b</p>");
  assert(
    !renderPage(layout, { title: "t", nav: UI_NAV, body: BODY, csrf: "c" }).includes(
      "denext-ui-raw",
    ),
  );
});

Deno.test("component nests inside an html template through renderView without escaping", () => {
  const node = h("em", { title: 'a"b' }, "x & y");
  assertEquals(
    toHtml(html`<p>${renderView(node)}</p>`),
    '<p><em title="a&quot;b">x &amp; y</em></p>',
  );
  // Arrays of rendered views interpolate element-wise, like any other fragment.
  const items = ["<1>", "<2>"].map((n) => renderView(h("li", null, n)));
  assertEquals(toHtml(html`<ul>${items}</ul>`), "<ul><li>&lt;1&gt;</li><li>&lt;2&gt;</li></ul>");
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
  // The one spelling difference from `esc`: named references instead of numeric ones.
  assertEquals(esc(evil), "&#34;&#62;&#60;script&#62;alert(1)&#60;/script&#62;&#38;&#39;");
  assertEquals(normaliseEntities(/>([^<]*)<\/a>$/.exec(out)?.[1] ?? ""), evil);
});

Deno.test("boolean and void attributes render the way the string views wrote them", () => {
  const out = toHtml(renderView(h(
    "form",
    { method: "post", action: "/x" },
    h("input", { type: "hidden", name: "_csrf", value: "tok" }),
    h("input", { type: "checkbox", name: "c", checked: false, disabled: true }),
    h("br", null),
    h("button", { type: "submit", disabled: true, hidden: false }, "Apply"),
    h("div", { "aria-busy": true, "aria-hidden": false }),
  )));
  // Void elements: no closing tag, no self-closing slash — as `opForm` / `hiddenField` write them.
  assertStringIncludes(out, '<input type="hidden" name="_csrf" value="tok">');
  assertStringIncludes(out, "<br><button");
  // A true boolean is bare, a false one is absent — `opForm`'s `<button … disabled>`.
  assertStringIncludes(out, '<input type="checkbox" name="c" disabled>');
  assertStringIncludes(out, '<button type="submit" disabled>Apply</button>');
  // The documented delta: aria-*/data-* booleans serialise as the strings React writes.
  assertStringIncludes(out, '<div aria-busy="true" aria-hidden="false"></div>');
});

Deno.test("renderPage takes a string, an html fragment, or a component tree", () => {
  const props = { n: "<n>" };
  assertEquals(renderPage((p: typeof props) => `<p>${esc(p.n)}</p>`, props), "<p>&#60;n&#62;</p>");
  assertEquals(renderPage((p: typeof props) => html`<p>${p.n}</p>`, props), "<p>&#60;n&#62;</p>");
  assertEquals(renderPage((p: typeof props) => h("p", null, p.n), props), "<p>&lt;n&gt;</p>");
  // The layout through the seam is exactly its own rendered tree.
  const options = { title: "t", nav: UI_NAV, body: BODY, csrf: "c", active: "/" };
  assertEquals(renderPage(layout, options), toHtml(renderView(layout(options))));
});

Deno.test("OpForm is opForm, modulo entity spelling and whitespace", () => {
  const options = {
    action: '/wizard?a="b"',
    label: "Apply <this> & that",
    fields: { op: "denojson", confirm: "1", odd: `"'<>&` },
    className: "op",
    disabled: true,
  };
  const extra = h("input", { type: "hidden", name: "task", value: "build" });
  const component = toHtml(renderView(h(OpForm, { csrf: `tok"&`, ...options, extra })));
  const string = toHtml(opForm(`tok"&`, { ...options, extra: renderView(extra) }));
  assertEquals(normalise(component), normalise(string));
  // Enabled, with no class and no extra: the attributes it omits, it omits exactly.
  const plain = { action: "/x", label: "Go" };
  assertEquals(
    normalise(toHtml(renderView(h(OpForm, { csrf: "c", ...plain })))),
    normalise(toHtml(opForm("c", plain))),
  );
});

Deno.test("DiffBlock is diffHtml byte for byte, modulo entity spelling only", () => {
  const diff = '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-was <b> & "q"\n+now\n ctx\n\n+last';
  const component = toHtml(renderView(h(DiffBlock, { diff })));
  // No whitespace normalisation here: inside <pre> every newline is content.
  assertEquals(normaliseEntities(component), normaliseEntities(toHtml(diffHtml(diff))));
  assertStringIncludes(component, '<span class="del">-was &lt;b&gt; &amp; &quot;q&quot;</span>');
  assertStringIncludes(component, "\n ctx\n\n<span");
});

Deno.test("Note and Out render the panels' note and output block", () => {
  assertEquals(toHtml(renderView(h(Note, null, "a <b>"))), '<p class="note">a &lt;b&gt;</p>');
  assertEquals(toHtml(renderView(h(Out, null))), '<pre class="out"></pre>');
  assertEquals(toHtml(renderView(h(Out, null, "x\n<y>"))), '<pre class="out">x\n&lt;y&gt;</pre>');
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
});
