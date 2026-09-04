// A dependency-free `.gitignore` matcher — the exclusion engine behind the codebase indexer.
// It honors what the developer's git honors so `denext_query_codebase` & friends never index
// vendored code, build output, data dirs, or secrets in ignored paths.
//
// Supported (git's real semantics): `#` comments, blank lines, `\`-escaped leading `#`/`!`,
// trailing-space trimming, leading `!` negation, trailing `/` (directory-only), a leading or
// mid-pattern `/` (anchored to the `.gitignore`'s own directory), `**` (spanning path
// segments), `*` (within a segment), and `?`. Rules are evaluated last-match-wins; a later
// negation re-includes a path an earlier rule excluded. Nested `.gitignore` files are layered
// via `Ignorer.extend(dir, prefix)` as the walker descends, each anchored to its own dir.

/** One compiled ignore rule. Regexes match a path relative to the walk root (POSIX). */
interface Rule {
  /** Matches the pattern path itself or anything under it. */
  readonly self: RegExp;
  /** Matches only paths strictly *under* the pattern path (its directory contents). */
  readonly under: RegExp;
  /** A leading-`!` rule: a match re-includes the path. */
  readonly negated: boolean;
  /** A trailing-`/` rule: only matches directories (files still excluded when under one). */
  readonly dirOnly: boolean;
}

// ---------- pattern compilation ----------

/** Strip trailing whitespace unless it is backslash-escaped (git keeps `"\ "`). */
function trimTrailing(line: string): string {
  return /\\\s+$/.test(line) ? line : line.replace(/\s+$/, "");
}

/** Read the leading flags (`!` negation, `\` escape of `#`/`!`); return the remaining body. */
function stripFlags(raw: string): { body: string; negated: boolean } {
  if (raw.startsWith("!")) return { body: raw.slice(1), negated: true };
  if (raw.startsWith("\\#") || raw.startsWith("\\!")) return { body: raw.slice(1), negated: false };
  return { body: raw, negated: false };
}

/** Translate one gitignore glob body into a regex source (anchored by the caller). */
function globToRegex(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++; // consume the second star
      if (glob[i + 1] === "/") i++; // `**/` — zero or more leading segments
      re += "(?:.*/)?";
    } else if (c === "*") {
      re += "[^/]*"; // `*` — within a single segment
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return re;
}

/** Escape a literal path segment for embedding in a regex. */
function escapeLiteral(s: string): string {
  return s.replace(/[.*+^${}()|[\]\\?]/g, "\\$&");
}

/**
 * Compile one `.gitignore` line into a `Rule`, or `null` for comments/blanks. `base` is the
 * directory of the `.gitignore` relative to the walk root (POSIX, no trailing slash; `""` at
 * the root) so nested files anchor to their own directory.
 */
export function compileRule(line: string, base = ""): Rule | null {
  const trimmed = trimTrailing(line).replace(/^\s+/, "");
  if (trimmed === "" || trimmed.startsWith("#")) return null;

  const { body, negated } = stripFlags(trimmed);
  const dirOnly = body.endsWith("/");
  const core = dirOnly ? body.slice(0, -1) : body;

  // A `/` anywhere but the trailing position anchors the pattern to `base`; otherwise it may
  // match at any depth below `base`.
  const anchored = core.slice(0, -1).includes("/") || core.startsWith("/");
  const cleaned = core.startsWith("/") ? core.slice(1) : core;

  const root = base ? `${escapeLiteral(base)}/` : "";
  const depth = anchored ? "" : "(?:.*/)?";
  const src = `^${root}${depth}${globToRegex(cleaned)}`;
  const self = new RegExp(`${src}(?:/.*)?$`); // the path or anything under it
  const under = new RegExp(`${src}/.+$`); // strictly the directory's contents
  return { self, under, negated, dirOnly };
}

// ---------- the matcher ----------

/** An immutable set of gitignore rules; `extend` layers a child directory's `.gitignore`. */
export class Ignorer {
  private constructor(private readonly rules: readonly Rule[]) {}

  /** An ignorer with no rules (nothing ignored). */
  static empty(): Ignorer {
    return new Ignorer([]);
  }

  /** Build an ignorer from `.gitignore` text whose patterns anchor at `base` (default root). */
  static fromText(text: string, base = ""): Ignorer {
    return new Ignorer(compileRules(text, base));
  }

  /** True if `rel` (POSIX, relative to the walk root) is ignored — last matching rule wins. */
  ignores(rel: string, isDir: boolean): boolean {
    let ignored = false;
    for (const r of this.rules) {
      // A dir-only rule matches a directory (itself or under it) but only the *contents* of a
      // matched directory when the path is a file — never a file that merely shares the name.
      const hit = r.dirOnly ? (isDir ? r.self.test(rel) : r.under.test(rel)) : r.self.test(rel);
      if (hit) ignored = !r.negated;
    }
    return ignored;
  }

  /**
   * Return a child ignorer adding the rules from `<dir>/.gitignore` (if present), anchored to
   * `prefix` (that dir's path relative to the walk root, POSIX, no trailing slash). Returns
   * `this` unchanged when there is no nested `.gitignore`.
   */
  async extend(dir: string, prefix: string): Promise<Ignorer> {
    let text: string;
    try {
      text = await Deno.readTextFile(`${dir}/.gitignore`);
    } catch {
      return this;
    }
    const added = compileRules(text, prefix);
    return added.length ? new Ignorer([...this.rules, ...added]) : this;
  }
}

/** Compile every line of a `.gitignore`, anchoring each rule at `base`. */
function compileRules(text: string, base: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const rule = compileRule(line, base);
    if (rule) rules.push(rule);
  }
  return rules;
}
