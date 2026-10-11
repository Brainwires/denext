// React Native mode's uniwind stylesheet pass: what uniwind's lightningcss visitor (the one its
// Vite plugin installs) does to the compiled Tailwind CSS, run over `tailwind.output` after each
// compile when the app has `uniwind` installed:
//
//   - `pixelRatio(n)` is `n` times the device pixel ratio, in px (React Native's
//     `PixelRatio.get() * n`; `n` defaults to 1), `fontScale(n)` is `n` px scaled by the root
//     font size (`n * 1rem / 16`: the browser's text size setting, React Native's font scale),
//     and `hairlineWidth()` is one device pixel (`1px / devicePixelRatio`, React Native's
//     `StyleSheet.hairlineWidth`). The device pixel ratio comes from resolution media queries,
//     as the custom property `--denext-pixel-ratio`.
//   - Theme variables declared with `@variant <theme>` in `@layer theme` (`:root:where(.dark,
//     .dark *)`) move to the theme's class (`.dark`), so a `ScopedTheme` subtree gets them, not
//     only a themed root.
//   - A theme-variant utility (`dark:bg-x`, `ocean-dark:bg-x`) applies inside `@scope (.dark) to
//     (.light, .ocean-dark, …)`: the nearest theme class wins, so a light subtree inside a dark
//     one is light. The `prefers-color-scheme` fallback of `light:` / `dark:` (no theme class
//     at all) is unchanged.
//
// Tailwind writes nested CSS (and flattened CSS with `--minify`); the pass parses either into a
// small tree, flattens the nesting (`&` resolved, as a browser would) and rewrites the flat
// rules, so both forms come out the same.

/** A declaration (`prop: value`) or a statement at-rule (`@import …;`), as written. */
interface CssText {
  readonly kind: "text";
  readonly text: string;
}

/** A rule with a block: a style rule (`selector { … }`) or a block at-rule (`@media … { … }`). */
interface CssBlock {
  readonly kind: "block";
  /** The prelude as written: the selector list, or `@name params`. */
  readonly prelude: string;
  readonly children: CssNode[];
}

/** A node of the parsed stylesheet. */
type CssNode = CssText | CssBlock;

/** At-rules whose block holds declarations, never nested rules. */
const DECLARATION_AT_RULES = /^@(?:font-face|property|page|counter-style|font-feature-values)\b/i;

