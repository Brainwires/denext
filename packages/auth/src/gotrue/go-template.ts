/**
 * The Go `html/template` subset Supabase Auth's mail templates are written in, so a
 * `GOTRUE_MAILER_TEMPLATES_*` template renders here as GoTrue renders it: `{{ .Field }}` and
 * `{{ .Data.key }}` lookups, `if` / `else if` / `else`, `with` / `else with`, `range` (with
 * `$i, $v :=`, `else`, `break` and `continue`), variables (`$x := …`, `$x = …`, `$`), pipes,
 * parenthesized calls, `{{- … -}}` trim markers and comments (`{{/* … *\/}}`), and the builtin
 * functions `and`, `or`, `not`, `len`, `index`, `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `print`,
 * `printf`, `println`, `html` and `urlquery`. Every value written out is HTML-escaped. A map key
 * that is absent reads as nil (empty output), as Go does for GoTrue's `map[string]any` data.
 *
 * What it does not take — `define` / `template` / `block`, method calls, `call`, `slice`,
 * `js`, printf widths — is a {@linkcode GoTemplateError}; the caller falls back to the
 * built-in template.
 *
 * @module
 */

/** A template that can't be parsed or executed. */
export class GoTemplateError extends Error {}

// ---- Tokens ---------------------------------------------------------------------------------

type Tok =
  | { k: "field"; path: string[]; sp: boolean }
  | { k: "var"; name: string; path: string[]; sp: boolean }
  | { k: "dot"; sp: boolean }
  | { k: "lit"; value: unknown; sp: boolean }
  | { k: "ident"; name: string; sp: boolean }
  | { k: "punct"; v: "(" | ")" | "|" | ":=" | "=" | ","; sp: boolean };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
const FIELDS = /^(?:\.[A-Za-z_][A-Za-z0-9_]*)+/;
const NUMBER = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;

/** Split `.a.b` into `["a", "b"]`. */
function pathOf(text: string): string[] {
  return text.split(".").slice(1);
}

/** Read a quoted string literal at `src[i]`; returns the value and the index after it. */
function readString(src: string, i: number): [string, number] {
  const q = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== q) j += q === '"' && src[j] === "\\" ? 2 : 1;
  if (j >= src.length) throw new GoTemplateError("unterminated quoted string");
  const body = src.slice(i + 1, j);
  if (q === "`") return [body, j + 1];
  try {
    return [JSON.parse(`"${body}"`) as string, j + 1];
  } catch {
    throw new GoTemplateError(`bad string literal ${src.slice(i, j + 1)}`);
  }
}

/** The literal words. */
const WORDS: Record<string, unknown> = { true: true, false: false, nil: null };

/** A `$var` token (with any field chain) at the start of `rest`. */
function readVar(rest: string, sp: boolean): [Tok, number] {
  const name = /^\$[A-Za-z0-9_]*/.exec(rest)![0];
  const more = FIELDS.exec(rest.slice(name.length))?.[0] ?? "";
  return [{ k: "var", name, path: pathOf(more), sp }, name.length + more.length];
}

/** A number, a word (`true` / `false` / `nil`, or a function name) at the start of `rest`. */
function readWord(rest: string, sp: boolean): [Tok, number] {
  const num = NUMBER.exec(rest);
  if (num) return [{ k: "lit", value: Number(num[0]), sp }, num[0].length];
  const word = IDENT.exec(rest)?.[0];
  if (!word) throw new GoTemplateError(`unexpected "${rest[0]}" in action`);
  const tok: Tok = Object.hasOwn(WORDS, word)
    ? { k: "lit", value: WORDS[word], sp }
    : { k: "ident", name: word, sp };
  return [tok, word.length];
}

/** One token of an action's text at `src[i]`. */
function readToken(src: string, i: number, sp: boolean): [Tok, number] {
  const rest = src.slice(i);
  const c = src[i];
  if (c === '"' || c === "`") {
    const [value, end] = readString(src, i);
    return [{ k: "lit", value, sp }, end];
  }
  if (rest.startsWith(":=")) return [{ k: "punct", v: ":=", sp }, i + 2];
  if ("()|=,".includes(c)) return [{ k: "punct", v: c as "(", sp }, i + 1];
  const fields = FIELDS.exec(rest);
  if (fields) return [{ k: "field", path: pathOf(fields[0]), sp }, i + fields[0].length];
  if (c === ".") return [{ k: "dot", sp }, i + 1];
  const [tok, len] = c === "$" ? readVar(rest, sp) : readWord(rest, sp);
  return [tok, i + len];
}

