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
 * - `{n, spellout}` → number-to-words and `{n, ordinal}` → `1st`/`2nd` — a first-party
 *   speller (English built in; other locales fall back to the localized numeral)
 * - `{count, plural, offset:1 =0 {…} one {…} other {…}}` with `#` — via `Intl.PluralRules`
 * - `{rank, selectordinal, one {…} other {…}}` — ordinal plural rules
 * - `{gender, select, male {…} female {…} other {…}}`
 * - nested submessages inside plural/select branches
 *
 * - apostrophe escaping — `''` → literal `'`; `'{'`/`'}'`/`'#'` quote the syntax
 *   char; a lone apostrophe before a non-syntax char is a literal `'`
 *
 * Everything is built on standard `Intl.*` + first-party code — **zero npm deps and zero
 * bundled data**. `spellout` spells English in full; other locales render the localized
 * numeral until per-language rules are added. Unknown argument types fall back to the raw value.
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
  /** Submessage nesting depth, bounded so a pathologically-nested message (thousands
   * of `plural`/`select` levels) can't overflow the JS stack — a `RangeError` → 500 if
   * an app formats an attacker-controlled message string. */
  #depth = 0;
  static readonly #MAX_DEPTH = 64;
  constructor(s: string) {
    this.#s = s;
  }

  /** Parse a (sub)message until end of input or an unmatched `}`. */
  parseMessage(): Node[] {
    if (++this.#depth > Parser.#MAX_DEPTH) {
      throw new Error(`ICU message nesting too deep (>${Parser.#MAX_DEPTH} levels)`);
    }
    try {
      return this.#parseMessageBody();
    } finally {
      this.#depth--;
    }
  }

  #parseMessageBody(): Node[] {
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
 * CLDR data is needed: `Intl` already holds it.
 */
function parseNumberSkeleton(skel: string): Intl.NumberFormatOptions {
  // deno-lint-ignore no-explicit-any -- some ECMA-402 string values (useGrouping:"min2")
  const o: any = {};
  for (const tok of skel.split(/\s+/)) {
    if (!tok) continue;
    const fixed = NUMBER_SKELETON_TOKENS[tok];
    if (fixed) Object.assign(o, fixed);
    else Object.assign(o, parametricNumberToken(tok));
  }
  return o as Intl.NumberFormatOptions;
}

/** Fixed number-skeleton tokens → the `Intl.NumberFormat` options they set. */
const NUMBER_SKELETON_TOKENS: Record<string, Record<string, unknown>> = {
  percent: { style: "percent" },
  "compact-short": { notation: "compact", compactDisplay: "short" },
  "compact-long": { notation: "compact", compactDisplay: "long" },
  scientific: { notation: "scientific" },
  engineering: { notation: "engineering" },
  "precision-integer": { maximumFractionDigits: 0 },
  "sign-always": { signDisplay: "always" },
  "sign-never": { signDisplay: "never" },
  "sign-except-zero": { signDisplay: "exceptZero" },
  "sign-auto": { signDisplay: "auto" },
  "sign-accounting": { currencySign: "accounting" },
  "group-off": { useGrouping: false },
  "group-min2": { useGrouping: "min2" },
  "group-auto": { useGrouping: true },
  "group-on-aligned": { useGrouping: true },
  "group-thousands": { useGrouping: true },
};