/** Index past the string literal that starts at `i` (quote `css[i]`). */
function skipString(css: string, i: number): number {
  const quote = css[i];
  let j = i + 1;
  while (j < css.length && css[j] !== quote) j += css[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** Index past the comment that starts at `i`. */
function skipComment(css: string, i: number): number {
  const end = css.indexOf("*/", i + 2);
  return end === -1 ? css.length : end + 2;
}

/** The index past the atom at `i`: an escape, a comment, a string literal, or one character. */
function atomEnd(css: string, i: number): number {
  const c = css[i];
  if (c === "\\") return i + 2;
  if (c === "/" && css[i + 1] === "*") return skipComment(css, i);
  if (c === '"' || c === "'") return skipString(css, i);
  return i + 1;
}

/** How a one-character atom moves the parenthesis / bracket depth (never below 0). */
function depthStep(atom: string, depth: number): number {
  if (atom === "(" || atom === "[") return 1;
  return (atom === ")" || atom === "]") && depth > 0 ? -1 : 0;
}

/** Characters that end a prelude or a declaration at depth 0. */
const STOPS = new Set(["{", ";", "}"]);

/**
 * Read from `start` up to the first `{`, `;` or `}` outside strings, comments, escapes and
 * parentheses.
 *
 * @returns The text read (comments dropped) and the index of the stop character.
 */
function readUntilStop(css: string, start: number): { text: string; stop: number } {
  let depth = 0;
  let text = "";
  let i = start;
  while (i < css.length) {
    const end = atomEnd(css, i);
    const atom = css.slice(i, end);
    if (depth === 0 && STOPS.has(atom)) break;
    if (atom.length === 1) depth += depthStep(atom, depth);
    if (!atom.startsWith("/*")) text += atom;
    i = end;
  }
  return { text, stop: i };
}

/** Parse a block's contents from `start` until its closing `}` (or the end). */
function parseNodes(css: string, start: number): { nodes: CssNode[]; end: number } {
  const nodes: CssNode[] = [];
  let i = start;
  while (i < css.length) {
    const { text, stop } = readUntilStop(css, i);
    const trimmed = text.trim();
    const c = css[stop];
    if (c === "{") {
      const inner = parseNodes(css, stop + 1);
      nodes.push({ kind: "block", prelude: trimmed.replace(/\s+/g, " "), children: inner.nodes });
      i = inner.end;
      continue;
    }
    if (trimmed) nodes.push({ kind: "text", text: trimmed });
    if (c === "}") return { nodes, end: stop + 1 };
    i = stop + 1;
  }
  return { nodes, end: css.length };
}

/** Split a selector list at its top-level commas. */
export function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < list.length;) {
    const end = atomEnd(list, i);
    const atom = list.slice(i, end);
    i = end;
    if (atom === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    if (atom.length === 1) depth += depthStep(atom, depth);
    current += atom;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Whether `selector` has an unescaped `&`. */
function hasNesting(selector: string): boolean {
  return /(^|[^\\])&/.test(selector);
}

/** `child` (one complex selector) resolved against the parent selector `parent`. */
function resolveNested(parent: string, child: string): string {
  if (hasNesting(child)) return child.replace(/(^|[^\\])&/g, (_, before) => before + parent);
  return `${parent} ${child}`;
}

/** The parent list as one selector (`:is(a, b)` for more than one). */
function joinParent(parents: readonly string[]): string {
  return parents.length === 1 ? parents[0] : `:is(${parents.join(", ")})`;
}

/**
 * The nesting in `nodes` flattened: every style rule's selector resolved against its parents,
 * the declarations of a rule with nested rules kept in order around them.
 *
 * @param nodes The parsed nodes.
 * @param parents The enclosing style rule's selectors, or null at the top level / in an
 *   at-rule outside any style rule.
 */
function flatten(nodes: readonly CssNode[], parents: readonly string[] | null): CssNode[] {
  const out: CssNode[] = [];
  let run: CssNode[] = [];
  const flushRun = () => {
    if (run.length && parents) {
      out.push({ kind: "block", prelude: parents.join(", "), children: run });
    } else out.push(...run);
    run = [];
  };
  for (const node of nodes) {
    if (node.kind === "text") {
      run.push(node);
      continue;
    }
    if (node.prelude.startsWith("@")) {
      flushRun();
      const keepsDeclarations = DECLARATION_AT_RULES.test(node.prelude) ||
        /^@(?:-webkit-)?keyframes\b/i.test(node.prelude);
      out.push({
        kind: "block",
        prelude: node.prelude,
        children: keepsDeclarations ? node.children : flatten(node.children, parents),
      });
      continue;
    }
    flushRun();
    const own = splitSelectorList(node.prelude);
    const resolved = parents ? own.map((s) => resolveNested(joinParent(parents), s)) : own;
    out.push(...flatten(node.children, resolved));
  }
  flushRun();
  return out;
}

/** Serialize `nodes`, two-space indented. */
function serialize(nodes: readonly CssNode[], indent = ""): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += `${indent}${node.text};\n`;
    } else if (node.children.length === 0 && node.prelude.startsWith("@")) {
      out += `${indent}${node.prelude} {}\n`;
    } else if (node.children.length > 0) {
      out += `${indent}${node.prelude} {\n${serialize(node.children, indent + "  ")}${indent}}\n`;
    }
  }
  return out;
}

// ---- uniwind's functions --------------------------------------------------------------------

/** The custom property the resolution media queries set to the device pixel ratio. */
const PIXEL_RATIO_PROPERTY = "--denext-pixel-ratio";

/** The device pixel ratios the media queries step through (common phone, tablet, laptop ones). */
const PIXEL_RATIOS = [1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.625, 2.75, 3, 3.5, 4];

/** The rules that keep {@linkcode PIXEL_RATIO_PROPERTY} at the screen's device pixel ratio. */
export function pixelRatioRules(): string {
  const steps = PIXEL_RATIOS.map((r) =>
    `@media (min-resolution: ${r}dppx), (-webkit-min-device-pixel-ratio: ${r}) {\n` +
    `  :root {\n    ${PIXEL_RATIO_PROPERTY}: ${r};\n  }\n}\n`
  ).join("");
  return `:root {\n  ${PIXEL_RATIO_PROPERTY}: 1;\n}\n${steps}`;
}

/** uniwind's functions and their CSS: `arg` is the function's argument (`""` when none). */
const FUNCTIONS: Readonly<Record<string, (arg: string) => string>> = {
  pixelRatio: (arg) => `calc(${arg || "1"} * var(${PIXEL_RATIO_PROPERTY}, 1) * 1px)`,
  fontScale: (arg) => `calc(${arg || "1"} * 0.0625rem)`,
  hairlineWidth: () => `calc(1px / var(${PIXEL_RATIO_PROPERTY}, 1))`,
};

