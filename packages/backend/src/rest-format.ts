// CSV for auto-REST (RFC 4180): `Accept: text/csv` turns the JSON rows Postgres built into a
// header line and one line per row; `Content-Type: text/csv` turns a body into the objects an
// insert takes (an unquoted `NULL` cell is SQL NULL, as in PostgREST). Numbers keep the digits
// Postgres printed — the JSON is read with its source text, so a `bigint` is never rounded.

import { RestError } from "./rest-parse.ts";

/** A number as Postgres printed it. */
class RawNumber {
  constructor(readonly source: string) {}
}

/** `JSON.parse` keeping each number's source text (the reviver's `context.source`). */
function parseKeepingNumbers(text: string): unknown {
  return JSON.parse(
    text,
    ((_key: string, value: unknown, context?: { source?: string }) =>
      typeof value === "number" && context?.source !== undefined
        ? new RawNumber(context.source)
        : value) as (key: string, value: unknown) => unknown,
  );
}

/** Restore nested numbers (inside a json cell) to plain JSON text. */
function nestedJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => v instanceof RawNumber ? Number(v.source) : v);
}

/** One CSV cell. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (value instanceof RawNumber) text = value.source;
  else if (typeof value === "string") text = value;
  else if (typeof value === "boolean") text = String(value);
  else text = nestedJson(value);
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Rows (Postgres's JSON array text) → CSV: a header from the first row's keys, then one line
 * per row. No rows → an empty body.
 *
 * @param json The JSON array text.
 * @returns The CSV text.
 */
export function csvFromJson(json: string): string {
  const rows = parseKeepingNumbers(json);
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const first = rows[0];
  if (first === null || typeof first !== "object" || first instanceof RawNumber) {
    return rows.map((value) => cell(value)).join("\n") + "\n";
  }
  const columns = Object.keys(first);
  const lines = [columns.map(cell).join(",")];
  for (const row of rows as Record<string, unknown>[]) {
    lines.push(columns.map((c) => cell(row[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

/** One CSV cell as read: its text, and whether it was quoted. */
interface ReadCell {
  text: string;
  quoted: boolean;
}

/** Read one quoted cell starting at the opening quote; returns the cell and the next index. */
function quotedCell(text: string, at: number): { cell: ReadCell; next: number } {
  let value = "";
  let i = at + 1;
  for (;;) {
    const close = text.indexOf('"', i);
    if (close < 0) throw new RestError(400, "PGRST102", "the CSV body has an unterminated quote");
    value += text.slice(i, close);
    if (text[close + 1] === '"') {
      value += '"';
      i = close + 2;
    } else return { cell: { text: value, quoted: true }, next: close + 1 };
  }
}

/** Split CSV text into records of cells. */
function records(text: string): ReadCell[][] {
  const out: ReadCell[][] = [];
  let row: ReadCell[] = [];
  let i = 0;
  while (i <= text.length) {
    let cellRead: ReadCell;
    if (text[i] === '"') {
      const { cell, next } = quotedCell(text, i);
      cellRead = cell;
      i = next;
    } else {
      const end = text.slice(i).search(/[,\r\n]|$/);
      cellRead = { text: text.slice(i, i + end), quoted: false };
      i += end;
    }
    row.push(cellRead);
    if (text[i] === ",") {
      i++;
      continue;
    }
    out.push(row);
    row = [];
    if (text[i] === "\r") i++;
    if (text[i] === "\n") i++;
    if (i >= text.length) break;
  }
  return out.filter((r) => !(r.length === 1 && r[0].text === "" && !r[0].quoted));
}

/**
 * A CSV body → the objects an insert takes: the first line names the columns; an unquoted
 * `NULL` is null, every other cell a string (Postgres parses it into the column's type).
 *
 * @param text The CSV text.
 * @returns The rows.
 * @throws {RestError} `PGRST102` for an unterminated quote or a row of the wrong width.
 */
export function rowsFromCsv(text: string): Record<string, string | null>[] {
  const [header, ...rest] = records(text);
  if (!header) throw new RestError(400, "PGRST102", "the CSV body is empty");
  const columns = header.map((c) => c.text);
  return rest.map((record, n) => {
    if (record.length !== columns.length) {
      throw new RestError(
        400,
        "PGRST102",
        `CSV row ${n + 2} has ${record.length} cells; the header names ${columns.length}`,
      );
    }
    return Object.fromEntries(
      record.map((c, i) => [columns[i], !c.quoted && c.text === "NULL" ? null : c.text]),
    );
  });
}
