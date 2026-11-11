// newHtmlRewriter(): the streaming shell stamp is opt-in (DENEXT_HTML_REWRITER=1) and needs the
// runtime's HTMLRewriter. Every branch runs in process here, with a stand-in constructor, so the
// coverage job counts them (the real rewriter only runs in a child with --unstable-html-rewriter).

import { assert, assertEquals } from "@std/assert";
import { newHtmlRewriter } from "../src/server/html-rewriter.ts";

const ENV = "DENEXT_HTML_REWRITER";

class FakeRewriter {
  on() {
    return this;
  }
  transform(input: Response) {
    return input;
  }
}

/** Run `fn` with `HTMLRewriter` set to `ctor` (or removed) and DENEXT_HTML_REWRITER set to `value`. */
function withRewriter(
  ctor: unknown,
  value: string | undefined,
  fn: () => void,
): void {
  const g = globalThis as { HTMLRewriter?: unknown };
  const hadCtor = "HTMLRewriter" in g;
  const oldCtor = g.HTMLRewriter;
  const oldEnv = Deno.env.get(ENV);
  if (ctor === undefined) delete g.HTMLRewriter;
  else g.HTMLRewriter = ctor;
  if (value === undefined) Deno.env.delete(ENV);
  else Deno.env.set(ENV, value);
  try {
    fn();
  } finally {
    if (hadCtor) g.HTMLRewriter = oldCtor;
    else delete g.HTMLRewriter;
    if (oldEnv === undefined) Deno.env.delete(ENV);
    else Deno.env.set(ENV, oldEnv);
  }
}

Deno.test("newHtmlRewriter: a rewriter only when the runtime has one and the app opted in", () => {
  withRewriter(FakeRewriter, "1", () => {
    assert(newHtmlRewriter() instanceof FakeRewriter);
  });
  for (const value of [undefined, "0", "true", ""]) {
    withRewriter(FakeRewriter, value, () => assertEquals(newHtmlRewriter(), null));
  }
  withRewriter(undefined, "1", () => assertEquals(newHtmlRewriter(), null));
  withRewriter("not a constructor", "1", () => assertEquals(newHtmlRewriter(), null));
});

Deno.test("newHtmlRewriter: an env the process may not read counts as not opted in", () => {
  withRewriter(FakeRewriter, "1", () => {
    const get = Deno.env.get;
    Deno.env.get = () => {
      throw new Deno.errors.NotCapable("Requires env access");
    };
    try {
      assertEquals(newHtmlRewriter(), null);
    } finally {
      Deno.env.get = get;
    }
  });
});
