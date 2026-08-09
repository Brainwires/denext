import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

const devFlag = globalThis as { __denextDev?: boolean };

/** Run `fn` with the dev flag set (or not) while capturing console.warn output. */
function capture(dev: boolean, fn: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  if (dev) devFlag.__denextDev = true;
  try {
    fn();
  } finally {
    console.warn = original;
    delete devFlag.__denextDev;
  }
  return warnings;
}

Deno.test("dev hydration: warns on a host tag mismatch", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  // Server rendered <div>hi</div>; the client renders <span>hi</span>.
  const div = doc.createElement("div");
  div.appendChild(doc.createTextNode("hi"));
  container.appendChild(div);

  const warnings = capture(true, () => {
    hydrateRoot(asEl(container), h("span", null, "hi"));
  });

  assertEquals(warnings.length, 1, warnings.join("\n"));
  assertStringIncludes(warnings[0], "hydration mismatch");
  assertStringIncludes(warnings[0], "<span>");
  assertStringIncludes(warnings[0], "<div>");
});

Deno.test("dev hydration: warns on a text-content mismatch", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  // Server rendered <p>0</p>; the client renders <p>1</p>.
  const p = doc.createElement("p");
  p.appendChild(doc.createTextNode("0"));
  container.appendChild(p);

  const warnings = capture(true, () => {
    hydrateRoot(asEl(container), h("p", null, "1"));
  });

  assert(warnings.length >= 1, "expected a text-mismatch warning");
  assertStringIncludes(warnings[0], "hydration mismatch");
});

Deno.test("production hydration: mismatch is silent without the dev flag", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const div = doc.createElement("div");
  div.appendChild(doc.createTextNode("hi"));
  container.appendChild(div);

  const warnings = capture(false, () => {
    hydrateRoot(asEl(container), h("span", null, "hi"));
  });

  assertEquals(warnings, []);
});

Deno.test("dev hydration: a correct hydration produces no warning", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  // Server and client agree exactly: <button>0</button>.
  const button = doc.createElement("button");
  button.appendChild(doc.createTextNode("0"));
  container.appendChild(button);

  const warnings = capture(true, () => {
    hydrateRoot(asEl(container), h("button", null, "0"));
  });

  assertEquals(warnings, []);
});

Deno.test("dev hydration: a mismatched subtree warns once, not per node (no false-positive storm)", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  // Server: <div><b>x</b></div>; client: <section><i>x</i></section>.
  const div = doc.createElement("div");
  const b = doc.createElement("b");
  b.appendChild(doc.createTextNode("x"));
  div.appendChild(b);
  container.appendChild(div);

  function Client(): VNode {
    return h("section", null, h("i", null, "x"));
  }

  const warnings = capture(true, () => {
    hydrateRoot(asEl(container), h(Client, null));
  });

  // Only the outermost mismatch warns; once the cursor drops to null the whole
  // subtree mounts fresh WITHOUT warnings — exactly why dynamic({ssr:false}),
  // resolved Suspense, and error fallbacks (all null-cursor) never trip this.
  assertEquals(warnings.length, 1, warnings.join("\n"));
  assertStringIncludes(warnings[0], "<section>");
});
