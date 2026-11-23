// The NTB1 batch encoder (src/gpui/encoder.ts): golden bytes for a small batch written by hand from
// the B1 spec, every opcode and value tag through an independent decoder, buffer growth, and the
// writer starting over after each batch.

import { assertEquals } from "@std/assert";
import { BatchWriter, OP, sameValue, TAG, UNSET } from "../src/gpui/encoder.ts";
import { decodeBatch } from "./helpers/gpui-fakes.ts";

Deno.test("golden bytes: header, CREATE, SET_ROOT, SET_STYLE, SET_TEXT (little-endian)", () => {
  const w = new BatchWriter(16); // forces the buffer to grow
  w.create(1, 1);
  w.setRoot(1);
  w.setStyle(1, [
    [40, { tag: "color", value: 0xff0000ff }],
    [20, { tag: "percent", value: 50 }],
    [21, { tag: "auto" }],
  ]);
  w.setText(2, "hé");
  assertEquals(w.opCount, 4);
  // deno-fmt-ignore
  const golden = [
    0x4e, 0x54, 0x42, 0x31, 0x01, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
    // CREATE id 1, kind 1
    0x01, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
    // SET_ROOT 1
    0x05, 0x01, 0x00, 0x00, 0x00,
    // SET_STYLE id 1, n 3
    0x06, 0x01, 0x00, 0x00, 0x00, 0x03, 0x00,
    // backgroundColor (40): color 0xff0000ff
    0x28, 0x00, 0x05, 0xff, 0x00, 0x00, 0xff,
    // width (20): percent 50.0
    0x14, 0x00, 0x02, 0x00, 0x00, 0x48, 0x42,
    // height (21): auto
    0x15, 0x00, 0x03,
    // SET_TEXT id 2, "hé" (3 UTF-8 bytes)
    0x08, 0x02, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x68, 0xc3, 0xa9,
  ];
  assertEquals([...w.finish(7)], golden);
});

Deno.test("every opcode and value tag round-trips", () => {
  const w = new BatchWriter();
  w.insert(1, 2);
  w.insert(1, 3, 2);
  w.remove(1, 2);
  w.destroy(2);
  w.setProp(3, 6, { tag: "f64", value: 2 ** 40 + 0.5 });
  w.setProp(3, 1, { tag: "string", value: "héllo ✓" });
  w.setProp(3, 3, { tag: "bool", value: true });
  w.setProp(3, 4, { tag: "bool", value: false });
  w.setProp(3, 9, { tag: "enum", value: 2 });
  w.setProp(3, 2, UNSET);
  w.setStyle(3, [[52, { tag: "f32", value: 14.5 }]]);
  w.listen(3, 1 | 16);
  w.setImage(4, 9);
  w.imageData(9, "image/png", new Uint8Array([1, 2, 3]));
  w.imageFree(9);
  const { seq, ops } = decodeBatch(w.finish(0xffffffff));
  assertEquals(seq, 0xffffffff);
  assertEquals(ops, [
    { op: "INSERT", parent: 1, child: 2, before: 0 },
    { op: "INSERT", parent: 1, child: 3, before: 2 },
    { op: "REMOVE", parent: 1, child: 2 },
    { op: "DESTROY", id: 2 },
    { op: "SET_PROP", id: 3, prop: 6, value: { tag: "f64", value: 2 ** 40 + 0.5 } },
    { op: "SET_PROP", id: 3, prop: 1, value: { tag: "string", value: "héllo ✓" } },
    { op: "SET_PROP", id: 3, prop: 3, value: { tag: "bool", value: true } },
    { op: "SET_PROP", id: 3, prop: 4, value: { tag: "bool", value: false } },
    { op: "SET_PROP", id: 3, prop: 9, value: { tag: "enum", value: 2 } },
    { op: "SET_PROP", id: 3, prop: 2, value: { tag: "unset" } },
    { op: "SET_STYLE", id: 3, props: [[52, { tag: "f32", value: 14.5 }]] },
    { op: "LISTEN", id: 3, mask: 17 },
    { op: "SET_IMAGE", id: 4, image: 9 },
    { op: "IMAGE_DATA", image: 9, mime: "image/png", bytes: [1, 2, 3] },
    { op: "IMAGE_FREE", image: 9 },
  ]);
});

Deno.test("the opcode and tag tables are the spec's", () => {
  assertEquals(Object.values(OP), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assertEquals(TAG, {
    unset: 0,
    f32: 1,
    percent: 2,
    auto: 3,
    enum: 4,
    color: 5,
    string: 6,
    bool: 7,
    f64: 8,
  });
});

Deno.test("the buffer grows for large payloads and each batch starts over", () => {
  const w = new BatchWriter(16);
  const big = "x".repeat(100_000);
  const bytes = new Uint8Array(70_000).fill(7);
  w.setText(1, big);
  w.imageData(2, "image/jpeg", bytes);
  const first = decodeBatch(w.finish(1));
  assertEquals(first.ops.length, 2);
  assertEquals((first.ops[0] as { text: string }).text.length, 100_000);
  assertEquals((first.ops[1] as { bytes: number[] }).bytes.length, 70_000);
  assertEquals(w.opCount, 0);
  const empty = w.finish(2);
  assertEquals(empty.length, 16);
  assertEquals(decodeBatch(empty), { seq: 2, ops: [] });
});

Deno.test("sameValue compares tag and payload", () => {
  assertEquals(sameValue({ tag: "f32", value: 1 }, { tag: "f32", value: 1 }), true);
  assertEquals(sameValue({ tag: "f32", value: 1 }, { tag: "percent", value: 1 }), false);
  assertEquals(sameValue({ tag: "f32", value: NaN }, { tag: "f32", value: NaN }), true);
  assertEquals(sameValue({ tag: "auto" }, { tag: "auto" }), true);
  assertEquals(sameValue(undefined, { tag: "auto" }), false);
  assertEquals(sameValue(undefined, undefined), true);
});
