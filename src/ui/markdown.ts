// The inline formatting of documentation prose — the JSDoc a schema `description` carries, and
// the help text a project's own CLI verbs declare.
//
// This returns COMPONENT CHILDREN, never a markup string. Every text segment goes back through
// the renderer, which escapes it, so a description reading "`<title>`" lands as
// `<code>&lt;title&gt;</code>` and a verb whose help says "<script>" can only ever be text. That
// matters because a project's `denext.config.ts` supplies some of this text, and the panel must
// not be a way for a config file to write markup into the page.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNodeChild } from "../jsx/types.ts";

/**
 * The two markers the config schema actually uses: `` `code` `` (306 occurrences) and
 * `**bold**` (15). Emphasis, links, headings and lists appear nowhere in it, so they are not
 * invented here — prose with none of these markers comes back as the one string it went in as.
 *
 * Both alternatives stop at a newline and contain no marker of their own, so an unpaired
 * backtick or asterisk stays literal instead of swallowing the rest of the paragraph. Code is
 * first in the alternation, so a marker inside a code span is left alone.
 */
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;

/**
 * Render documentation prose as children, with its inline markers formatted.
 *
 * @param text The prose, as the schema or a verb declares it.
 * @returns The children to place inside a paragraph — plain strings and `code`/`strong` nodes.
 */
export function inlineMarkdown(text: string): VNodeChild[] {
  const out: VNodeChild[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > at) out.push(text.slice(at, index));
    const [, code, bold] = match;
    out.push(code === undefined ? h("strong", null, bold) : h("code", null, code));
    at = index + match[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
