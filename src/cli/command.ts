// The denext CLI command framework — a declarative subcommand + flag registry
// that replaces the hand-rolled `switch` + ad-hoc `Deno.args.includes(...)`
// scanning the CLI used through 1.x.
//
// A command declares its flags and positionals as data (so `--help`, "did you
// mean" suggestions, and shell completions are all derived, not hand-maintained),
// and the same {@linkcode CommandSpec} shape is what a plugin contributes through
// the plugin contract's `addCommand` seam — so first-party and plugin verbs share
// one parser, one help renderer, and one dispatch path.
//
// This module is deliberately dependency-free (no build/server imports) so it can
// be unit-tested in isolation and imported from the plugin surface without dragging
// the toolchain in. (`edit-distance` is a pure, zero-dependency leaf util.)

import { editDistance } from "../utils/edit-distance.ts";

/** The value kind a flag carries. A `boolean` flag is a bare presence switch. */
export type FlagType = "boolean" | "string" | "number";

/** A declarative flag on a {@linkcode CommandSpec} (or a global flag). */
export interface FlagSpec {
  /** Long name without the leading `--` (e.g. `"port"` for `--port`). */
  readonly name: string;
  /** Optional single-character alias without the leading `-` (e.g. `"p"`). */
  readonly alias?: string;
  /** Additional long names that resolve to this flag (e.g. `["hostname"]`). */
  readonly altNames?: readonly string[];
  /** Value kind. `boolean` flags take no value (presence = `true`). */
  readonly type: FlagType;
  /** Default applied when the flag is absent. */
  readonly default?: string | number | boolean;
  /** One-line help shown under `--help`. */
  readonly help: string;
  /** Value placeholder for help/usage of a valued flag (e.g. `"<port>"`). */
  readonly valueName?: string;
}

/** A declarative positional argument on a {@linkcode CommandSpec}. */
export interface PositionalSpec {
  /** Display name (e.g. `"dir"`). */
  readonly name: string;
  /** One-line help. */
  readonly help: string;
  /** Whether omitting it is an error. */
  readonly required?: boolean;
  /** Whether it soaks up all remaining positionals. */
  readonly variadic?: boolean;
}

/** Global flags recognized on every command, parsed out before command flags. */
export interface GlobalFlags {
  /** `--cwd <path>` — run as if invoked from this directory. */
  readonly cwd?: string;
  /** `--config <path>` — explicit deno/denext config path. */
  readonly config?: string;
  /** `--json` — machine-readable output where a command supports it. */
  readonly json: boolean;
  /** `--verbose` — extra diagnostic output. */
  readonly verbose: boolean;
  /** `--quiet` — suppress non-essential output. */
  readonly quiet: boolean;
}

/** The parsed invocation handed to a command's {@linkcode CommandSpec.run}. */
export interface CommandContext {
  /** Positional arguments in order (command name already stripped). */
  readonly positionals: string[];
  /** Resolved flag values keyed by long name (defaults applied). */
  readonly flags: Readonly<Record<string, string | number | boolean>>;
  /** Global flag values. */
  readonly global: GlobalFlags;
  /**
   * Pass-through tokens: everything after a literal `--`, plus (for a
   * {@linkcode CommandSpec.passthrough} command) any unrecognized flags. Forwarded
   * verbatim to an underlying subprocess by wrapping verbs (`test`, `lint`, …).
   */
  readonly rest: string[];
}

/** A first-class denext CLI verb. */
export interface CommandSpec {
  /** The verb (e.g. `"dev"`). */
  readonly name: string;
  /** One-line summary for the top-level help table. */
  readonly summary: string;
  /** Optional multi-line usage/detail shown under the command's own `--help`. */
  readonly usage?: string;
  /** Alternate names that dispatch to this command. */
  readonly aliases?: readonly string[];
  /** Declarative flags. */
  readonly flags?: readonly FlagSpec[];
  /** Declarative positionals (for help/usage; parsing collects all positionals). */
  readonly positionals?: readonly PositionalSpec[];
  /**
   * When true, this verb loads user modules and therefore needs `.env` loaded and
   * the CSS/module-resolution re-exec applied before {@linkcode run} (the 1.x
   * `MODULE_COMMANDS` gate, now declared per command).
   */
  readonly loadsModules?: boolean;
  /**
   * Override how the module gate (and env loading) derive the project directory.
   * Defaults to the first positional; a verb whose first positional is not the dir
   * (e.g. `desktop <action> [dir]`) supplies this. Only consulted when
   * {@linkcode loadsModules} is set.
   */
  readonly moduleDir?: (ctx: CommandContext) => string;
  /**
   * When true, unrecognized flags are collected into {@linkcode CommandContext.rest}
   * instead of erroring — for verbs that forward to a `deno` subcommand.
   */
  readonly passthrough?: boolean;
  /** Hide from the top-level help table (still runnable). */
  readonly hidden?: boolean;
  /** The command implementation. */
  run(ctx: CommandContext): void | Promise<void>;
}

