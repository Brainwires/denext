// Coverage for runtime font + script helpers: localFont CSS generation, FontFace,
// googleFontUrl skeleton building, googleFont fetch (success + failure via a stubbed
// fetch), and the <Script> strategy → attribute mapping + client script injection.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { FontFace, localFont } from "../src/runtime/font.ts";
import { googleFont, googleFontUrl } from "../src/runtime/font-google.ts";
import { handleClientScriptLoad, initScriptLoader, Script } from "../src/runtime/script.ts";

// ---- localFont / FontFace --------------------------------------------------

Deno.test("localFont builds @font-face CSS from a single string src with a format hint", () => {
  const f = localFont({ family: "Inter", src: "/fonts/inter.woff2" });
  assertStringIncludes(f.css, '@font-face{font-family:"Inter";');
  assertStringIncludes(f.css, 'url("/fonts/inter.woff2") format("woff2")');
  assertStringIncludes(f.css, "font-display:swap;");
  assertEquals(f.fontFamily, '"Inter"');
  assertEquals(f.style.fontFamily, '"Inter"');
});

Deno.test("localFont supports multiple faces, fallbacks, per-source + default weight/style", () => {
  const f = localFont({
    family: "My Font",
    src: [
      { url: "/a.ttf", weight: "400" },
      { url: "/b.otf", style: "italic" },
      { url: "/c.unknownext" }, // no recognized extension → no format() hint
    ],
    weight: "700",
    style: "normal",
    display: "optional",
    fallback: ["system-ui", "sans-serif"],
  });
  assertStringIncludes(f.css, 'format("truetype")'); // .ttf
  assertStringIncludes(f.css, 'format("opentype")'); // .otf
  assert(!f.css.includes('format("unknownext")'), "unknown extension yields no format() hint");
  assertStringIncludes(f.css, "font-weight:400;"); // per-source weight
  assertStringIncludes(f.css, "font-style:italic;"); // per-source style
  assertStringIncludes(f.css, "font-weight:700;"); // default weight on the source that omitted it
  assertStringIncludes(f.css, "font-display:optional;");
  assertEquals(f.fontFamily, '"My Font", system-ui, sans-serif');
});

Deno.test("FontFace renders the css into a <style> via dangerouslySetInnerHTML", () => {
  const f = localFont({ family: "X", src: "/x.woff" });
  const vnode = FontFace({ font: f });
  assertEquals(vnode.type, "style");
  assertEquals(
    (vnode.props.dangerouslySetInnerHTML as { __html: string }).__html,
    f.css,
  );
});

// ---- googleFontUrl ---------------------------------------------------------

Deno.test("googleFontUrl encodes family, wght axis and display", () => {
  const url = googleFontUrl({ family: "Roboto Mono", weights: [400, 700] });
  assertStringIncludes(url, "family=Roboto+Mono:wght@400;700");
  assertStringIncludes(url, "&display=swap");
});

Deno.test("googleFontUrl builds the ital,wght axis for italic styles", () => {
  const url = googleFontUrl({
    family: "Inter",
    weights: [400],
    styles: ["normal", "italic"],
    display: "optional",
  });
  assertStringIncludes(url, "ital,wght@0,400;1,400");
  assertStringIncludes(url, "&display=optional");
});

Deno.test("googleFontUrl defaults to weight 400 when none given", () => {
  assertStringIncludes(googleFontUrl({ family: "Lato" }), "family=Lato:wght@400");
});

// ---- googleFont (stubbed fetch) --------------------------------------------

