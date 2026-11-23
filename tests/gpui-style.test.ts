// React Native styles to NTB1 style props (src/gpui/style.ts, color.ts, stylesheet.ts): colour
// parsing to RGBA u32, flattening, shorthand expansion with React Native's precedence, value
// encoding per prop, and the diff that unsets removed props.

import { assertEquals, assertStrictEquals } from "@std/assert";
import { parseColor } from "../src/gpui/color.ts";
import {
  diffStyle,
  encodeStyleValue,
  expandShorthands,
  flattenStyle,
  registerStyle,
  resolveStyle,
} from "../src/gpui/style.ts";
import { StyleSheet } from "../src/gpui/stylesheet.ts";
import { ENUM, STYLE_PROP } from "../src/gpui/props.generated.ts";

Deno.test("parseColor: hex forms", () => {
  assertEquals(parseColor("#f00"), 0xff0000ff);
  assertEquals(parseColor("#f008"), 0xff000088);
  assertEquals(parseColor("#00FF00"), 0x00ff00ff);
  assertEquals(parseColor("#12345678"), 0x12345678);
  assertEquals(parseColor("#12345"), null);
  assertEquals(parseColor("#ggg"), null);
});

Deno.test("parseColor: rgb() / rgba(), comma and space syntax", () => {
  assertEquals(parseColor("rgb(255, 0, 0)"), 0xff0000ff);
  assertEquals(parseColor("rgba(0, 0, 255, 0.5)"), 0x0000ff80);
  assertEquals(parseColor("rgb(0 128 0 / 50%)"), 0x00800080);
  assertEquals(parseColor("rgb(100%, 0%, 0%)"), 0xff0000ff);
  assertEquals(parseColor("rgba(300, -5, 0, 2)"), 0xff0000ff);
  assertEquals(parseColor("rgb(1, 2)"), null);
  assertEquals(parseColor("rgb(1, x, 2)"), null);
  assertEquals(parseColor("rgba(1, 2, 3, nope)"), null);
  assertEquals(parseColor("rgb(1 2 3 / 4 / 5)"), null);
  assertEquals(parseColor("rgb(, 2, 3)"), null);
});

Deno.test("parseColor: names, transparent, case and what is not a colour", () => {
  assertEquals(parseColor("tomato"), 0xff6347ff);
  assertEquals(parseColor("  RebeccaPurple "), 0x663399ff);
  assertEquals(parseColor("transparent"), 0);
  assertEquals(parseColor("hsl(0, 100%, 50%)"), null);
  assertEquals(parseColor("notacolor"), null);
  assertEquals(parseColor(0xff0000), null);
  assertEquals(parseColor(undefined), null);
});

Deno.test("flattenStyle: arrays, nesting, falsy entries, registered ids, explicit undefined", () => {
  const id = registerStyle({ color: "red", margin: 2 });
  assertEquals(flattenStyle([{ padding: 1 }, null, false, [{ padding: 2 }, id], undefined]), {
    padding: 2,
    color: "red",
    margin: 2,
  });
  assertEquals(flattenStyle([{ color: "red" }, { color: undefined }]), { color: undefined });
  assertEquals(flattenStyle([null, false]), undefined);
  assertEquals(flattenStyle(null), undefined);
  assertEquals(flattenStyle("nope"), undefined);
  const one = { flex: 1 };
  assertStrictEquals(flattenStyle(one), one);
});

Deno.test("expandShorthands: side beats axis beats all, start/end beat left/right", () => {
  const out = expandShorthands({
    marginTop: 5,
    margin: 1,
    marginHorizontal: 2,
    paddingVertical: 3,
    padding: 4,
    paddingStart: 9,
    paddingLeft: 7,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderColor: "red",
    borderRadius: 6,
    borderTopRightRadius: 0,
    transform: [{ scale: 2 }],
    shadowColor: "black",
    opacity: undefined,
    color: null,
  });
  assertEquals(Object.fromEntries(out), {
    marginTop: 5,
    marginRight: 2,
    marginBottom: 1,
    marginLeft: 2,
    paddingTop: 3,
    paddingRight: 4,
    paddingBottom: 3,
    paddingLeft: 9,
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderLeftWidth: 3,
    borderTopColor: "red",
    borderRightColor: "red",
    borderBottomColor: "red",
    borderLeftColor: "red",
    borderTopLeftRadius: 6,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 6,
    borderBottomLeftRadius: 6,
  });
  assertEquals(expandShorthands(undefined).size, 0);
  // Order does not matter: the longhand written first still wins over a later shorthand.
  assertEquals(
    expandShorthands({ marginEnd: 4, marginHorizontal: 1, marginVertical: 2 }).get("marginRight"),
    4,
  );
});