/** Tokenize an action's inner text. */
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let sp = true;
  while (i < src.length) {
    if (/\s/.test(src[i])) {
      sp = true;
      i++;
      continue;
    }
    const [tok, end] = readToken(src, i, sp);
    out.push(tok);
    i = end;
    sp = false;
  }
  return out;
}

// ---- Splitting text and actions -------------------------------------------------------------

type Piece = { text: string } | { action: string };

/** The index of the `}}` that closes the action opened before `from` (quotes skipped). */
function closeOf(src: string, from: number): number {
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "`") i = readString(src, i)[1] - 1;
    else if (c === "}" && src[i + 1] === "}") return i;
  }
  throw new GoTemplateError("unclosed action");
}

/** Split a template into text and action pieces, applying the `{{-` / `-}}` trim markers. */
function split(src: string): Piece[] {
  const out: Piece[] = [];
  let i = 0;
  let trimNext = false;
  while (i <= src.length) {
    const open = src.indexOf("{{", i);
    let text = src.slice(i, open < 0 ? src.length : open);
    if (trimNext) text = text.replace(/^\s+/, "");
    if (open < 0) {
      out.push({ text });
      break;
    }
    let start = open + 2;
    if (src[start] === "-" && /\s/.test(src[start + 1] ?? "")) {
      text = text.replace(/\s+$/, "");
      start++;
    }
    out.push({ text });
    const close = closeOf(src, start);
    let inner = src.slice(start, close);
    trimNext = /\s-$/.test(inner);
    if (trimNext) inner = inner.slice(0, -1);
    out.push({ action: inner.trim() });
    i = close + 2;
  }
  return out;
}

// ---- Parse tree -----------------------------------------------------------------------------

type Arg =
  | { k: "field"; path: string[] }
  | { k: "var"; name: string; path: string[] }
  | { k: "dot" }
  | { k: "lit"; value: unknown }
  | { k: "fn"; name: string }
  | { k: "sub"; pipe: Pipe; path: string[] };

interface Pipe {
  /** Declared (`:=`) or assigned (`=`) variables. */
  vars: string[];
  assign: boolean;
  cmds: Arg[][];
}

type Node =
  | { t: "text"; text: string }
  | { t: "out"; pipe: Pipe }
  | { t: "if" | "with"; pipe: Pipe; body: Node[]; alt: Node[] }
  | { t: "range"; pipe: Pipe; body: Node[]; alt: Node[] }
  | { t: "break" | "continue" };

/** A cursor over one action's tokens. */
class Toks {
  i = 0;
  constructor(readonly list: Tok[]) {}
  peek(): Tok | undefined {
    return this.list[this.i];
  }
  next(): Tok | undefined {
    return this.list[this.i++];
  }
  isPunct(v: string): boolean {
    const t = this.peek();
    return t?.k === "punct" && t.v === v;
  }
}

/** One operand (a parenthesized pipeline may be followed by a field chain). */
function parseArg(ts: Toks): Arg {
  const t = ts.next()!;
  if (t.k === "ident") return { k: "fn", name: t.name };
  if (t.k !== "punct") return t; // a field, variable, dot or literal is its own operand
  if (t.v !== "(") throw new GoTemplateError(`unexpected "${t.v}" in operand`);
  const pipe = parsePipe(ts, true);
  if (!ts.isPunct(")")) throw new GoTemplateError("unclosed left paren");
  ts.next();
  const after = ts.peek();
  const path = after?.k === "field" && !after.sp ? (ts.next(), after.path) : [];
  return { k: "sub", pipe, path };
}

/** The variable declaration (`$a, $b :=` / `$a =`) a pipeline starts with, if any. */
function parseDecl(ts: Toks): Pick<Pipe, "vars" | "assign"> {
  const start = ts.i;
  const vars: string[] = [];
  while (ts.peek()?.k === "var") {
    const v = ts.next() as Extract<Tok, { k: "var" }>;
    if (v.path.length) break;
    vars.push(v.name);
    if (ts.isPunct(",")) {
      ts.next();
      continue;
    }
    if (ts.isPunct(":=") || ts.isPunct("=")) {
      const assign = (ts.next() as { v: string }).v === "=";
      return { vars, assign };
    }
    break;
  }
  ts.i = start;
  return { vars: [], assign: false };
}

