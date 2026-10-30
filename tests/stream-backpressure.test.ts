// Consumer-demand (pull) gating of the streaming renderer and its react-dom/server adapters:
// the core `renderToReadableStream`, the compat `renderToReadableStream`, the Node-stream
// `renderToPipeableStream` (Writable backpressure via write() === false / 'drain') and
// `renderToStaticNodeStream` (produce on `_read` demand). Rendering of Suspense boundaries is
// NOT gated — only the flush to the consumer is — so `await allReady` before reading completes.

import { assert, assertEquals } from "@std/assert";
import { EventEmitter } from "node:events";
import ReactDOMServer, {
  renderToReadableStream as compatRenderToReadableStream,
} from "../src/compat/react-dom-server.ts";
import { renderToReadableStream } from "../src/jsx/render-to-stream.ts";
import { createResource, Suspense } from "../src/runtime/suspense.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNodeChildren } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const BOUNDARIES = 40;
const PAD = "x".repeat(2048);

/** A tree of `count` Suspense boundaries, each resolving (after a microtask) to ~2 KB. */
function manyBoundaries(count = BOUNDARIES): VNodeChildren {
  const items = Array.from({ length: count }, (_, i) => {
    const read = createResource(() => Promise.resolve(`item-${i}-${PAD}`));
    const Item = () => h("p", null, read());
    return h(Suspense as Any, { key: i, fallback: h("i", null, "…") }, h(Item as Any, null));
  });
  return h("main", null, h("h1", null, "Shell"), items);
}

