// The HTTP side of auto-REST, after PostgREST: the `Prefer` header (`return=`, `count=`,
// `resolution=`, `missing=default`, `tx=`, `handling=`, `params=single-object`,
// `max-affected=`), the `Accept` media types (JSON, one object, CSV, GeoJSON, an execution plan,
// `nulls=stripped`), the request body's media types (JSON, CSV, a form), the profile headers
// that pick a schema, and the PostgREST-shaped error envelope.

import { isApiError, readCappedBody, STALLED, TOO_LARGE } from "@denext/denext/server";
import { rowsFromCsv } from "./rest-format.ts";
import { RestError } from "./rest-parse.ts";

/** What `Prefer` asked for. */
export interface Preferences {
  /** `return=`: what a write answers with (absent: `minimal`). */
  return?: "minimal" | "representation" | "headers-only";
  /** `count=`: count every matching row, exactly or by the planner's estimate. */
  count?: "exact" | "planned" | "estimated";
  /** `resolution=`: an insert is an upsert. */
  resolution?: "merge" | "ignore";
  /** `missing=default`: a key a row leaves out takes the column's default. */
  missingDefault: boolean;
  /** `tx=rollback`: run, answer, and roll back. */
  rollback: boolean;
  /** `handling=strict`: an unknown preference is an error, and `max-affected` is enforced. */
  strict: boolean;
  /** `params=single-object`: an RPC body is the function's one json argument. */
  singleObject: boolean;
  /** `max-affected=N` (with `handling=strict`): a write touching more rows is rolled back. */
  maxAffected?: number;
  /** The preferences honoured, for `Preference-Applied`. */
  applied: string[];
}

/** A recognised `Prefer` token → how it sets the preferences. */
const PREFERENCE_TOKENS: Record<string, (p: Preferences) => void> = {
  "return=minimal": (p) => p.return = "minimal",
  "return=representation": (p) => p.return = "representation",
  "return=headers-only": (p) => p.return = "headers-only",
  "count=exact": (p) => p.count = "exact",
  "count=planned": (p) => p.count = "planned",
  "count=estimated": (p) => p.count = "estimated",
  "resolution=merge-duplicates": (p) => p.resolution = "merge",
  "resolution=ignore-duplicates": (p) => p.resolution = "ignore",
  "missing=default": (p) => p.missingDefault = true,
  "missing=null": (p) => p.missingDefault = false,
  "tx=rollback": (p) => p.rollback = true,
  "tx=commit": (p) => p.rollback = false,
  "handling=strict": (p) => p.strict = true,
  "handling=lenient": (p) => p.strict = false,
  "params=single-object": (p) => p.singleObject = true,
};

/**
 * Read the `Prefer` header (comma-separated tokens, several headers allowed). Under
 * `handling=strict` an unknown token is a 400 (`PGRST122`); otherwise it is ignored.
 *
 * @param request The request.
 * @returns The preferences.
 * @throws {RestError} For an unknown token under `handling=strict`.
 */
export function preferencesOf(request: Request): Preferences {
  const prefs: Preferences = {
    missingDefault: false,
    rollback: false,
    strict: false,
    singleObject: false,
    applied: [],
  };
  const tokens = (request.headers.get("prefer") ?? "").split(",").map((t) => t.trim())
    .filter((t) => t !== "");
  const unknown: string[] = [];
  for (const token of tokens) {
    const set = PREFERENCE_TOKENS[token];
    const max = /^max-affected=(\d{1,9})$/.exec(token);
    if (set) set(prefs);
    else if (max) prefs.maxAffected = Number(max[1]);
    else if (!token.startsWith("timezone=")) {
      unknown.push(token);
      continue;
    }
    prefs.applied.push(token);
  }
  if (prefs.strict && unknown.length) {
    throw new RestError(
      400,
      "PGRST122",
      "Invalid preferences given with handling=strict",
      `Invalid preferences: ${unknown.join(", ").slice(0, 200)}`,
    );
  }
  return prefs;
}

