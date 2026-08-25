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
// the toolchain in.

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
  { name: "cwd", type: "string", valueName: "<path>", help: "Run as if from this directory" },
  { name: "config", type: "string", valueName: "<path>", help: "Explicit config file path" },
  { name: "json", type: "boolean", help: "Machine-readable output where supported" },
  { name: "verbose", type: "boolean", help: "Extra diagnostic output" },
  { name: "quiet", type: "boolean", help: "Suppress non-essential output" },
];

/** The outcome of parsing an argv against the registry. */
export type ParseOutcome =
  | { readonly kind: "run"; readonly command: CommandSpec; readonly ctx: CommandContext }
  | { readonly kind: "help"; readonly command?: CommandSpec }
  | { readonly kind: "version" }
  | { readonly kind: "error"; readonly message: string; readonly suggestion?: string };

/** Coerce a raw string to a flag's declared type, or throw a usage error. */
function coerce(spec: FlagSpec, raw: string): string | number | boolean {
  if (spec.type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`--${spec.name} expects a number, got "${raw}"`);
    return n;
  }
  if (spec.type === "boolean") return raw !== "false" && raw !== "0";
  return raw;
}

/** Levenshtein edit distance (small inputs — verb/flag names). */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/**
 * The closest name in `candidates` to `input` within a small edit-distance
 * threshold (scaled to the input length), or `undefined` when nothing is close —
 * powering "did you mean" hints for both unknown verbs and unknown flags.
 */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
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
      if (this.#byName.has(n)) throw new Error(`denext: duplicate CLI command name "${n}"`);
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
    // A bare `--version`/`-v` (or as the verb) prints the version.
    const first = argv.find((a) => !a.startsWith("-")) ?? undefined;
    if (first === undefined) {
      if (argv.includes("--version") || argv.includes("-v")) return { kind: "version" };
      return { kind: "help" };
    }
    if (first === "version") return { kind: "version" };
    if (first === "help") {
      const topic = argv.slice(argv.indexOf(first) + 1).find((a) => !a.startsWith("-"));
      const cmd = topic ? this.get(topic) : undefined;
      return { kind: "help", command: cmd };
    }

    const command = this.get(first);
    if (!command) {
      const near = suggest(first, this.names());
      return {
        kind: "error",
        message: `unknown command "${first}"`,
        suggestion: near ? `denext ${near}` : undefined,
      };
    }

    // Everything after the verb token is the command's argv.
    const rest = argv.slice(argv.indexOf(first) + 1);
    const merged = [...(command.flags ?? []), ...GLOBAL_FLAGS];
    const byLong = new Map<string, FlagSpec>();
    for (const f of merged) {
      byLong.set(f.name, f);
      for (const alt of f.altNames ?? []) byLong.set(alt, f);
    }
    const byAlias = new Map(merged.filter((f) => f.alias).map((f) => [f.alias!, f]));

    const flags: Record<string, string | number | boolean> = {};
    const positionals: string[] = [];
    const passthrough: string[] = [];
    let sawDashDash = false;

    try {
      for (let i = 0; i < rest.length; i++) {
        const tok = rest[i];
        if (sawDashDash) {
          passthrough.push(tok);
          continue;
        }
        if (tok === "--") {
          sawDashDash = true;
          continue;
        }
        if (tok === "--help" || tok === "-h") return { kind: "help", command };

        if (tok.startsWith("--")) {
          const eq = tok.indexOf("=");
          const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
          const inline = eq >= 0 ? tok.slice(eq + 1) : undefined;
          const spec = byLong.get(name);
          if (!spec) {
            if (command.passthrough) {
              passthrough.push(tok);
              continue;
            }
            const nearFlag = suggest(name, [...byLong.keys()]);
            return {
              kind: "error",
              message: `unknown flag "--${name}" for "${command.name}"`,
              suggestion: nearFlag ? `--${nearFlag}` : undefined,
            };
          }
          if (spec.type === "boolean") {
            flags[spec.name] = inline === undefined ? true : coerce(spec, inline);
          } else {
            const val = inline ?? rest[++i];
            if (val === undefined) throw new Error(`--${name} needs a value`);
            flags[spec.name] = coerce(spec, val);
          }
        } else if (tok.length > 1 && tok[0] === "-" && !/^-\d/.test(tok)) {
          const alias = tok.slice(1);
          const spec = byAlias.get(alias);
          if (!spec) {
            if (command.passthrough) {
              passthrough.push(tok);
              continue;
            }
            return {
              kind: "error",
              message: `unknown flag "-${alias}" for "${command.name}"`,
            };
          }
          if (spec.type === "boolean") {
            flags[spec.name] = true;
          } else {
            const val = rest[++i];
            if (val === undefined) throw new Error(`-${alias} needs a value`);
            flags[spec.name] = coerce(spec, val);
          }
        } else {
          positionals.push(tok);
        }
      }
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }

    // Apply declared defaults for absent flags.
    for (const f of merged) {
      if (f.default !== undefined && !(f.name in flags)) flags[f.name] = f.default;
    }

    const global: GlobalFlags = {
      cwd: typeof flags.cwd === "string" ? flags.cwd : undefined,
      config: typeof flags.config === "string" ? flags.config : undefined,
      json: flags.json === true,
      verbose: flags.verbose === true,
      quiet: flags.quiet === true,
    };

    return {
      kind: "run",
      command,
      ctx: { positionals, flags, global, rest: passthrough },
    };
  }

  /** Render the top-level help (verb table + global flags). */
  formatHelp(version: string): string {
    const rows = this.#canonical
      .filter((c) => !c.hidden)
      .map((c) => [`  denext ${c.name}`, c.summary] as const);
    const width = Math.max(...rows.map(([l]) => l.length));
    const table = rows.map(([l, s]) => `${l.padEnd(width + 3)}${s}`).join("\n");
    const globals = GLOBAL_FLAGS
      .map((f) => `  --${f.name}${f.valueName ? " " + f.valueName : ""}`.padEnd(20) + f.help)
      .join("\n");
    return `denext ${version} — one power tool for all of React\n\n` +
      `Usage: denext <command> [options]\n\n` +
      `Commands:\n${table}\n\n` +
      `Global options:\n${globals}\n\n` +
      `Run \`denext <command> --help\` for command-specific options.`;
  }

  /** Render a single command's help (usage + flags + positionals). */
  formatCommandHelp(command: CommandSpec): string {
    const parts: string[] = [`denext ${command.name} — ${command.summary}`];
    if (command.usage) parts.push("", command.usage);
    if (command.positionals?.length) {
      parts.push("", "Arguments:");
      for (const p of command.positionals) {
        parts.push(`  ${p.name.padEnd(16)}${p.help}${p.required ? " (required)" : ""}`);
      }
    }
    const flags = [...(command.flags ?? []), ...GLOBAL_FLAGS];
    if (flags.length) {
      parts.push("", "Options:");
      for (const f of flags) {
        const label = `  --${f.name}${f.alias ? ", -" + f.alias : ""}` +
          (f.valueName ? " " + f.valueName : "");
        parts.push(`${label.padEnd(28)}${f.help}`);
      }
    }
    return parts.join("\n");
  }
}