/** The global flags every command accepts, as data (drives parsing + help). */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  {
    name: "cwd",
    type: "string",
    valueName: "<path>",
    help: "Run as if from this directory",
  },
  {
    name: "config",
    type: "string",
    valueName: "<path>",
    help: "Explicit config file path",
  },
  {
    name: "json",
    type: "boolean",
    help: "Machine-readable output where supported",
  },
  { name: "verbose", type: "boolean", help: "Extra diagnostic output" },
  { name: "quiet", type: "boolean", help: "Suppress non-essential output" },
];

/** The outcome of parsing an argv against the registry. */
export type ParseOutcome =
  | {
    readonly kind: "run";
    readonly command: CommandSpec;
    readonly ctx: CommandContext;
  }
  | { readonly kind: "help"; readonly command?: CommandSpec }
  | { readonly kind: "version" }
  | {
    readonly kind: "error";
    readonly message: string;
    readonly suggestion?: string;
  };

/** Coerce a raw string to a flag's declared type, or throw a usage error. */
function coerce(spec: FlagSpec, raw: string): string | number | boolean {
  if (spec.type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(`--${spec.name} expects a number, got "${raw}"`);
    }
    return n;
  }
  if (spec.type === "boolean") return raw !== "false" && raw !== "0";
  return raw;
}

/**
 * The closest name in `candidates` to `input` within a small edit-distance
 * threshold (scaled to the input length), or `undefined` when nothing is close —
 * powering "did you mean" hints for both unknown verbs and unknown flags.
 */
