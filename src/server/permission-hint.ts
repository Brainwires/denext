// What to do when the server is refused a permission its `start` task does not grant.
//
// `denext create` and `denext migrate` write a least-privilege `start` task (net, read, env,
// write to `.denext`, and for a migrated Next.js app the read-only system information Node's
// `os` module reads). An npm dependency that needs more (a spawn, a write elsewhere, the network
// interfaces) dies with Deno's `NotCapable: Requires <name> access to "<target>", run again with
// the --allow-<name> flag`, which names the flag but not where it goes. The first time each
// refusal reaches the server's error path (a request's error, or `start` failing to boot), this
// says which permission was refused, the edit to the `start` task that grants it, and where the
// production checklist explains the trade-off.

/** A refused permission, parsed from Deno's message. */
export interface PermissionRefusal {
  /** The permission name (`sys`, `run`, `write`, `net`, `ffi`, …). */
  readonly name: string;
  /** What it was refused for (`hostname`, `git`, a path or host), or null when unnamed. */
  readonly target: string | null;
}

const REQUIRES = /Requires ([a-z-]+) access(?: to "([^"]*)")?/;

/** The production checklist section on `start`'s permissions. */
const CHECKLIST_URL = "https://denext.dev/docs/production-checklist";

/**
 * The refused permission behind `error` (or its `cause`), or null when it is not one.
 *
 * @param error Anything thrown.
 */
export function permissionRefusal(error: unknown): PermissionRefusal | null {
  for (let e = error, depth = 0; e && depth < 5; depth++) {
    if (e instanceof Deno.errors.NotCapable || e instanceof Deno.errors.PermissionDenied) {
      const m = REQUIRES.exec(e.message);
      if (m) return { name: m[1], target: m[2] ?? null };
    }
    e = e instanceof Error ? e.cause : undefined;
  }
  return null;
}

/** The flag that grants `refusal`, scoped to its target where Deno scopes that permission. */
function grantFor({ name, target }: PermissionRefusal): string {
  if (!target) return `--allow-${name}`;
  if (name === "write") return `--allow-write=.denext,${target}`;
  if (name === "sys" || name === "run" || name === "ffi" || name.startsWith("net")) {
    return `--allow-${name}=${target}`;
  }
  return `--allow-${name}`;
}

/** `compile.permissions`' key for a permission, or null when the config has none for it. */
const COMPILE_KEYS: Record<string, string> = {
  write: "write",
  run: "run",
  ffi: "ffi",
  sys: "sys",
  "net-connect": "netConnect",
  "net-listen": "netListen",
};

/** The hint for a `deno compile`d app: its grants are baked from `compile.permissions`. */
function binaryHint(refusal: PermissionRefusal, what: string): string {
  const key = COMPILE_KEYS[refusal.name];
  const grant = key
    ? `\`compile: { permissions: { ${key}: [${JSON.stringify(refusal.target ?? "*")}] } }\``
    : '`compile: { permissions: "all" }`';
  return `denext: the server was refused ${what}, which this binary was not built with ` +
    `(a dependency needs it). Add ${grant} to denext.config.ts and rebuild with ` +
    `\`denext build --compile\`. Why the grants are scoped: ${CHECKLIST_URL}`;
}

/**
 * The message for `refusal`: the permission, the edit to deno.json's `start` task that grants
 * it, `-A` as the blunt fallback, and the checklist link. In a `deno compile`d app, the
 * `compile.permissions` entry to rebuild with instead.
 *
 * @param refusal The refused permission.
 * @param standalone Whether this process is a compiled binary (default: detected).
 */
export function permissionHint(
  refusal: PermissionRefusal,
  standalone: boolean = (Deno.build as { standalone?: boolean }).standalone === true,
): string {
  const what = refusal.target ? `${refusal.name} access to "${refusal.target}"` : `${refusal.name}`;
  if (standalone) return binaryHint(refusal, what);
  const flag = grantFor(refusal);
  const merge = flag.includes("=")
    ? ` If the task already has an \`--allow-${refusal.name}=…\` list, add ` +
      `\`${refusal.target}\` to it instead (Deno keeps only the last one).`
    : "";
  return `denext: the server was refused ${what}, which your \`start\` task does not grant ` +
    "(a dependency needs it). Grant it by adding " +
    `\`${flag}\` to the \`start\` task in deno.json.${merge} ` +
    "Replacing the task's permission flags with `-A` grants everything, if you accept that. " +
    `Why the task is scoped: ${CHECKLIST_URL}`;
}

const reported = new Set<string>();

/**
 * At most this many distinct (permission, target) hints per process: an app that reaches
 * user-supplied hosts or paths under a scoped grant must not grow the set, or the log, without
 * bound. Past it a refusal is still recognised, but no longer printed.
 */
export const MAX_REPORTED_PERMISSION_HINTS = 256;

/** Forget the hints printed so far (tests). */
export function resetPermissionHintsForTesting(): void {
  reported.clear();
}

/**
 * Print {@linkcode permissionHint} for the permission `error` was refused, once per permission
 * and target for the process. A no-op for any other error.
 *
 * @param error Anything thrown.
 * @param log Where to print (default `console.error`).
 * @returns Whether `error` was a refused permission.
 */
export function reportPermissionRefusal(
  error: unknown,
  log: (message: string) => void = console.error,
): boolean {
  const refusal = permissionRefusal(error);
  if (!refusal) return false;
  const key = `${refusal.name}\0${refusal.target ?? ""}`;
  if (!reported.has(key) && reported.size < MAX_REPORTED_PERMISSION_HINTS) {
    reported.add(key);
    log(permissionHint(refusal));
  }
  return true;
}
