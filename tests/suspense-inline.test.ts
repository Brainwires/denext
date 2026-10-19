// A Suspense boundary whose content finishes in the shell pass renders INLINE in the shell, as
// React's streaming renderer writes it: its content between `<!--$-->` / `<!--/$-->`, with no
// fallback, no `data-dnx-b` placeholder, no `<template data-dnx-r>` and no reveal script — so it
// reads with JavaScript off and a crawler or an `allReady` consumer gets the content. A boundary
// that suspends (a thrown thenable, an async component) still streams, unless it has finished by
// the time the shell is read. The client hydrates both shapes without a mismatch.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  renderShell,
  renderToReadableStream,
  streamToString,
} from "../src/jsx/render-to-stream.ts";
import { renderFlightShell } from "../src/jsx/render-to-flight-stream.ts";
import {
  prerender,
  renderToReadableStream as compatRenderToReadableStream,
} from "../src/compat/react-dom-server.ts";
import { Suspense, use } from "../src/runtime/suspense.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { VNode, VNodeChildren } from "../src/jsx/types.ts";
import { stuckHoles } from "../src/testing/conformance.ts";
import { flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import { installHydrationWarning } from "../src/client/fiber/hydration.ts";
// react-dom/client installs the `<!--$!-->` (client-rendered boundary) hydration it brings.
import "../src/compat/react-dom-client.ts";
import { useState } from "../src/runtime/hooks.ts";
import {
  FakeComment,
  type FakeDocument,
  FakeElement,
  type FakeNode,
  makeDom,
} from "./helpers/dom.ts";
import { hydratedFlight, streamedChunks } from "./helpers/streamed-flight.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** A promise settling after a real timer: content waiting on it suspends past the shell. */
const later = <T>(value: T, ms = 20): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

/** Reads `p` with `use()` inside a `<b>`. */
function Use({ p }: { p: Promise<string> }): VNode {
  return h("b", null, use(p));
}

const boundary = (children: VNodeChildren, fallback: VNodeChildren = h("i", null, "L")) =>
  h(Suspense, { fallback, children });

/** The reveal runtime, stripped so goldens compare markup only. */
const noRuntime = (html: string) => html.replace(/<script>\(function\(\)[\s\S]*?<\/script>/, "");

// ---- React parity: the shapes react-dom@19.3.1's renderToReadableStream writes ----------------
//
// Recorded from react-dom@19.3.1/server.browser for the same trees (read at once, or after
// `await stream.allReady`). React's streamed shape (`<!--$?--><template id="B:0">` + `$RC`) is its
// own; denext streams with `data-dnx-b` / `data-dnx-r`, so for those cases only the decision —
// inline or streamed — is compared.
const REACT = {
  sync: "<div><!--$--><p>x</p><!--/$--></div>",
  text: "<div>a<!--$-->b<!--/$-->c</div>",
  cached: "<div><!--$--><b>C</b><!--/$--></div>",
  allReady: "<div><!--$--><b>T</b><!--/$--></div>",
  // nestedInlineOuter: the outer boundary inline, the inner one (a timer) streamed.
  nestedOuterPrefix: "<div><!--$--><p>a</p>",
};

Deno.test("parity: a boundary that never suspends is written inline, as React writes it", async () => {
  const sync = await streamToString(
    renderToReadableStream(h("div", null, boundary(h("p", null, "x")))),
  );
  assertEquals(sync, REACT.sync, "no placeholder, no template, no reveal runtime");
  const text = await streamToString(
    renderToReadableStream(h("div", null, "a", boundary("b", "L"), "c")),
  );
  assertEquals(text, REACT.text);
  // use() of a promise already known to be settled (React's status fields) does not suspend.
  const cached = Object.assign(Promise.resolve("C"), { status: "fulfilled", value: "C" });
  const html = await streamToString(
    renderToReadableStream(h("div", null, boundary(h(Use, { p: cached })))),
  );
  assertEquals(html, REACT.cached);
});

Deno.test("parity: a boundary that suspends still streams — even on an already-resolved promise", async () => {
  // An async component with nothing to wait on: it still suspends, as in React.
  function Async(): Promise<VNode> {
    return Promise.resolve(h("b", null, "async"));
  }
  for (
    const content of [
      h(Use, { p: later("T") }), // a real wait
      h(Use, { p: Promise.resolve("R") }), // React streams an untracked promise too
      h(Async, null), // an async component suspends in React
    ]
  ) {
    const html = await streamToString(renderToReadableStream(h("div", null, boundary(content))));
    assertStringIncludes(html, '<div data-dnx-b="dnx0"><i>L</i></div>', "fallback placeholder");
    assertStringIncludes(html, '<template data-dnx-r="dnx0"><b>');
    assert(!html.includes("<!--$-->"), "not inline");
  }
});

Deno.test("parity: mixed nesting — an inline parent with a suspending child, and the reverse", async () => {
  const outerInline = await streamToString(
    renderToReadableStream(
      h("div", null, boundary([h("p", null, "a"), boundary(h(Use, { p: later("T") }), "L2")])),
    ),
  );
  assert(noRuntime(outerInline).startsWith(REACT.nestedOuterPrefix), outerInline);
  assertStringIncludes(outerInline, '<!--$--><p>a</p><div data-dnx-b="dnx1">L2</div><!--/$-->');
  assertStringIncludes(outerInline, '<template data-dnx-r="dnx1"><b>T</b></template>');
  assert(!outerInline.includes('data-dnx-b="dnx0"'), "the outer boundary has no placeholder");

  const outerStreamed = await streamToString(
    renderToReadableStream(
      h("div", null, boundary([h(Use, { p: later("T") }), boundary(h("p", null, "in"), "L2")])),
    ),
  );
  assertStringIncludes(outerStreamed, '<div data-dnx-b="dnx0"><i>L</i></div>');
  // The inner boundary finished long before its parent: inline in the parent's template.
  assertStringIncludes(
    outerStreamed,
    '<template data-dnx-r="dnx0"><b>T</b><!--$--><p>in</p><!--/$--></template>',
  );
  assert(!outerStreamed.includes('data-dnx-b="dnx1"'), "no placeholder for the inner one");
});

Deno.test("allReady: awaited before reading, every boundary is inline (core, compat, prerender)", async () => {
  const tree = () => h("div", null, boundary(h(Use, { p: later("T") })));
  const core = renderToReadableStream(tree());
  await core.allReady;
  assertEquals(await streamToString(core), REACT.allReady);

  const compat = await compatRenderToReadableStream(tree());
  await compat.allReady;
  assertEquals(await streamToString(compat), REACT.allReady);

  const { prelude } = await prerender(tree());
  assertEquals(await streamToString(prelude), REACT.allReady);

  // Read at once instead, the boundary still streams.
  const eager = await streamToString(await compatRenderToReadableStream(tree()));
  assertStringIncludes(eager, '<template data-dnx-r="dnx0"><b>T</b></template>');
});

Deno.test("a document shell keeps its inline boundary and its closing tags in place", async () => {
  const html = await streamToString(
    await compatRenderToReadableStream(
      h("html", null, h("body", null, boundary(h("main", null, "ready")))),
    ),
  );
  assertEquals(
    html,
    "<!DOCTYPE html><html><body><!--$--><main>ready</main><!--/$--></body></html>",
  );
});

Deno.test("renderShell (the app router path): an inline boundary leaves no hole to stream", async () => {
  const shell = await renderShell(
    h("main", null, boundary(h("p", null, "now")), boundary(h(Use, { p: later("then") }))),
    null,
  );
  assertStringIncludes(shell.shell, "<!--$--><p>now</p><!--/$-->");
  assertStringIncludes(shell.shell, '<div data-dnx-b="dnx1"><i>L</i></div>');
  assertEquals(shell.holes.size, 1, "only the suspending boundary streams");
  const [hole] = await Promise.all(shell.holes);
  assertEquals(hole, { ...hole, id: "dnx1", html: "<b>then</b>", ok: true });
});

Deno.test("a boundary that failed before the shell flushed is marked and found stuck", async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    const Throws = (): VNode => {
      throw new Error("boom");
    };
    const shell = await renderShell(h("main", null, boundary(h(Throws, null))), null);
    assertEquals(shell.shell, '<main><div data-dnx-b="dnx0" data-dnx-failed><i>L</i></div></main>');
    assertEquals(shell.holes.size, 0);
    // A document with no streamed hole carries no reveal runtime: still reported.
    assertEquals(stuckHoles(`<html><body>${shell.shell}</body></html>`), ["dnx0"]);
  } finally {
    console.error = origError;
  }
});