/** A pipeline: an optional declaration, then commands joined by `|`. */
function parsePipe(ts: Toks, inSub = false): Pipe {
  const decl = parseDecl(ts);
  const cmds: Arg[][] = [];
  let cmd: Arg[] = [];
  while (ts.peek() && !(inSub && ts.isPunct(")"))) {
    if (ts.isPunct("|")) {
      ts.next();
      if (!cmd.length) throw new GoTemplateError("missing command before |");
      cmds.push(cmd);
      cmd = [];
      continue;
    }
    cmd.push(parseArg(ts));
  }
  if (!cmd.length) throw new GoTemplateError("missing value in pipeline");
  cmds.push(cmd);
  return { ...decl, cmds };
}

/** Parse an action's text as a pipeline. */
function pipeOf(text: string): Pipe {
  const ts = new Toks(tokenize(text));
  const pipe = parsePipe(ts);
  if (ts.peek()) throw new GoTemplateError(`unexpected token in "${text}"`);
  return pipe;
}

/** What ended a list of nodes: the end of input, `end`, or an `else …` action. */
type Stop = { k: "eof" } | { k: "end" } | { k: "else"; rest: string };

/** The control keyword an action starts with, and the rest of it. */
function keywordOf(action: string): [string, string] {
  const m = /^(if|else|end|range|with|break|continue|define|template|block)\b\s*([\s\S]*)$/
    .exec(action);
  return m ? [m[1], m[2]] : ["", action];
}

/** The parser over a template's pieces. */
class Parser {
  i = 0;
  constructor(readonly pieces: Piece[]) {}

  /** Nodes up to the next `end` / `else` (or the end of input). */
  list(loops: number): [Node[], Stop] {
    const out: Node[] = [];
    while (this.i < this.pieces.length) {
      const p = this.pieces[this.i++];
      if ("text" in p) {
        if (p.text) out.push({ t: "text", text: p.text });
        continue;
      }
      if (p.action.startsWith("/*")) {
        if (!p.action.endsWith("*/")) throw new GoTemplateError("unclosed comment");
        continue;
      }
      const [kw, rest] = keywordOf(p.action);
      if (kw === "end") return [out, { k: "end" }];
      if (kw === "else") return [out, { k: "else", rest }];
      out.push(this.node(kw, rest, loops));
    }
    return [out, { k: "eof" }];
  }

  /** One action node. */
  node(kw: string, rest: string, loops: number): Node {
    switch (kw) {
      case "":
        return { t: "out", pipe: pipeOf(rest) };
      case "if":
      case "with":
        return this.branch(kw, rest, loops);
      case "range":
        return this.range(rest, loops);
      case "break":
      case "continue":
        if (!loops || rest) throw new GoTemplateError(`{{${kw}}} outside {{range}}`);
        return { t: kw };
    }
    throw new GoTemplateError(`{{${kw}}} is not supported in mail templates`);
  }

  /** `if` / `with`, with an `else`, or a chained `else if` / `else with`. */
  branch(t: "if" | "with", rest: string, loops: number): Node {
    const pipe = pipeOf(rest);
    const [body, stop] = this.list(loops);
    return { t, pipe, body, alt: this.alt(t, stop, loops) };
  }

  /** The `else` part of a control structure (empty when it has none). */
  alt(t: "if" | "with" | "range", stop: Stop, loops: number): Node[] {
    if (stop.k === "eof") throw new GoTemplateError(`unexpected EOF in {{${t}}}`);
    if (stop.k === "end") return [];
    const [kw, rest] = keywordOf(stop.rest);
    if (kw === t && t !== "range") return [this.branch(t, rest, loops)];
    if (stop.rest) throw new GoTemplateError(`unexpected "${stop.rest}" after else`);
    const [alt, end] = this.list(loops);
    if (end.k !== "end") throw new GoTemplateError(`expected {{end}} in {{${t}}}`);
    return alt;
  }

  /** `range`. */
  range(rest: string, loops: number): Node {
    const pipe = pipeOf(rest);
    if (pipe.vars.length > 2) throw new GoTemplateError("too many range variables");
    const [body, stop] = this.list(loops + 1);
    return { t: "range", pipe, body, alt: this.alt("range", stop, loops) };
  }
}

