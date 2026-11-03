// A client build leaves a runtime piece out when a scan of the app's own sources finds no use of
// it. A use the scan can't see (a library's) must not fail quietly: like the form-action and
// hook-boundary gates (errors 6 and 7), the route-pattern href gate reports error 8 instead of
// navigating to the literal `/blog/[slug]`, and the blur-placeholder gate reports error 9 instead
// of leaving the placeholder painted.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { formatHref, installBlurGate } from "../src/client/navigation.ts";
import { BLUR_ATTR } from "../src/runtime/image-blur.ts";

/** Run `fn` with the define `name` set to `false`, collecting what `reportError` reported. */
function withGateOff(name: string, fn: () => void): Error[] {
  const g = globalThis as Record<string, unknown>;
  const seen: Error[] = [];
  const onError = (e: ErrorEvent) => {
    e.preventDefault();
    seen.push(e.error);
  };
  addEventListener("error", onError);
  g[name] = false;
  try {
    fn();
  } finally {
    delete g[name];
    removeEventListener("error", onError);
  }
  return seen;
}

Deno.test("href gate off: a route-pattern href reports error 8; a plain one doesn't", () => {
  let out = "";
  const seen = withGateOff("__DENEXT_HREF_PARAMS__", () => {
    out = formatHref({ pathname: "/blog/[slug]", params: { slug: "x" } } as never);
    formatHref({ pathname: "/blog/x", params: { slug: "x" } } as never);
  });
  assertEquals(out, "/blog/[slug]");
  assertEquals(seen.length, 1);
  assertStringIncludes(seen[0].message, "error 8");
  // With the gate on (unset: the dev / unbundled path) the pattern is filled, nothing reported.
  assertEquals(formatHref({ pathname: "/blog/[slug]", params: { slug: "x" } } as never), "/blog/x");
});

Deno.test("blur gate off: a server-rendered blur placeholder reports error 9", () => {
  const doc = (selector: string | null) =>
    ({ querySelector: (s: string) => (s === selector ? {} : null) }) as unknown as Document;
  const seen = withGateOff("__DENEXT_IMAGE_BLUR__", () => {
    installBlurGate(doc(`img[${BLUR_ATTR}]`));
    installBlurGate(doc(null)); // no placeholder on the page: nothing to say
  });
  assertEquals(seen.length, 1);
  assertStringIncludes(seen[0].message, "error 9");
});
