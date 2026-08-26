/**
 * A compact ICU MessageFormat implementation for the next-intl compat layer,
 * built entirely on the standard `Intl.*` APIs (no `intl-messageformat` npm dep).
 *
 * Supported syntax:
 * - `{name}` — interpolation
 * - `{name, number}` / `number, percent` / `number, ::currency/USD` and full `::` number
 *   skeletons (fraction digits, `compact`, `sign-*`, `group-*`, …) — via `Intl.NumberFormat`
 * - `{name, date, short|medium|long|full}` / `{name, time, …}` and `::` date field skeletons
 *   (`::yMMMd`, `::jm`, …) — via `Intl.DateTimeFormat`
 * - `{secs, duration}` → `H:MM:SS` — via `Intl.DurationFormat` (with a zero-data fallback)
 * - `{count, plural, offset:1 =0 {…} one {…} other {…}}` with `#` — via `Intl.PluralRules`
 * - `{rank, selectordinal, one {…} other {…}}` — ordinal plural rules
 * - `{gender, select, male {…} female {…} other {…}}`
 * - nested submessages inside plural/select branches
 *
 * - apostrophe escaping — `''` → literal `'`; `'{'`/`'}'`/`'#'` quote the syntax
 *   char; a lone apostrophe before a non-syntax char is a literal `'`
 *
 * Not supported (documented gap): `spellout` (number-to-words) — it needs bundled CLDR/RBNF
 * data, which the zero-npm/zero-data design forbids. Unsupported argument types fall back to
 * inserting the raw value. Everything above stays dependency-free and data-free (`Intl` only).
 *
 * @module
 */

/** A value interpolated into a message. */
export type IcuValue = string | number | boolean | Date | null | undefined;
/** The values map passed alongside a message. */
export type IcuValues = Record<string, IcuValue>;

// ---- AST -------------------------------------------------------------------

interface ArgNode {
  kind: "arg";
  name: string;
  type?: string;
  style?: string;
  offset: number;
  options?: Record<string, Node[]>;
}
type Node = string | ArgNode;

/**
 * Placeholder for a `#` that was apostrophe-quoted (a literal `#`, not the plural
 * count). It rides through rendering untouched by the `#`-substitution and is
 * restored to `#` at the end of {@link formatIcu}. A private-use code point that
 * won't occur in real message text.
 */
const QUOTED_POUND = "\uE000";

/** Recursive-descent parser over an ICU message string. */
class Parser {
  #s: string;
  #i = 0;
  constructor(s: string) {
    this.#s = s;
  }

  /** Parse a (sub)message until end of input or an unmatched `}`. */
  parseMessage(): Node[] {
    const nodes: Node[] = [];
    let text = "";
    while (this.#i < this.#s.length) {
      const ch = this.#s[this.#i];
      if (ch === "}") break; // end of a submessage
      if (ch === "'") {
        text += this.#readQuote();
        continue;
      }
      if (ch === "{") {
        if (text) {
          nodes.push(text);
          text = "";
        }
        nodes.push(this.#parseArg());
      } else {
        text += ch;
        this.#i++;
      }
    }
    if (text) nodes.push(text);
    return nodes;
  }

  /**
   * Handle an apostrophe per ICU MessageFormat rules, returning the literal text it
   * produces (`#` is emitted as {@link QUOTED_POUND} so the plural substitution skips
   * it). `''` → `'`; `'` before a syntax char (`{`/`}`/`#`/`|`) opens a quoted run
   * until the next lone `'`; a `'` before anything else is a literal apostrophe.
   */
  #readQuote(): string {
    this.#i++; // consume the opening "'"
    const next = this.#s[this.#i];
    if (next === "'") { // "''" → a literal apostrophe
      this.#i++;
      return "'";
    }
    if (next !== "{" && next !== "}" && next !== "#" && next !== "|") {
      return "'"; // lone apostrophe before a non-syntax char
    }
    // Quoted run: literal until a closing "'" ("''" inside stays a literal "'").
    let out = "";
    while (this.#i < this.#s.length) {
      const c = this.#s[this.#i];
      if (c === "'") {
        if (this.#s[this.#i + 1] === "'") {
          out += "'";
          this.#i += 2;
          continue;
        }
        this.#i++; // consume closing "'"
        break;
      }
      out += c === "#" ? QUOTED_POUND : c;
      this.#i++;
    }
    return out;
  }