/** A uniwind function call's start: its name not preceded by a name character or an escape. */
const FUNCTION_CALL = /(?<![\w\\-])(pixelRatio|fontScale|hairlineWidth)\(/g;

/**
 * `value` with uniwind's `pixelRatio()`, `fontScale()` and `hairlineWidth()` calls replaced by
 * their CSS (nested calls too).
 *
 * @param value A declaration value (or any CSS text outside selectors).
 */
export function replaceUniwindFunctions(value: string): string {
  let out = "";
  let last = 0;
  FUNCTION_CALL.lastIndex = 0;
  for (let m = FUNCTION_CALL.exec(value); m; m = FUNCTION_CALL.exec(value)) {
    const open = m.index + m[0].length;
    let depth = 1;
    let j = open;
    while (j < value.length && depth > 0) {
      if (value[j] === "(") depth++;
      else if (value[j] === ")") depth--;
      j++;
    }
    if (depth !== 0) break;
    const arg = replaceUniwindFunctions(value.slice(open, j - 1).trim());
    out += value.slice(last, m.index) + FUNCTIONS[m[1]](arg);
    last = j;
    FUNCTION_CALL.lastIndex = j;
  }
  return out + value.slice(last);
}

// ---- theme scoping ---------------------------------------------------------------------------

/** `name` as a regular expression source (a theme name is an identifier). */
function escapeRegExp(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What `:where(.T, .T *)` (any spacing) for one of `themes` matches: group 1 is the theme. */
function themeWherePattern(themes: readonly string[]): RegExp {
  const names = themes.map(escapeRegExp).join("|");
  return new RegExp(`:where\\(\\s*\\.(${names})\\s*,\\s*\\.\\1\\s+\\*\\s*\\)`);
}

/** The theme every selector of `selectors` is scoped to by `:where(.T, .T *)`, if one. */
function scopedTheme(selectors: readonly string[], where: RegExp): string | null {
  let theme: string | null = null;
  for (const s of selectors) {
    const m = where.exec(s);
    if (!m || (theme !== null && m[1] !== theme)) return null;
    theme = m[1];
  }
  return theme;
}

/** Whether `selector` is the document root with a theme's `:where(.T, .T *)`, and nothing else. */
function isRootThemeSelector(selector: string, where: RegExp): boolean {
  const m = where.exec(selector);
  if (!m) return false;
  const rest = selector.slice(0, m.index) + selector.slice(m.index + m[0].length);
  return /^(?::root|:host|:is\(\s*:root\s*,\s*:host\s*\))$/.test(rest.trim());
}

/** The `@scope` prelude that applies `theme`'s rules up to the next other theme class. */
function scopePrelude(theme: string, themes: readonly string[]): string {
  const others = themes.filter((t) => t !== theme).map((t) => `.${t}`);
  return others.length ? `@scope (.${theme}) to (${others.join(", ")})` : `@scope (.${theme})`;
}

/**
 * The theme rewrites over flat `nodes`: theme variables on the theme's class, theme-variant
 * rules inside `@scope`, and uniwind's functions in every declaration.
 */
function rewrite(
  nodes: readonly CssNode[],
  themes: readonly string[],
  where: RegExp,
  inThemeLayer: boolean,
): CssNode[] {
  return nodes.map((node): CssNode => {
    if (node.kind === "text") {
      return node.text.startsWith("@")
        ? node
        : { kind: "text", text: replaceUniwindFunctions(node.text) };
    }
    if (node.prelude.startsWith("@")) {
      const layer = /^@layer\s+([\w.-]+)\s*$/i.exec(node.prelude)?.[1];
      const children = rewrite(
        node.children,
        themes,
        where,
        layer ? layer === "theme" : inThemeLayer,
      );
      return { kind: "block", prelude: node.prelude, children };
    }
    const children = rewrite(node.children, themes, where, inThemeLayer);
    const selectors = splitSelectorList(node.prelude);
    const theme = scopedTheme(selectors, where);
    if (!theme) return { kind: "block", prelude: node.prelude, children };
    if (inThemeLayer && selectors.every((s) => isRootThemeSelector(s, where))) {
      return { kind: "block", prelude: `.${theme}`, children };
    }
    return {
      kind: "block",
      prelude: scopePrelude(theme, themes),
      children: [{ kind: "block", prelude: node.prelude, children }],
    };
  });
}

/**
 * uniwind's stylesheet pass (see the module comment) over compiled Tailwind CSS.
 *
 * @param css The compiled Tailwind output.
 * @param themes The registered themes (`light`, `dark`, then the extra themes).
 * @returns The rewritten CSS.
 */
export function uniwindCss(css: string, themes: readonly string[]): string {
  const where = themeWherePattern(themes.length ? themes : ["light", "dark"]);
  const flat = flatten(parseNodes(css, 0).nodes, null);
  // Comments are dropped by the parse; keep a leading `/*! … */` banner (Tailwind's licence line).
  const banner = /^\s*(\/\*![\s\S]*?\*\/)/.exec(css)?.[1];
  const out = (banner ? banner + "\n" : "") + serialize(rewrite(flat, themes, where, false));
  return out.includes(`var(${PIXEL_RATIO_PROPERTY}`) ? out + pixelRatioRules() : out;
}
