/**
 * A compact ICU MessageFormat implementation for the next-intl compat layer,
 * built entirely on the standard `Intl.*` APIs (no `intl-messageformat` npm dep).
 *
 * Supported syntax:
 * - `{name}` — interpolation
 * - `{name, number}` / `number, percent|integer` and `::` number skeletons, long and concise
 *   (`currency/EUR`, `unit/meter`, `measure-unit/…`, `per-measure-unit/…`, `unit-width-*`,
 *   `.00##` / `.00+` / `.00/w` / `.##/@@#r`, `@@#`, `precision-increment/0.05`,
 *   `rounding-mode-*`, `compact-*` / `K` / `KK`, `scientific` / `engineering` / `E0`,
 *   `sign-*` / `+!` / `()`, `group-*` / `,_`, `integer-width/…` / `000`, `scale/N`, `%x100`,
 *   `numbering-system/…`) — via `Intl.NumberFormat`
 * - `{name, date, short|medium|long|full}` / `{name, time, …}` and `::` date field skeletons
 *   (`::yMMMd`, `::jm`, `::Kms`, `::hmsSSS`, `::MMMMdBh`, `::Hmv`, …) — via
 *   `Intl.DateTimeFormat`; a field it has no option for (quarter, week, day of year) throws
 * - `{secs, duration}` → `H:MM:SS` — via `Intl.DurationFormat` (with a zero-data fallback)
 * - `{n, spellout}` → number-to-words and `{n, ordinal}` → `1st`/`2nd` — a first-party
 *   speller (English built in; other locales fall back to the localized numeral)
 * - `{count, plural, offset:1 =0 {…} one {…} other {…}}` with `#` — via `Intl.PluralRules`
 * - `{rank, selectordinal, one {…} other {…}}` — ordinal plural rules
 * - `{gender, select, male {…} female {…} other {…}}`
 * - nested submessages inside plural/select branches, up to {@link MAX_ICU_DEPTH} levels (an
 *   iterative parser and renderer: nesting costs no JS stack)
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

/**
 * One submessage being parsed: its nodes so far and pending text, and — below the root — the
 * `plural` / `select` argument and selector it is the branch of.
 */
interface ParseFrame {
  nodes: Node[];
  text: string;
  arg?: ArgNode;
  selector?: string;
}

/**
 * The deepest `plural` / `select` / `selectordinal` nesting a message may have. Real catalogs
 * stop at three or four levels; nesting costs a heap frame per level (never JS stack), so the
 * cap is set far above any real message (and well above the recursive parser's old 64) while a
 * hostile message still fails fast with a `SyntaxError`, as FormatJS's parser throws one.
 */
export const MAX_ICU_DEPTH = 1000;

/**
 * The longest message, in UTF-16 code units, {@link formatIcu} parses. Parsing and rendering are
 * linear in the length, so this bounds the CPU and memory one hostile message (an
 * attacker-controlled string) can cost; a real message, even a long legal paragraph, is a few
 * thousand.
 */
export const MAX_ICU_LENGTH = 256 * 1024;

/**
 * The most characters one message renders to. A `#` repeated through a plural branch renders the
 * formatted count each time, so without a cap a message at {@link MAX_ICU_LENGTH} could render to
 * hundreds of megabytes.
 */
const MAX_ICU_OUTPUT = 16 * 1024 * 1024;