/** The response's media type. */
export type Media =
  | { readonly kind: "json" | "csv" | "geojson" }
  | { readonly kind: "object" | "array"; readonly stripped: boolean }
  | {
    readonly kind: "plan";
    readonly format: "json" | "text";
    readonly for: string;
    readonly options: readonly string[];
  };

/** The `EXPLAIN` options a plan request may ask for. */
const PLAN_OPTIONS = new Set(["analyze", "verbose", "settings", "buffers", "wal"]);

/** One media range of `Accept`: its type and its parameters. */
function mediaRange(range: string): { type: string; params: Map<string, string> } {
  const [type, ...rest] = range.split(";").map((part) => part.trim());
  const params = new Map<string, string>();
  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      params.set(
        part.slice(0, eq).trim().toLowerCase(),
        part.slice(eq + 1).trim().replace(/^"|"$/g, ""),
      );
    }
  }
  return { type: type.toLowerCase(), params };
}

/** One media range → the media it means, or `undefined` when unsupported. */
function mediaOf(type: string, params: Map<string, string>): Media | undefined {
  const stripped = params.get("nulls") === "stripped";
  switch (type) {
    case "":
    case "*/*":
    case "application/*":
    case "application/json":
      return { kind: "json" };
    case "application/vnd.pgrst.object+json":
    case "application/vnd.pgrst.object":
      return { kind: "object", stripped };
    case "application/vnd.pgrst.array+json":
      return { kind: "array", stripped };
    case "text/csv":
      return { kind: "csv" };
    case "application/geo+json":
      return { kind: "geojson" };
    case "application/vnd.pgrst.plan":
    case "application/vnd.pgrst.plan+json":
    case "application/vnd.pgrst.plan+text": {
      const options = (params.get("options") ?? "").split("|").filter((o) => o !== "");
      if (options.some((o) => !PLAN_OPTIONS.has(o))) return undefined;
      return {
        kind: "plan",
        format: type.endsWith("+text") ? "text" : "json",
        for: params.get("for") ?? "application/json",
        options,
      };
    }
  }
  return undefined;
}

/**
 * The response media the `Accept` header asks for: the first range this API produces.
 *
 * @param request The request.
 * @returns The media.
 * @throws {RestError} `PGRST107` (406) when none is produced here.
 */
export function mediaOfRequest(request: Request): Media {
  const accept = request.headers.get("accept");
  if (accept === null || accept.trim() === "") return { kind: "json" };
  for (const range of accept.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const { type, params } = mediaRange(range);
    const media = mediaOf(type, params);
    if (media) return media;
  }
  throw new RestError(
    406,
    "PGRST107",
    `None of these media types are available: ${accept.slice(0, 200)}`,
  );
}

/**
 * The schema a request targets: `Accept-Profile` (reads) or `Content-Profile` (writes), else the
 * first exposed schema.
 *
 * @param request The request.
 * @param schemas The exposed schemas.
 * @param write Whether it is a write (POST / PATCH / DELETE / PUT).
 * @returns The schema.
 * @throws {RestError} `PGRST106` (406) for a schema that is not exposed.
 */
export function profileOf(request: Request, schemas: readonly string[], write: boolean): string {
  const header = request.headers.get(write ? "content-profile" : "accept-profile");
  if (header === null || header.trim() === "") return schemas[0];
  const schema = header.trim();
  if (!schemas.includes(schema)) {
    throw new RestError(
      406,
      "PGRST106",
      `The schema must be one of the following: ${schemas.join(", ")}`,
    );
  }
  return schema;
}

/**
 * The request body, capped, by its media type: JSON (the default), CSV (an array of objects
 * whose cells are strings or null), or a form (one object).
 *
 * @param request The request.
 * @param max The cap, in bytes.
 * @returns The parsed body.
 * @throws {RestError} For an unsupported type, an oversized or stalled body, or bad syntax.
 */
