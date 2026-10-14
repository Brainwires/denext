// Markdown the scaffolds write, laid out the way `deno fmt` lays it out (Deno's defaults: 80
// columns, prose wrapped), so a fresh project passes `deno fmt --check` with no config of its own.
// The text varies with the options (`src/app` vs `app`, the rows a feature adds), so it is wrapped
// and padded here rather than by hand.

/** The column `deno fmt` wraps Markdown prose at by default. */
const PROSE_WIDTH = 80;

/**
 * An unbreakable piece of a paragraph: an inline code span or a link (`[text](url)`) stays whole
 * however many spaces it holds; other text breaks at every space.
 */
const PROSE_ATOM = /(?:`[^`]*`|\[[^\]]*\]\([^)]*\)|\S)+/g;

/**
 * One Markdown paragraph or list item, wrapped greedily at 80 columns.
 *
 * @param text The prose (line breaks in it are spaces).
 * @param first What the first line starts with (`"- "` for a list item).
 * @param rest What every following line starts with (`"  "` under a list item).
 * @returns The wrapped lines, each ending in a newline.
 */
export function wrapProse(text: string, first = "", rest = ""): string {
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const atom of text.match(PROSE_ATOM) ?? []) {
    if (!empty && line.length + 1 + atom.length > PROSE_WIDTH) {
      lines.push(line);
      line = rest + atom;
    } else {
      line += (empty ? "" : " ") + atom;
    }
    empty = false;
  }
  lines.push(line);
  return lines.map((l) => l + "\n").join("");
}

/**
 * A Markdown table with every column padded to its widest cell, as `deno fmt` writes it.
 *
 * @param header The header cells.
 * @param rows The body rows (as many cells as the header).
 * @returns The table, each line ending in a newline.
 */
export function markdownTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: readonly string[]) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |\n`;
  return line(header) + line(widths.map((w) => "-".repeat(w))) + rows.map(line).join("");
}
