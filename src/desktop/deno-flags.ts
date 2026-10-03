/**
 * `desktop.denoFlags`: extra `deno desktop` flags a project needs to build or run at all (a pnpm
 * workspace needs `--node-modules-dir=none`, or `deno desktop` type-checks against its
 * `node_modules` and rewrites the root `package.json`). `denext desktop run` / `dev` and the
 * package scripts pass them before the entry.
 *
 * Only an allow-list of resolution and type-check flags is accepted, each as one `--flag` or
 * `--flag=value` entry. Permission flags are refused (the packaged app's permissions come from
 * `desktop.capabilities` and `desktop.extraPermissions`), and so are the flags denext sets itself
 * (`--output`, `--target`, `--include`, `--icon`, `--config`, …). Pure, no imports: the config
 * validator and the CLI share it.
 *
 * @module
 */

/** The flags taken bare, and the value each `--flag=value` form accepts (`null`: bare only). */
const ALLOWED: Readonly<Record<string, { bare: boolean; value: RegExp | null }>> = {
  "--node-modules-dir": { bare: true, value: /^(auto|manual|none)$/ },
  "--node-modules-linker": { bare: false, value: /^(isolated|hoisted)$/ },
  "--exclude-unused-npm": { bare: true, value: null },
  "--no-check": { bare: true, value: /^remote$/ },
  "--check": { bare: true, value: /^all$/ },
  "--no-lock": { bare: true, value: null },
  "--lock": { bare: true, value: /^[^\s=,]+$/ },
  "--frozen-lockfile": { bare: true, value: /^(true|false)$/ },
  "--cached-only": { bare: true, value: null },
  "--no-remote": { bare: true, value: null },
  "--no-npm": { bare: true, value: null },
  "--no-code-cache": { bare: true, value: null },
  "--conditions": { bare: false, value: /^[A-Za-z0-9_.:-]+(,[A-Za-z0-9_.:-]+)*$/ },
};

/** `--unstable-<feature>` flags (bare). */
const UNSTABLE = /^--unstable-[a-z0-9]+(-[a-z0-9]+)*$/;

/** Flags that grant or deny permissions: never through `denoFlags`. */
const PERMISSION =
  /^(-A|--allow-all|--allow-[a-z-]+|--deny-[a-z-]+|--ignore-[a-z-]+|-[RWNESIP]|--permission-set|--no-prompt|--unsafely-ignore-certificate-errors)(=|$)/;

/** The flags denext passes itself. */
const MANAGED =
  /^(-o|--output|--target|--include|--exclude|--icon|-c|--config|--no-config|--all-targets|--backend|--hmr|--env-file|--v8-flags|--inspect[a-z-]*|--location|--seed|--preload|--require|--import-map|--vendor|--reload|-r|--compress)(=|$)/;

/** The allowed flags, for messages. */
const DESKTOP_DENO_FLAGS: readonly string[] = [...Object.keys(ALLOWED), "--unstable-*"];

/**
 * Why `flag` cannot be a `desktop.denoFlags` entry, or `null` when it can.
 *
 * @param flag One entry.
 * @returns The reason, or `null`.
 */
export function desktopDenoFlagError(flag: unknown): string | null {
  if (typeof flag !== "string" || flag === "") return "must be a non-empty string";
  if (/\s/.test(flag)) return "must be one flag without whitespace (write `--flag=value`)";
  if (PERMISSION.test(flag)) {
    return "permission flags are not accepted: the app's permissions come from " +
      "desktop.capabilities and desktop.extraPermissions";
  }
  if (MANAGED.test(flag)) return "denext sets this flag itself";
  if (UNSTABLE.test(flag)) return null;
  const eq = flag.indexOf("=");
  const name = eq < 0 ? flag : flag.slice(0, eq);
  const rule = ALLOWED[name];
  if (!Object.hasOwn(ALLOWED, name) || rule === undefined) {
    return `is not an allowed flag (allowed: ${DESKTOP_DENO_FLAGS.join(", ")})`;
  }
  if (eq < 0) return rule.bare ? null : `needs a value (${name}=…)`;
  const value = flag.slice(eq + 1);
  return rule.value?.test(value) ? null : `has an invalid value "${value}"`;
}

/**
 * `desktop.denoFlags` of a config, checked.
 *
 * @param config The project config (`denext.config.ts`'s default export), or `undefined`.
 * @returns The flags, in order (`[]` when unset).
 * @throws {Error} When the value is not an array, or an entry is refused.
 */
export function desktopDenoFlags(config: unknown): string[] {
  const raw = (config as { desktop?: { denoFlags?: unknown } } | null | undefined)?.desktop
    ?.denoFlags;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("desktop.denoFlags must be an array of flags");
  return raw.map((flag, i) => {
    const why = desktopDenoFlagError(flag);
    if (why) throw new Error(`desktop.denoFlags[${i}] ${JSON.stringify(flag)}: ${why}`);
    return flag as string;
  });
}
