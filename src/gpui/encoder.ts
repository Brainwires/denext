/**
 * The NTB1 batch encoder: the binary format a window's `nativeTree.commit` takes (B1 spec, "Batch
 * format, version 1"). All integers are little-endian; a string is a `u32` byte length and its
 * UTF-8; node id 0 means none.
 *
 * ```
 * header:  "NTB1" | version u16 = 1 | flags u16 = 0 | seq u32 | op_count u32
 * op:      opcode u8 | payload
 * ```
 *
 * {@linkcode BatchWriter} appends ops to a buffer that doubles as it fills, and
 * {@linkcode BatchWriter.finish} writes the header and hands back one batch.
 *
 * @module
 */

import { NTB_VERSION } from "./props.generated.ts";

/** The opcodes (the spec's op table). */
export const OP = {
  CREATE: 1,
  INSERT: 2,
  REMOVE: 3,
  DESTROY: 4,
  SET_ROOT: 5,
  SET_STYLE: 6,
  SET_PROP: 7,
  SET_TEXT: 8,
  LISTEN: 9,
  SET_IMAGE: 10,
  IMAGE_DATA: 11,
  IMAGE_FREE: 12,
} as const;

/** The value tags (the spec's value encoding table). */
export const TAG = {
  unset: 0,
  f32: 1,
  percent: 2,
  auto: 3,
  enum: 4,
  color: 5,
  string: 6,
  bool: 7,
  f64: 8,
} as const;

/** A style or prop value, as one value tag and its payload. */
export type NtValue =
  | { readonly tag: "unset" }
  | { readonly tag: "auto" }
  | { readonly tag: "f32" | "percent" | "f64"; readonly value: number }
  | { readonly tag: "enum"; readonly value: number }
  | { readonly tag: "color"; readonly value: number }
  | { readonly tag: "string"; readonly value: string }
  | { readonly tag: "bool"; readonly value: boolean };

/** The `unset` value: the prop goes back to its default. */
export const UNSET: NtValue = { tag: "unset" };

/**
 * Whether two values encode to the same bytes (a diff sends only the props that differ).
 *
 * @param a One value.
 * @param b The other.
 * @returns Whether they are equal.
 */
export function sameValue(a: NtValue | undefined, b: NtValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.tag !== b.tag) return false;
  const av = (a as { value?: unknown }).value;
  const bv = (b as { value?: unknown }).value;
  return av === bv || (Number.isNaN(av) && Number.isNaN(bv));
}

/** The header's magic, "NTB1". */
const MAGIC = [0x4e, 0x54, 0x42, 0x31] as const;
/** The header's size in bytes. */
const HEADER_BYTES = 16;

const utf8 = new TextEncoder();

/**
 * One window's batch under construction: ops are appended as the renderer works, and
 * {@linkcode BatchWriter.finish} turns them into the bytes `nativeTree.commit` takes, then starts
 * the next batch.
 */
export class BatchWriter {
  #bytes: Uint8Array;
  #view: DataView;
  #length = HEADER_BYTES;
  #ops = 0;

  /** @param capacity The first buffer's size in bytes (it doubles as needed). */
  constructor(capacity = 1024) {
    this.#bytes = new Uint8Array(Math.max(HEADER_BYTES, capacity));
    this.#view = new DataView(this.#bytes.buffer);
  }

  /** How many ops the batch holds. */
  get opCount(): number {
    return this.#ops;
  }

  /** Make room for `more` bytes. */
  #reserve(more: number): void {
    const need = this.#length + more;
    if (need <= this.#bytes.length) return;
    let size = this.#bytes.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = next;
    this.#view = new DataView(next.buffer);
  }