Deno.test("googleFont fetches the CSS and returns a FontResult with fallbacks", async () => {
  const original = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = ((input: string | URL | Request) => {
    requestedUrl = String(input);
    return Promise.resolve(new Response("/* @font-face css */", { status: 200 }));
  }) as typeof fetch;
  try {
    const result = await googleFont({ family: "Inter", weights: [400], fallback: ["sans-serif"] });
    assertStringIncludes(requestedUrl, "fonts.googleapis.com/css2?family=Inter");
    assertEquals(result.fontFamily, '"Inter", sans-serif');
    assertStringIncludes(result.css, "@font-face");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("googleFont throws on a non-ok response", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response("nope", { status: 404 }))) as typeof fetch;
  try {
    await assertRejects(
      () => googleFont({ family: "Missing" }),
      Error,
      'failed to fetch "Missing" (404)',
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ---- Script ----------------------------------------------------------------

Deno.test("Script defaults to afterInteractive: external scripts get defer", () => {
  const vnode = Script({ src: "/a.js" });
  assertEquals(vnode.type, "script");
  assertEquals(vnode.props.defer, true);
  assertEquals(vnode.props.src, "/a.js");
});

Deno.test("Script beforeInteractive does not defer", () => {
  const vnode = Script({ src: "/a.js", strategy: "beforeInteractive" });
  assert(!("defer" in vnode.props) || vnode.props.defer !== true);
});

Deno.test("Script lazyOnload adds fetchpriority=low and defer", () => {
  const vnode = Script({ src: "/a.js", strategy: "lazyOnload" });
  assertEquals(vnode.props.fetchpriority, "low");
  assertEquals(vnode.props.defer, true);
});

Deno.test("Script worker degrades to afterInteractive (deferred external)", () => {
  const vnode = Script({ src: "/w.js", strategy: "worker" });
  assertEquals(vnode.props.defer, true);
});

Deno.test("Script with inline children renders dangerouslySetInnerHTML and no defer", () => {
  const vnode = Script({ children: "console.log(1)" });
  assertEquals(
    (vnode.props.dangerouslySetInnerHTML as { __html: string }).__html,
    "console.log(1)",
  );
  assert(!("defer" in vnode.props), "inline scripts are not deferred");
});

// ---- handleClientScriptLoad / initScriptLoader (client-only) ---------------

Deno.test("handleClientScriptLoad is a no-op during SSR (no document)", () => {
  assertEquals(typeof (globalThis as { document?: unknown }).document, "undefined");
  // Should simply return without throwing.
  handleClientScriptLoad({ src: "/x.js" });
  initScriptLoader([{ src: "/y.js" }]);
});

Deno.test("handleClientScriptLoad injects a script and dedupes by src on the client", () => {
  const appended: Array<Record<string, unknown>> = [];
  const existing = new Set<string>();
  const fakeDoc = {
    querySelector(sel: string) {
      // sel looks like: script[src="..."]
      const m = /src="(.*)"/.exec(sel);
      return m && existing.has(m[1]) ? {} : null;
    },
    createElement(_tag: string) {
      const attrs: Record<string, unknown> = {};
      return {
        attrs,
        textContent: "",
        setAttribute(k: string, v: string) {
          attrs[k] = v;
        },
        addEventListener() {},
      };
    },
    body: {
      appendChild(el: { attrs: Record<string, unknown> }) {
        appended.push(el.attrs);
        if (typeof el.attrs.src === "string") existing.add(el.attrs.src);
      },
    },
  };
  const g = globalThis as { document?: unknown; CSS?: unknown };
  const origDoc = g.document;
  const origCss = g.CSS;
  g.document = fakeDoc;
  g.CSS = { escape: (s: string) => s };
  try {
    handleClientScriptLoad({ src: "/one.js", id: "s1" });
    assertEquals(appended.length, 1);
    assertEquals(appended[0].src, "/one.js");
    assertEquals(appended[0].id, "s1");
    // Second call with the same src is deduped.
    handleClientScriptLoad({ src: "/one.js" });
    assertEquals(appended.length, 1, "same src is not appended twice");
    // A different src is injected.
    initScriptLoader([{ src: "/two.js" }, { children: "inline()" }]);
    assertEquals(appended.length, 3);
    assertEquals(appended[2].src, undefined, "inline script has no src attribute");
  } finally {
    g.document = origDoc;
    g.CSS = origCss;
  }
});
