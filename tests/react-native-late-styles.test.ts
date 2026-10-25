// React Native mode on the App Router: the rules react-native-web's style sheet gains while a
// streamed Suspense boundary renders reach the browser ahead of that boundary's content, once
// each, under the streamed response's hash-based CSP (src/server/late-style-sheets.ts).
//
// The sheet here is a stand-in with react-native-web's text shape (one rule per line, ordered
// groups behind `[stylesheet-group="N"]{}` markers), registered as React Native mode's server
// bundle registers the real one; each slow boundary inserts its rules as it renders, as a
// module first loaded inside the boundary does with `StyleSheet.create`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import { createResource, Suspense } from "../src/runtime/suspense.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { LATE_STYLES_RUNTIME_BODY } from "../src/server/late-style-sheets.ts";
import { lateStylesRuntimeHash, sha256Base64 } from "../src/server/csp.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { PageProps } from "../src/server/types.ts";
import type { VNode } from "../src/jsx/types.ts";

const REGISTRY = Symbol.for("denext.serverStyleSheets");
const SHEET_ID = "react-native-stylesheet";

/** A react-native-web-shaped ordered sheet: groups of rules, each group behind its marker. */
function orderedSheet() {
  const groups = new Map<number, string[]>();
  const insert = (rule: string, group: number) => {
    const rules = groups.get(group) ?? [];
    if (!rules.includes(rule)) rules.push(rule);
    groups.set(group, rules);
  };
  const textContent = () =>
    [...groups.keys()].sort((a, b) => a - b).flatMap((g) => [
      `[stylesheet-group="${g}"]{}`,
      ...groups.get(g)!.toSorted(),
    ]).join("\n");
  return { insert, textContent };
}

/** Register `sheet` as React Native mode's server bundle does; the returned function undoes it. */
function register(sheet: { textContent(): string }): () => void {
  const g = globalThis as Record<symbol, unknown>;
  const prev = g[REGISTRY];
  g[REGISTRY] = new Map([[SHEET_ID, () => ({ id: SHEET_ID, textContent: sheet.textContent() })]]);
  return () => {
    if (prev === undefined) delete g[REGISTRY];
    else g[REGISTRY] = prev;
  };
}