export async function bodyOf(request: Request, max: number): Promise<unknown> {
  const type = (request.headers.get("content-type") ?? "application/json").trim().toLowerCase();
  const kind = /^application\/json\b/.test(type)
    ? "json"
    : /^text\/csv\b/.test(type)
    ? "csv"
    : /^application\/x-www-form-urlencoded\b/.test(type)
    ? "form"
    : undefined;
  if (!kind) {
    throw new RestError(415, "PGRST102", "the body must be application/json, text/csv or a form");
  }
  const bytes = await readCappedBody(request, max);
  if (bytes === TOO_LARGE) throw new RestError(413, "PGRST102", "the request body is too large");
  if (bytes === STALLED) throw new RestError(408, "PGRST102", "the request body stalled");
  const text = new TextDecoder().decode(bytes);
  if (kind === "csv") return rowsFromCsv(text);
  if (kind === "form") return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    throw new RestError(400, "PGRST102", "the body is not valid JSON");
  }
}

/** `Range: 0-24` (or `items=0-24`) → offset and length, when present and well-formed. */
export function rangeOf(request: Request): { offset: number; length?: number } | undefined {
  const match = /^\s*(?:items=)?(\d{1,9})-(\d{0,9})\s*$/.exec(request.headers.get("range") ?? "");
  if (!match) return undefined;
  const from = Number(match[1]);
  if (match[2] === "") return { offset: from };
  const to = Number(match[2]);
  if (to < from) throw new RestError(416, "PGRST103", "the requested range is not satisfiable");
  return { offset: from, length: to - from + 1 };
}

/**
 * Exactly one row, or the 406 PostgREST answers.
 *
 * @param n The row count.
 * @throws {RestError} `PGRST116` unless `n` is 1.
 */
export function requireOne(n: number): void {
  if (n !== 1) {
    throw new RestError(
      406,
      "PGRST116",
      "JSON object requested, multiple (or no) rows returned",
      `The result contains ${n} rows`,
    );
  }
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** A PostgREST-shaped JSON error. */
function errorBody(code: string, message: string, details: unknown, hint: string | null) {
  return JSON.stringify({ code, details, hint, message });
}

/**
 * The HTTP status for a SQLSTATE, after PostgREST's table.
 *
 * @param code The SQLSTATE.
 * @returns The status.
 */
export function statusForSqlState(code: string): number {
  if (code === "23503" || code === "23505") return 409;
  if (code === "42501") return 403;
  if (code === "42P01" || code === "42883") return 404;
  if (code === "57014") return 504;
  if (code === "25006") return 405;
  if (code === "P0001") return 400;
  const exact: Record<string, number> = { "08": 503, "53": 503, "54": 413, "28": 403 };
  const head = code.slice(0, 2);
  if (head in exact) return exact[head];
  if (head === "0L" || head === "0P") return 403;
  if (head === "22" || head === "23" || head === "42") return 400;
  return 500;
}

/** A JSON error response. */
function jsonError(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** A Postgres error → its response (a 5xx hides the database's message). */
function postgresError(pg: { code: string; message?: unknown; detail?: unknown; hint?: unknown }) {
  const status = statusForSqlState(pg.code);
  if (status < 500 || status === 504) {
    const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
    return jsonError(
      status,
      errorBody(pg.code, String(pg.message), text(pg.detail), text(pg.hint)),
    );
  }
  console.error("[@denext/backend] REST statement failed", pg);
  return jsonError(status, errorBody(pg.code, "database error", null, null));
}

/**
 * Anything thrown → the error response.
 *
 * @param error The error.
 * @returns The response.
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof RestError) {
    const response = jsonError(
      error.status,
      errorBody(error.code, error.message, error.details, error.hint),
    );
    if (error.status === 503) response.headers.set("retry-after", "1");
    return response;
  }
  if (isApiError(error)) {
    return jsonError(error.status, errorBody(error.code, error.message, null, null));
  }
  const pg = error as { code?: unknown };
  if (typeof pg?.code === "string" && /^[0-9A-Z]{5}$/.test(pg.code)) {
    return postgresError(pg as { code: string });
  }
  console.error("[@denext/backend] REST request failed", error);
  return jsonError(503, errorBody("PGRST001", "the database is unavailable", null, null));
}
