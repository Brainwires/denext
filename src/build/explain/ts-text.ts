// Readers for the type text inside TypeScript's messages: split a union, list an object
// type's keys, and pull the actual / expected types and the property path out of an
// assignability chain.

/** The index just past the string literal opening at `i` (its closing quote, unescaped). */
function skipString(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && !(text[j] === quote && text[j - 1] !== "\\")) j++;
  return j + 1;
}

/** The bracket-depth change a character makes (`=>` is not a closing bracket). */
function depthDelta(text: string, i: number): number {
  const ch = text[i];
  if ("{([<".includes(ch)) return 1;
  return "})]>".includes(ch) && text[i - 1] !== "=" ? -1 : 0;
}

/** Split `text` on `sep` at bracket depth 0, outside string literals. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length;) {
    if ("\"'`".includes(text[i])) {
      i = skipString(text, i);
    } else if (depth === 0 && text.startsWith(sep, i)) {
      out.push(text.slice(start, i).trim());
      i = start = i + sep.length;
    } else {
      depth += depthDelta(text, i++);
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

/** The members of a union type text (`"a" | "b"` → `['"a"', '"b"']`). */
export function unionMembers(type: string): string[] {
  return splitTop(type, "|");
}

/** The string value of a string-literal type text (`"a"` → `a`), or null. */
export function stringLiteral(type: string): string | null {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(type.trim());
  return m ? m[1] : null;
}

/** Every member is a string literal: their values, else null. */
export function stringLiteralUnion(type: string): string[] | null {
  const values = unionMembers(type).map(stringLiteral);
  return values.length > 0 && values.every((v) => v !== null) ? values as string[] : null;
}

/** The property names of an object type text (`{ id: string; name?: string; }` → `id, name`). */
export function objectKeys(type: string): string[] {
  const t = type.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return [];
  return splitTop(t.slice(1, -1), ";")
    .map((member) => /^(?:readonly\s+)?["']?([\w$-]+)["']?\??\s*:/.exec(member)?.[1])
    .filter((k): k is string => k !== undefined);
}

/** `Type 'A' is not assignable to type 'B'.` (or `Argument of type … parameter of type …`). */
export function assignablePair(line: string): { actual: string; expected: string } | null {
  const m =
    /^(?:Type|Argument of type) '(.*)' is not assignable to (?:type|parameter of type) '(.*)'\.?$/
      .exec(line.trim());
  return m ? { actual: m[1], expected: m[2] } : null;
}

/** `Property 'x' is missing in type '…' but required in type '…'.` → `x`. */
export function missingProperty(line: string): string | null {
  return /^Property '([^']+)' is missing in type /.exec(line.trim())?.[1] ?? null;
}

/**
 * The property path TypeScript's chain walks into: `The types of 'a.b' are incompatible` and
 * `Types of property 'c' are incompatible` lines, in order.
 */
export function chainPath(lines: readonly string[]): string[] {
  const path: string[] = [];
  for (const line of lines) {
    const deep = /^The types of '([^']+)' are incompatible/.exec(line);
    if (deep) path.push(...deep[1].split("."));
    const one = /^Types of property '([^']+)' are incompatible/.exec(line);
    if (one) path.push(one[1]);
  }
  return path;
}

/** A short form of a long type text for prose (`{ … }` past `max` characters). */
export function shortType(type: string, max = 60): string {
  const t = type.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  if (t.startsWith("{")) return "{ … }";
  return `${t.slice(0, max - 1)}…`;
}
