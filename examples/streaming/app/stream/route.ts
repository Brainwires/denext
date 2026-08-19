// True out-of-order streaming SSR via `renderToReadableStream`. Unlike the page
// path (which buffers), this handler flushes the shell — including each Suspense
// fallback — in the first chunk, then streams a <template> + swap script for each
// boundary as its data resolves. Written with `h()` because API route files are
// plain .ts (no JSX).

import { createResource, h, renderToReadableStream, Suspense } from "denext";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function GET(): Response {
  // A resource that resolves after a beat; reading it suspends its boundary.
  const report = createResource(() =>
    delay(400).then(() => "Report ready ✓ (streamed in after the shell)")
  );
  const Report = () => h("p", { class: "metric" }, report());

  const tree = h(
    "main",
    { class: "app" },
    h("h1", null, "Streamed SSR"),
    h(
      "p",
      { class: "lede" },
      "This shell was flushed immediately. The report below streams in when its data resolves.",
    ),
    h(
      Suspense,
      {
        fallback: h(
          "p",
          { class: "skeleton", "data-fallback": "1" },
          "Generating report…",
        ),
      },
      h(Report, null),
    ),
  );

  const stream = renderToReadableStream(tree, {
    shellPrefix:
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Streamed SSR · denext</title><link rel="stylesheet" href="/styles.css"></head><body>`,
    shellSuffix: `</body></html>`,
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
