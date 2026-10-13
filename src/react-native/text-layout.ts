/**
 * React Native's `ellipsizeMode` and `onTextLayout` on `Text` for React Native mode, which
 * react-native-web drops (its one-line and multi-line clamps always end in `…`):
 *
 * - `ellipsizeMode="clip"` cuts the text at the edge with no ellipsis; `"tail"` is the default.
 * - `ellipsizeMode="head"` / `"middle"` on a one-line `Text` (`numberOfLines={1}`) whose
 *   children are plain text draw `…` at the start or in the middle: the longest cut that fits
 *   is measured in the DOM, after each render and when the text's box is resized. With more
 *   lines, or with nested elements, they fall back to `"tail"` (as React Native's Android does
 *   past one line).
 * - `onTextLayout` receives `{ nativeEvent: { lines } }`, one entry per drawn line with its
 *   `text`, `x`, `y`, `width` and `height` relative to the `Text`, plus `ascender`,
 *   `descender`, `capHeight` and `xHeight` estimated from the font size (the DOM exposes no
 *   font metrics). It is called after a render or a resize that changed the lines.
 *
 * React Native mode's build wraps react-native-web's `Text` with `withTextProps`
 * (src/react-native/text-fit.ts), which includes {@linkcode withTextLayout}.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren, VNodeType } from "../jsx/types.ts";
import { useRef, useState } from "../runtime/hooks.ts";
import { useMeasuredNode } from "./measured-node.ts";

/** The ellipsis React Native draws. */
const ELLIPSIS = "…";

/** One line as React Native's `onTextLayout` reports it. */
export interface TextLayoutLine {
  /** The line's text. */
  readonly text: string;
  /** Left edge, px from the `Text`'s. */
  readonly x: number;
  /** Top edge, px from the `Text`'s. */
  readonly y: number;
  /** Width, px. */
  readonly width: number;
  /** Height, px. */
  readonly height: number;
  /** Ascender, px (estimated). */
  readonly ascender: number;
  /** Descender, px (estimated). */
  readonly descender: number;
  /** Cap height, px (estimated). */
  readonly capHeight: number;
  /** x-height, px (estimated). */
  readonly xHeight: number;
}

/** A box, as `getBoundingClientRect` gives it. */
interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The DOM range slice the line reader uses. */
interface TextRange {
  setStart(node: unknown, offset: number): void;
  setEnd(node: unknown, offset: number): void;
  getClientRects(): ArrayLike<Rect>;
}

/** A DOM node, as the line reader walks it. */
interface TextNode {
  readonly nodeType: number;
  readonly data?: string;
  readonly childNodes?: ArrayLike<TextNode>;
}

/** The text element's DOM slice. */
export interface LayoutElement extends TextNode {
  readonly ownerDocument: {
    createRange(): TextRange;
    defaultView?: { getComputedStyle?(el: unknown): { fontSize: string } } | null;
  };
  getBoundingClientRect(): Rect;
}

/** The text nodes under `node`, in order. */
function textNodes(node: TextNode, out: TextNode[] = []): TextNode[] {
  if (node.nodeType === 3) out.push(node);
  else for (const child of Array.from(node.childNodes ?? [])) textNodes(child, out);
  return out;
}

