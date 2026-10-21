// The helpers every denext.config field-group validator shares: the field-scoped `Fail`, the
// finite-number checks, and the small shape predicates.

/** Throws a field-scoped `invalid <name>: \`<field>\` <msg>` error. */
export type Fail = (field: string, msg: string) => never;

export interface NumOpts {
  int?: boolean;
  min?: number;
  max?: number;
}

/** Whether `v` is a finite number within the requested range / integer-ness. */
function isValidNumber(v: unknown, opts: NumOpts): boolean {
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  if (v < (opts.min ?? 0)) return false;
  if (opts.max !== undefined && v > opts.max) return false;
  if (opts.int && !Number.isInteger(v)) return false;
  return true;
}

/**
 * A `NaN`/`Infinity`/negative slips silently into HTTP headers (`max-age`),
 * redirect-loop bounds, and cache-eviction counts otherwise, so validate
 * finiteness/range at boot (present fields only; `undefined` keeps the default).
 */
export function num(fail: Fail, field: string, v: unknown, opts: NumOpts = {}): void {
  if (isValidNumber(v, opts)) return;
  const min = opts.min ?? 0;
  const range = opts.max !== undefined ? `${min}..${opts.max}` : `>= ${min}`;
  fail(field, `must be a finite ${opts.int ? "integer" : "number"} ${range}`);
}

/** Validate an array of numbers element-wise. */
export function numArray(fail: Fail, field: string, v: unknown, opts: NumOpts): void {
  if (!Array.isArray(v)) fail(field, "must be an array of numbers");
  else (v as unknown[]).forEach((el, i) => num(fail, `${field}[${i}]`, el, opts));
}

/** Whether `v` is a plain (non-array, non-null) object. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A value that must be one of `allowed` when set. */
export function oneOf(v: unknown, allowed: readonly string[], field: string, fail: Fail): void {
  if (v !== undefined && !allowed.includes(v as string)) {
    fail(field, `must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`);
  }
}

/** An optional project-relative path: a non-empty string when present. */
export function validateOptionalPath(field: string, value: unknown, fail: Fail): void {
  if (value !== undefined && (typeof value !== "string" || value === "")) {
    fail(field, "must be a non-empty path relative to the project root");
  }
}

/**
 * The problem with one network permission entry (`--allow-net`'s host syntax: `host`,
 * `host:port`, a bare `:port`, an IP, `[IPv6]`, `*.example.com`, `unix:<path>`, or `"*"`), else
 * `null`. Deno refuses a URL there, and a comma would split it into two entries.
 *
 * @param entry The entry.
 * @returns The message, or `null`.
 */
function netHostError(entry: string): string | null {
  if (entry === "" || /[\s,]/.test(entry)) {
    return `has ${JSON.stringify(entry)}: an entry is one host, without spaces or commas`;
  }
  if (entry.includes("://")) {
    return `has ${JSON.stringify(entry)}: a host (api.example.com, :3000), not a URL`;
  }
  return null;
}

/**
 * An object of permission kinds to value lists (`compile.permissions`,
 * `desktop.extraPermissions`): each key one of `kinds` holding a list `isList` accepts, and each
 * entry of a `netConnect` / `netListen` list a host (see {@linkcode netHostError}).
 *
 * @param field The config path, for the messages.
 * @param permissions The object.
 * @param kinds The kinds it takes.
 * @param isList Whether a value is an acceptable list.
 * @param fail The failure reporter.
 */
export function validatePermissionLists(
  field: string,
  permissions: Record<string, unknown>,
  kinds: readonly string[],
  isList: (v: unknown) => boolean,
  fail: Fail,
): void {
  for (const [k, v] of Object.entries(permissions)) {
    if (!kinds.includes(k) || !isList(v)) {
      fail(`${field}.${k}`, `must be an array of strings (kinds: ${kinds.join(", ")})`);
    }
    if (k !== "netConnect" && k !== "netListen") continue;
    const error = (v as string[]).map(netHostError).find((e) => e !== null);
    if (error) fail(`${field}.${k}`, error);
  }
}
