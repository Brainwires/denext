// An error boundary whose own fallback throws while rendering hands that error to the next
// boundary up (or to the root's uncaught handling) and never catches it again itself — the
// same boundary re-catching it re-rendered forever (#101). The client renders run in a Worker
// so a regression is terminated by a timeout instead of hanging the suite; the server renders
// are async and bounded by a race.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { ErrorBoundary } from "../src/runtime/error-boundary.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { renderToReadableStream } from "../src/jsx/render-to-stream.ts";
import type { VNode } from "../src/jsx/types.ts";

const TIMEOUT_MS = 10_000;

/** Render one probe scenario in a Worker; reject when it doesn't finish in time. */
function probe(
  scenario: "outer" | "root" | "class-outer" | "class-root",
): Promise<Record<string, unknown>> {
  const worker = new Worker(
    new URL("./fixtures/error-boundary-loop/probe.ts", import.meta.url),
    { type: "module" },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the "${scenario}" render did not finish in ${TIMEOUT_MS} ms`)),
      TIMEOUT_MS,
    );
    worker.onmessage = (e) => resolve(e.data);
    worker.onerror = (e) => {
      e.preventDefault();
      reject(new Error(e.message));
    };
    worker.postMessage(scenario);
  }).finally(() => {
    clearTimeout(timer);
    worker.terminate();
  });
}

/** Race a server render against the timeout. */
function bounded<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`render did not finish in ${TIMEOUT_MS} ms`)),
        TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

Deno.test("client: a boundary whose fallback throws hands the error to the outer boundary", async () => {
  const r = await probe("outer");
  assertEquals(r.html, "<p>outer: fallback boom</p>");
  assertEquals(r.fallbackRenders, 1);
  assertEquals(r.caught, ["child boom", "fallback boom"]);
  assertEquals(r.uncaught, []);
  assertEquals(r.thrown, null);
});

Deno.test("client: a boundary whose fallback throws, with no boundary above, surfaces it at the root", async () => {
  const r = await probe("root");
  assertEquals(r.fallbackRenders, 1);
  assertEquals(r.caught, ["child boom"]);
  assertEquals(r.uncaught, ["fallback boom"]);
  assertEquals(r.thrown, "fallback boom");
});

Deno.test("client: a class boundary whose error UI throws hands the error to the outer boundary", async () => {
  const r = await probe("class-outer");
  assertEquals(r.html, "<p>outer: fallback boom</p>");
  assertEquals(r.fallbackRenders, 1);
  assertEquals(r.uncaught, []);
  assertEquals(r.thrown, null);
});

Deno.test("client: a class boundary whose error UI throws, with no boundary above, surfaces it at the root", async () => {
  const r = await probe("class-root");
  assertEquals(r.fallbackRenders, 1);
  assertEquals(r.uncaught, ["fallback boom"]);
  assertEquals(r.thrown, "fallback boom");
});

function Boom(): VNode {
  throw new Error("child boom");
}
function ThrowingFallback(): VNode {
  throw new Error("fallback boom");
}
function OuterFallback(props: { error: Error }): VNode {
  return h("p", null, `outer: ${props.error.message}`);
}
const inner = () => h(ErrorBoundary, { fallback: ThrowingFallback, children: h(Boom, null) });

Deno.test("server: a boundary whose fallback throws hands the error to the outer boundary", async () => {
  const html = await bounded(
    renderToString(h(ErrorBoundary, { fallback: OuterFallback, children: inner() })),
  );
  assertStringIncludes(html, "outer:");
});

Deno.test("server: a boundary whose fallback throws, with no boundary above, rejects the render", async () => {
  const err = await bounded(renderToString(inner()).then(() => null, (e: Error) => e));
  assertEquals(err?.message, "fallback boom");
});

Deno.test("streaming: a boundary whose fallback throws hands the error to the outer boundary", async () => {
  const stream = renderToReadableStream(
    h(ErrorBoundary, { fallback: OuterFallback, children: inner() }),
  );
  const html = await bounded(new Response(stream).text());
  assertStringIncludes(html, "outer:");
});
