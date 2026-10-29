// Adopting a Lustre server component's first paint (`src/lustre/view-adopt.ts`): the server's
// JSON view walked against the nodes its `to_string` HTML parsed into, over a small DOM
// (tests/helpers/lustre-adopt-dom.ts) and Lustre's `insertMetadataChild` as Lustre writes it. The
// nodes stay (same identity), get Lustre's metadata at the paths the reconciler would have given
// them, and the handlers and properties come back as one `update` patch. Through the view client
// (mount frames, focus, the fallback) in tests/gleam-lustre-view-client.vitest.ts; with the real
// Lustre runtime in tests/e2e/lustre.e2e.test.ts.

import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { adoptLustreView, LustreAdoptMismatch } from "../src/lustre/view-adopt.ts";
import type { LustreInsertMetadata } from "../src/lustre/view-adopt.ts";
import {
  el,
  insertMetadataChild,
  metaOf,
  type MiniComment,
  MiniDocument,
  type MiniElement,
  type MiniNode,
  type MiniText,
} from "./helpers/lustre-adopt-dom.ts";

const insert = insertMetadataChild as unknown as LustreInsertMetadata;
const adopt = (root: MiniElement, vdom: unknown) =>
  adoptLustreView(root as unknown as Element, vdom, insert);

// The server's view, as Lustre's `vnode.to_json` writes it (empty fields left out).
const text = (content: string) => ({ kind: 2, ...(content ? { content } : {}) });
const attr = (name: string, value: string) => ({ kind: 0, name, value });
const on = (name: string) => ({ kind: 2, name, prevent_default: { kind: 0 } });
const element = (tag: string, attributes: unknown[], children: unknown[] = []) => ({
  kind: 1,
  tag,
  ...(attributes.length ? { attributes } : {}),
  ...(children.length ? { children } : {}),
});

/** The example counter's view (examples/lustre/gleam/src/counter.gleam) at `count`. */
const counterView = (count: number) =>
  element("div", [attr("class", "counter")], [
    element("button", [attr("class", "dec"), on("click")], [text("-")]),
    element("span", [attr("class", "count")], [text(String(count))]),
    element("button", [attr("class", "inc"), on("click")], [text("+")]),
    element("input", [attr("class", "note"), attr("value", ""), on("input")]),
    element("output", [attr("class", "echo")], []),
  ]);

/** Its `to_string` HTML, as the parser builds it. */
function counterPaint(doc: MiniDocument, count: number) {
  const root = el(doc, "div", { "data-dnx-lustre-view": "counter" });
  const parts = {
    dec: el(doc, "button", { class: "dec" }, "-"),
    count: el(doc, "span", { class: "count" }, String(count)),
    inc: el(doc, "button", { class: "inc" }, "+"),
    note: el(doc, "input", { class: "note", value: "" }),
    echo: el(doc, "output", { class: "echo" }),
  };
  const counter = el(doc, "div", { class: "counter" }, ...Object.values(parts));
  root.appendChild(counter);
  return { root, counter, ...parts };
}

Deno.test("adoptLustreView: the server-rendered nodes are the view's nodes, with Lustre's metadata", () => {
  const doc = new MiniDocument();
  const paint = counterPaint(doc, 7);
  const before = [paint.counter, paint.dec, paint.count, paint.count.firstChild, paint.note];
  const { patch, edited } = adopt(paint.root, counterView(7));

  // Same nodes, in the same places, nothing added.
  assertStrictEquals(paint.root.firstChild, paint.counter);
  assertEquals(paint.root.childNodes.length, 1);
  assertEquals(
    [paint.counter, paint.dec, paint.count, paint.count.firstChild, paint.note],
    before,
  );
  assertStrictEquals(paint.counter.childNodes[1], paint.count);
  assertEquals((paint.count.firstChild as MiniText).data, "7");

  // Metadata where the reconciler looks: root → counter → its five children, by index.
  const rootMeta = metaOf(paint.root)!;
  assertStrictEquals(rootMeta.children[0].node, paint.counter);
  assertEquals(
    rootMeta.children[0].children.map((m) => m.node),
    [paint.dec, paint.count, paint.inc, paint.note, paint.echo],
  );
  assertStrictEquals(metaOf(paint.count.firstChild!)!.parent, metaOf(paint.count));

  // The handlers HTML could not carry, as one patch: counter (0) → dec (0), inc (2), note (3).
  assertEquals(patch.children.length, 1);
  assertEquals(patch.children[0].children.map((p) => p.index), [0, 2, 3]);
  assertEquals(patch.children[0].children[0].changes, [
    { kind: 2, added: [on("click")], removed: [] },
  ]);
  assertEquals(edited, []);
});

