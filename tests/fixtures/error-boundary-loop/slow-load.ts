// Worker for tests/error-boundary-fallback-throw.test.ts's harness tests: loads slowly (a
// top-level wait standing in for a cold type-check), then answers "ok" or loops forever on
// "loop", following the probe's ready / result protocol.

await new Promise((r) => setTimeout(r, 500));

self.onmessage = (e: MessageEvent<string>) => {
  if (e.data === "loop") { for (;;) { /* a render that never finishes */ } }
  self.postMessage({ type: "result", data: { answered: e.data } });
};
self.postMessage({ type: "ready" });