/** A line being collected. */
interface OpenLine {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Add a piece of text and its box to the lines (a new line when it starts below the last). */
function place(lines: OpenLine[], text: string, r: Rect): void {
  const last = lines.at(-1);
  if (last && r.top < last.bottom - (last.bottom - last.top) / 2) {
    last.text += text;
    last.left = Math.min(last.left, r.left);
    last.right = Math.max(last.right, r.right);
    last.top = Math.min(last.top, r.top);
    last.bottom = Math.max(last.bottom, r.bottom);
  } else {
    lines.push({ text, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
}

/** Place `node`'s text: word by word, character by character for a word that wraps. */
function placeNode(range: TextRange, node: TextNode, lines: OpenLine[]): void {
  const data = node.data ?? "";
  for (const m of data.matchAll(/\S*\s*/g)) {
    if (m[0] === "") continue;
    range.setStart(node, m.index);
    range.setEnd(node, m.index + m[0].length);
    const rects = range.getClientRects();
    if (rects.length === 1) {
      place(lines, m[0], rects[0]);
      continue;
    }
    for (let i = m.index; i < m.index + m[0].length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getClientRects()[0];
      if (r) place(lines, data[i], r);
    }
  }
}

/**
 * The lines `el` draws, as React Native's `onTextLayout` reports them.
 *
 * @param el The `Text`'s element.
 * @returns The lines.
 */
export function textLayoutLines(el: LayoutElement): TextLayoutLine[] {
  const doc = el.ownerDocument;
  const range = doc.createRange();
  const lines: OpenLine[] = [];
  for (const node of textNodes(el)) placeNode(range, node, lines);
  const box = el.getBoundingClientRect();
  const size = parseFloat(doc.defaultView?.getComputedStyle?.(el).fontSize ?? "") || 14;
  return lines.map((l) => ({
    text: l.text,
    x: l.left - box.left,
    y: l.top - box.top,
    width: l.right - l.left,
    height: l.bottom - l.top,
    ascender: size * 0.8,
    descender: size * 0.2,
    capHeight: size * 0.7,
    xHeight: size * 0.5,
  }));
}

/** The element slice the one-line truncation measures with. */
export interface TruncateElement {
  readonly offsetWidth: number;
  readonly parentNode:
    | { appendChild(n: unknown): unknown; removeChild(n: unknown): unknown }
    | null;
  cloneNode(deep: boolean): ProbeElement;
}

/** The hidden clone the truncation measures text in. */
interface ProbeElement {
  textContent: string | null;
  readonly style: Record<string, string>;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

/** `chars` cut to `keep` characters with the ellipsis at the start or in the middle. */
export function ellipsize(chars: readonly string[], keep: number, mode: "head" | "middle"): string {
  if (keep >= chars.length) return chars.join("");
  if (mode === "head") return ELLIPSIS + chars.slice(chars.length - keep).join("");
  const front = Math.ceil(keep / 2);
  return chars.slice(0, front).join("") + ELLIPSIS +
    chars.slice(chars.length - (keep - front)).join("");
}

/**
 * The longest `head` / `middle` cut of `text` that fits on one line of `el`, measured in a
 * hidden clone of it (the element itself is not touched).
 *
 * @param el The `Text`'s element.
 * @param text The full text.
 * @param mode Where the ellipsis goes.
 * @returns The text to draw (`text` itself when it fits).
 */
export function truncateToFit(el: TruncateElement, text: string, mode: "head" | "middle"): string {
  const parent = el.parentNode;
  if (!parent) return text;
  const probe = el.cloneNode(false);
  Object.assign(probe.style, {
    position: "absolute",
    visibility: "hidden",
    width: `${el.offsetWidth}px`,
    whiteSpace: "pre",
    textOverflow: "clip",
  });
  parent.appendChild(probe);
  const fits = (s: string) => {
    probe.textContent = s;
    return probe.scrollWidth <= probe.clientWidth + 1;
  };
  try {
    if (fits(text)) return text;
    const chars = Array.from(text);
    let lo = 0;
    let hi = chars.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(ellipsize(chars, mid, mode))) lo = mid;
      else hi = mid - 1;
    }
    return ellipsize(chars, lo, mode);
  } finally {
    parent.removeChild(probe);
  }
}

/** The children as one string, when they are plain text (strings and numbers) only. */
function plainText(children: unknown): string | null {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (!Array.isArray(children)) return null;
  let out = "";
  for (const c of children) {
    if (typeof c !== "string" && typeof c !== "number") return null;
    out += c;
  }
  return out;
}

/** The props the wrapper reads (the rest go on to react-native-web's `Text`). */
interface LayoutTextProps {
  readonly ellipsizeMode?: "head" | "middle" | "tail" | "clip";
  readonly onTextLayout?: (event: { nativeEvent: { lines: TextLayoutLine[] } }) => void;
  readonly numberOfLines?: number;
  readonly children?: VNodeChildren;
  readonly style?: unknown;
  readonly ref?: unknown;
  readonly [prop: string]: unknown;
}

/** The style for an ellipsis mode: `clip`, and the manual cuts, draw no CSS ellipsis. */
function clipStyle(mode: LayoutTextProps["ellipsizeMode"], manual: boolean): unknown {
  return mode === "clip" || manual ? { textOverflow: "clip" } : null;
}

/** The `head` / `middle` mode to cut by hand: one line of plain text only, else `null`. */
function manualMode(props: LayoutTextProps, text: string | null): "head" | "middle" | null {
  const mode = props.ellipsizeMode;
  if (mode !== "head" && mode !== "middle") return null;
  return props.numberOfLines === 1 && text !== null ? mode : null;
}

/** Report the lines to `onTextLayout` when they differ from the last report. */
function reportLines(
  el: LayoutElement,
  last: { current: string },
  onTextLayout: NonNullable<LayoutTextProps["onTextLayout"]>,
): void {
  const lines = textLayoutLines(el);
  const key = JSON.stringify(lines);
  if (key === last.current) return;
  last.current = key;
  onTextLayout({ nativeEvent: { lines } });
}

/**
 * react-native-web's `Text` with `ellipsizeMode` and `onTextLayout` (see the module docs). A
 * `Text` with neither renders exactly as before.
 *
 * @param Text react-native-web's `Text`.
 * @returns The wrapped `Text`.
 */
export function withTextLayout(Text: VNodeType): VNodeType {
  function LayoutText(props: LayoutTextProps): VNode {
    const { ellipsizeMode: mode, onTextLayout, ...rest } = props;
    const text = plainText(props.children);
    const manual = manualMode(props, text);
    const [shown, setShown] = useState<string | null>(null);
    const lastLines = useRef("");
    const { ref } = useMeasuredNode<LayoutElement & TruncateElement>(
      manual !== null || !!onTextLayout,
      props.ref,
      (el) => {
        if (manual) {
          const next = truncateToFit(el, text ?? "", manual);
          setShown((s) => (s === next ? s : next));
        }
        if (onTextLayout) reportLines(el, lastLines, onTextLayout);
      },
    );
    if (!manual && !onTextLayout && mode !== "clip") return h(Text, rest);
    const clip = clipStyle(mode, manual !== null);
    return h(Text, {
      ...rest,
      ref,
      style: clip ? [props.style, clip] : props.style,
      children: manual && shown !== null ? shown : props.children,
    });
  }
  return Object.assign(LayoutText, { displayName: "Text" }) as unknown as VNodeType;
}
