// Per-surface request deadlines. denext answers a request that runs past the app's
// `requestTimeout` (30 s by default) with a 503, and the deadline covers the response body too.
// That suits pages and actions, not the backend's own surfaces: an Edge Function has its own
// `timeoutMs` (150 s by default), a storage upload or download streams for as long as the file
// takes, and a REST statement may be allowed longer than 30 s (`rest.statementTimeout`). A
// pass-through handler, registered before the others, gives each such request the deadline of
// its surface (`setRequestTimeout`) and claims nothing.

import { setRequestTimeout } from "@denext/denext/server";
import type { ResolvedFunctions } from "./functions.ts";
import type { ResolvedRest } from "./rest.ts";

/** One surface's deadline: requests whose app-relative path starts with `prefix`. */
export interface SurfaceDeadline {
  /** The app-relative path prefix (ends with `/`). */
  prefix: string;
  /** The deadline, ms from the request's start. */
  ms: number;
}

/** How long a storage transfer (upload, download, TUS chunk) may take: an hour. */
const STORAGE_DEADLINE_MS = 60 * 60 * 1000;

/** What an Edge Function's deadline adds to its own `timeoutMs`: the worker's start and reply. */
const FUNCTION_MARGIN_MS = 10_000;

/** What a REST request's deadline adds to `statementTimeout`: the queue wait and the reply. */
const REST_MARGIN_MS = 6_000;

/** The surfaces and the app's own deadline the table is built from. */
export interface DeadlineInput {
  /** The app's `requestTimeout` (`0`: none — then no surface gets one either). */
  appTimeoutMs: number;
  /** The functions options, when functions are on. */
  functions?: ResolvedFunctions;
  /** The REST options, when auto-REST is on. */
  rest?: ResolvedRest;
  /** Whether storage is on. */
  storage: boolean;
  /** The Storage API's base path, or `null` when it is off. */
  storageApiBase: string | null;
}

/**
 * Each backend surface's deadline. Only ever longer than the app's: a surface that fits in it
 * keeps it.
 *
 * @param input The surfaces and the app's deadline.
 * @returns The deadlines, by path prefix.
 */
export function surfaceDeadlines(input: DeadlineInput): SurfaceDeadline[] {
  if (input.appTimeoutMs === 0) return [];
  const out: SurfaceDeadline[] = [];
  const longer = (prefix: string, ms: number) => {
    if (ms > input.appTimeoutMs) out.push({ prefix, ms });
  };
  if (input.functions) {
    const own = Object.values(input.functions.functions).map((f) => f.timeoutMs ?? 0);
    longer(
      input.functions.basePath + "/",
      Math.max(input.functions.timeoutMs, ...own) + FUNCTION_MARGIN_MS,
    );
  }
  if (input.storage) {
    longer("/_denext/storage/", STORAGE_DEADLINE_MS);
    if (input.storageApiBase) longer(input.storageApiBase + "/", STORAGE_DEADLINE_MS);
  }
  if (input.rest) longer(input.rest.basePath + "/", input.rest.statementTimeout + REST_MARGIN_MS);
  return out;
}

/**
 * The pass-through request handler that applies {@linkcode surfaceDeadlines}: it sets the
 * matching surface's deadline on the request and returns `null`, so the surface's own handler
 * still answers.
 *
 * @param deadlines The table.
 * @param appBasePath The app's `basePath` (stripped before matching).
 * @returns The handler.
 */
export function deadlineHandler(
  deadlines: SurfaceDeadline[],
  appBasePath: string,
): (request: Request) => null {
  const base = appBasePath.replace(/\/$/, "");
  return (request) => {
    let path = new URL(request.url).pathname;
    if (base && path.startsWith(base + "/")) path = path.slice(base.length);
    const match = deadlines.find((d) => path.startsWith(d.prefix));
    if (match) setRequestTimeout(match.ms);
    return null;
  };
}