  #parseArg(): ArgNode {
    this.#i++; // consume "{"
    const name = this.#readUntil([",", "}"]).trim();
    const node: ArgNode = { kind: "arg", name, offset: 0 };
    if (this.#s[this.#i] === "}") {
      this.#i++;
      return node;
    }
    this.#i++; // consume ","
    const type = this.#readUntil([",", "}"]).trim();
    node.type = type;
    if (type === "plural" || type === "selectordinal" || type === "select") {
      this.#i++; // consume "," before the options
      node.options = this.#parseOptions(node);
      // consume closing "}"
      if (this.#s[this.#i] === "}") this.#i++;
    } else if (this.#s[this.#i] === ",") {
      this.#i++; // consume ","
      node.style = this.#readUntil(["}"]).trim();
      if (this.#s[this.#i] === "}") this.#i++;
    } else if (this.#s[this.#i] === "}") {
      this.#i++;
    }
    return node;
  }

  #parseOptions(node: ArgNode): Record<string, Node[]> {
    const options: Record<string, Node[]> = {};
    this.#skipSpace();
    // optional offset:N
    if (this.#s.startsWith("offset:", this.#i)) {
      this.#i += "offset:".length;
      node.offset = parseInt(this.#readUntil([" ", "\t", "\n"]), 10) || 0;
      this.#skipSpace();
    }
    while (this.#i < this.#s.length && this.#s[this.#i] !== "}") {
      const selector = this.#readUntil(["{"]).trim();
      if (!selector) break;
      this.#i++; // consume "{"
      options[selector] = this.parseMessage();
      if (this.#s[this.#i] === "}") this.#i++; // consume submessage "}"
      this.#skipSpace();
    }
    return options;
  }

  #readUntil(stops: string[]): string {
    let out = "";
    while (this.#i < this.#s.length && !stops.includes(this.#s[this.#i])) {
      out += this.#s[this.#i++];
    }
    return out;
  }

  #skipSpace(): void {
    while (this.#i < this.#s.length && /\s/.test(this.#s[this.#i])) this.#i++;
  }
}

// ---- Evaluation ------------------------------------------------------------

/** Map an ICU number style (named or a `::` skeleton) to `Intl.NumberFormat` options. */
function numberOptions(style: string | undefined): Intl.NumberFormatOptions {
  if (!style) return {};
  if (style === "percent") return { style: "percent" };
  if (style === "integer") return { maximumFractionDigits: 0 };
  if (style.startsWith("::")) return parseNumberSkeleton(style.slice(2).trim());
  return {};
}

/**
 * Parse an ICU number `::` skeleton (space-separated tokens) into `Intl.NumberFormat`
 * options — the common next-intl subset. Unknown tokens are ignored (graceful), and no
 * CLDR data is needed: `Intl` already holds it. `spellout` is intentionally unsupported.
 */
function parseNumberSkeleton(skel: string): Intl.NumberFormatOptions {
  // deno-lint-ignore no-explicit-any -- some ECMA-402 string values (useGrouping:"min2")
  const o: any = {};
  for (const tok of skel.split(/\s+/)) {
    if (!tok) continue;
    if (/^\.[0#]+$/.test(tok)) {
      o.minimumFractionDigits = (tok.match(/0/g) ?? []).length;
      o.maximumFractionDigits = tok.length - 1;
      continue;
    }
    const cur = /^currency\/([A-Za-z]{3})$/.exec(tok);
    if (cur) {
      o.style = "currency";
      o.currency = cur[1].toUpperCase();
      continue;
    }
    const iw = /^integer-width\/\+?(0+)$/.exec(tok);
    if (iw) {
      o.minimumIntegerDigits = iw[1].length;
      continue;
    }
    switch (tok) {
      case "percent":
        o.style = "percent";
        break;
      case "compact-short":
        o.notation = "compact";
        o.compactDisplay = "short";
        break;
      case "compact-long":
        o.notation = "compact";
        o.compactDisplay = "long";
        break;
      case "scientific":
        o.notation = "scientific";
        break;
      case "engineering":
        o.notation = "engineering";
        break;
      case "precision-integer":
        o.maximumFractionDigits = 0;
        break;
      case "sign-always":
        o.signDisplay = "always";
        break;
      case "sign-never":
        o.signDisplay = "never";
        break;
      case "sign-except-zero":
        o.signDisplay = "exceptZero";
        break;
      case "sign-auto":
        o.signDisplay = "auto";
        break;
      case "sign-accounting":
        o.currencySign = "accounting";
        break;
      case "group-off":
        o.useGrouping = false;
        break;
      case "group-min2":
        o.useGrouping = "min2";
        break;
      case "group-auto":
      case "group-on-aligned":
      case "group-thousands":
        o.useGrouping = true;
        break;
    }
  }
  return o as Intl.NumberFormatOptions;
}

/** Map an ICU date/time style (named bucket or a `::` field skeleton) to `Intl` options. */
function dateOptions(type: string, style: string | undefined): Intl.DateTimeFormatOptions {
  const key = type === "time" ? "timeStyle" : "dateStyle";
  if (style && style.startsWith("::")) return parseDateSkeleton(style.slice(2).trim());
  const s = (style || "medium") as "short" | "medium" | "long" | "full";
  return { [key]: s };
}

/** Parse an ICU date `::` field skeleton (`yMMMd`, `jm`, …) into `Intl.DateTimeFormat` options. */
function parseDateSkeleton(skel: string): Intl.DateTimeFormatOptions {
  const o: Intl.DateTimeFormatOptions = {};
  for (const run of skel.match(/([a-zA-Z])\1*/g) ?? []) {
    const c = run[0];
    const n = run.length;
    switch (c) {
      case "y":
      case "Y":
        o.year = n >= 2 ? "2-digit" : "numeric";
        break;
      case "M":
      case "L":
        o.month = n >= 5
          ? "narrow"
          : n === 4
          ? "long"
          : n === 3
          ? "short"
          : n === 2
          ? "2-digit"
          : "numeric";
        break;
      case "d":
        o.day = n >= 2 ? "2-digit" : "numeric";
        break;
      case "E":
      case "e":
      case "c":
        o.weekday = n >= 5 ? "narrow" : n === 4 ? "long" : "short";
        break;
      case "h":
        o.hour = n >= 2 ? "2-digit" : "numeric";
        o.hour12 = true;
        break;
      case "H":
        o.hour = n >= 2 ? "2-digit" : "numeric";
        o.hour12 = false;
        break;
      case "j":
        o.hour = n >= 2 ? "2-digit" : "numeric";
        break; // locale-default hour cycle
      case "m":
        o.minute = n >= 2 ? "2-digit" : "numeric";
        break;
      case "s":
        o.second = n >= 2 ? "2-digit" : "numeric";
        break;
      case "G":
        o.era = n >= 4 ? "long" : "short";
        break;
      case "z":
      case "Z":
      case "O":
      case "v":
        o.timeZoneName = n >= 4 ? "long" : "short";
        break;
    }
  }
  return o;
}

function render(nodes: Node[], values: IcuValues, locale: string, poundValue?: number): string {
  let out = "";
  for (const node of nodes) {
    if (typeof node === "string") {
      out += poundValue === undefined
        ? node
        : node.replace(/#/g, () => new Intl.NumberFormat(locale).format(poundValue));
      continue;
    }
    out += renderArg(node, values, locale, poundValue);
  }
  return out;
}

function renderArg(node: ArgNode, values: IcuValues, locale: string, poundValue?: number): string {
  const value = values[node.name];
  switch (node.type) {
    case undefined:
      return value == null ? `{${node.name}}` : String(value);
    case "number": {
      // Missing/non-numeric values render as empty rather than "NaN".
      const n = Number(value);
      if (value == null || Number.isNaN(n)) return "";
      return new Intl.NumberFormat(locale, numberOptions(node.style)).format(n);
    }
    case "date":
    case "time": {
      if (value == null) return "";
      const date = value instanceof Date ? value : new Date(value as string | number);
      if (Number.isNaN(date.getTime())) return "";
      return new Intl.DateTimeFormat(locale, dateOptions(node.type, node.style)).format(date);
    }
    case "select": {
      // A nested select inherits the enclosing plural's `#` value.
      const branch = node.options?.[String(value)] ?? node.options?.other ?? [];
      return render(branch, values, locale, poundValue);
    }
    case "plural":
    case "selectordinal": {
      const n = Number(value);
      // Non-numeric count falls back to the `other` branch with no `#` value.
      if (value == null || Number.isNaN(n)) {
        return render(node.options?.other ?? [], values, locale);
      }
      const adjusted = n - node.offset;
      // Explicit `=N` matches take precedence over plural categories.
      const exact = node.options?.[`=${n}`];
      const branch = exact ??
        node.options?.[
          new Intl.PluralRules(locale, {
            type: node.type === "selectordinal" ? "ordinal" : "cardinal",
          }).select(adjusted)
        ] ?? node.options?.other ?? [];
      return render(branch, values, locale, adjusted);
    }
    case "duration": {
      // Value = whole seconds → `H:MM:SS`. Uses `Intl.DurationFormat` (zero data) when
      // present, with a byte-identical hand-rolled fallback so output is stable either way.
      if (value == null) return "";
      const total = Math.trunc(Number(value));
      if (Number.isNaN(total)) return "";
      const neg = total < 0;
      const abs = Math.abs(total);
      const parts = {
        hours: Math.floor(abs / 3600),
        minutes: Math.floor((abs % 3600) / 60),
        seconds: abs % 60,
      };
      // deno-lint-ignore no-explicit-any -- Intl.DurationFormat may be absent from the lib types
      const DF = (Intl as any).DurationFormat;
      const body = typeof DF === "function"
        ? new DF(locale, { style: "digital" }).format(parts) as string
        : `${parts.hours}:${String(parts.minutes).padStart(2, "0")}:${
          String(parts.seconds).padStart(2, "0")
        }`;
      return neg ? "-" + body : body;
    }
    default:
      // Unknown type — fall back to the raw value.
      return value == null ? "" : String(value);
  }
}

// Bounded parse cache. Catalog messages are few and fixed, but an app formatting
// dynamic/user-derived message strings must not grow this without limit — evict
// oldest-first once the cap is reached.
const cache = new Map<string, Node[]>();
const CACHE_MAX = 1000;

/**
 * Format an ICU `message` with `values` for `locale`.
 *
 * @param message The ICU message string.
 * @param values Interpolation values.
 * @param locale The BCP-47 locale (drives plural rules and number/date formatting).
 * @returns The formatted string.
 */
export function formatIcu(message: string, values: IcuValues = {}, locale = "en"): string {
  let ast = cache.get(message);
  if (!ast) {
    ast = new Parser(message).parseMessage();
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(message, ast);
  }
  // Restore any apostrophe-quoted `#` (protected from the plural substitution).
  const out = render(ast, values, locale);
  return out.includes(QUOTED_POUND) ? out.replaceAll(QUOTED_POUND, "#") : out;
}
