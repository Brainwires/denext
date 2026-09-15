// Flow collections (`[a, b]`, `{ K: v }`) inside the compose editor's block YAML: where one
// closes and where each of its top-level items sits, so an edit can splice one item in place and
// the field keeps the style it was written in. Quoted scalars, nested collections and comments
// are stepped over. The reading is deliberately small — the editor re-parses every splice and
// compares it with the intended change, and anything this module cannot follow is null, which the
// editor turns into a refusal rather than a guess.
//
// Build-time only; never imported by a shipped bundle.

/** One item's `[start, end)` in the scanned text, surrounding whitespace and commas excluded. */
export interface FlowItem {
  /** Index of the item's first character. */
  start: number;
  /** One past its last character. */
  end: number;
}

/** A flow collection's top level. */
export interface Flow {
  /** Index of the opening `[` or `{`. */
  open: number;
  /** Index of the matching closing bracket. */
  close: number;
  /** Its top-level items, in order. */
  items: FlowItem[];
}

/** A token of flow YAML: a bracket, a comma, or an atom (a quoted scalar, a run of plain text). */
interface Token {
  kind: "open" | "close" | "comma" | "atom";
  at: number;
  end: number;
}

/** Index just past a quoted scalar opening at `i`, or -1 when it never closes. */
function pastQuoted(text: string, i: number): number {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (quote === '"' && text[j] === "\\") j++;
    else if (text[j] === quote && quote === "'" && text[j + 1] === "'") j++;
    else if (text[j] === quote) return j + 1;
  }
  return -1;
}

/** Index just past the atom at `i`: a quoted scalar, or plain text up to a flow indicator. */
function atomEnd(text: string, i: number): number {
  if (text[i] === '"' || text[i] === "'") return pastQuoted(text, i);
  let j = i;
  while (j < text.length && !/[\s,[\]{}]/.test(text[j])) j++;
  return j;
}

/** The token kind a character starts. */
function kindOf(c: string): Token["kind"] {
  if (c === "[" || c === "{") return "open";
  if (c === "]" || c === "}") return "close";
  return c === "," ? "comma" : "atom";
}

/** The flow tokens from `from` on, skipping whitespace and `#` comments; null at a bad quote. */
function* tokens(text: string, from: number): Generator<Token | null> {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "#" && /\s/.test(text[i - 1] ?? " ")) {
      const eol = text.indexOf("\n", i);
      i = eol === -1 ? text.length : eol;
      continue;
    }
    const kind = kindOf(c);
    const end = kind === "atom" ? atomEnd(text, i) : i + 1;
    if (end === -1) {
      yield null;
      return;
    }
    yield { kind, at: i, end };
    i = end;
  }
}

/** A walk over a collection's tokens: nesting depth, the items so far, the item being read. */
interface Walk {
  depth: number;
  items: FlowItem[];
  item: FlowItem | null;
}

/** How a token changes the nesting depth. */
const DEPTH: Readonly<Record<Token["kind"], number>> = { open: 1, close: -1, comma: 0, atom: 0 };

/**
 * Feed one token to the walk: the closing bracket's index once the collection ends, -1 to go on,
 * or null when it is malformed (an empty item between two commas).
 */
function feed(walk: Walk, token: Token): number | null {
  const top = walk.depth === 1 && (token.kind === "comma" || token.kind === "close");
  if (!top) {
    walk.item = { start: walk.item?.start ?? token.at, end: token.end };
    walk.depth += DEPTH[token.kind];
    return -1;
  }
  if (walk.item) walk.items.push(walk.item);
  else if (token.kind === "comma") return null;
  walk.item = null;
  return token.kind === "close" ? token.at : -1;
}

/**
 * Read the flow collection that opens at `text[open]`: where it closes and where each top-level
 * item sits.
 *
 * @param text The text holding the collection (it may span lines).
 * @param open Index of its `[` or `{`.
 * @returns Its brackets and items, or null when it does not close or has an empty item.
 */
export function readFlow(text: string, open: number): Flow | null {
  if (text[open] !== "[" && text[open] !== "{") return null;
  const walk: Walk = { depth: 1, items: [], item: null };
  for (const token of tokens(text, open + 1)) {
    const close = token === null ? null : feed(walk, token);
    if (close === null) return null;
    if (close !== -1) return { open, close, items: walk.items };
  }
  return null;
}
