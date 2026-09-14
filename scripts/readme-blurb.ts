// The README → `{ title, blurb }` extractor shared by the generated docs indexes:
// `scripts/gen-examples-index.ts` (examples.json) and `scripts/gen-plugin-catalog.ts`
// (src/plugin/catalog.json). Both take an example's/package's own README as the single
// source of truth for how it describes itself, so a README edit is the only place a
// title or blurb is ever written.

/** The blurb length the generated indexes cut at. */
export const BLURB_MAX = 200;

/** Markdown inline syntax → plain text (links keep their text, emphasis/code lose their marks). */
export function plainText(md: string): string {
  return md
    .replace(/\s+/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[\s(])[*_]([^*_]+)[*_]/g, "$1$2")
    .trim();
}

/** ~200 chars, cut at the last sentence end that fits; otherwise at a word boundary. */
export function truncate(text: string, max = BLURB_MAX): string {
  if (text.length <= max) return text;
  let sentence = -1;
  for (const m of text.matchAll(/[.!?](?=\s|$)/g)) {
    if (m.index >= max) break;
    sentence = m.index;
  }
  if (sentence > max / 3) return text.slice(0, sentence + 1);
  const head = text.slice(0, max);
  const word = head.lastIndexOf(" ");
  return `${head.slice(0, word > 0 ? word : max).trimEnd()}…`;
}

/** The README's first `# H1` and the first paragraph under it, both as plain text. */
export function readmeSummary(md: string): { title: string; blurb: string } {
  const h1 = /^#[ \t]+(.+)$/m.exec(md);
  const title = h1 ? plainText(h1[1]) : "";
  const rest = h1 ? md.slice(h1.index + h1[0].length) : "";
  const para = rest
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !/^[#>|<[\]!-]|^```/.test(p));
  return { title, blurb: para ? truncate(plainText(para)) : "" };
}