Deno.test("adoptLustreView: what the visitor typed is kept, and the field is reported", () => {
  const doc = new MiniDocument();
  const paint = counterPaint(doc, 1);
  paint.note.focus();
  paint.note.value = "typed before the mount";
  const view = counterView(1);
  // A `value` property in the view (Lustre's `property("value", …)`) would overwrite it.
  (view.children![3] as { attributes: unknown[] }).attributes.push({
    kind: 1,
    name: "value",
    value: "",
  });
  const { patch, edited } = adopt(paint.root, view);
  assertEquals(paint.note.value, "typed before the mount");
  assertStrictEquals(doc.activeElement, paint.note);
  assertEquals(edited, [paint.note as unknown as Element]);
  // The note's patch carries its input handler, not the value property.
  const notePatch = patch.children[0].children.find((p) => p.index === 3)!;
  assertEquals(notePatch.changes[0].added.map((a) => a.name), ["input"]);
});

Deno.test("adoptLustreView: fragments, maps and memos read from to_string's markers", () => {
  const doc = new MiniDocument();
  const c = (data: string) => doc.createComment(data) as MiniComment;
  const open = c(" lustre:fragment ");
  const close = c(" /lustre:fragment ");
  const map = c(" lustre:map ");
  const memo = c(" lustre:memo ");
  const a = el(doc, "a", {});
  const b = el(doc, "b", { "data-lustre-key": "k1" });
  const i = el(doc, "i", {});
  const section = el(doc, "section", {});
  for (const n of [open, a, memo, b, close, map, i]) section.appendChild(n as MiniNode);
  const root = el(doc, "div", {}, section);
  const view = element("section", [], [
    { kind: 0, children: [element("a", []), { ...element("b", []), key: "k1" }] },
    { kind: 4, child: element("i", []) },
  ]);
  adopt(root, view);
  const outer = metaOf(section)!;
  const inner = outer.children[0];
  assertStrictEquals(inner.node, open);
  assertStrictEquals(inner.endNode, close);
  assertEquals(inner.children.map((m) => m.node), [a, b]);
  assertEquals(inner.children[1].key, "k1");
  assertEquals(b.getAttribute("data-lustre-key"), null); // Lustre's virtualise drops it too
  assertStrictEquals(outer.children[1].node, map);
  assertStrictEquals(outer.children[1].children[0].node, i);
  assert(!section.childNodes.includes(memo), "memo markers are removed, as virtualise does");

  // A fragment or map with no marker in the page gets an empty text node as its head, as the
  // reconciler writes one outside debug mode.
  const bare = el(doc, "div", {}, el(doc, "a", {}));
  adopt(bare, { kind: 0, children: [{ kind: 4, child: element("a", []) }] });
  const heads = bare.childNodes.slice(0, 2) as MiniText[];
  assertEquals(heads.map((h) => [h.nodeType, h.data]), [[3, ""], [3, ""]]);
  assertStrictEquals(metaOf(heads[0])!.children[0].node, heads[1]);
});

Deno.test("adoptLustreView: merged text is split, empty text inserted, differing text and attributes set", () => {
  const doc = new MiniDocument();
  const p = el(doc, "p", { class: "old" }, "Hello, world");
  const root = el(doc, "div", {}, p);
  const stale = el(doc, "span", {});
  p.appendChild(stale); // past the view's children: removed
  adopt(
    root,
    element("p", [attr("class", "new")], [text("Hello, "), text("world"), text(""), text("!")]),
  );
  assertEquals(p.getAttribute("class"), "new");
  assertEquals(p.childNodes.map((n) => (n as MiniText).data), ["Hello, ", "world", "", "!"]);
  assertEquals(metaOf(p)!.children.map((m) => m.node), p.childNodes);
});

Deno.test("adoptLustreView: another tag than the view's is a mismatch", () => {
  const doc = new MiniDocument();
  const root = el(doc, "div", {}, el(doc, "section", {}));
  assertThrows(() => adopt(root, element("article", [])), LustreAdoptMismatch);
  assertThrows(() => adopt(el(doc, "div", {}), element("p", [])), LustreAdoptMismatch);
  assertThrows(() => adopt(root, null), LustreAdoptMismatch);
  assertThrows(() => adopt(root, { kind: 9 }), LustreAdoptMismatch);
  const unclosed = el(doc, "div", {});
  unclosed.appendChild(doc.createComment(" lustre:fragment "));
  unclosed.appendChild(el(doc, "a", {}));
  assertThrows(
    () => adopt(unclosed, { kind: 0, children: [element("a", [])] }),
    LustreAdoptMismatch,
  );
  assertThrows(() => adopt(root, { kind: 4 }), LustreAdoptMismatch);
});