/** `obj[key]` when `key` is its own property (never `Object.prototype`'s `constructor`, …). */
function own<T>(obj: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/**
 * Parser over an ICU message string. Iterative — an explicit stack of submessages, never the JS
 * call stack — so nesting costs no stack and parsing is linear in the message's length; the
 * nesting ({@link MAX_ICU_DEPTH}) and the length ({@link MAX_ICU_LENGTH}) are capped, so a
 * pathological message (an attacker-controlled string) throws instead of costing unbounded work.
 */
class Parser {
  #s: string;
  #i = 0;
  constructor(s: string) {
    if (s.length > MAX_ICU_LENGTH) {
      throw new SyntaxError(`ICU message too long (${s.length} > ${MAX_ICU_LENGTH} characters)`);
    }
    this.#s = s;
  }

  /** Enter one more level of submessage, refusing past {@link MAX_ICU_DEPTH}. */
  static #push(stack: ParseFrame[], frame: ParseFrame): void {
    // The root frame is level 0, so the stack holds the depth plus one.
    if (stack.length > MAX_ICU_DEPTH) {
      throw new SyntaxError(`ICU message nesting too deep (> ${MAX_ICU_DEPTH} levels)`);
    }
    stack.push(frame);
  }

  /** Parse the whole message (a stray top-level `}` ends it, as in a submessage). */
  parseMessage(): Node[] {
    const root: ParseFrame = { nodes: [], text: "" };
    const stack: ParseFrame[] = [root];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const branch = this.#scan(frame);
      if (branch) {
        Parser.#push(stack, branch);
        continue;
      }
      // The frame ended (`}` or end of input).
      if (frame.text) frame.nodes.push(frame.text);
      frame.text = "";
      if (frame === root) break;
      stack.pop();
      const arg = frame.arg!;
      arg.options![frame.selector!] = frame.nodes;
      if (this.#s[this.#i] === "}") this.#i++; // the submessage's "}"
      const next = this.#nextBranch(arg);
      if (next) Parser.#push(stack, next);
    }
    return root.nodes;
  }

  /**
   * Read `frame`'s text and simple arguments up to its end (`}` / end of input; null) or to the
   * first branch of a `plural` / `select` argument (that branch's frame, to parse next).
   */
  #scan(frame: ParseFrame): ParseFrame | null {
    while (this.#i < this.#s.length) {
      const ch = this.#s[this.#i];
      if (ch === "}") return null;
      if (ch === "'") {
        frame.text += this.#readQuote();
        continue;
      }
      if (ch !== "{") {
        frame.text += ch;
        this.#i++;
        continue;
      }
      if (frame.text) frame.nodes.push(frame.text);
      frame.text = "";
      const arg = this.#parseArg();
      frame.nodes.push(arg);
      if (arg.options) {
        const branch = this.#nextBranch(arg);
        if (branch) return branch;
      }
    }
    return null;
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

  /**
   * An argument from its `{`: a simple one whole (through its `}`), or a `plural` / `select`
   * header (through `offset:N`) with empty `options`, its branches parsed by the caller.
   */
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
      // No prototype: a branch named `__proto__` / `constructor` is just a branch.
      node.options = Object.create(null);
      this.#skipSpace();
      if (this.#s.startsWith("offset:", this.#i)) {
        this.#i += "offset:".length;
        node.offset = parseInt(this.#readUntil([" ", "\t", "\n"]), 10) || 0;
      }
    } else if (this.#s[this.#i] === ",") {
      this.#i++; // consume ","
      node.style = this.#readUntil(["}"]).trim();
      if (this.#s[this.#i] === "}") this.#i++;
    } else if (this.#s[this.#i] === "}") {
      this.#i++;
    }
    return node;
  }

  /**
   * The next branch of `arg` (its selector read and its `{` consumed), or null when its options
   * end — the argument's closing `}` then consumed.
   */
  #nextBranch(arg: ArgNode): ParseFrame | null {
    this.#skipSpace();
    const selector = this.#s[this.#i] === "}" ? "" : this.#readUntil(["{"]).trim();
    if (!selector) {
      if (this.#s[this.#i] === "}") this.#i++;
      return null;
    }
    this.#i++; // consume "{"
    return { nodes: [], text: "", arg, selector };
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

/** A number style resolved: `Intl.NumberFormat` options and a multiplier (`scale/N`). */
interface NumberStyle {
  options: Intl.NumberFormatOptions;
  scale: number;
}

/** Map an ICU number style (named or a `::` skeleton) to `Intl.NumberFormat` options. */
function numberStyle(style: string | undefined): NumberStyle {
  if (style?.startsWith("::")) return parseNumberSkeleton(style.slice(2).trim());
  const named = style ? own(NAMED_NUMBER_STYLES, style) : undefined;
  return { options: named ?? {}, scale: 1 };
}

/** The named number styles (`{n, number, percent}`). */
const NAMED_NUMBER_STYLES: Record<string, Intl.NumberFormatOptions> = {
  percent: { style: "percent" },
  integer: { maximumFractionDigits: 0 },
};

/** Number-skeleton option bag being built (some ECMA-402 values postdate the lib types). */
// deno-lint-ignore no-explicit-any
type NumberBag = Record<string, any>;

/**
 * Parse an ICU number `::` skeleton — long (`currency/EUR unit-width-narrow`) and concise
 * (`K`, `+!`, `%x100`, `.00`, `@@#`, `000`, `E0`) tokens — into `Intl.NumberFormat` options and
 * a scale, as next-intl's formatter (FormatJS's skeleton parser) reads them. A token with no
 * `Intl.NumberFormat` equivalent (`decimal-always`, an exponent width) is ignored, as FormatJS
 * ignores it. No CLDR data is needed: `Intl` already holds it.
 */
function parseNumberSkeleton(skel: string): NumberStyle {
  const o: NumberBag = {};
  let scale = 1;
  for (const tok of skel.split(/\s+/)) {
    if (tok) scale *= applyNumberToken(o, tok);
  }
  // `measure-unit/… per-measure-unit/…` is one compound unit (`meter-per-second`).
  if (o.perUnit !== undefined) {
    if (o.unit) o.unit = `${o.unit}-per-${o.perUnit}`;
    delete o.perUnit;
  }
  return { options: o as Intl.NumberFormatOptions, scale };
}

/** Apply one skeleton token to `o`; returns the factor it scales the value by (`scale/N`). */
function applyNumberToken(o: NumberBag, tok: string): number {
  const [stem, ...opts] = tok.split("/");
  if (stem === "scale") {
    const n = Number(opts[0]);
    return Number.isFinite(n) ? n : 1;
  }
  // `%x100` is `percent scale/100`: the value is a fraction, and Intl's percent multiplies.
  const fixed = stem === "%x100" ? { style: "percent" } : own(NUMBER_SKELETON_TOKENS, stem);
  Object.assign(o, fixed ?? stemOptions(stem, opts));
  return 1;
}

/** Fixed number-skeleton stems (long and concise) → the `Intl.NumberFormat` options they set. */
const NUMBER_SKELETON_TOKENS: Record<string, NumberBag> = {
  percent: { style: "percent" },
  "%": { style: "percent" },
  "compact-short": { notation: "compact", compactDisplay: "short" },
  K: { notation: "compact", compactDisplay: "short" },
  "compact-long": { notation: "compact", compactDisplay: "long" },
  KK: { notation: "compact", compactDisplay: "long" },
  scientific: { notation: "scientific" },
  engineering: { notation: "engineering" },
  "notation-simple": { notation: "standard" },
  "precision-integer": { maximumFractionDigits: 0 },
  ".": { maximumFractionDigits: 0 },
  "precision-unlimited": { maximumFractionDigits: 20 },
  "precision-currency-standard": {},
  "precision-currency-cash": {},
  "sign-auto": { signDisplay: "auto" },
  "+?": { signDisplay: "exceptZero" },
  "sign-always": { signDisplay: "always" },
  "+!": { signDisplay: "always" },
  "sign-never": { signDisplay: "never" },
  "+_": { signDisplay: "never" },
  "sign-except-zero": { signDisplay: "exceptZero" },
  "sign-negative": { signDisplay: "negative" },
  "+-": { signDisplay: "negative" },
  "sign-accounting": { currencySign: "accounting" },
  "()": { currencySign: "accounting" },
  "sign-accounting-always": { currencySign: "accounting", signDisplay: "always" },
  "()!": { currencySign: "accounting", signDisplay: "always" },
  "sign-accounting-except-zero": { currencySign: "accounting", signDisplay: "exceptZero" },
  "()?": { currencySign: "accounting", signDisplay: "exceptZero" },
  "sign-accounting-negative": { currencySign: "accounting", signDisplay: "negative" },
  "()-": { currencySign: "accounting", signDisplay: "negative" },
  "group-off": { useGrouping: false },
  ",_": { useGrouping: false },
  "group-min2": { useGrouping: "min2" },
  ",?": { useGrouping: "min2" },
  "group-auto": { useGrouping: "auto" },
  "group-on-aligned": { useGrouping: "always" },
  ",!": { useGrouping: "always" },
  "group-thousands": { useGrouping: "always" },
  "unit-width-narrow": { unitDisplay: "narrow", currencyDisplay: "narrowSymbol" },
  "unit-width-short": { unitDisplay: "short", currencyDisplay: "symbol" },
  "unit-width-full-name": { unitDisplay: "long", currencyDisplay: "name" },
  "unit-width-iso-code": { currencyDisplay: "code" },
  "rounding-mode-ceiling": { roundingMode: "ceil" },
  "rounding-mode-floor": { roundingMode: "floor" },
  "rounding-mode-down": { roundingMode: "trunc" },
  "rounding-mode-up": { roundingMode: "expand" },
  "rounding-mode-half-even": { roundingMode: "halfEven" },
  "rounding-mode-half-down": { roundingMode: "halfTrunc" },
  "rounding-mode-half-up": { roundingMode: "halfExpand" },
  latin: { numberingSystem: "latn" },
};

/** A stem that carries options (`currency/EUR`) or a pattern (`.00`, `@@#`, `000`, `E0`). */
function stemOptions(stem: string, opts: string[]): NumberBag {
  const optioned = own(OPTION_STEMS, stem);
  if (optioned) return opts.length > 0 ? optioned(opts) : {};
  if (/^\.[0#]*[+*]?$/.test(stem)) return { ...fractionDigits(stem), ...fractionOption(opts) };
  if (/^@+#*[+*]?$/.test(stem)) return significantDigits(stem);
  if (/^0+$/.test(stem)) return { minimumIntegerDigits: stem.length };
  const exp = /^(E{1,2})(?:\+[!?])?0+$/.exec(stem);
  if (exp) return { notation: exp[1] === "EE" ? "engineering" : "scientific" };
  return {};
}

/** Stems whose meaning is in their `/` options. */
const OPTION_STEMS: Record<string, (opts: string[]) => NumberBag> = {
  currency: ([c]) =>
    /^[A-Za-z]{3}$/.test(c) ? { style: "currency", currency: c.toUpperCase() } : {},
  "measure-unit": ([u]) => ({ style: "unit", unit: simpleUnit(u) }),
  unit: ([u]) => ({ style: "unit", unit: u }),
  "per-measure-unit": ([u]) => ({ perUnit: simpleUnit(u) }),
  "integer-width": ([w]) => {
    // Counted, not matched: an unanchored `/0+$/` is quadratic on a long run of zeros.
    let zeros = 0;
    while (zeros < w.length && w[w.length - 1 - zeros] === "0") zeros++;
    return zeros > 0 && zeros <= 21 ? { minimumIntegerDigits: zeros } : {};
  },
  "precision-increment": ([inc]) => roundingIncrement(inc),
  "numbering-system": ([ns]) => ({ numberingSystem: ns }),
};

/** `length-meter` → `meter` (a CLDR unit id without its type). */
function simpleUnit(id: string): string {
  return id.replace(/^[a-z]+-(?=[a-z])/, "");
}

/** `.00##` → min/max fraction digits; `.00+` / `.00*` leaves the maximum open. */
function fractionDigits(stem: string): NumberBag {
  const min = (stem.match(/0/g) ?? []).length;
  const open = /[+*]$/.test(stem);
  const max = open ? 20 : stem.length - 1;
  return { minimumFractionDigits: min, maximumFractionDigits: Math.max(min, max) };
}

/** A fraction stem's option: `/w` strips trailing zeros of an integer; `/@@#r` / `s` digits. */
function fractionOption(opts: string[]): NumberBag {
  const [opt] = opts;
  if (!opt) return {};
  if (opt === "w") return { trailingZeroDisplay: "stripIfInteger" };
  const sig = /^(@+#*[+*]?)([rs]?)$/.exec(opt);
  if (!sig) return {};
  return {
    ...significantDigits(sig[1]),
    roundingPriority: sig[2] === "s" ? "lessPrecision" : "morePrecision",
  };
}

/** `@@#` → min 2 / max 3 significant digits; `@@+` / `@@*` leaves the maximum open. */
function significantDigits(stem: string): NumberBag {
  const min = (stem.match(/@/g) ?? []).length;
  const max = /[+*]$/.test(stem) ? 21 : min + (stem.match(/#/g) ?? []).length;
  return { minimumSignificantDigits: min, maximumSignificantDigits: max };
}

/** The increments `Intl.NumberFormat` accepts as `roundingIncrement`. */
const INCREMENTS = new Set([1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000]);

/** `precision-increment/0.05` → round to 0.05 (fraction digits from the increment). */
function roundingIncrement(inc: string): NumberBag {
  // Bounded before the match: `(\d*)\.?(\d*)` backtracks quadratically on a long digit run.
  if (inc.length > 32) return {};
  const m = /^(\d*)\.?(\d*)$/.exec(inc);
  if (!m) return {};
  const digits = m[2].length;
  const step = Number(m[1] + m[2]);
  if (!INCREMENTS.has(step)) return {};
  if (step === 1) return { minimumFractionDigits: digits, maximumFractionDigits: digits };
  return { roundingIncrement: step, minimumFractionDigits: digits, maximumFractionDigits: digits };
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

/** Year: only exactly `yy` is 2-digit (`yyyy` is the full year, as in CLDR). */
const yearDigits = (n: number): "2-digit" | "numeric" => (n === 2 ? "2-digit" : "numeric");

/** A textual field's width: 5+ narrow, 4 long, else short. */
const width = (n: number): "narrow" | "long" | "short" =>
  n >= 5 ? "narrow" : n === 4 ? "long" : "short";

/** A time-zone field's name style: `short` / `long` per its width. */
const zone =
  (short: string, long: string, at = 4) => (o: Intl.DateTimeFormatOptions, n: number) => {
    // deno-lint-ignore no-explicit-any -- the offset / generic styles postdate some lib types
    (o as any).timeZoneName = n >= at ? long : short;
  };

/** An hour field with its hour cycle (`h` 1–12, `H` 0–23, `K` 0–11, `k` 1–24). */
const hour =
  (cycle: "h11" | "h12" | "h23" | "h24") => (o: Intl.DateTimeFormatOptions, n: number) => {
    o.hour = digits(n);
    o.hourCycle = cycle;
  };

/** A field `Intl.DateTimeFormat` has no option for: an error, as next-intl's formatter raises. */
const unsupported = (what: string): DateField => () => {
  throw new RangeError(
    `ICU date skeleton: ${what} fields are not supported by Intl.DateTimeFormat`,
  );
};

/**
 * Skeleton field letters → the option each run sets (CLDR field symbols). The fields
 * `Intl.DateTimeFormat` has no option for (quarter, week, day of year) throw, as next-intl's
 * formatter does: an error, never a date rendered without them.
 */
const DATE_FIELDS: Record<string, DateField> = {
  G: (o, n) => (o.era = n >= 5 ? "narrow" : n === 4 ? "long" : "short"),
  y: (o, n) => (o.year = yearDigits(n)),
  Y: (o, n) => (o.year = yearDigits(n)),
  u: (o, n) => (o.year = yearDigits(n)),
  M: (o, n) => (o.month = n >= 3 ? width(n) : digits(n)),
  L: (o, n) => (o.month = n >= 3 ? width(n) : digits(n)),
  d: (o, n) => (o.day = digits(n)),
  E: (o, n) => (o.weekday = width(n)),
  e: (o, n) => (o.weekday = n >= 3 ? width(n) : "short"),
  c: (o, n) => (o.weekday = n >= 3 ? width(n) : "short"),
  a: () => {}, // the day period follows the hour field's cycle
  b: (o, n) => (o.dayPeriod = width(n)),
  B: (o, n) => (o.dayPeriod = width(n)),
  h: hour("h12"),
  H: hour("h23"),
  K: hour("h11"),
  k: hour("h24"),
  j: (o, n) => (o.hour = digits(n)), // locale-default hour cycle
  J: (o, n) => (o.hour = digits(n)),
  C: (o, n) => (o.hour = digits(n)),
  m: (o, n) => (o.minute = digits(n)),
  s: (o, n) => (o.second = digits(n)),
  S: (o, n) => (o.fractionalSecondDigits = Math.min(n, 3) as 1 | 2 | 3),
  z: zone("short", "long"),
  Z: zone("shortOffset", "longOffset"),
  O: zone("shortOffset", "longOffset"),
  v: zone("shortGeneric", "longGeneric"),
  V: zone("shortGeneric", "longGeneric", 3),
  X: zone("shortOffset", "longOffset"),
  x: zone("shortOffset", "longOffset"),
  Q: unsupported("quarter (Q)"),
  q: unsupported("quarter (q)"),
  w: unsupported("week (w)"),
  W: unsupported("week (W)"),
  D: unsupported("day-of-year (D)"),
  F: unsupported("day-of-week-in-month (F)"),
  g: unsupported("modified Julian day (g)"),
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

/** A submessage being rendered: its nodes, the next one, and the enclosing plural's `#` value. */
interface RenderFrame {
  nodes: Node[];
  i: number;
  pound?: number;
}

/**
 * `Intl` formatters by locale and options, built once: a message renders one `#` per character
 * at worst and one plural rule per level, so building a formatter for each would make the
 * render's cost a constructor per character. Cleared when it grows past a few dozen entries
 * (the locales an app serves), so hostile locale strings cannot grow it either.
 */
const intlCache = new Map<string, Intl.PluralRules | Intl.NumberFormat>();

function cachedIntl<T extends Intl.PluralRules | Intl.NumberFormat>(key: string, make: () => T): T {
  let hit = intlCache.get(key) as T | undefined;
  if (hit === undefined) {
    if (intlCache.size >= 64) intlCache.clear();
    hit = make();
    intlCache.set(key, hit);
  }
  return hit;
}

/** The locale's plain number format (what `#` renders as). */
const numberFormat = (locale: string): Intl.NumberFormat =>
  cachedIntl(`n\0${locale}`, () => new Intl.NumberFormat(locale));

/** `text` with every `#` replaced by `count` (a function, so `$` is never a pattern). */
const replacePound = (text: string, count: string): string => text.replaceAll("#", () => count);

/** The locale's cardinal or ordinal plural rules. */
const pluralRules = (locale: string, type: Intl.PluralRuleType): Intl.PluralRules =>
  cachedIntl(`p\0${type}\0${locale}`, () => new Intl.PluralRules(locale, { type }));

/**
 * Render a parsed message. Iterative, like the parser: a `plural` / `select` pushes its chosen
 * branch instead of recursing, so nesting depth costs no stack.
 */
function render(nodes: Node[], values: IcuValues, locale: string): string {
  let out = "";
  const stack: RenderFrame[] = [{ nodes, i: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.i >= frame.nodes.length) {
      stack.pop();
      continue;
    }
    const node = frame.nodes[frame.i++];
    const branch = typeof node !== "string" && node.options
      ? chooseBranch(node, values, locale, frame.pound)
      : null;
    if (branch) stack.push(branch);
    else out += renderPiece(node, frame.pound, values, locale);
    if (out.length > MAX_ICU_OUTPUT) {
      throw new RangeError(`ICU message output too long (> ${MAX_ICU_OUTPUT} characters)`);
    }
  }
  return out;
}

/** A text run (its `#` the enclosing plural's count) or a simple argument, rendered. */
function renderPiece(node: Node, pound: number | undefined, values: IcuValues, locale: string) {
  if (typeof node !== "string") return renderArg(node, values, locale);
  return pound === undefined || !node.includes("#")
    ? node
    : replacePound(node, numberFormat(locale).format(pound));
}

/**
 * The branch a `select` / `plural` / `selectordinal` argument renders. A select keeps the
 * enclosing plural's `#`; a plural's `#` is its own count less the offset.
 */
function chooseBranch(
  node: ArgNode,
  values: IcuValues,
  locale: string,
  pound?: number,
): RenderFrame {
  const options = node.options!;
  const value = own(values, node.name);
  if (node.type === "select") {
    return { nodes: own(options, String(value)) ?? own(options, "other") ?? [], i: 0, pound };
  }
  return pluralBranch(node, numberOf(value), locale);
}

/** A plural's branch: `=N` first, then the plural category of the count less the offset. */
function pluralBranch(node: ArgNode, n: number | null, locale: string): RenderFrame {
  const options = node.options!;
  // Non-numeric count falls back to the `other` branch with no `#` value.
  if (n === null) return { nodes: own(options, "other") ?? [], i: 0 };
  const adjusted = n - node.offset;
  const category = pluralRules(locale, node.type === "selectordinal" ? "ordinal" : "cardinal")
    .select(adjusted);
  const nodes = own(options, `=${n}`) ?? own(options, category) ?? own(options, "other") ?? [];
  return { nodes, i: 0, pound: adjusted };
}

function renderArg(node: ArgNode, values: IcuValues, locale: string): string {
  const value = own(values, node.name);
  if (node.type === undefined) return value == null ? `{${node.name}}` : String(value);
  const renderer = own(ARG_RENDERERS, node.type);
  // Unknown type — fall back to the raw value.
  if (!renderer) return value == null ? "" : String(value);
  return renderer({ node, value, locale });
}

/** One argument to render: its node, the looked-up value, and the locale. */
interface ArgRender {
  node: ArgNode;
  value: unknown;
  locale: string;
}

/** A finite number from a value, or null (missing/non-numeric values render as empty rather than "NaN"). */
function numberOf(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function renderNumber({ node, value, locale }: ArgRender): string {
  const n = numberOf(value);
  if (n === null) return "";
  const { options, scale } = numberStyle(node.style);
  return new Intl.NumberFormat(locale, options).format(n * scale);
}

function renderDate({ node, value, locale }: ArgRender): string {
  if (value == null) return "";
  const date = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, dateOptions(node.type!, node.style)).format(date);
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

/** Per simple argument type (`date`/`time` share one); `plural` / `select` are branches. */
const ARG_RENDERERS: Record<string, (arg: ArgRender) => string> = {
  number: renderNumber,
  date: renderDate,
  time: renderDate,
  duration: renderDuration,
  spellout: renderSpellout,
  ordinal: renderOrdinal,
};

// Bounded parse cache. Catalog messages are few and fixed, but an app formatting
// dynamic/user-derived message strings must not grow this without limit — evict
// oldest-first once either cap is reached: the entry count, or the total length of the cached
// messages (each up to MAX_ICU_LENGTH, so a count alone would let a thousand of them stay).
const cache = new Map<string, Node[]>();
const CACHE_MAX = 1000;
const CACHE_MAX_CHARS = 4 * 1024 * 1024;
let cachedChars = 0;

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
    while (
      cache.size >= CACHE_MAX || (cache.size > 0 && cachedChars + message.length > CACHE_MAX_CHARS)
    ) {
      const oldest = cache.keys().next().value as string;
      cache.delete(oldest);
      cachedChars -= oldest.length;
    }
    cache.set(message, ast);
    cachedChars += message.length;
  }
  // Restore any apostrophe-quoted `#` (protected from the plural substitution).
  const out = render(ast, values, locale);
  return out.includes(QUOTED_POUND) ? out.replaceAll(QUOTED_POUND, "#") : out;
}
