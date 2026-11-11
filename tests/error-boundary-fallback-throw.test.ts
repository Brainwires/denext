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
/** How long a probe Worker may take to load (and type-check its module graph) before it is
 * ready; separate from the render limit so a busy machine's cold load isn't counted as a loop. */
const LOAD_TIMEOUT_MS = 120_000;

interface WorkerLimits {
  loadMs: number;
  renderMs: number;
}

/** Start `url` in a Worker, wait (under `loadMs`) for its `ready` message, then post `message`
 * and wait (under `renderMs`, counted from the post) for its `result`. */
function runInWorker(
  url: URL,
  message: unknown,
  label: string,
  limits: WorkerLimits = { loadMs: LOAD_TIMEOUT_MS, renderMs: TIMEOUT_MS },
): Promise<Record<string, unknown>> {
  const worker = new Worker(url, { type: "module" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the "${label}" probe did not load in ${limits.loadMs} ms`)),
      limits.loadMs,
    );
    worker.onmessage = (e: MessageEvent<{ type: string; data?: Record<string, unknown> }>) => {
      if (e.data.type === "ready") {
        clearTimeout(timer);
        timer = setTimeout(
          () => reject(new Error(`the "${label}" render did not finish in ${limits.renderMs} ms`)),
          limits.renderMs,
        );
        worker.postMessage(message);
      } else resolve(e.data.data ?? {});
    };
    worker.onerror = (e) => {
      e.preventDefault();
      reject(new Error(e.message));
    };
  }).finally(() => {
    clearTimeout(timer);
    worker.terminate();
  });
}

/** Render one probe scenario in a Worker; reject when it doesn't finish in time. */
function probe(
  scenario: "outer" | "root" | "class-outer" | "class-root",
): Promise<Record<string, unknown>> {
  return runInWorker(
    new URL("./fixtures/error-boundary-loop/probe.ts", import.meta.url),
    scenario,
    scenario,
  );
}

const slowLoad = new URL("./fixtures/error-boundary-loop/slow-load.ts", import.meta.url);

Deno.test("harness: the render limit starts once the Worker has loaded", async () => {
  // The Worker takes 500 ms to load; a 200 ms render limit counted from creation would fail.
  const r = await runInWorker(slowLoad, "ok", "slow load", { loadMs: 30_000, renderMs: 200 });
  assertEquals(r, { answered: "ok" });
});

Deno.test("harness: a render that never finishes still times out after the Worker loads", async () => {
  const err = await runInWorker(slowLoad, "loop", "loop", { loadMs: 30_000, renderMs: 200 })
    .then(() => null, (e: Error) => e);
  assertEquals(err?.message, 'the "loop" render did not finish in 200 ms');
});

Deno.test("harness: a Worker that loads too slowly fails under the load limit", async () => {
  const err = await runInWorker(slowLoad, "ok", "slow", { loadMs: 100, renderMs: 10_000 })
    .then(() => null, (e: Error) => e);
  assertEquals(err?.message, 'the "slow" probe did not load in 100 ms');
});

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