/** Parse a template. */
function parse(src: string): Node[] {
  const parser = new Parser(split(src));
  const [nodes, stop] = parser.list(0);
  if (stop.k !== "eof") throw new GoTemplateError(`unexpected {{${stop.k}}}`);
  return nodes;
}

// ---- Values ---------------------------------------------------------------------------------

/** A plain object (Go's map). */
function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Go's truth: false, 0, "", nil and empty collections are false. */
function truth(v: unknown): boolean {
  if (v == null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isMap(v)) return Object.keys(v).length > 0;
  return true;
}

/** A float64 as Go's `%v` prints it (`%g`, shortest, exponent from 1e+06 / below 1e-04). */
function goFloat(n: number): string {
  if (!Number.isFinite(n)) return Number.isNaN(n) ? "NaN" : n > 0 ? "+Inf" : "-Inf";
  if (n === 0) return Object.is(n, -0) ? "-0" : "0";
  const [mant, e] = n.toExponential().split("e");
  const exp = Number(e);
  if (exp >= -4 && exp < 6) return String(n);
  return `${mant}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/** A value as Go's `fmt.Sprint` prints it (nil prints empty, as html/template does). */
function show(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return goFloat(v);
  if (Array.isArray(v)) return `[${v.map(show).join(" ")}]`;
  if (isMap(v)) {
    return `map[${Object.keys(v).sort().map((k) => `${k}:${show(v[k])}`).join(" ")}]`;
  }
  return String(v);
}

/** Look `path` up from `v`: a missing map key is nil; a field of a non-map is an error. */
function walk(v: unknown, path: string[]): unknown {
  for (const name of path) {
    if (v == null) return undefined;
    if (!isMap(v)) throw new GoTemplateError(`can't evaluate field ${name} in ${typeof v}`);
    v = Object.hasOwn(v, name) ? v[name] : undefined;
  }
  return v;
}

/** Go's comparable basic kinds. */
function basic(v: unknown): boolean {
  return v == null || ["string", "number", "boolean"].includes(typeof v);
}

/** `eq a b c…`: whether `a` equals any of the rest. */
function eq(a: unknown, ...rest: unknown[]): boolean {
  if (!rest.length) throw new GoTemplateError("missing argument for comparison");
  for (const b of rest) {
    if (!basic(a) || !basic(b)) throw new GoTemplateError("non-comparable types");
    if ((a ?? null) === (b ?? null)) return true;
  }
  return false;
}

/** `lt a b`, for two numbers or two strings. */
function lt(a: unknown, b: unknown): boolean {
  const ok = (typeof a === "number" && typeof b === "number") ||
    (typeof a === "string" && typeof b === "string");
  if (!ok) throw new GoTemplateError("incompatible types for comparison");
  return (a as number) < (b as number);
}

/** `len x`: a string's UTF-8 byte count, a list's or map's size. */
function len(v: unknown): number {
  if (typeof v === "string") return new TextEncoder().encode(v).length;
  if (Array.isArray(v)) return v.length;
  if (isMap(v)) return Object.keys(v).length;
  throw new GoTemplateError(`len of ${v === null ? "nil" : typeof v}`);
}

/** One `index` step into a list. */
function indexList(v: unknown[], k: number): unknown {
  if (Number.isInteger(k) && k >= 0 && k < v.length) return v[k];
  throw new GoTemplateError(`index out of range: ${k}`);
}

/** One step of `index`: a list by position, a map by key. */
function indexOne(v: unknown, k: unknown): unknown {
  if (Array.isArray(v) && typeof k === "number") return indexList(v, k);
  if (isMap(v) && typeof k === "string") return Object.hasOwn(v, k) ? v[k] : undefined;
  throw new GoTemplateError(v == null ? "index of untyped nil" : "can't index item");
}

/** `index x k…`. */
function index(v: unknown, ...keys: unknown[]): unknown {
  return keys.reduce(indexOne, v);
}

/** `fmt.Sprint`: a space between operands when neither is a string. */
function sprint(args: unknown[]): string {
  let out = "";
  args.forEach((a, i) => {
    if (i > 0 && typeof a !== "string" && typeof args[i - 1] !== "string") out += " ";
    out += show(a);
  });
  return out;
}

/** One `printf` verb applied to `arg`. */
function verb(v: string, arg: unknown): string {
  switch (v) {
    case "v":
    case "s":
      return show(arg);
    case "d":
      return typeof arg === "number" && Number.isInteger(arg) ? String(arg) : `%!d(${show(arg)})`;
    case "q":
      return JSON.stringify(show(arg));
    case "t":
      return typeof arg === "boolean" ? String(arg) : `%!t(${show(arg)})`;
  }
  throw new GoTemplateError(`printf verb %${v} is not supported`);
}

