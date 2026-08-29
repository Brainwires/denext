/**
 * next-intl rich-text (`t.rich`) and markup (`t.markup`) rendering.
 *
 * These format an ICU message that ALSO carries `<tag>…</tag>` callback markup —
 * `t.rich("msg", { link: (chunks) => <a>{chunks}</a> })`. A text run is formatted with
 * the ICU engine ({@link formatIcu}); a `<tag>` run renders its children and hands them to
 * the caller-supplied handler (a `<tag>` with no handler renders its children inline).
 *
 * `rich` handlers return nodes and the result is a denext node tree; `markup` handlers
 * return strings and the result is a string (for non-React contexts, e.g. an email body).
 *
 * **Scope:** tags are recognized at ICU brace-depth 0 — a `<…>` inside an ICU `{…}`
 * argument (e.g. a tag placed inside a `plural` branch) is passed through to the ICU engine
 * as literal text rather than treated as a rich tag. Top-level and nested tags, self-closing
 * tags, and ICU interpolation within text runs are all supported.
 *
 * @module
 */

import { Fragment, h } from "../../../mod.ts";
import type { VNodeChild, VNodeChildren } from "../../jsx/types.ts";
import { formatIcu, type IcuValue } from "./icu.ts";

/** A rich-text tag handler: wraps the tag's already-rendered children in a node. */
export type RichTagHandler = (chunks: VNodeChildren) => VNodeChild;
/** A markup tag handler: wraps the tag's already-rendered string children in a string. */
export type MarkupTagHandler = (chunks: string) => string;

/** Values for `t.rich`: ICU interpolation values plus `<tag>` node handlers. */
export type RichValues = Record<string, IcuValue | RichTagHandler>;
/** Values for `t.markup`: ICU interpolation values plus `<tag>` string handlers. */
export type MarkupValues = Record<string, IcuValue | MarkupTagHandler>;

/** A parsed rich message part: literal/ICU text, or a tag wrapping further parts. */
type RichNode =
  | { kind: "text"; value: string }
  | { kind: "tag"; name: string; children: RichNode[] };

const TAG_OPEN = /^<([a-zA-Z][a-zA-Z0-9_-]*)\s*(\/?)>/;
const TAG_CLOSE = /^<\/([a-zA-Z][a-zA-Z0-9_-]*)\s*>/;

/**
 * Parse `message` into a tree of text/tag nodes. `<tag>`/`</tag>`/`<tag/>` are recognized
 * only at ICU brace-depth 0; everything else (including ICU `{…}` arguments) is text.
 */
function parseRich(message: string): RichNode[] {
  let i = 0;

  function parseChildren(stopTag: string | null): RichNode[] {
    const nodes: RichNode[] = [];
    let text = "";
    let depth = 0; // ICU `{…}` nesting depth — tags inside an argument are left to ICU
    const flush = () => {
      if (text) {
        nodes.push({ kind: "text", value: text });
        text = "";
      }
    };
    while (i < message.length) {
      const ch = message[i];
      if (ch === "{") {
        depth++;
        text += ch;
        i++;
        continue;
      }
      if (ch === "}") {
        if (depth > 0) depth--;
        text += ch;
        i++;
        continue;
      }
      if (ch === "<" && depth === 0) {
        const rest = message.slice(i);
        const close = TAG_CLOSE.exec(rest);
        if (close) {
          if (stopTag !== null && close[1] === stopTag) {
            i += close[0].length;
            flush();
            return nodes;
          }
          // An unmatched close tag — treat the "<" as literal text.
          text += ch;
          i++;
          continue;
        }
        const open = TAG_OPEN.exec(rest);
        if (open) {
          flush();
          i += open[0].length;
          const name = open[1];
          const selfClosing = open[2] === "/";
          nodes.push({ kind: "tag", name, children: selfClosing ? [] : parseChildren(name) });
          continue;
        }
        // A lone "<" that opens no tag — literal.
        text += ch;
        i++;
        continue;
      }
      text += ch;
      i++;
    }
    flush();
    return nodes;
  }

  return parseChildren(null);
}

/** Render parsed nodes to a node tree, invoking `<tag>` handlers from `values`. */
function renderRich(nodes: RichNode[], values: RichValues, locale: string): VNodeChild[] {
  const out: VNodeChild[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      const str = formatIcu(node.value, values as Record<string, IcuValue>, locale);
      if (str) out.push(str);
      continue;
    }
    const children = renderRich(node.children, values, locale);
    const chunks: VNodeChildren = children.length === 1 ? children[0] : children;
    const handler = values[node.name];
    if (typeof handler === "function") {
      out.push((handler as RichTagHandler)(chunks));
    } else {
      // No handler for this tag — render its children inline.
      out.push(...children);
    }
  }
  return out;
}

/** Render parsed nodes to a string, invoking `<tag>` string handlers from `values`. */
function renderMarkup(nodes: RichNode[], values: MarkupValues, locale: string): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += formatIcu(node.value, values as Record<string, IcuValue>, locale);
      continue;
    }
    const inner = renderMarkup(node.children, values, locale);
    const handler = values[node.name];
    out += typeof handler === "function" ? (handler as MarkupTagHandler)(inner) : inner;
  }
  return out;
}

/**
 * Format an ICU + `<tag>` message to a denext node (next-intl's `t.rich`).
 *
 * @param message The ICU/rich message string.
 * @param values Interpolation values plus `<tag>` handlers.
 * @param locale The BCP-47 locale.
 * @returns A denext node (a Fragment wrapping the rendered children).
 */
export function formatRich(message: string, values: RichValues = {}, locale = "en"): VNodeChild {
  const children = renderRich(parseRich(message), values, locale);
  // Wrap in a Fragment so the result is a single node, matching next-intl's return shape.
  return h(Fragment, null, ...children);
}

/**
 * Format an ICU + `<tag>` message to a string (next-intl's `t.markup`).
 *
 * @param message The ICU/rich message string.
 * @param values Interpolation values plus `<tag>` string handlers.
 * @param locale The BCP-47 locale.
 * @returns The formatted string with tag handlers applied.
 */
export function formatMarkup(message: string, values: MarkupValues = {}, locale = "en"): string {
  return renderMarkup(parseRich(message), values, locale);
}
