// Layer 2 (React side): render each shared workload with react-dom/server, under
// Node (React's native runtime). Measures the same two APIs as the denext side:
//
//   • stream — renderToReadableStream, drained to bytes (the modern, recommended
//              production path; the primary metric).
//   • string — renderToString (React's legacy synchronous API; secondary).
//
//   node --expose-gc bench/layer2-ssr/run-react.mjs
//
// react/react-dom resolve from bench/node_modules. workloads + the timing
// harness are the SAME modules the denext side uses (Node type-stripping loads
// the .ts). Identical shape, identical method.

import { createElement, version as reactVersion } from "react";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { microbench } from "../lib/microbench.ts";
import { WORKLOADS } from "./workloads.ts";

const create = createElement;

async function drain(stream) {
  const reader = stream.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
  }
  return n;
}

// One render+drain of a React stream. renderToReadableStream is async and the
// returned stream carries `.allReady`; draining it to the end fully renders.
async function renderStream(element) {
  const stream = await renderToReadableStream(element);
  return drain(stream);
}

const results = [];
for (const w of WORKLOADS) {
  const tree = w.build(create);

  if (renderToString(tree).length === 0) {
    console.error(`react string produced empty HTML for ${w.name}`);
    process.exit(1);
  }
  if ((await renderStream(tree)) === 0) {
    console.error(`react stream produced no bytes for ${w.name}`);
    process.exit(1);
  }

  console.error(`react stream: ${w.name} …`);
  const stream = await microbench(w.name, () => renderStream(tree), {
    samples: 21,
  });
  console.error(`react string: ${w.name} …`);
  const string = await microbench(w.name, () => renderToString(tree), {
    samples: 21,
  });

  const meta = {
    description: w.description,
    framework: "react",
    runtime: `node ${process.version}`,
    reactVersion,
  };
  results.push({ ...stream, ...meta, api: "stream" });
  results.push({ ...string, ...meta, api: "string" });
}

console.log(JSON.stringify(results));
process.exit(0);
