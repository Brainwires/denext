import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { Fragment, h, jsx } from "../src/jsx/jsx-runtime.ts";
import { FRAGMENT } from "../src/jsx/types.ts";

Deno.test("jsx creates a vnode with normalized props", () => {
  const node = jsx("div", { className: "box", children: "hi" });
  assertEquals(node.type, "div");
  assertEquals(node.props.className, "box");
  assertEquals(node.props.children, "hi");
  assertEquals(node.key, null);
});

Deno.test("jsx lifts an explicit key argument onto the node", () => {
  const node = jsx("li", { children: "item" }, "row-1");
  assertEquals(node.key, "row-1");
  assertEquals(node.props.key, "row-1");
});

Deno.test("Fragment is the shared fragment symbol", () => {
  assertEquals(Fragment, FRAGMENT);
});

Deno.test("h() collects variadic children", () => {
  const node = h("ul", null, h("li", null, "a"), h("li", null, "b"));
  const kids = node.props.children as unknown[];
  assertEquals(Array.isArray(kids), true);
  assertEquals(kids.length, 2);
});

Deno.test("h() with a single child stores it unwrapped", () => {
  const node = h("p", null, "solo");
  assertEquals(node.props.children, "solo");
});