  #u8(v: number): void {
    this.#reserve(1);
    this.#view.setUint8(this.#length, v);
    this.#length += 1;
  }

  #u16(v: number): void {
    this.#reserve(2);
    this.#view.setUint16(this.#length, v, true);
    this.#length += 2;
  }

  #u32(v: number): void {
    this.#reserve(4);
    this.#view.setUint32(this.#length, v >>> 0, true);
    this.#length += 4;
  }

  #f32(v: number): void {
    this.#reserve(4);
    this.#view.setFloat32(this.#length, v, true);
    this.#length += 4;
  }

  #f64(v: number): void {
    this.#reserve(8);
    this.#view.setFloat64(this.#length, v, true);
    this.#length += 8;
  }

  #data(bytes: Uint8Array): void {
    this.#u32(bytes.length);
    this.#reserve(bytes.length);
    this.#bytes.set(bytes, this.#length);
    this.#length += bytes.length;
  }

  #string(text: string): void {
    // UTF-8 takes at most 3 bytes per UTF-16 code unit.
    this.#reserve(4 + text.length * 3);
    const at = this.#length;
    const { written } = utf8.encodeInto(text, this.#bytes.subarray(at + 4));
    this.#view.setUint32(at, written, true);
    this.#length = at + 4 + written;
  }

  #op(code: number): void {
    this.#u8(code);
    this.#ops += 1;
  }

  /** Write `value`: its tag, then its payload. */
  #value(value: NtValue): void {
    this.#u8(TAG[value.tag]);
    switch (value.tag) {
      case "f32":
      case "percent":
        return this.#f32(value.value);
      case "f64":
        return this.#f64(value.value);
      case "enum":
        return this.#u8(value.value);
      case "color":
        return this.#u32(value.value);
      case "string":
        return this.#string(value.value);
      case "bool":
        return this.#u8(value.value ? 1 : 0);
    }
  }

  /** CREATE: a new node of `kind` (ids are never reused). */
  create(id: number, kind: number): void {
    this.#op(OP.CREATE);
    this.#u32(id);
    this.#u16(kind);
  }

  /** INSERT: attach (or move) `child` under `parent`, before `before` (0 appends). */
  insert(parent: number, child: number, before = 0): void {
    this.#op(OP.INSERT);
    this.#u32(parent);
    this.#u32(child);
    this.#u32(before);
  }

  /** REMOVE: detach `child` from `parent` (the node stays alive). */
  remove(parent: number, child: number): void {
    this.#op(OP.REMOVE);
    this.#u32(parent);
    this.#u32(child);
  }

  /** DESTROY: free the node and its detached subtree. */
  destroy(id: number): void {
    this.#op(OP.DESTROY);
    this.#u32(id);
  }

  /** SET_ROOT: the window's root view (0 for none). */
  setRoot(id: number): void {
    this.#op(OP.SET_ROOT);
    this.#u32(id);
  }

  /** SET_STYLE: set the listed style props (`unset` resets one to its default). */
  setStyle(id: number, entries: ReadonlyArray<readonly [number, NtValue]>): void {
    this.#op(OP.SET_STYLE);
    this.#u32(id);
    this.#u16(entries.length);
    for (const [prop, value] of entries) {
      this.#u16(prop);
      this.#value(value);
    }
  }

  /** SET_PROP: one non-style prop. */
  setProp(id: number, prop: number, value: NtValue): void {
    this.#op(OP.SET_PROP);
    this.#u32(id);
    this.#u16(prop);
    this.#value(value);
  }

  /** SET_TEXT: a RawText node's content. */
  setText(id: number, text: string): void {
    this.#op(OP.SET_TEXT);
    this.#u32(id);
    this.#string(text);
  }

  /** LISTEN: the node's event mask (replaces the previous one). */
  listen(id: number, mask: number): void {
    this.#op(OP.LISTEN);
    this.#u32(id);
    this.#u32(mask);
  }

  /** SET_IMAGE: point an Image node at a decoded image (0 for none). */
  setImage(id: number, imageId: number): void {
    this.#op(OP.SET_IMAGE);
    this.#u32(id);
    this.#u32(imageId);
  }

  /** IMAGE_DATA: an image's encoded bytes, which the host decodes and caches. */
  imageData(imageId: number, mime: string, bytes: Uint8Array): void {
    this.#op(OP.IMAGE_DATA);
    this.#u32(imageId);
    this.#string(mime);
    this.#data(bytes);
  }

  /** IMAGE_FREE: the host may drop the image. */
  imageFree(imageId: number): void {
    this.#op(OP.IMAGE_FREE);
    this.#u32(imageId);
  }

  /**
   * Seal the batch: write its header with `seq`, return its bytes (a copy), and start an empty
   * batch.
   *
   * @param seq The batch's sequence number (per window).
   * @returns The batch.
   */
  finish(seq: number): Uint8Array {
    this.#bytes.set(MAGIC, 0);
    this.#view.setUint16(4, NTB_VERSION, true);
    this.#view.setUint16(6, 0, true);
    this.#view.setUint32(8, seq >>> 0, true);
    this.#view.setUint32(12, this.#ops, true);
    const batch = this.#bytes.slice(0, this.#length);
    this.#length = HEADER_BYTES;
    this.#ops = 0;
    return batch;
  }
}
