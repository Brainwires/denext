// Options schemas for plugins the first-party catalog doesn't know. A JSR package opts in by
// publishing `denext.catalog.optionsSchema` (a plain JSON Schema) in its `deno.json` or
// `jsr.json` — the block first-party packages carry. The UI reads that file for the version the
// project's `deno.lock` resolved (else the latest), keeps only the schema keys the options form
// reads, each checked and bounded, and caches a good answer for a few minutes. No remote code is
// ever loaded: the schema is data, rendered through the same escaped widgets as the catalog's.

import type { SchemaNode } from "../form/schema.ts";
import { uiSafeJoin } from "../security.ts";
import { normalizeSpec } from "../../build/plugin-install.ts";
import type { JsrConfigResult, JsrMetaResult, JsrRequestOptions } from "../jsr.ts";

/** The registry calls this module needs (the Plugins panel's injectable JSR client). */
export interface SchemaSource {
  /** A package's latest version. */
  readonly meta: (scope: string, name: string, opts?: JsrRequestOptions) => Promise<JsrMetaResult>;
  /** A package's published `deno.json` / `jsr.json` at one version. */
  readonly config: (
    scope: string,
    name: string,
    version: string,
    opts?: JsrRequestOptions,
  ) => Promise<JsrConfigResult>;
}

/** A published options schema, or why there is none to offer. */
export type PublishedSchema =
  | { readonly ok: true; readonly schema: SchemaNode; readonly version: string }
  | { readonly ok: false; readonly reason: string };

/** How deep a published schema may nest. */
const MAX_DEPTH = 6;
/** How many schema nodes it may hold in all. */
const MAX_NODES = 400;
/** How many properties (or `required` names) one object may list. */
const MAX_KEYS = 100;
/** The longest `description` kept. */
const MAX_TEXT = 1000;
/** The most `enum` values kept. */
const MAX_ENUM = 100;
/** The most `anyOf` branches kept. */
const MAX_BRANCHES = 20;
/** An option name the form (and the config writer) can own. */
const KEY_RE = /^[A-Za-z_$][\w$]*$/;
/** Names that would reach an object's prototype. */
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
/** How long a good answer is reused. */
const CACHE_TTL_MS = 5 * 60_000;
/** How many packages' answers are kept. */
const CACHE_MAX = 32;

const cache = new Map<string, { at: number; schema: SchemaNode }>();

type Node = Record<string, unknown>;
type Next = (child: unknown) => SchemaNode | null;

function isRecord(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** The scalar keys the form reads, each with its check; any other key is dropped. */
const SCALARS: Readonly<Record<string, (value: unknown) => boolean>> = {
  type: (v) =>
    typeof v === "string" ||
    (Array.isArray(v) && v.length <= 8 && v.every((t) => typeof t === "string")),
  description: (v) => typeof v === "string" && v.length <= MAX_TEXT,
  minimum: (v) => typeof v === "number" && Number.isFinite(v),
  maximum: (v) => typeof v === "number" && Number.isFinite(v),
  required: (v) =>
    Array.isArray(v) && v.length <= MAX_KEYS && v.every((k) => typeof k === "string"),
  enum: (v) => Array.isArray(v) && v.length <= MAX_ENUM && v.every(isPrimitive),
};

/** The child-schema keys the form reads, each cleaned through `next`; `null` refuses. */
const CHILDREN: Readonly<Record<string, (value: unknown, next: Next) => unknown>> = {
  properties: cleanProperties,
  items: (v, next) => next(v),
  anyOf: (v, next) => {
    if (!Array.isArray(v) || v.length > MAX_BRANCHES) return null;
    const branches = v.map(next);
    return branches.includes(null) ? null : branches;
  },
  additionalProperties: (v, next) => typeof v === "boolean" ? v : next(v),
};

/** An object's properties, each name ownable and each schema cleaned; `null` refuses. */
function cleanProperties(value: unknown, next: Next): Record<string, SchemaNode> | null {
  if (!isRecord(value) || Object.keys(value).length > MAX_KEYS) return null;
  const out: Record<string, SchemaNode> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!KEY_RE.test(key) || RESERVED.has(key)) return null;
    const cleaned = next(child);
    if (cleaned === null) return null;
    out[key] = cleaned;
  }
  return out;
}

