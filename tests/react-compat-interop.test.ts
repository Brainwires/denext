// WS1 npm-interop surface: the compat additions that let real npm React libraries
// resolve to denext's single runtime — react-dom/server, react-dom/test-utils,
// React.cache, the react-dom form hooks, and the react-is classifiers that were
// previously hardcoded to `false`.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import ReactDOMServer, {
  renderToReadableStream,
  renderToStaticMarkup,
  renderToString as serverRenderToString,
} from "../src/compat/react-dom-server.ts";
import TestUtils, { act } from "../src/compat/test-utils.ts";
import React, { cache, createContext, Profiler } from "../src/compat/react.ts";
import ReactDOM, { useFormState, useFormStatus } from "../src/compat/react-dom.ts";
import * as ReactIs from "../src/compat/react-is.ts";
import { StrictMode } from "../src/runtime/strict-mode.ts";
import { createResource, Suspense } from "../src/runtime/suspense.ts";
import { h } from "../src/jsx/jsx-runtime.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(
    chunks.reduce((acc, c) => {
      const out = new Uint8Array(acc.length + c.length);
      out.set(acc);
      out.set(c, acc.length);
      return out;
    }, new Uint8Array()),
  );
}

Deno.test("react-dom/server: renderToReadableStream streams HTML and resolves allReady", async () => {
  const stream = await renderToReadableStream(h("div", null, "hello"));
  // allReady resolves independently of consumer backpressure (buffered).
  await stream.allReady;
  const html = await readAll(stream);
  assert(html.includes("hello"), `expected rendered content, got: ${html}`);
  assert(html.includes("<div"), "expected the host element");
});

Deno.test("react-dom/server: renderToString/renderToStaticMarkup render the sync subset", () => {
  const tree = h("div", { class: "a" }, h("p", null, "hi ", h("b", null, "x")));
  const html = '<div class="a"><p>hi <b>x</b></p></div>';
  assertEquals(serverRenderToString(tree), html);
  assertEquals(renderToStaticMarkup(tree), html); // no hydration markers → identical output

  // A Suspense boundary whose children suspend renders its fallback (React's contract).
  const read = createResource(() => new Promise<string>(() => {})); // never resolves
  const Slow = () => h("strong", null, read());
  const sus = h(
    "div",
    null,
    h(Suspense, { fallback: h("em", null, "…"), children: h(Slow, null) }),
  );
  assertEquals(serverRenderToString(sus), "<div><em>…</em></div>");

  // A genuinely async Server Component outside a boundary throws a guided error.
  const Async = async () => {
    await Promise.resolve();
    return h("span", null, "later");
  };
  assertThrows(() => serverRenderToString(h(Async as Any, null)), Error, "renderToReadableStream");

  // The Node-stream APIs still throw — denext targets the Web stream, not Node `Writable`.
  assertThrows(() => (ReactDOMServer as Any).renderToPipeableStream(), Error, "async");
  assertThrows(() => (ReactDOMServer as Any).renderToStaticNodeStream(), Error, "async");
  assertEquals(ReactDOMServer.version, "19.2.0");
});

Deno.test("react-dom/test-utils: exposes act", async () => {
  assertEquals(typeof act, "function");
  assertEquals(TestUtils.act, act);
  // act runs and resolves.
  let ran = false;
  await act(() => {
    ran = true;
  });
  assert(ran);
});

Deno.test("React.cache: memoizes by argument identity (primitive + object args)", () => {
  let calls = 0;
  const fn = cache((a: number, b: { k: string }) => {
    calls++;
    return `${a}:${b.k}`;
  });
  const obj = { k: "x" };
  assertEquals(fn(1, obj), "1:x");
  assertEquals(fn(1, obj), "1:x");
  assertEquals(calls, 1, "same args → one call");
  fn(2, obj);
  assertEquals(calls, 2, "different primitive arg → recompute");
  fn(1, { k: "x" });
  assertEquals(calls, 3, "different object identity → recompute (ref-keyed)");
  assert(typeof (React as Any).cache === "function", "exposed on the default namespace");
});

Deno.test("react-dom: exposes the React 19 form hooks", () => {
  assertEquals(typeof useFormStatus, "function");
  assertEquals(typeof useFormState, "function");
  assertEquals((ReactDOM as Any).useFormStatus, useFormStatus);
  assertEquals((ReactDOM as Any).useFormState, useFormState);
});

