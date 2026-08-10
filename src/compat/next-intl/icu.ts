/**
 * A compact ICU MessageFormat implementation for the next-intl compat layer,
 * built entirely on the standard `Intl.*` APIs (no `intl-messageformat` npm dep).
 *
 * Supported syntax:
 * - `{name}` — interpolation
 * - `{name, number}` / `number, percent` / `number, ::currency/USD` — via `Intl.NumberFormat`
 * - `{name, date, short|medium|long|full}` / `{name, time, …}` — via `Intl.DateTimeFormat`
 * - `{count, plural, offset:1 =0 {…} one {…} other {…}}` with `#` — via `Intl.PluralRules`
 * - `{rank, selectordinal, one {…} other {…}}` — ordinal plural rules
 * - `{gender, select, male {…} female {…} other {…}}`
 * - nested submessages inside plural/select branches
 *
 * Not supported (documented gaps): apostrophe escaping, `spellout`/`duration`,
 * full number/date skeletons. Unsupported argument types fall back to inserting
 * the raw value.
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

/** Map an ICU number style to `Intl.NumberFormat` options. */
function numberOptions(style: string | undefined): Intl.NumberFormatOptions {
  if (!style) return {};
  if (style === "percent") return { style: "percent" };
  if (style === "integer") return { maximumFractionDigits: 0 };
  const currency = /^::currency\/([A-Z]{3})$/.exec(style);
  if (currency) return { style: "currency", currency: currency[1] };
  return {};
}

/** Map an ICU date/time style to `Intl.DateTimeFormat` options. */
function dateOptions(type: string, style: string | undefined): Intl.DateTimeFormatOptions {
  const key = type === "time" ? "timeStyle" : "dateStyle";
  const s = (style || "medium") as "short" | "medium" | "long" | "full";
  return { [key]: s };
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
    out += renderArg(node, values, locale);
  }
  return out;
}

function renderArg(node: ArgNode, values: IcuValues, locale: string): string {
  const value = values[node.name];
  switch (node.type) {
    case undefined:
      return value == null ? `{${node.name}}` : String(value);
    case "number":
      return new Intl.NumberFormat(locale, numberOptions(node.style)).format(Number(value));
    case "date":
    case "time":
      return new Intl.DateTimeFormat(locale, dateOptions(node.type, node.style)).format(
        value instanceof Date ? value : new Date(value as string | number),
      );
    case "select": {
      const branch = node.options?.[String(value)] ?? node.options?.other ?? [];
      return render(branch, values, locale);
    }
    case "plural":
    case "selectordinal": {
      const n = Number(value);
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
  return render(ast, values, locale);
}
