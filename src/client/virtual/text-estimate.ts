/**
 * Height prediction for text rows without the DOM (`VirtualList`'s `estimateText`): wrap the
 * row's text greedily with canvas `measureText` word widths at the list's width, then
 * `lines × lineHeight + padding`. A close estimate before a row renders keeps the scrollbar
 * and `scrollToIndex` targets steady on huge lists of chat messages. Where no canvas exists
 * (SSR, tests) an average-glyph-width approximation is used, so the estimate is still
 * deterministic.
 *
 * @module
 */

/** How to predict a text row's size. */
export interface TextEstimateOptions<T> {
  /** CSS font shorthand the row text renders in (e.g. `"14px system-ui"`). */
  readonly font: string;
  /** The text box width in px; default: the list's cross-axis size minus `padding`. */
  readonly width?: number;
  /** Line height in px. */
  readonly lineHeight: number;
  /** Extra px added to every row (vertical padding, borders, gaps). Default 0. */
  readonly padding?: number;
  /** The text a row renders. */
  readonly text: (item: T) => string;
}

/** The `measureText` part of a 2D context. */
interface Measurer {
  font: string;
  measureText(text: string): { width: number };
}

/** A 2D context for measuring, or `undefined` without a canvas. */
function createMeasurer(): Measurer | undefined {
  try {
    const g = globalThis as {
      OffscreenCanvas?: new (w: number, h: number) => { getContext(t: "2d"): unknown };
      document?: { createElement(tag: "canvas"): { getContext(t: "2d"): unknown } };
    };
    const canvas = g.OffscreenCanvas
      ? new g.OffscreenCanvas(1, 1)
      : g.document?.createElement("canvas");
    const ctx = canvas?.getContext("2d") as Measurer | null | undefined;
    return ctx && typeof ctx.measureText === "function" ? ctx : undefined;
  } catch {
    return undefined;
  }
}

/** The font size in px named by a CSS font shorthand (16 when none is found). */
function fontSizeOf(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 16;
}

/**
 * A function from item to predicted size, for the given options. `widthOf()` supplies the
 * width when `options.width` is not set (the list passes its cross-axis size).
 */
export function createTextEstimator<T>(
  options: TextEstimateOptions<T>,
  widthOf: () => number,
): (item: T) => number {
  let measurer: Measurer | undefined | null = null;
  const words = new Map<string, number>();
  const approx = fontSizeOf(options.font) * 0.55;
  const widthOfWord = (word: string): number => {
    let w = words.get(word);
    if (w === undefined) {
      if (measurer === null) {
        measurer = createMeasurer();
        if (measurer) measurer.font = options.font;
      }
      w = measurer ? measurer.measureText(word).width : word.length * approx;
      if (words.size > 20_000) words.clear();
      words.set(word, w);
    }
    return w;
  };
  return (item: T): number => {
    const padding = options.padding ?? 0;
    const width = Math.max(1, options.width ?? (widthOf() - padding));
    const space = widthOfWord(" ");
    let lines = 0;
    for (const paragraph of String(options.text(item) ?? "").split("\n")) {
      lines += wrappedLines(paragraph, width, space, widthOfWord);
    }
    return Math.max(1, lines) * options.lineHeight + padding;
  };
}

/** Lines a paragraph wraps to at `width` (greedy word wrap; over-wide words break). */
function wrappedLines(
  paragraph: string,
  width: number,
  space: number,
  widthOfWord: (word: string) => number,
): number {
  let lines = 1;
  let x = 0;
  for (const word of paragraph.split(/\s+/)) {
    if (!word) continue;
    const w = widthOfWord(word);
    if (x > 0 && x + space + w > width) {
      lines++;
      x = 0;
    }
    if (w > width) {
      lines += Math.floor(w / width);
      x = w % width;
    } else x += (x > 0 ? space : 0) + w;
  }
  return lines;
}
