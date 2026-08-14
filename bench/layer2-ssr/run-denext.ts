// Layer 2 (denext side): render each shared workload with denext's own SSR, under
// Deno. Two APIs are measured so the comparison is both fair and complete:
//
//   • stream — renderToReadableStream, drained to bytes. The modern, production
//              path (what a real app serves); the primary metric.
//   • string — renderToString. The direct HTML-string API; a secondary metric
//              compared against React's (legacy) renderToString.
//
// Emits a JSON result array on stdout; progress to stderr.
//   deno run -A --v8-flags=--expose-gc bench/layer2-ssr/run-denext.ts

import { h } from "../../src/jsx/jsx-runtime.ts";
import { renderToString } from "../../src/jsx/render-to-string.ts";
import { renderToReadableStream } from "../../src/jsx/render-to-stream.ts";
import { microbench } from "../lib/microbench.ts";
import { type Create, WORKLOADS } from "./workloads.ts";

const create = h as unknown as Create;

/** Read a stream to completion, counting bytes (models a server draining it). */
async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
  }
  return n;
}

const results = [];
for (const w of WORKLOADS) {
  const tree = w.build(create);

  // Correctness gate before timing.
  if ((await renderToString(tree as never)).length === 0) {
    console.error(`denext string produced empty HTML for ${w.name}`);
    Deno.exit(1);
  }
  if ((await drain(renderToReadableStream(tree as never))) === 0) {
    console.error(`denext stream produced no bytes for ${w.name}`);
    Deno.exit(1);
  }

  console.error(`denext stream: ${w.name} …`);
  const stream = await microbench(
    w.name,
    () => drain(renderToReadableStream(tree as never)),
    {
      samples: 21,
    },
  );
  console.error(`denext string: ${w.name} …`);
  const string = await microbench(w.name, () => renderToString(tree as never), {
    samples: 21,
  });

  const meta = {
    description: w.description,
    framework: "denext",
    runtime: `deno ${Deno.version.deno}`,
  };
  results.push({ ...stream, ...meta, api: "stream" });
  results.push({ ...string, ...meta, api: "string" });
}

console.log(JSON.stringify(results));
// denext's runtime can leave timers/resources alive; the measurement is done.
Deno.exit(0);
