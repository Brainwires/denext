// Child of tests/spa-script-workers.test.ts, run with `--unstable-html-rewriter`: stamps each
// shell read from stdin (a JSON array) on both paths and prints `{ rewriter, pairs }`, where each
// pair is `[stringPath, streamedPath]`.
import { stampWorkerNonce, stampWorkerNonceBody } from "../../../src/build/spa/script-workers.ts";

const shells: string[] = JSON.parse(await new Response(Deno.stdin.readable).text());
const pairs: [string, string, boolean][] = [];
for (const shell of shells) {
  const body = stampWorkerNonceBody(shell, "/_denext/~partytown/", "n0nce");
  const streamed = typeof body === "string" ? body : await new Response(body).text();
  pairs.push([
    stampWorkerNonce(shell, "/_denext/~partytown/", "n0nce"),
    streamed,
    typeof body !== "string",
  ]);
}
console.log(
  JSON.stringify({
    rewriter: typeof (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter,
    pairs,
  }),
);