/** One node, cleaned; `null` when it (or anything under it) is off, too deep or too big. */
function clean(node: unknown, depth: number, budget: { nodes: number }): SchemaNode | null {
  if (!isRecord(node) || depth > MAX_DEPTH || ++budget.nodes > MAX_NODES) return null;
  const out: Node = {};
  for (const [key, valid] of Object.entries(SCALARS)) {
    if (!Object.hasOwn(node, key)) continue;
    if (!valid(node[key])) return null;
    out[key] = structuredClone(node[key]);
  }
  const hint = node["x-denext"];
  if (isRecord(hint) && hint.widget === "textarea") out["x-denext"] = { widget: "textarea" };
  const next: Next = (child) => clean(child, depth + 1, budget);
  for (const [key, copy] of Object.entries(CHILDREN)) {
    if (!Object.hasOwn(node, key)) continue;
    const value = copy(node[key], next);
    if (value === null) return null;
    out[key] = value;
  }
  return out as SchemaNode;
}

/**
 * A copy of a published options schema holding only the keys the options form reads — `type`,
 * `description`, `minimum`/`maximum`, `required`, `enum`, `properties`, `items`, `anyOf`,
 * `additionalProperties` and the `textarea` widget hint — each checked, bounded in depth and size,
 * with no property name that could reach a prototype. The root must be an object with properties.
 *
 * @param node A schema a third-party package published (untrusted).
 * @returns The cleaned schema, or `null` when it can't be offered as a form.
 */
export function sanitizeOptionsSchema(node: unknown): SchemaNode | null {
  const cleaned = clean(node, 0, { nodes: 0 });
  return cleaned !== null && cleaned.type === "object" && cleaned.properties !== undefined
    ? cleaned
    : null;
}

/** The version the project's `deno.lock` resolved `spec` to, if it has one. */
async function lockedVersion(dir: string, spec: string): Promise<string | null> {
  try {
    const lock: unknown = JSON.parse(await Deno.readTextFile(await uiSafeJoin(dir, "deno.lock")));
    const specifiers = isRecord(lock) && isRecord(lock.specifiers) ? lock.specifiers : {};
    for (const [key, version] of Object.entries(specifiers)) {
      if (key.startsWith("jsr:") && normalizeSpec(key) === spec && typeof version === "string") {
        return version;
      }
    }
  } catch { /* no readable lockfile: fall back to the latest version */ }
  return null;
}

/** The `denext.catalog` block of a parsed config, if it has one. */
function catalogBlock(config: unknown): Node | null {
  if (!isRecord(config) || !isRecord(config.denext)) return null;
  return isRecord(config.denext.catalog) ? config.denext.catalog : null;
}

/** Keep a good answer, dropping the oldest past the cap. */
function remember(key: string, schema: SchemaNode): void {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), schema });
}

/**
 * The options schema `spec` publishes, for the version the project's lockfile resolved (else
 * the latest on JSR): read once per version and reused for a few minutes.
 *
 * @param dir The project root (its `deno.lock` is read).
 * @param spec The package, `@scope/name`.
 * @param source The registry calls.
 * @param opts An abort signal.
 * @returns The cleaned schema and its version, or why there is none.
 */
export async function publishedOptionsSchema(
  dir: string,
  spec: string,
  source: SchemaSource,
  opts: JsrRequestOptions = {},
): Promise<PublishedSchema> {
  const [scope, name] = spec.slice(1).split("/");
  let version = await lockedVersion(dir, spec);
  if (version === null) {
    const meta = await source.meta(scope, name, opts);
    if (!meta.ok) {
      return { ok: false, reason: `could not resolve ${spec} on jsr.io: ${meta.reason}` };
    }
    version = meta.latest;
  }
  const key = `${spec}@${version}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, schema: hit.schema, version };
  const config = await source.config(scope, name, version, opts);
  if (!config.ok) {
    return { ok: false, reason: `reading ${key} from jsr.io failed: ${config.reason}` };
  }
  const published = catalogBlock(config.value)?.optionsSchema;
  if (published === undefined) {
    return { ok: false, reason: `${key} publishes no denext.catalog.optionsSchema` };
  }
  const schema = sanitizeOptionsSchema(published);
  if (schema === null) {
    return {
      ok: false,
      reason: `${key}'s denext.catalog.optionsSchema is not an options schema the form can show`,
    };
  }
  remember(key, schema);
  return { ok: true, schema, version };
}
