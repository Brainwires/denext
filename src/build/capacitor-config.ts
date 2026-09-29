// The Capacitor config file of a project (`capacitor.config.*`): finding it in Capacitor's own
// lookup order, reading its literal values, and setting one key while keeping every other byte of
// a JS/TS module. Shared by `denext mobile dev` (the session's server URL), `denext mobile add
// offline-screen` (server.errorPath) and `denext mobile doctor` (what the shell will load).

import { join } from "@std/path";
import { commit, objectSetEdits, readConfigModel, unwrap } from "./config-edit.ts";
import { type Node, parseModule, txt } from "./swc-ast.ts";

/** The Capacitor config file names, in the order the Capacitor CLI looks for them. */
export const CAPACITOR_CONFIGS: readonly string[] = [
  "capacitor.config.ts",
  "capacitor.config.js",
  "capacitor.config.mjs",
  "capacitor.config.cjs",
  "capacitor.config.json",
];

/** The Capacitor config file of `root`, in Capacitor's own lookup order. */
export async function capacitorConfigFile(root: string): Promise<string | null> {
  for (const name of CAPACITOR_CONFIGS) {
    try {
      if ((await Deno.stat(join(root, name))).isFile) return join(root, name);
    } catch { /* not this one */ }
  }
  return null;
}

/** Top-level `const x = …` / `export const x = …` initialisers, by name. */
function topLevelBindings(body: Node[]): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const item of body) {
    const decl = item.type === "ExportDeclaration" ? item.declaration : item;
    if (decl?.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations ?? []) {
      if (d.id?.type === "Identifier" && d.init) out.set(d.id.value, d.init);
    }
  }
  return out;
}

/** The object literal an exported expression is: itself, a `const` it names, or a call's arg. */
function objectOf(expr: Node, bindings: Map<string, Node>): Node | null {
  let e = unwrap(expr ?? {});
  if (e.type === "Identifier") e = unwrap(bindings.get(e.value) ?? {});
  if (e.type === "CallExpression") e = unwrap(e.arguments?.[0]?.expression ?? {});
  return e.type === "ObjectExpression" ? e : null;
}

/** Whether `node` is `module.exports`. */
function isModuleExports(node: Node): boolean {
  const n = unwrap(node ?? {});
  return n.type === "MemberExpression" && n.object?.value === "module" &&
    n.property?.value === "exports";
}

/** The exported config object: `export default {…}` / `config` / `defineConfig({…})` / CJS. */
export function exportedObject(body: Node[]): Node | null {
  const bindings = topLevelBindings(body);
  for (const item of body) {
    if (item.type === "ExportDefaultExpression") return objectOf(item.expression, bindings);
    const assign = item.type === "ExpressionStatement" ? item.expression : null;
    if (assign?.type === "AssignmentExpression" && isModuleExports(assign.left)) {
      return objectOf(assign.right, bindings);
    }
  }
  return null;
}

/** Set one key path in a JS/TS config module's exported object, splicing only that value. */
async function spliceModule(source: string, path: string[], value: unknown): Promise<string> {
  const parsed = await parseModule(source);
  const obj = parsed ? exportedObject(parsed.body) : null;
  if (!parsed || !obj) {
    throw new Error(
      "could not find the exported config object (expected `export default {…}`, " +
        "`export default config` with `const config = {…}`, or `module.exports = {…}`)",
    );
  }
  const edits = objectSetEdits(parsed.ctx, obj, path, value);
  if (!edits.ok) throw new Error(`cannot set ${path.join(".")}: ${edits.reason}`);
  const result = await commit(source, parsed.ctx, edits.edits, "capacitor.config");
  if (!result.ok) throw new Error(result.reason);
  return result.source;
}

/**
 * The config source with the key at `path` set to `value`: a JSON config is re-serialised with
 * two-space indent; a JS/TS module has just that value spliced (every other byte kept).
 *
 * @param file The config file's path (its extension picks JSON or module editing).
 * @param source Its current content.
 * @param path The key path, e.g. `["server", "errorPath"]`.
 * @param value The value (plain data).
 * @returns The edited source.
 */
export async function withCapacitorConfigValue(
  file: string,
  source: string,
  path: readonly string[],
  value: unknown,
): Promise<string> {
  if (!file.endsWith(".json")) return await spliceModule(source, [...path], value);
  const config = JSON.parse(source) as Record<string, unknown>;
  let at = config;
  for (const key of path.slice(0, -1)) {
    const next = at[key];
    at = at[key] = typeof next === "object" && next !== null && !Array.isArray(next)
      ? next as Record<string, unknown>
      : {};
  }
  at[path[path.length - 1]] = value;
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * The Capacitor config's data: a JSON config parsed, or the exported object of a JS/TS module
 * with each top-level key whose value is a plain literal (a key computed by code is left out).
 * Null when the source cannot be read as either.
 *
 * @param file The config file's path.
 * @param source Its content.
 * @returns The config's literal values, or null.
 */
export async function readCapacitorConfig(
  file: string,
  source: string,
): Promise<Record<string, unknown> | null> {
  if (file.endsWith(".json")) {
    try {
      const value = JSON.parse(source) as unknown;
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  const parsed = await parseModule(source);
  const obj = parsed ? exportedObject(parsed.body) : null;
  if (!parsed || !obj) return null;
  const model = await readConfigModel(`export default ${txt(parsed.ctx, obj)};\n`);
  return Object.fromEntries(
    Object.entries(model.keys).flatMap(([key, info]) =>
      info.kind === "editable" ? [[key, info.value]] : []
    ),
  );
}