/** Parametric tokens: `.00#` fraction digits, `currency/EUR`, `integer-width/+000`. */
function parametricNumberToken(tok: string): Record<string, unknown> {
  if (/^\.[0#]+$/.test(tok)) {
    return {
      minimumFractionDigits: (tok.match(/0/g) ?? []).length,
      maximumFractionDigits: tok.length - 1,
    };
  }
  const cur = /^currency\/([A-Za-z]{3})$/.exec(tok);
  if (cur) return { style: "currency", currency: cur[1].toUpperCase() };
  const iw = /^integer-width\/\+?(0+)$/.exec(tok);
  if (iw) return { minimumIntegerDigits: iw[1].length };
  return {};
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
  for (const run of skel.match(/([a-zA-Z])\1*/g) ?? []) DATE_FIELDS[run[0]]?.(o, run.length);
  return o;
}

type DateField = (o: Intl.DateTimeFormatOptions, n: number) => void;

/** `n` repeats of a numeric field → `2-digit` from two on. */
const digits = (n: number): "2-digit" | "numeric" => (n >= 2 ? "2-digit" : "numeric");

/** A textual field's width: 5+ narrow, 4 long, else short. */
const width = (n: number): "narrow" | "long" | "short" =>
  n >= 5 ? "narrow" : n === 4 ? "long" : "short";

/** Skeleton field letters → the option each run sets (CLDR field symbols). */
const DATE_FIELDS: Record<string, DateField> = {
  y: (o, n) => (o.year = digits(n)),
  Y: (o, n) => (o.year = digits(n)),
  M: (o, n) => (o.month = n >= 3 ? width(n) : digits(n)),
  L: (o, n) => (o.month = n >= 3 ? width(n) : digits(n)),
  d: (o, n) => (o.day = digits(n)),
  E: (o, n) => (o.weekday = width(n)),
  e: (o, n) => (o.weekday = width(n)),
  c: (o, n) => (o.weekday = width(n)),
  h: (o, n) => {
    o.hour = digits(n);
    o.hour12 = true;
  },
  H: (o, n) => {
    o.hour = digits(n);
    o.hour12 = false;
  },
  j: (o, n) => (o.hour = digits(n)), // locale-default hour cycle
  m: (o, n) => (o.minute = digits(n)),
  s: (o, n) => (o.second = digits(n)),
  G: (o, n) => (o.era = n >= 4 ? "long" : "short"),
  z: (o, n) => (o.timeZoneName = n >= 4 ? "long" : "short"),
  Z: (o, n) => (o.timeZoneName = n >= 4 ? "long" : "short"),
  O: (o, n) => (o.timeZoneName = n >= 4 ? "long" : "short"),
  v: (o, n) => (o.timeZoneName = n >= 4 ? "long" : "short"),
};

// ---- spellout / ordinal (first-party number-to-words; no npm, no CLDR data) ------
//
// ICU backs `spellout`/`ordinal` with CLDR RBNF rule sets. Rather than bundle that data
// (or an npm formatter), denext ships a hand-rolled English number-speller — pure code,
// zero data. English is built in; other locales fall back to the localized numeral (the
// ordinal *category* is still taken from `Intl.PluralRules`, so it stays locale-aware).

const SPELL_SMALL = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const SPELL_TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];
const SPELL_SCALES = [
  "",
  "thousand",
  "million",
  "billion",
  "trillion",
  "quadrillion",
  "quintillion",
];

/** Spell a non-negative integer < 1000 in English (`""` for 0). */
function spellUnder1000(x: number): string {
  let s = "";
  if (x >= 100) {
    s += SPELL_SMALL[Math.floor(x / 100)] + " hundred";
    x %= 100;
    if (x) s += " ";
  }
  if (x >= 20) {
    s += SPELL_TENS[Math.floor(x / 10)];
    if (x % 10) s += "-" + SPELL_SMALL[x % 10];
  } else if (x > 0) {
    s += SPELL_SMALL[x];
  }
  return s;
}

/** Spell a non-negative integer in English. */
function spellInteger(n: number): string {
  if (n === 0) return "zero";
  const chunks: number[] = [];
  while (n > 0) {
    chunks.push(n % 1000);
    n = Math.floor(n / 1000);
  }
  const parts: string[] = [];
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i] === 0) continue;
    parts.push(spellUnder1000(chunks[i]) + (SPELL_SCALES[i] ? " " + SPELL_SCALES[i] : ""));
  }
  return parts.join(" ");
}

/** English number-to-words for `{n, spellout}` (handles sign + a decimal fraction). */
function spelloutEnglish(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value < 0) return "minus " + spelloutEnglish(-value);
  const words = spellInteger(Math.trunc(value));
  if (Number.isInteger(value)) return words;
  const frac = String(value).split(".")[1] ?? "";
  const digits = [...frac].map((d) => SPELL_SMALL[Number(d)]).join(" ");
  return `${words} point ${digits}`;
}

