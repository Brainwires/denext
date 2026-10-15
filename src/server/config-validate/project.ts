// The project-level parts of denext.config: Tailwind, i18n, feature flags, project CLI verbs and
// the `optimizePackageImports` lists.

import type { DenextConfig } from "../config.ts";
import { VERB_NAME } from "../../cli/command.ts";
import { isReservedDenoVerb, reservedVerbError } from "../../cli/deno-verbs.ts";
import { validateRemovedExperimental } from "./keys.ts";
import type { Fail } from "./shared.ts";

/** `tailwind.input`/`output` are required non-empty path strings. */
function validateTailwind(tailwind: unknown, fail: Fail): void {
  if (tailwind === undefined) return;
  if (typeof tailwind !== "object" || tailwind === null) {
    return fail("tailwind", "must be an object");
  }
  const tw = tailwind as Record<string, unknown>;
  for (const k of ["input", "output"]) {
    if (typeof tw[k] !== "string" || !tw[k]) {
      fail(`tailwind.${k}`, "must be a non-empty path string");
    }
  }
}

/** `i18n.locales` is a non-empty string list and `defaultLocale` is one of them. */
function validateI18n(i18n: unknown, fail: Fail): void {
  if (i18n === undefined) return;
  const { locales, defaultLocale } = (i18n ?? {}) as { locales?: unknown; defaultLocale?: unknown };
  const list = Array.isArray(locales) ? locales : [];
  if (list.length === 0 || list.some((l) => typeof l !== "string")) {
    return fail("i18n.locales", "must be a non-empty array of locale strings");
  }
  if (typeof defaultLocale !== "string" || !list.includes(defaultLocale)) {
    fail("i18n.defaultLocale", "must be one of i18n.locales");
  }
}

/**
 * `features` must be a flat map of booleans — the fold replaces a `feature("KEY")` call with
 * the literal, so a non-boolean value would emit invalid code (and a nested object is always a
 * mistake). Absent keeps every flag off.
 */
function validateFeatures(features: unknown, at: string, fail: Fail): void {
  if (features === undefined) return;
  if (typeof features !== "object" || features === null || Array.isArray(features)) {
    fail(at, "must be an object mapping flag names to booleans");
  }
  for (const [key, value] of Object.entries(features as Record<string, unknown>)) {
    if (typeof value !== "boolean") {
      fail(`${at}.${key}`, "must be a boolean");
    }
  }
}

/**
 * One `commands[i]` entry: a usable verb name, a summary to show in `denext --help`,
 * and a callable `run`. Nothing here checks for a collision with a built-in verb —
 * that is not an error: the CLI simply keeps the built-in (core wins) and skips the
 * entry, so a denext release adding a verb can never break a project's config load. A
 * name (or alias) of one of Deno's code-running verbs (`run`, `x`, `eval`, `serve`,
 * `compile`, `install`, `uninstall`, `upgrade`, `task`) IS an error: `denext <name>`
 * must always mean Deno's there.
 */
function validateCommand(command: unknown, index: number, seen: Set<string>, fail: Fail): void {
  const at = `commands[${index}]`;
  if (typeof command !== "object" || command === null || Array.isArray(command)) {
    return fail(at, "must be an object with `name`, `summary`, and `run`");
  }
  const { name, summary, run } = command as Record<string, unknown>;
  // The one grammar for a verb name, shared with the CLI's help cache: what validation admits
  // here is exactly what the cache accepts back from disk (`src/cli/command-cache.ts`).
  if (typeof name !== "string" || !VERB_NAME.test(name)) {
    fail(`${at}.name`, `must be a lowercase verb name matching ${VERB_NAME}`);
  }
  if (typeof name === "string" && isReservedDenoVerb(name)) {
    fail(`${at}.name`, reservedVerbError(name));
  }
  const aliases = (command as { aliases?: unknown }).aliases;
  if (Array.isArray(aliases)) {
    aliases.forEach((alias, j) => {
      if (typeof alias === "string" && isReservedDenoVerb(alias)) {
        fail(`${at}.aliases[${j}]`, reservedVerbError(alias));
      }
    });
  }
  if (seen.has(name as string)) {
    fail(`${at}.name`, `duplicates an earlier \`commands\` entry ("${name}")`);
  }
  seen.add(name as string);
  if (typeof summary !== "string" || !summary) {
    fail(`${at}.summary`, "must be a non-empty one-line description");
  }
  if (typeof run !== "function") fail(`${at}.run`, "must be a function");
}