Deno.test("react-is: isStrictMode / isProfiler recognize denext's markers", () => {
  assert(ReactIs.isStrictMode(StrictMode), "bare StrictMode component");
  assert(ReactIs.isStrictMode(h(StrictMode as Any, null, "x")), "a rendered <StrictMode>");
  assert(!ReactIs.isStrictMode(() => h("div", null)));

  assert(ReactIs.isProfiler(Profiler), "bare Profiler component");
  assert(
    ReactIs.isProfiler(h(Profiler as Any, { id: "p", onRender: () => {} }, "x")),
    "a rendered <Profiler>",
  );
  assert(!ReactIs.isProfiler(() => h("div", null)));
});

Deno.test("react-is: isContextConsumer recognizes a denext .Consumer", () => {
  const Ctx = createContext("default");
  assert(ReactIs.isContextConsumer(Ctx.Consumer), "the render-prop consumer");
  assert(!ReactIs.isContextConsumer(Ctx), "the context/provider is not a consumer");
  assert(!ReactIs.isContextConsumer(() => h("div", null)));
});

// Guard: the promise from renderToReadableStream rejects allReady on a render error
// (onError is invoked), so consumers awaiting allReady see the failure.
Deno.test("react-dom/server: a render error rejects allReady and calls onError", async () => {
  const Boom = () => {
    throw new Error("boom");
  };
  let seen: unknown;
  const stream = await renderToReadableStream(h(Boom as Any, null), {
    onError: (e) => {
      seen = e;
    },
  });
  await assertRejects(() => stream.allReady, Error, "boom");
  assert(seen instanceof Error && seen.message === "boom", "onError received the error");
});

// Regression: the IDIOMATIC streaming path does NOT await allReady. On a render
// error the drainer rejects allReady; without an internal handler that becomes an
// unhandled rejection, which crashes the Deno process. The Deno test runner fails
// on an unhandled rejection, so a clean completion here is the guard.
Deno.test("react-dom/server: a render error without awaiting allReady is not an unhandled rejection", async () => {
  const Boom = () => {
    throw new Error("kaboom");
  };
  const stream = await renderToReadableStream(h(Boom as Any, null));
  // Stream it (as a Response would) WITHOUT touching allReady; the read surfaces
  // the error.
  let errored = false;
  try {
    await readAll(stream);
  } catch {
    errored = true;
  }
  assert(errored, "reading the errored stream throws");
  // Let the drainer's rejection settle; if allReady had no handler this tick would
  // trip the runner's unhandled-rejection detector.
  await new Promise((r) => setTimeout(r, 10));
});

// Consumer cancel (e.g. client disconnect) must stop the drain quietly — no
// spurious onError, no crash from enqueue-after-close.
Deno.test("react-dom/server: consumer cancel doesn't fire a spurious onError", async () => {
  let onErrorCalls = 0;
  // A large document so the drainer is still mid-flight when we cancel.
  const rows = Array.from({ length: 300 }, (_, i) => h("li", null, "row " + i));
  const stream = await renderToReadableStream(h("ul", null, rows), {
    onError: () => onErrorCalls++,
  });
  const reader = stream.getReader();
  await reader.read(); // pull the shell
  await reader.cancel("client gone");
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(onErrorCalls, 0, "cancel is not a render error");
  await stream.allReady; // resolves (not rejects) on cancel
});

// An aborted render must REJECT allReady (React's contract), not resolve with
// truncated HTML reported as complete. denext's source renderer closes the stream
// on abort (it checks the signal in its flush loop), so the shim must detect the
// aborted close and reject rather than resolve.
Deno.test("react-dom/server: an aborted render rejects allReady", async () => {
  const controller = new AbortController();
  let seen: unknown;
  const stream = await renderToReadableStream(
    h("div", null, "content"),
    { signal: controller.signal, onError: (e) => (seen = e) },
  );
  controller.abort(new Error("timed out"));
  // Drive the stream so the drainer observes the aborted close.
  await readAll(stream).catch(() => {});
  await assertRejects(() => stream.allReady);
  assert(seen != null, "onError is called on abort");
});