Deno.test("encodeStyleValue: lengths, enums, colours, fonts, aspect ratio", () => {
  assertEquals(encodeStyleValue("width", 10), { tag: "f32", value: 10 });
  assertEquals(encodeStyleValue("width", "50%"), { tag: "percent", value: 50 });
  assertEquals(encodeStyleValue("width", "auto"), { tag: "auto" });
  assertEquals(encodeStyleValue("width", "%"), null);
  assertEquals(encodeStyleValue("width", "10px"), null);
  assertEquals(encodeStyleValue("width", Infinity), null);
  assertEquals(encodeStyleValue("flexDirection", "row-reverse"), { tag: "enum", value: 2 });
  assertEquals(encodeStyleValue("flexDirection", "sideways"), null);
  assertEquals(encodeStyleValue("textDecorationLine", "underline line-through"), {
    tag: "enum",
    value: ENUM.textDecorationLine["underline line-through"],
  });
  assertEquals(encodeStyleValue("backgroundColor", "#000"), { tag: "color", value: 0x000000ff });
  assertEquals(encodeStyleValue("color", "nope"), null);
  assertEquals(encodeStyleValue("fontFamily", "Inter"), { tag: "string", value: "Inter" });
  assertEquals(encodeStyleValue("fontFamily", 3), null);
  assertEquals(encodeStyleValue("fontWeight", "bold"), { tag: "f32", value: 700 });
  assertEquals(encodeStyleValue("fontWeight", "600"), { tag: "f32", value: 600 });
  assertEquals(encodeStyleValue("fontWeight", 300), { tag: "f32", value: 300 });
  assertEquals(encodeStyleValue("fontWeight", "heaviest"), null);
  assertEquals(encodeStyleValue("aspectRatio", 1.5), { tag: "f32", value: 1.5 });
  assertEquals(encodeStyleValue("aspectRatio", "16 / 8"), { tag: "f32", value: 2 });
  assertEquals(encodeStyleValue("aspectRatio", "3"), { tag: "f32", value: 3 });
  assertEquals(encodeStyleValue("aspectRatio", "a/b"), null);
  assertEquals(encodeStyleValue("aspectRatio", NaN), null);
  assertEquals(encodeStyleValue("aspectRatio", true), null);
});

Deno.test("resolveStyle and diffStyle: changed props, unset for removed ones, in id order", () => {
  const prev = resolveStyle({ padding: 4, backgroundColor: "red", opacity: 0.5 });
  const next = resolveStyle([{ padding: 4, backgroundColor: "blue" }, { width: "auto" }]);
  assertEquals(diffStyle(prev, next), [
    [STYLE_PROP.width, { tag: "auto" }],
    [STYLE_PROP.backgroundColor, { tag: "color", value: 0x0000ffff }],
    [STYLE_PROP.opacity, { tag: "unset" }],
  ]);
  assertEquals(diffStyle(next, next), []);
  // A value the prop does not take is left out (and so unset if it was set).
  assertEquals(resolveStyle({ color: "nope" }).size, 0);
});

Deno.test("StyleSheet: create freezes, flatten, compose, the constants", () => {
  const styles = StyleSheet.create({ a: { flex: 1 }, b: { padding: 2 } });
  assertEquals(Object.isFrozen(styles), true);
  assertEquals(Object.isFrozen(styles.a), true);
  assertEquals(StyleSheet.flatten([styles.a, styles.b]), { flex: 1, padding: 2 });
  assertEquals(StyleSheet.compose(styles.a, styles.b), [styles.a, styles.b]);
  assertStrictEquals(StyleSheet.compose(styles.a, null), styles.a);
  assertStrictEquals(StyleSheet.compose(null, styles.b), styles.b);
  assertEquals(StyleSheet.flatten(StyleSheet.registerStyle({ top: 1 })), { top: 1 });
  assertEquals(StyleSheet.hairlineWidth, 1);
  assertEquals(StyleSheet.absoluteFill, {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  });
  assertStrictEquals(StyleSheet.absoluteFillObject, StyleSheet.absoluteFill);
});
