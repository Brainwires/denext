// Fakes for the denext/gpui tests: an NTB1 batch decoder (the host's side of the format, written
// independently of src/gpui/encoder.ts from the B1 spec), a window with a recording
// `nativeTree`, and a `Deno.desktop` that reports the native tree.

/** A decoded value: its tag name and payload. */
export type DecodedValue =
  | { tag: "unset" }
  | { tag: "auto" }
  | { tag: "f32" | "percent" | "f64" | "enum" | "color"; value: number }
  | { tag: "string"; value: string }
  | { tag: "bool"; value: boolean };

/** A decoded op. */
export type DecodedOp =
  | { op: "CREATE"; id: number; kind: number }
  | { op: "INSERT"; parent: number; child: number; before: number }
  | { op: "REMOVE"; parent: number; child: number }
  | { op: "DESTROY"; id: number }
  | { op: "SET_ROOT"; id: number }
  | { op: "SET_STYLE"; id: number; props: Array<[number, DecodedValue]> }
  | { op: "SET_PROP"; id: number; prop: number; value: DecodedValue }
  | { op: "SET_TEXT"; id: number; text: string }
  | { op: "LISTEN"; id: number; mask: number }
  | { op: "SET_IMAGE"; id: number; image: number }
  | { op: "IMAGE_DATA"; image: number; mime: string; bytes: number[] }
  | { op: "IMAGE_FREE"; image: number };

/** A decoded batch. */
export interface DecodedBatch {
  seq: number;
  ops: DecodedOp[];
}

/** Each value tag's payload reader, by tag. */
const VALUE_READERS: Record<number, (r: Reader) => DecodedValue> = {
  0: () => ({ tag: "unset" }),
  1: (r) => ({ tag: "f32", value: r.f32() }),
  2: (r) => ({ tag: "percent", value: r.f32() }),
  3: () => ({ tag: "auto" }),
  4: (r) => ({ tag: "enum", value: r.u8() }),
  5: (r) => ({ tag: "color", value: r.u32() }),
  6: (r) => ({ tag: "string", value: r.string() }),
  7: (r) => ({ tag: "bool", value: r.u8() === 1 }),
  8: (r) => ({ tag: "f64", value: r.f64() }),
};

/** A little-endian reader over one batch. */
class Reader {
  at = 0;
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(): number {
    return this.view.getUint8(this.at++);
  }
  u16(): number {
    const v = this.view.getUint16(this.at, true);
    this.at += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.at, true);
    this.at += 4;
    return v;
  }
  f64(): number {
    const v = this.view.getFloat64(this.at, true);
    this.at += 8;
    return v;
  }
  data(): Uint8Array {
    const len = this.u32();
    const out = this.bytes.subarray(this.at, this.at + len);
    this.at += len;
    return out;
  }
  string(): string {
    return new TextDecoder().decode(this.data());
  }
  value(): DecodedValue {
    const read = VALUE_READERS[this.u8()];
    if (!read) throw new Error(`bad value tag at ${this.at - 1}`);
    return read(this);
  }
}

/** SET_STYLE's payload. */
function readStyle(r: Reader): DecodedOp {
  const id = r.u32();
  const n = r.u16();
  const props: Array<[number, DecodedValue]> = [];
  for (let i = 0; i < n; i++) props.push([r.u16(), r.value()]);
  return { op: "SET_STYLE", id, props };
}

/** Each opcode's payload reader, by opcode. */
const OP_READERS: Record<number, (r: Reader) => DecodedOp> = {
  1: (r) => ({ op: "CREATE", id: r.u32(), kind: r.u16() }),
  2: (r) => ({ op: "INSERT", parent: r.u32(), child: r.u32(), before: r.u32() }),
  3: (r) => ({ op: "REMOVE", parent: r.u32(), child: r.u32() }),
  4: (r) => ({ op: "DESTROY", id: r.u32() }),
  5: (r) => ({ op: "SET_ROOT", id: r.u32() }),
  6: readStyle,
  7: (r) => ({ op: "SET_PROP", id: r.u32(), prop: r.u16(), value: r.value() }),
  8: (r) => ({ op: "SET_TEXT", id: r.u32(), text: r.string() }),
  9: (r) => ({ op: "LISTEN", id: r.u32(), mask: r.u32() }),
  10: (r) => ({ op: "SET_IMAGE", id: r.u32(), image: r.u32() }),
  11: (r) => ({ op: "IMAGE_DATA", image: r.u32(), mime: r.string(), bytes: [...r.data()] }),
  12: (r) => ({ op: "IMAGE_FREE", image: r.u32() }),
};

/** One op, by opcode. */
function readOp(r: Reader): DecodedOp {
  const read = OP_READERS[r.u8()];
  if (!read) throw new Error(`bad opcode at ${r.at - 1}`);
  return read(r);
}

/**
 * Decode one NTB1 batch, checking the header and that every byte is consumed.
 *
 * @param bytes The batch.
 * @returns Its sequence number and ops.
 */
export function decodeBatch(bytes: Uint8Array): DecodedBatch {
  const r = new Reader(bytes);
  const magic = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8());
  if (magic !== "NTB1") throw new Error(`bad magic ${magic}`);
  if (r.u16() !== 1) throw new Error("bad version");
  if (r.u16() !== 0) throw new Error("bad flags");
  const seq = r.u32();
  const count = r.u32();
  const ops: DecodedOp[] = [];
  for (let i = 0; i < count; i++) ops.push(readOp(r));
  if (r.at !== bytes.length) throw new Error(`${bytes.length - r.at} trailing bytes`);
  return { seq, ops };
}

/** A window whose `nativeTree.commit` records each batch. */
export interface FakeWindow {
  /** The batches committed, in order. */
  readonly batches: Uint8Array[];
  /** What `commit` returns. */
  code: number;
  /** The native tree. */
  readonly nativeTree: { commit(batch: Uint8Array): number };
  /** The listeners, by event type. */
  readonly listeners: Map<string, Set<(event: Event) => void>>;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  /** Dispatch a `nativetree` event with `detail` (an object or JSON text). */
  emit(detail: unknown): void;
  /** Every batch decoded, then forgotten. */
  take(): DecodedBatch[];
  /** The ops of every batch, then forgotten. */
  takeOps(): DecodedOp[];
}

/**
 * A fake window (see {@linkcode FakeWindow}).
 *
 * @returns The window.
 */
export function fakeWindow(): FakeWindow {
  const batches: Uint8Array[] = [];
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const win: FakeWindow = {
    batches,
    code: 0,
    nativeTree: {
      commit(batch) {
        batches.push(batch);
        return win.code;
      },
    },
    listeners,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(detail) {
      for (const l of listeners.get("nativetree") ?? []) {
        l(new CustomEvent("nativetree", { detail }));
      }
    },
    take() {
      return batches.splice(0).map(decodeBatch);
    },
    takeOps() {
      return win.take().flatMap((b) => b.ops);
    },
  };
  return win;
}

/** A `Deno.desktop` reporting `nativeTree: { version }` (or what `caps` says). */
export function fakeDesktop(caps: Record<string, unknown> = { nativeTree: { version: 1 } }) {
  return { windowCapabilities: () => caps };
}

/** Let queued microtasks (and the event loop's current turn) run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
