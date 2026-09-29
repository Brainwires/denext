// A Markdown table generated into a docs page between two HTML-comment markers, shared by the
// table generators (scripts/gen-rn-community-docs.ts, scripts/gen-expo-shim-docs.ts): reading
// the current table, comparing it cell by cell, and rewriting it or failing `--check`.

/** A Markdown table reduced to its cells, so `deno fmt`'s column padding does not matter. */
export function tableCells(markdown: string): string[][] {
  return markdown.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && !/^\|[\s|:-]+\|$/.test(line))
    .map((line) => line.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\s+/g, " ")));
}

/** The page's table between `start` and `end`, or null when the markers are missing. */
export function tableBetween(page: string, start: string, end: string): string | null {
  const from = page.indexOf(start);
  const to = page.indexOf(end);
  if (from < 0 || to < from) return null;
  return page.slice(from + start.length, to).trim();
}

/** A Markdown table from its header cells and its already-rendered rows. */
export function markdownTable(header: readonly string[], rows: readonly string[]): string {
  return [`| ${header.join(" | ")} |`, `|${" --- |".repeat(header.length)}`, ...rows].join("\n");
}

/** Where a generated table lives: the page (repo-relative) and its two markers. */
export interface TableMarkers {
  /** The docs page, repo-relative. */
  readonly page: string;
  /** The start marker. */
  readonly start: string;
  /** The end marker. */
  readonly end: string;
}

/** A reader for the table at `at`: the page text in, the table (or null) out. */
export function tableReader(at: TableMarkers): (page: string) => string | null {
  return (page) => tableBetween(page, at.start, at.end);
}

/**
 * The script entry point: rewrite the table between the markers when it differs from `table`,
 * or with `--check` exit 1 instead of writing. Exits 1 when the markers are missing.
 */
export async function refreshGeneratedTable(at: TableMarkers, table: string): Promise<void> {
  const url = new URL(`../../${at.page}`, import.meta.url);
  const page = await Deno.readTextFile(url);
  const current = tableBetween(page, at.start, at.end);
  if (current === null) {
    console.error(`${at.page}: the ${at.start} / ${at.end} markers are missing`);
    Deno.exit(1);
  }
  if (JSON.stringify(tableCells(current)) === JSON.stringify(tableCells(table))) return;
  if (Deno.args.includes("--check")) {
    console.error(`${at.page}: a generated table is stale — run the script that writes it`);
    Deno.exit(1);
  }
  const from = page.indexOf(at.start) + at.start.length;
  const to = page.indexOf(at.end);
  await Deno.writeTextFile(url, `${page.slice(0, from)}\n\n${table}\n\n${page.slice(to)}`);
  console.log(`wrote ${at.page}`);
}