/** Count `TextEncoder#encode` calls (each is one chunk produced for the consumer). */
function spyEncode(): { count: () => number; restore: () => void } {
  const proto = TextEncoder.prototype;
  const original = proto.encode;
  let n = 0;
  proto.encode = function (this: TextEncoder, input?: string) {
    n++;
    return original.call(this, input);
  };
  return { count: () => n, restore: () => void (proto.encode = original) };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Whether `p` settles within `ms` (the deadline's timer is cleared either way). */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(() => true),
      new Promise<boolean>((r) => timer = setTimeout(() => r(false), ms)),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

/** A duck-typed Node Writable whose `write()` returns false until the test emits 'drain'. */
class SlowWritable extends EventEmitter {
  chunks: Uint8Array[] = [];
  writes = 0;
  ended = false;
  destroyedWith: unknown = undefined;
  accept = false;
  write(chunk: Uint8Array): boolean {
    this.writes++;
    this.chunks.push(chunk);
    return this.accept;
  }
  end(): this {
    this.ended = true;
    this.emit("finish");
    return this;
  }
  destroy(error?: unknown): this {
    this.destroyedWith = error ?? new Error("destroyed");
    this.emit("close");
    return this;
  }
  text(): string {
    return new TextDecoder().decode(new Uint8Array(this.chunks.flatMap((c) => [...c])));
  }
}

Deno.test("core renderToReadableStream: flushes on consumer demand, not eagerly", async () => {
  const spy = spyEncode();
  try {
    const stream = renderToReadableStream(manyBoundaries());
    const reader = stream.getReader();
    await reader.read(); // the shell
    await tick(); // every boundary has resolved by now
    const produced = spy.count();
    assert(produced <= 3, `produced ${produced} chunks ahead of an idle consumer`);
    let html = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
    }
    for (let i = 0; i < BOUNDARIES; i++) assert(html.includes(`item-${i}-`), `item ${i}`);
  } finally {
    spy.restore();
  }
});

Deno.test("core renderToReadableStream: allReady resolves before anyone reads", async () => {
  const stream = renderToReadableStream(manyBoundaries()) as ReadableStream<Uint8Array> & {
    allReady: Promise<void>;
  };
  // The bound only ends a failure (500 ms was within a loaded machine's scheduling stalls).
  const settled = await within(stream.allReady, 5_000);
  assert(settled, "allReady must not wait for the consumer to read");
  const html = await readText(stream);
  for (let i = 0; i < BOUNDARIES; i++) assert(html.includes(`item-${i}-`), `item ${i}`);
});

Deno.test("compat renderToReadableStream: await allReady then read completes without an eager drain", async () => {
  const spy = spyEncode();
  try {
    const stream = await compatRenderToReadableStream(manyBoundaries());
    await stream.allReady; // the crawler / static-generation path — must not deadlock
    await tick();
    const produced = spy.count();
    assert(produced <= 3, `buffered ${produced} chunks before the consumer read anything`);
    const html = await readText(stream);
    for (let i = 0; i < BOUNDARIES; i++) assert(html.includes(`item-${i}-`), `item ${i}`);
  } finally {
    spy.restore();
  }
});

Deno.test("renderToPipeableStream: honours write() === false and resumes on 'drain'", async () => {
  const spy = spyEncode();
  try {
    const sink = new SlowWritable();
    let allReady = false;
    const { pipe } = ReactDOMServer.renderToPipeableStream(manyBoundaries(), {
      onAllReady: () => (allReady = true),
    });
    pipe(sink as Any);
    // Every boundary suspended once, so each completes a macrotask after its data settles.
    for (let i = 0; i < 100 && !allReady; i++) await tick(10);
    assertEquals(sink.writes, 1, "no write after write() returned false, before 'drain'");
    assert(allReady, "rendering (not flushing) completes while the destination is blocked");
    const produced = spy.count();
    assert(produced <= 4, `buffered ${produced} chunks ahead of a blocked destination`);
    // Release one chunk per 'drain' until the render finishes.
    for (let i = 0; i < 500 && !sink.ended; i++) {
      const before = sink.writes;
      sink.emit("drain");
      await tick(1);
      assert(sink.writes - before <= 1 || sink.ended, "one write per drain while write() is false");
    }
    assert(sink.ended, "the destination is ended once everything flushed");
    const html = sink.text();
    assert(html.includes("<h1>Shell</h1>"), "the shell arrived");
    for (let i = 0; i < BOUNDARIES; i++) assert(html.includes(`item-${i}-`), `item ${i}`);
  } finally {
    spy.restore();
  }
});

Deno.test("renderToPipeableStream: pipe() from inside onShellReady (React's documented pattern)", async () => {
  const sink = new SlowWritable();
  sink.accept = true;
  let finished!: () => void;
  const done = new Promise<void>((r) => (finished = r));
  sink.on("finish", () => finished());
  const stream = ReactDOMServer.renderToPipeableStream(manyBoundaries(4), {
    onShellReady() {
      stream.pipe(sink as Any);
    },
  });
  const ok = await within(done, 1000);
  assert(ok, "onShellReady fires before pipe() and the piped render completes");
  assert(sink.text().includes("item-3-"));
});

Deno.test("renderToPipeableStream: abort() while blocked on 'drain' tears the pipe down", async () => {
  const sink = new SlowWritable();
  const errors: unknown[] = [];
  const Never = () => {
    throw new Promise<void>(() => {});
  };
  const { pipe, abort } = ReactDOMServer.renderToPipeableStream(
    h("main", null, "shell", h(Suspense as Any, { fallback: "…" }, h(Never as Any, null))),
    { onError: (e: unknown) => errors.push(e) },
  );
  pipe(sink as Any);
  await tick();
  assertEquals(sink.writes, 1);
  abort(new Error("deadline"));
  await tick();
  assert(sink.destroyedWith instanceof Error, "the destination is destroyed on abort");
  assertEquals(errors.length, 1, "onError reports the abort once");
  assertEquals(sink.writes, 1, "nothing written after the abort");
});

Deno.test("renderToPipeableStream: a destination that closes early cancels the render", async () => {
  const sink = new SlowWritable();
  const { pipe } = ReactDOMServer.renderToPipeableStream(manyBoundaries());
  pipe(sink as Any);
  await tick();
  sink.emit("close"); // client went away
  sink.emit("drain");
  await tick();
  assertEquals(sink.writes, 1, "no write after the destination closed");
  assert(!sink.ended);
});

Deno.test("renderToStaticNodeStream: renders on read demand and chunks large output", async () => {
  let renders = 0;
  const big = "y".repeat(200_000);
  const Big = () => {
    renders++;
    return h("div", null, big);
  };
  const readable = ReactDOMServer.renderToStaticNodeStream(h(Big as Any, null));
  await tick(5);
  assertEquals(renders, 0, "nothing renders before the consumer reads");
  let chunks = 0;
  let total = 0;
  for await (const chunk of readable) {
    chunks++;
    total += (chunk as Uint8Array).byteLength;
  }
  assertEquals(renders, 1);
  assertEquals(total, "<div></div>".length + big.length);
  assert(chunks > 1, `the document is pushed in bounded chunks (got ${chunks})`);
});

Deno.test("renderToStaticNodeStream: a render error destroys the stream and reports onError", async () => {
  const Boom = () => {
    throw new Error("static boom");
  };
  let seen: unknown;
  const readable = ReactDOMServer.renderToStaticNodeStream(h(Boom as Any, null), {
    onError: (e: unknown) => (seen = e),
  });
  let caught: unknown;
  try {
    for await (const _ of readable) { /* drain */ }
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error && caught.message === "static boom", String(caught));
  assert(seen instanceof Error);
});