export function suggest(
  input: string,
  candidates: readonly string[],
): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  const threshold = Math.max(2, Math.floor(input.length / 2));
  for (const c of candidates) {
    const d = editDistance(input, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best !== undefined && bestDist <= threshold ? best : undefined;
}

/** A registry of commands with parsing, dispatch, and help rendering. */
export class CommandRegistry {
  readonly #byName = new Map<string, CommandSpec>();
  readonly #canonical: CommandSpec[] = [];

  /** Register a command (and its aliases). Throws on a name/alias collision. */
  register(spec: CommandSpec): void {
    const names = [spec.name, ...(spec.aliases ?? [])];
    for (const n of names) {
      if (this.#byName.has(n)) {
        throw new Error(`denext: duplicate CLI command name "${n}"`);
      }
      this.#byName.set(n, spec);
    }
    this.#canonical.push(spec);
  }

  /** Look up a command by name or alias. */
  get(name: string): CommandSpec | undefined {
    return this.#byName.get(name);
  }

  /** All registered commands (canonical, in registration order). */
  list(): readonly CommandSpec[] {
    return this.#canonical;
  }

  /** Every dispatchable name (for completions + suggestions). */
  names(): string[] {
    return [...this.#byName.keys()];
  }

  /**
   * Parse a full argv (as in `Deno.args`) into an actionable {@linkcode ParseOutcome}.
   * Resolves the leading verb, then parses the remainder against that command's flag
   * schema merged with {@linkcode GLOBAL_FLAGS}. `--help`/`-h` and `--version`/`-v`
   * are recognized before and after the verb.
   */
  parse(argv: string[]): ParseOutcome {
    const verb = argv.find((a) => !a.startsWith("-"));
    if (verb === undefined) return bareOutcome(argv);
    if (verb === "version") return { kind: "version" };
    // Everything after the verb token is the command's argv.
    const rest = argv.slice(argv.indexOf(verb) + 1);
    if (verb === "help") {
      const topic = rest.find((a) => !a.startsWith("-"));
      return { kind: "help", command: topic ? this.get(topic) : undefined };
    }
    const command = this.get(verb);
    if (!command) {
      const near = suggest(verb, this.names());
      return {
        kind: "error",
        message: `unknown command "${verb}"`,
        suggestion: near ? `denext ${near}` : undefined,
      };
    }
    return parseCommandArgv(command, rest);
  }

  /** Render the top-level help (verb table + global flags). */
  formatHelp(version: string): string {
    const rows = this.#canonical
      .filter((c) => !c.hidden)
      .map((c) => [`  denext ${c.name}`, c.summary] as const);
    const width = Math.max(...rows.map(([l]) => l.length));
    const table = rows.map(([l, s]) => `${l.padEnd(width + 3)}${s}`).join("\n");
    const globals = GLOBAL_FLAGS
      .map((f) =>
        `  --${f.name}${f.valueName ? " " + f.valueName : ""}`.padEnd(20) +
        f.help
      )
      .join("\n");
    return `denext ${version} — one power tool for all of React\n\n` +
      `Usage: denext <command> [options]\n\n` +
      `Commands:\n${table}\n\n` +
      `Global options:\n${globals}\n\n` +
      `Run \`denext <command> --help\` for command-specific options.`;
  }

  /** Render a single command's help (usage + flags + positionals). */
  formatCommandHelp(command: CommandSpec): string {
    const flags = [...(command.flags ?? []), ...GLOBAL_FLAGS];
    return [
      `denext ${command.name} — ${command.summary}`,
      ...section(command.usage ? [command.usage] : []),
      ...section(positionalsHelp(command), "Arguments:"),
      ...section(flagsHelp(flags), "Options:"),
    ].join("\n");
  }
}

/** A blank-line-separated help section (with an optional heading); nothing when empty. */
function section(lines: string[], heading?: string): string[] {
  if (lines.length === 0) return [];
  return heading ? ["", heading, ...lines] : ["", ...lines];
}

/** One help line per positional argument. */
function positionalsHelp(command: CommandSpec): string[] {
  return (command.positionals ?? []).map((p) =>
    `  ${p.name.padEnd(16)}${p.help}${p.required ? " (required)" : ""}`
  );
}

/** One help line per flag: `--name, -a <value>` padded, then its help text. */
function flagsHelp(flags: readonly FlagSpec[]): string[] {
  return flags.map((f) => {
    const label = `  --${f.name}${f.alias ? ", -" + f.alias : ""}` +
      (f.valueName ? " " + f.valueName : "");
    return `${label.padEnd(28)}${f.help}`;
  });
}

/** No verb at all: a bare `--version`/`-v` prints the version; anything else is help. */
function bareOutcome(argv: string[]): ParseOutcome {
  if (argv.includes("--version") || argv.includes("-v")) {
    return { kind: "version" };
  }
  return { kind: "help" };
}

/** A command's flag schema merged with the global flags, indexed by long name and alias. */
interface FlagIndex {
  merged: FlagSpec[];
  byLong: Map<string, FlagSpec>;
  byAlias: Map<string, FlagSpec>;
}

function indexFlags(command: CommandSpec): FlagIndex {
  const merged = [...(command.flags ?? []), ...GLOBAL_FLAGS];
  const byLong = new Map<string, FlagSpec>();
  for (const f of merged) {
    byLong.set(f.name, f);
    for (const alt of f.altNames ?? []) byLong.set(alt, f);
  }
  const byAlias = new Map(
    merged.filter((f) => f.alias).map((f) => [f.alias!, f]),
  );
  return { merged, byLong, byAlias };
}

/** The mutable result of a token walk. */
interface ParsedArgv {
  flags: Record<string, string | number | boolean>;
  positionals: string[];
  passthrough: string[];
}

/**
 * Parse a command's argv against its flag schema. `--help`/`-h` short-circuits to help;
 * an unknown flag is an error (or forwarded for a passthrough command); `--` forwards
 * everything after it.
 */
function parseCommandArgv(command: CommandSpec, rest: string[]): ParseOutcome {
  const index = indexFlags(command);
  const out: ParsedArgv = { flags: {}, positionals: [], passthrough: [] };
  try {
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (tok === "--") {
        out.passthrough.push(...rest.slice(i + 1));
        break;
      }
      if (tok === "--help" || tok === "-h") return { kind: "help", command };
      const consumed = parseToken(command, index, out, rest, i);
      if (typeof consumed !== "number") return consumed; // an error outcome
      i += consumed;
    }
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  // Apply declared defaults for absent flags.
  for (const f of index.merged) {
    if (f.default !== undefined && !(f.name in out.flags)) {
      out.flags[f.name] = f.default;
    }
  }
  return {
    kind: "run",
    command,
    ctx: {
      positionals: out.positionals,
      flags: out.flags,
      global: globalFlagsOf(out.flags),
      rest: out.passthrough,
    },
  };
}

/** One token: a long flag, a short flag, or a bare value. */
function parseToken(
  command: CommandSpec,
  index: FlagIndex,
  out: ParsedArgv,
  rest: string[],
  i: number,
): number | ParseOutcome {
  const tok = rest[i];
  if (tok.startsWith("--")) return parseLongFlag(command, index, out, rest, i);
  if (isShortFlag(tok)) return parseShortFlag(command, index, out, rest, i);
  return parseBare(command, out, tok);
}

/** `-x` (one dash, not a negative number). */
function isShortFlag(tok: string): boolean {
  return tok.length > 1 && tok[0] === "-" && !/^-\d/.test(tok);
}

/**
 * `--name[=value]`. Returns how many extra tokens were consumed (a separate value), or
 * an error outcome for an unknown flag on a non-passthrough command.
 */
function parseLongFlag(
  command: CommandSpec,
  index: FlagIndex,
  out: ParsedArgv,
  rest: string[],
  i: number,
): number | ParseOutcome {
  const tok = rest[i];
  const eq = tok.indexOf("=");
  const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
  const inline = eq >= 0 ? tok.slice(eq + 1) : undefined;
  const spec = index.byLong.get(name);
  if (!spec) {
    if (command.passthrough) {
      out.passthrough.push(tok);
      return 0;
    }
    const nearFlag = suggest(name, [...index.byLong.keys()]);
    return {
      kind: "error",
      message: `unknown flag "--${name}" for "${command.name}"`,
      suggestion: nearFlag ? `--${nearFlag}` : undefined,
    };
  }
  if (spec.type === "boolean") {
    out.flags[spec.name] = inline === undefined ? true : coerce(spec, inline);
    return 0;
  }
  const val = inline ?? rest[i + 1];
  if (val === undefined) throw new Error(`--${name} needs a value`);
  out.flags[spec.name] = coerce(spec, val);
  return inline === undefined ? 1 : 0;
}

/** `-a [value]`. Same contract as {@link parseLongFlag}. */
function parseShortFlag(
  command: CommandSpec,
  index: FlagIndex,
  out: ParsedArgv,
  rest: string[],
  i: number,
): number | ParseOutcome {
  const tok = rest[i];
  const alias = tok.slice(1);
  const spec = index.byAlias.get(alias);
  if (!spec) {
    if (command.passthrough) {
      out.passthrough.push(tok);
      return 0;
    }
    return {
      kind: "error",
      message: `unknown flag "-${alias}" for "${command.name}"`,
    };
  }
  if (spec.type === "boolean") {
    out.flags[spec.name] = true;
    return 0;
  }
  const val = rest[i + 1];
  if (val === undefined) throw new Error(`-${alias} needs a value`);
  out.flags[spec.name] = coerce(spec, val);
  return 1;
}

/**
 * A bare token. A forwarding verb (test/lint/fmt/…) keeps positionals in the SAME
 * ordered `rest` stream as unrecognized flags, so `--filter Auth` stays adjacent and in
 * order when forwarded (not split + reordered).
 */
function parseBare(command: CommandSpec, out: ParsedArgv, tok: string): number {
  (command.passthrough ? out.passthrough : out.positionals).push(tok);
  return 0;
}

/** The typed global flags read off the parsed flag record. */
function globalFlagsOf(
  flags: Record<string, string | number | boolean>,
): GlobalFlags {
  return {
    cwd: typeof flags.cwd === "string" ? flags.cwd : undefined,
    config: typeof flags.config === "string" ? flags.config : undefined,
    json: flags.json === true,
    verbose: flags.verbose === true,
    quiet: flags.quiet === true,
  };
}