/** `fmt.Sprintf` with `%v %s %d %q %t %%`. */
function sprintf(format: unknown, ...args: unknown[]): string {
  if (typeof format !== "string") throw new GoTemplateError("printf format must be a string");
  let n = 0;
  const out = format.replace(/%(.)/g, (_, v: string) => {
    if (v === "%") return "%";
    return n < args.length ? verb(v, args[n++]) : `%!${v}(MISSING)`;
  });
  return n < args.length ? `${out}%!(EXTRA ${args.slice(n).map(show).join(", ")})` : out;
}

/** Go's `url.QueryEscape`. */
function urlquery(...args: unknown[]): string {
  return encodeURIComponent(sprint(args)).replace(/%20/g, "+")
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Two-argument helper: Go's comparisons take exactly two operands. */
function two(name: string, f: (a: unknown, b: unknown) => boolean) {
  return (...a: unknown[]) => {
    if (a.length !== 2) throw new GoTemplateError(`wrong number of args for ${name}`);
    return f(a[0], a[1]);
  };
}

/** The builtin functions, `and` / `or` aside (they short-circuit; see {@linkcode Exec}). */
const FUNCS: Record<string, (...args: unknown[]) => unknown> = {
  not: (...a) => {
    if (a.length !== 1) throw new GoTemplateError("wrong number of args for not");
    return !truth(a[0]);
  },
  len: (...a) => {
    if (a.length !== 1) throw new GoTemplateError("wrong number of args for len");
    return len(a[0]);
  },
  index: (v, ...k) => index(v, ...k),
  eq,
  ne: two("ne", (a, b) => !eq(a, b)),
  lt: two("lt", lt),
  le: two("le", (a, b) => lt(a, b) || eq(a, b)),
  gt: two("gt", (a, b) => !lt(a, b) && !eq(a, b)),
  ge: two("ge", (a, b) => !lt(a, b)),
  print: (...a) => sprint(a),
  println: (...a) => `${a.map(show).join(" ")}\n`,
  printf: sprintf,
  // The output is HTML-escaped once anyway: html/template drops a redundant `html`.
  html: (...a) => sprint(a),
  urlquery,
};

// ---- Execution ------------------------------------------------------------------------------

/** `break` / `continue` unwinding a `range` body. */
class LoopSignal {
  constructor(readonly kind: "break" | "continue") {}
}

/** One run of a template over its data. */
class Exec {
  out = "";
  vars: [string, unknown][];
  constructor(readonly escape: (s: string) => string, root: unknown) {
    this.vars = [["$", root]];
  }

  /** A variable's value. */
  lookup(name: string): unknown {
    for (let i = this.vars.length - 1; i >= 0; i--) {
      if (this.vars[i][0] === name) return this.vars[i][1];
    }
    throw new GoTemplateError(`undefined variable: ${name}`);
  }

  /** Set an existing variable (`$x = …`). */
  assign(name: string, value: unknown): void {
    for (let i = this.vars.length - 1; i >= 0; i--) {
      if (this.vars[i][0] === name) {
        this.vars[i][1] = value;
        return;
      }
    }
    throw new GoTemplateError(`undefined variable: ${name}`);
  }

  /** One operand's value (a function name here is a call with no arguments). */
  arg(a: Arg, dot: unknown): unknown {
    switch (a.k) {
      case "field":
        return walk(dot, a.path);
      case "var":
        return walk(this.lookup(a.name), a.path);
      case "dot":
        return dot;
      case "lit":
        return a.value;
      case "fn":
        return this.call(a.name, [], dot, []);
      case "sub":
        return walk(this.pipe(a.pipe, dot), a.path);
    }
  }

  /** Call a builtin; `piped` is the previous command's value (passed last). */
  call(name: string, args: Arg[], dot: unknown, piped: unknown[]): unknown {
    if (name === "and" || name === "or") {
      const all: (() => unknown)[] = [
        ...args.map((a) => () => this.arg(a, dot)),
        ...piped.map((v) => () => v),
      ];
      if (!all.length) throw new GoTemplateError(`wrong number of args for ${name}`);
      let v: unknown;
      for (const get of all) {
        v = get();
        if (truth(v) !== (name === "and")) return v;
      }
      return v;
    }
    const fn = FUNCS[name];
    if (!fn) throw new GoTemplateError(`function "${name}" not defined`);
    return fn(...args.map((a) => this.arg(a, dot)), ...piped);
  }

  /** One command of a pipeline. */
  cmd(cmd: Arg[], dot: unknown, piped: unknown[]): unknown {
    const [head, ...rest] = cmd;
    if (head.k === "fn") return this.call(head.name, rest, dot, piped);
    if (rest.length || piped.length) {
      throw new GoTemplateError("can't give an argument to a non-function");
    }
    return this.arg(head, dot);
  }

  /** A pipeline's value, binding its variables. */
  pipe(p: Pipe, dot: unknown): unknown {
    let v: unknown;
    p.cmds.forEach((c, i) => {
      v = this.cmd(c, dot, i ? [v] : []);
    });
    for (const name of p.vars) {
      if (p.assign) this.assign(name, v);
      else this.vars.push([name, v]);
    }
    return v;
  }

  /** Run `nodes` with `dot`, dropping the variables they declare afterwards. */
  block(nodes: Node[], dot: unknown): void {
    const mark = this.vars.length;
    try {
      for (const n of nodes) this.node(n, dot);
    } finally {
      this.vars.length = mark;
    }
  }

  node(n: Node, dot: unknown): void {
    switch (n.t) {
      case "text":
        this.out += n.text;
        return;
      case "out": {
        const v = this.pipe(n.pipe, dot);
        if (!n.pipe.vars.length) this.out += this.escape(show(v));
        return;
      }
      case "break":
      case "continue":
        throw new LoopSignal(n.t);
      case "range":
        return this.range(n, dot);
    }
    this.branch(n, dot);
  }

  /** `if` / `with`. */
  branch(n: Extract<Node, { t: "if" | "with" }>, dot: unknown): void {
    const mark = this.vars.length;
    try {
      const v = this.pipe(n.pipe, dot);
      if (truth(v)) this.block(n.body, n.t === "with" ? v : dot);
      else this.block(n.alt, dot);
    } finally {
      this.vars.length = mark;
    }
  }

  /** `range` over a list, or a map in key order; nil ranges over nothing. */
  range(n: Extract<Node, { t: "range" }>, dot: unknown): void {
    const mark = this.vars.length;
    try {
      const { vars, cmds } = n.pipe;
      const v = this.pipe({ vars: [], assign: false, cmds }, dot);
      const entries: [unknown, unknown][] = Array.isArray(v)
        ? v.map((x, i) => [i, x])
        : isMap(v)
        ? Object.keys(v).sort().map((k) => [k, v[k]])
        : v == null
        ? []
        : (() => {
          throw new GoTemplateError(`range can't iterate over ${show(v)}`);
        })();
      if (!entries.length) return this.block(n.alt, dot);
      for (const [k, x] of entries) {
        if (this.iteration(n.body, vars, k, x) === "break") break;
      }
    } finally {
      this.vars.length = mark;
    }
  }

  /** One `range` iteration; returns `"break"` when the body broke out. */
  iteration(body: Node[], vars: string[], k: unknown, x: unknown): "break" | undefined {
    const mark = this.vars.length;
    if (vars.length === 1) this.vars.push([vars[0], x]);
    if (vars.length === 2) this.vars.push([vars[0], k], [vars[1], x]);
    try {
      this.block(body, x);
    } catch (e) {
      if (!(e instanceof LoopSignal)) throw e;
      if (e.kind === "break") return "break";
    } finally {
      this.vars.length = mark;
    }
    return undefined;
  }
}

/**
 * Parse and run a Go template over `data`, HTML-escaping every value it writes out.
 *
 * @param template The template text.
 * @param data The root data (`.` and `$`).
 * @param escape How a written value is escaped.
 * @returns The rendered text.
 * @throws {GoTemplateError} When the template can't be parsed or executed.
 */
export function executeGoTemplate(
  template: string,
  data: Record<string, unknown>,
  escape: (s: string) => string,
): string {
  const nodes = parse(template);
  const run = new Exec(escape, data);
  try {
    run.block(nodes, data);
  } catch (e) {
    if (e instanceof LoopSignal) throw new GoTemplateError(`{{${e.kind}}} outside {{range}}`);
    throw e;
  }
  return run.out;
}