function appWith(home: unknown, config: Record<string, unknown> = {}) {
  const base = {
    kind: "page" as const,
    layoutChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  };
  const manifest: RouteManifest = {
    pages: [{ ...base, pattern: parsePattern("/"), routePath: "/", filePath: "home.tsx" }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
    directives: new Map(),
  };
  return createApp({
    getManifest: () => manifest,
    load: (fp: string) => Promise.resolve(fp === "home.tsx" ? home : undefined),
    ...config,
  });
}

/** A page with a styled shell and two slow boundaries, each adding rules when it renders. */
function page(sheet: ReturnType<typeof orderedSheet>, client?: unknown) {
  sheet.insert("body{margin:0;}", 0);
  sheet.insert(".r-shell{color:red;}", 2);
  const gates: Array<(v: string) => void> = [];
  const slow = (name: string, rules: Array<[string, number]>) => {
    const read = createResource(() => new Promise<string>((r) => gates.push(r)));
    return (): VNode => {
      const text = read();
      for (const [rule, group] of rules) sheet.insert(rule, group);
      return h("b", { className: `r-${name}` }, `${name}:${text}`);
    };
  };
  const A = slow("a", [[".r-a{color:blue;}", 2], [".r-shared{flex:1;}", 2.2], [".r-cls{x:y;}", 1]]);
  const B = slow("b", [[".r-b{color:green;}", 2], [".r-shared{flex:1;}", 2.2]]);
  const Page = (_p: PageProps): VNode =>
    h(
      "main",
      { className: "r-shell" },
      client ? h(client as () => VNode, null) : null,
      h(Suspense, { fallback: h("p", null, "…a"), children: h(A, null) }),
      h(Suspense, { fallback: h("p", null, "…b"), children: h(B, null) }),
    );
  return { Page, open: () => gates.splice(0).forEach((open) => open("ok")) };
}

/** The streamed rules blocks of `html`, in document order, each with where it sits. */
function rulesBlocks(html: string): Array<{ at: number; rules: Record<string, unknown[]> }> {
  const re = /<script type="application\/json" data-dnx-rules>([\s\S]*?)<\/script>/g;
  return [...html.matchAll(re)].map((m) => ({ at: m.index!, rules: JSON.parse(m[1]) }));
}

for (const flight of [false, true]) {
  Deno.test(`streamed Suspense (${flight ? "Flight" : "HTML"}): a late boundary's react-native-web rules stream ahead of it, once each, under the CSP`, async () => {
    const sheet = orderedSheet();
    const restore = register(sheet);
    try {
      let client: unknown;
      if (flight) {
        const Clock = (): VNode => h("time", null, "now");
        tagClientExports({ Clock } as Record<string, unknown>, "c_rn_late_clock");
        client = Clock;
      }
      const { Page, open } = page(sheet, client);
      const app = appWith({ default: Page }, { streaming: true });
      const res = await app(new Request("http://localhost/"));
      const csp = res.headers.get("content-security-policy");
      assert(csp, "the streamed response keeps its CSP");
      const hash = await lateStylesRuntimeHash();
      assertEquals(hash, `'sha256-${await sha256Base64(LATE_STYLES_RUNTIME_BODY)}'`);
      assertStringIncludes(csp, hash!, "the late-styles runtime is allowed by its hash");
      queueMicrotask(open);
      const html = await res.text();

      // The head carries what the shell used; the late rules are not in it.
      const head = html.slice(0, html.indexOf("</head>"));
      assertStringIncludes(head, ".r-shell{color:red;}");
      assert(!head.includes(".r-a{"), "a late rule is not in the head");

      const blocks = rulesBlocks(html);
      assert(blocks.length >= 1, "the late rules streamed");
      const streamed = blocks.flatMap((b) => b.rules[SHEET_ID] as Array<[number | null, string]>);
      const texts = streamed.map(([, rule]) => rule);
      // Each late rule once, with its group; nothing the head already carried.
      for (const rule of [".r-a{color:blue;}", ".r-b{color:green;}", ".r-shared{flex:1;}"]) {
        assertEquals(texts.filter((t) => t === rule).length, 1, `${rule} streams once`);
      }
      assert(!texts.includes(".r-shell{color:red;}"), "the head's rules are not repeated");
      assert(!texts.some((t) => t.startsWith("[stylesheet-group")), "markers are not rules");
      assertEquals(streamed.find(([, t]) => t === ".r-shared{flex:1;}")![0], 2.2);
      assertEquals(streamed.find(([, t]) => t === ".r-cls{x:y;}")![0], 1);

      // Before (or with) each boundary's content: every rule a boundary uses precedes its
      // template, and the runtime that applies a block follows it directly.
      for (const [name, rule] of [["a", ".r-a{color:blue;}"], ["b", ".r-b{color:green;}"]]) {
        const template = html.search(
          new RegExp(`<template data-dnx-r="[^"]+"[^>]*><b class="r-${name}"`),
        );
        assert(template > 0, `boundary ${name} streamed`);
        const block = blocks.find((b) =>
          (b.rules[SHEET_ID] as Array<[number, string]>).some(([, t]) => t === rule)
        )!;
        assert(block.at < template, `${rule} precedes boundary ${name}'s content`);
      }
      for (const b of blocks) {
        const after = html.slice(b.at).replace(/^<script[^>]*>[\s\S]*?<\/script>/, "");
        assert(after.startsWith(`<script>${LATE_STYLES_RUNTIME_BODY}</script>`));
      }
    } finally {
      restore();
    }
  });
}

Deno.test("streamed Suspense with no render-time sheet: no rules block, no extra CSP hash", async () => {
  assertEquals(await lateStylesRuntimeHash(), null);
  const sheet = orderedSheet();
  const { Page, open } = page(sheet); // inserts into a sheet nothing registered
  const app = appWith({ default: Page }, { streaming: true });
  const res = await app(new Request("http://localhost/"));
  const csp = res.headers.get("content-security-policy")!;
  assert(!csp.includes(`'sha256-${await sha256Base64(LATE_STYLES_RUNTIME_BODY)}'`));
  queueMicrotask(open);
  const html = await res.text();
  assertStringIncludes(html, "<template data-dnx-r=");
  assert(!html.includes("data-dnx-rules"));
});

/** A CSSOM sheet stand-in: `cssRules` texts and `insertRule` (rejecting `!bad` rules). */
function cssomSheet(initial: string[]) {
  const cssRules = initial.map((cssText) => ({ cssText }));
  return {
    cssRules,
    insertRule(text: string, index: number) {
      if (text.includes("!bad")) throw new SyntaxError("rejected");
      // A browser re-serializes a marker as `[stylesheet-group="2"] { }`.
      cssRules.splice(index, 0, { cssText: text.replace(/\{\}$/, " { }") });
      return index;
    },
  };
}

Deno.test("late-styles runtime: inserts each rule into its group, adding a missing group's marker", () => {
  const sheet = cssomSheet([
    '[stylesheet-group="0"] { }',
    "body { margin: 0px; }",
    '[stylesheet-group="2"] { }',
    ".r-shell { color: red; }",
    '[stylesheet-group="3"] { }',
    ".r-last { order: 1; }",
  ]);
  const block = {
    textContent: JSON.stringify({
      [SHEET_ID]: [[2, ".r-a{color:blue;}"], [2.2, ".r-shared{flex:1;}"], [1, ".r-cls{x:y;}"], [
        2,
        ".r-bad{!bad}",
      ], [null, ".plain{a:b;}"]],
      "no-such-sheet": [[0, ".x{}"]],
    }),
    attrs: new Set(["data-dnx-rules"]),
    removeAttribute(name: string) {
      this.attrs.delete(name);
    },
    parentNode: {
      removed: 0,
      removeChild() {
        this.removed++;
      },
    },
  };
  const document = {
    querySelectorAll: (sel: string) => {
      assertEquals(sel, "script[data-dnx-rules]");
      return block.attrs.has("data-dnx-rules") ? [block] : [];
    },
    getElementById: (id: string) => (id === SHEET_ID ? { sheet } : null),
  };
  new Function("document", LATE_STYLES_RUNTIME_BODY)(document);
  assertEquals(sheet.cssRules.map((r) => r.cssText), [
    '[stylesheet-group="0"] { }',
    "body { margin: 0px; }",
    '[stylesheet-group="1"] { }',
    ".r-cls{x:y;}",
    '[stylesheet-group="2"] { }',
    ".r-shell { color: red; }",
    ".r-a{color:blue;}",
    '[stylesheet-group="2.2"] { }',
    ".r-shared{flex:1;}",
    '[stylesheet-group="3"] { }',
    ".r-last { order: 1; }",
    ".plain{a:b;}",
  ]);
  assertEquals(block.parentNode.removed, 1, "the applied block is removed");
  // Applied once: a second run finds no unapplied block.
  new Function("document", LATE_STYLES_RUNTIME_BODY)(document);
  assertEquals(sheet.cssRules.length, 12);
});