// ---- the request path -----------------------------------------------------------------------

function manifest(): RouteManifest {
  return {
    pages: [{
      kind: "page",
      pattern: parsePattern("/"),
      routePath: "/",
      filePath: "home.tsx",
      layoutChain: [],
      templateChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

Deno.test("a streamed page whose boundaries never suspend is served whole, readable without JS", async () => {
  const Page = (): VNode => h("div", null, h("h1", null, "shell"), boundary(h("p", null, "body")));
  const app = createApp({
    getManifest: manifest,
    load: (fp: string) => Promise.resolve(fp === "home.tsx" ? { default: Page } : undefined),
    streaming: true,
  });
  const html = await (await app(new Request("http://localhost/"))).text();
  assertStringIncludes(html, "<h1>shell</h1><!--$--><p>body</p><!--/$-->");
  assert(!html.includes("data-dnx-b"), "no placeholder");
  assert(!html.includes("<template data-dnx-r"), "no template");
});

// ---- Flight: inline boundaries fill their holes in the shell's tree --------------------------

Deno.test("Flight shell: an inline boundary's subtree is in the tree; a streamed one streams its own", async () => {
  const tree = h(
    "main",
    null,
    boundary(h("p", null, "now", boundary(h(Use, { p: later("inner") }), "L2"))),
  );
  const shell = await renderFlightShell(tree);
  assertStringIncludes(
    shell.shellHtml,
    '<!--$--><p>now<div data-dnx-b="dnx1">L2</div></p><!--/$-->',
  );
  assert(shell.hasHoles);
  let streamed = "";
  const controller = {
    enqueue: (b: Uint8Array) => (streamed += new TextDecoder().decode(b)),
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const tail = await shell.streamHoles(controller, encoder);
  assertStringIncludes(streamed, '<template data-dnx-r="dnx1"><b>inner</b></template>');
  assert(streamedChunks(streamed, "data-dnx-f").has("dnx1"), "the streamed boundary's Flight");
  assert(!streamedChunks(streamed, "data-dnx-f").has("dnx0"), "none for the inline one");
  // The browser's tree: the tail (inline boundary filled) plus the streamed chunk.
  const doc = `${streamed}<script id="__denext_flight" type="application/json">${
    JSON.stringify(tail.flight)
  }</script>`;
  const json = JSON.stringify(hydratedFlight(doc));
  assert(!json.includes(`"$":"$"`), "no unfilled hole: " + json);
  assertStringIncludes(json, "now");
  assertStringIncludes(json, "inner");
});

// ---- hydration of both shapes ---------------------------------------------------------------

/** Server HTML as fake-DOM nodes, comments included (the shared parser drops them). */
function serverNodes(doc: FakeDocument, parent: FakeNode, html: string): void {
  const stack: FakeNode[] = [parent];
  for (const m of html.matchAll(/<!--([\s\S]*?)-->|<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.appendChild(new FakeComment(m[1]));
    else if (m[5] !== undefined) top.appendChild(doc.createTextNode(m[5]));
    else if (m[2]) stack.pop();
    else {
      const el = doc.createElement(m[3]);
      for (const a of m[4].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], a[2] ?? "");
      top.appendChild(el);
      stack.push(el);
    }
  }
}

/** Hydrate `tree` over `html` in dev, returning the warnings and errors it logged. */
function hydrateOver(html: string, tree: VNode): { container: FakeElement; logged: string[] } {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  serverNodes(doc, container, html);
  const logged: string[] = [];
  const warn = console.warn;
  const error = console.error;
  const dev = globalThis as { __denextDev?: boolean };
  console.warn = (...a: unknown[]) => logged.push(a.join(" "));
  console.error = (...a: unknown[]) => logged.push(a.join(" "));
  dev.__denextDev = true;
  installHydrationWarning();
  try {
    flushSync(() => void hydrateRoot(container as Any, tree));
  } finally {
    console.warn = warn;
    console.error = error;
    delete dev.__denextDev;
    installHydrationWarning(false);
  }
  return { container, logged };
}

function Counter(): VNode {
  const [n] = useState(0);
  return h("button", null, `n=${n}`);
}

/** The client tree both server shapes below came from. */
const appTree = () =>
  h("div", null, "a", boundary(h("section", null, h(Counter, null)), "L"), h("p", null, "after"));

Deno.test("hydration: an inline boundary hydrates in place — no mismatch, the server nodes kept", async () => {
  const html = await streamToString(renderToReadableStream(appTree()));
  assertEquals(
    html,
    "<div>a<!--$--><section><button>n=0</button></section><!--/$--><p>after</p></div>",
  );
  const { container, logged } = hydrateOver(html, appTree());
  assertEquals(logged, [], logged.join("\n"));
  const div = container.childNodes[0] as FakeElement;
  // a, <!--$-->, <section>, <!--/$-->, <p>: the comments are passed over.
  const section = div.childNodes.find((n) => n instanceof FakeElement && n.tagName === "SECTION");
  assert(section, "the server <section> was adopted");
  // Only the boundary markers (which only hydration needs) are gone.
  assertEquals(container.innerHTML, html.replace(/<!--\/?\$-->/g, ""));
});

Deno.test("hydration: a streamed boundary's revealed placeholder is unwrapped — no mismatch", () => {
  // The DOM the swap runtime leaves: the template's content inside the placeholder.
  const html =
    '<div>a<div data-dnx-b="dnx0"><section><button>n=0</button></section></div><p>after</p></div>';
  const { container, logged } = hydrateOver(html, appTree());
  assertEquals(logged, [], logged.join("\n"));
  assertEquals(
    container.innerHTML,
    "<div>a<section><button>n=0</button></section><p>after</p></div>",
    "the content in the placeholder's position, the wrapper gone",
  );
});

Deno.test("hydration: the server's own nodes are adopted, not re-created, in both shapes", () => {
  for (
    const html of [
      "<div>a<!--$--><section><button>n=0</button></section><!--/$--><p>after</p></div>",
      '<div>a<div data-dnx-b="dnx0"><section><button>n=0</button></section></div><p>after</p></div>',
    ]
  ) {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    serverNodes(doc, container, html);
    const all = (n: FakeNode): FakeNode[] => [n, ...n.childNodes.flatMap(all)];
    const button = all(container).find((n) => n instanceof FakeElement && n.tagName === "BUTTON");
    flushSync(() => void hydrateRoot(container as Any, appTree()));
    const after = all(container).find((n) => n instanceof FakeElement && n.tagName === "BUTTON");
    assert(button && button === after, "the server <button> is the hydrated one: " + html);
  }
});

// ---- buffered renderToString: React's Suspense markers --------------------------------------

Deno.test("renderToString brackets a boundary with React's markers; static markup does not", async () => {
  const { renderToString: compatRenderToString, renderToStaticMarkup } = await import(
    "../src/compat/react-dom-server.ts"
  );
  const { renderToString } = await import("../src/jsx/render-to-string.ts");
  // Recorded from react-dom@19.3.1 (production build).
  assertEquals(
    compatRenderToString(h("div", null, boundary(h("p", null, "x")))),
    "<div><!--$--><p>x</p><!--/$--></div>",
  );
  assertEquals(
    compatRenderToString(h("div", null, "a", boundary("b", "L"), "c")),
    "<div>a<!--$-->b<!--/$-->c</div>",
  );
  // A sync render shows the fallback of a boundary that suspends, marked client-rendered.
  assertEquals(
    compatRenderToString(h("div", null, boundary(h(Use, { p: new Promise<string>(() => {}) })))),
    "<div><!--$!--><template></template><i>L</i><!--/$--></div>",
  );
  assertEquals(
    renderToStaticMarkup(h("div", null, boundary(h("p", null, "x")))),
    "<div><p>x</p></div>",
  );
  // The async buffered render resolves the boundary and marks it, as React's renderToString.
  assertEquals(
    await renderToString(h("div", null, boundary(h(Use, { p: later("T") })))),
    "<div><!--$--><b>T</b><!--/$--></div>",
  );
});

Deno.test("hydration: a client-rendered boundary (<!--$!-->) renders its content fresh, no mismatch", () => {
  const html = "<div>a<!--$!--><template></template>L<!--/$--><p>after</p></div>";
  const { container, logged } = hydrateOver(
    html,
    h("div", null, "a", boundary(h("section", null, h(Counter, null)), "L"), h("p", null, "after")),
  );
  assertEquals(logged, [], logged.join("\n"));
  assertEquals(
    container.innerHTML,
    "<div>a<section><button>n=0</button></section><p>after</p></div>",
    "the server fallback replaced by the client's content",
  );
});

Deno.test("hydration: an unterminated <!--$!--> boundary and server markup that ends early", () => {
  // No closing marker: the client renders the boundary itself, to the end of the parent.
  const open = hydrateOver(
    "<div><!--$!--><template></template>L</div>",
    h("div", null, boundary(h("section", null, h(Counter, null)), "L")),
  );
  assertEquals(open.logged, [], open.logged.join("\n"));
  assertEquals(open.container.innerHTML, "<div><section><button>n=0</button></section></div>");
  // The client renders more than the server sent: past the markers the cursor runs out.
  const short = hydrateOver(
    "<div><!--$--><p>x</p><!--/$--></div>",
    h("div", null, boundary(h("p", null, "x")), h("span", null, "more")),
  );
  assertEquals(short.logged.length, 1, short.logged.join("\n"));
  assertStringIncludes(short.logged[0], "the server markup ended early");
});

Deno.test("renderShell: a control signal in a nested inline boundary is the shell's", async () => {
  const { InlineBoundarySignal } = await import("../src/jsx/stream-boundaries.ts");
  const { isRedirect, redirect } = await import("../src/runtime/error-boundary.ts");
  const Inner = (): VNode => redirect("/elsewhere");
  const origError = console.error;
  console.error = () => {};
  try {
    const err = await renderShell(
      h("main", null, boundary(h("div", null, "outer", boundary(h(Inner, null))))),
      { tags: [] },
    ).then(() => null, (e) => e);
    assert(err instanceof InlineBoundarySignal, String(err));
    assert(isRedirect(err.signal), "the redirect itself, for the page to answer with");
  } finally {
    console.error = origError;
  }
});
