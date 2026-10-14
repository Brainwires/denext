// pgoutput protocol-v1 messages built by hand, for the logical-source unit tests (what
// `pg_logical_slot_get_binary_changes(…, 'proto_version', '1', …)` returns, one message per row).

const enc = new TextEncoder();

/** A message under construction (big-endian, as the protocol is). */
export class Msg {
  bytes: number[] = [];
  u8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }
  i16(v: number): this {
    return this.u8(v >> 8).u8(v);
  }
  i32(v: number): this {
    return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v);
  }
  i64(v: bigint): this {
    for (let i = 7; i >= 0; i--) this.u8(Number((v >> BigInt(i * 8)) & 0xffn));
    return this;
  }
  char(c: string): this {
    return this.u8(c.charCodeAt(0));
  }
  str(s: string): this {
    this.bytes.push(...enc.encode(s), 0);
    return this;
  }
  tuple(cells: Array<string | null | undefined>): this {
    this.i16(cells.length);
    for (const cell of cells) {
      if (cell === null) this.char("n");
      else if (cell === undefined) this.char("u");
      else {
        const b = enc.encode(cell);
        this.char("t").i32(b.length);
        this.bytes.push(...b);
      }
    }
    return this;
  }
  done(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/** Microseconds since 2000-01-01 for an epoch-ms time. */
const pgTime = (ms: number) => BigInt(ms - 946_684_800_000) * 1000n;
export const begin = (ms: number) => new Msg().char("B").i64(1n).i64(pgTime(ms)).i32(7).done();
export const relation = (
  oid: number,
  schema: string,
  table: string,
  cols: Array<[string, number]>,
) => {
  const m = new Msg().char("R").i32(oid).str(schema).str(table).char("d").i16(cols.length);
  for (const [name, type] of cols) m.u8(name === "id" ? 1 : 0).str(name).i32(type).i32(-1);
  return m.done();
};
export const insert = (oid: number, cells: Array<string | null | undefined>) =>
  new Msg().char("I").i32(oid).char("N").tuple(cells).done();
export const update = (
  oid: number,
  cells: Array<string | null | undefined>,
  old?: { kind: "K" | "O"; cells: Array<string | null | undefined> },
) => {
  const m = new Msg().char("U").i32(oid);
  if (old) m.char(old.kind).tuple(old.cells);
  return m.char("N").tuple(cells).done();
};
export const del = (oid: number, kind: "K" | "O", cells: Array<string | null | undefined>) =>
  new Msg().char("D").i32(oid).char(kind).tuple(cells).done();
export const truncate = (oids: number[]) => {
  const m = new Msg().char("T").i32(oids.length).u8(0);
  for (const oid of oids) m.i32(oid);
  return m.done();
};