// English ordinal indicators, keyed by `Intl.PluralRules` ordinal category.
const ORDINAL_SUFFIX: Record<string, string> = { one: "st", two: "nd", few: "rd", other: "th" };

/** `{n, ordinal}` → `1st`/`2nd`/… (English). Non-English locales get the plain numeral. */
function ordinalWord(n: number, locale: string): string {
  const numeral = new Intl.NumberFormat(locale).format(n);
  if (!/^en\b/i.test(locale)) return numeral; // English-only indicators (bounded scope)
  const category = new Intl.PluralRules(locale, { type: "ordinal" }).select(n);
  return numeral + (ORDINAL_SUFFIX[category] ?? "th");
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
  if (node.type === undefined) return value == null ? `{${node.name}}` : String(value);
  const renderer = ARG_RENDERERS[node.type];
  // Unknown type — fall back to the raw value.
  if (!renderer) return value == null ? "" : String(value);
  return renderer({ node, value, values, locale, poundValue });
}

/** One argument to render: its node, the looked-up value, and the render context. */
interface ArgRender {
  node: ArgNode;
  value: unknown;
  values: IcuValues;
  locale: string;
  poundValue?: number;
}

/** A finite number from a value, or null (missing/non-numeric values render as empty rather than "NaN"). */
function numberOf(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function renderNumber({ node, value, locale }: ArgRender): string {
  const n = numberOf(value);
  return n === null ? "" : new Intl.NumberFormat(locale, numberOptions(node.style)).format(n);
}

function renderDate({ node, value, locale }: ArgRender): string {
  if (value == null) return "";
  const date = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, dateOptions(node.type!, node.style)).format(date);
}

/** A nested select inherits the enclosing plural's `#` value. */
function renderSelect({ node, value, values, locale, poundValue }: ArgRender): string {
  const branch = node.options?.[String(value)] ?? node.options?.other ?? [];
  return render(branch, values, locale, poundValue);
}

function renderPlural({ node, value, values, locale }: ArgRender): string {
  const n = numberOf(value);
  // Non-numeric count falls back to the `other` branch with no `#` value.
  if (n === null) return render(node.options?.other ?? [], values, locale);
  const adjusted = n - node.offset;
  // Explicit `=N` matches take precedence over plural categories.
  const category = new Intl.PluralRules(locale, {
    type: node.type === "selectordinal" ? "ordinal" : "cardinal",
  }).select(adjusted);
  const branch = node.options?.[`=${n}`] ?? node.options?.[category] ?? node.options?.other ?? [];
  return render(branch, values, locale, adjusted);
}

/**
 * Value = whole seconds → `H:MM:SS`. Uses `Intl.DurationFormat` (zero data) when present,
 * with a byte-identical hand-rolled fallback so output is stable either way.
 */
function renderDuration({ value, locale }: ArgRender): string {
  if (value == null) return "";
  const total = Math.trunc(Number(value));
  if (Number.isNaN(total)) return "";
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
  return total < 0 ? "-" + body : body;
}

/**
 * Number-to-words. English is spelled in full; other locales fall back to the localized
 * numeral (per-language spelling rules are a bounded, extensible scope).
 */
function renderSpellout({ value, locale }: ArgRender): string {
  const n = numberOf(value);
  if (n === null) return "";
  return /^en\b/i.test(locale) ? spelloutEnglish(n) : new Intl.NumberFormat(locale).format(n);
}

/** `1st`/`2nd`/… — English indicators over the locale-aware ordinal category. */
function renderOrdinal({ value, locale }: ArgRender): string {
  const n = numberOf(value);
  return n === null ? "" : ordinalWord(n, locale);
}

/** Per argument type. `date`/`time` share a renderer, as do `plural`/`selectordinal`. */
const ARG_RENDERERS: Record<string, (arg: ArgRender) => string> = {
  number: renderNumber,
  date: renderDate,
  time: renderDate,
  select: renderSelect,
  plural: renderPlural,
  selectordinal: renderPlural,
  duration: renderDuration,
  spellout: renderSpellout,
  ordinal: renderOrdinal,
};

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