/** `commands` is a list of shape-valid, uniquely named project verbs. */
export function validateCommands(commands: unknown, fail: Fail): void {
  if (commands === undefined) return;
  if (!Array.isArray(commands)) return fail("commands", "must be an array of command objects");
  const seen = new Set<string>();
  commands.forEach((command, i) => validateCommand(command, i, seen, fail));
}

/**
 * `optimizePackageImports` (and Next's `experimental.optimizePackageImports`) is a list of
 * package names, `"!pkg"` exclusions, or (top-level only) `false` — a non-string entry would
 * otherwise never match an import, silently.
 */
function validatePackageList(list: unknown, at: string, fail: Fail, allowFalse = false): void {
  if (list === undefined || (allowFalse && list === false)) return;
  const bad = (p: unknown) => typeof p !== "string" || p === "" || p === "!";
  if (!Array.isArray(list) || list.some(bad)) {
    fail(
      at,
      "must be an array of package names (e.g. " +
        '["lucide-react", "react-icons/*", "!recharts"])' + (allowFalse ? " or false" : ""),
    );
  }
}

/** Nested fields whose absence would crash at request time rather than at boot. */
export function validateNestedRequired(config: DenextConfig, fail: Fail): void {
  validateRemovedExperimental(config.experimental, fail);
  validateFeatures(config.features, "features", fail);
  validatePackageList(config.optimizePackageImports, "optimizePackageImports", fail, true);
  validatePackageList(
    config.experimental?.optimizePackageImports,
    "experimental.optimizePackageImports",
    fail,
  );
  validateTailwind(config.tailwind, fail);
  validateI18n(config.i18n, fail);
}

/** The permission kinds `compile.permissions` takes. */
const COMPILE_PERMISSION_KINDS = ["write", "run", "ffi", "sys"];

/** Whether `p` is a project-relative path: not absolute, no `..` segment. */
function insideProject(p: string): boolean {
  return !/^([\\/]|[a-zA-Z]:)/.test(p) && !p.split(/[\\/]/).includes("..");
}

/** `compile.include`: a list of non-empty project-relative paths. */
function validateCompileInclude(include: unknown, fail: Fail): void {
  if (include === undefined) return;
  const paths = Array.isArray(include) ? include : [include];
  if (!Array.isArray(include) || !paths.every((p) => typeof p === "string" && p !== "")) {
    return fail("compile.include", "must be an array of project-relative paths");
  }
  const outside = (paths as string[]).find((p) => !insideProject(p));
  if (outside !== undefined) {
    fail("compile.include", `must stay inside the project (got ${JSON.stringify(outside)})`);
  }
}

/** Whether `v` is a list of `--allow-*` values (non-empty strings, no commas). */
function isPermissionList(v: unknown): boolean {
  return Array.isArray(v) && v.every((s) => typeof s === "string" && s !== "" && !s.includes(","));
}

/** `compile.permissions`: `"all"`, or an object of permission kinds to value lists. */
function validateCompilePermissions(permissions: unknown, fail: Fail): void {
  if (permissions === undefined || permissions === "all") return;
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return fail("compile.permissions", 'must be "all" or an object of permission kinds');
  }
  for (const [k, v] of Object.entries(permissions as Record<string, unknown>)) {
    if (!COMPILE_PERMISSION_KINDS.includes(k) || !isPermissionList(v)) {
      fail(
        `compile.permissions.${k}`,
        `must be an array of strings (kinds: ${COMPILE_PERMISSION_KINDS.join(", ")})`,
      );
    }
  }
}

/**
 * `compile`: `include` a list of project-relative paths (no `..`, none absolute), `permissions`
 * `"all"` or an object of permission kinds to string arrays.
 */
export function validateCompile(compile: unknown, fail: Fail): void {
  if (compile === undefined) return;
  if (typeof compile !== "object" || compile === null || Array.isArray(compile)) {
    return fail("compile", "must be an object");
  }
  const { include, permissions } = compile as { include?: unknown; permissions?: unknown };
  validateCompileInclude(include, fail);
  validateCompilePermissions(permissions, fail);
}
