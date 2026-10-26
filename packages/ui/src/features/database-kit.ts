// What every page of the Database section shares: the `db-admin` child (its runner seam and the
// one way to ask it), the failure statuses, the panel and the answer a reply renders as, and how a
// request's fields are read. The pages themselves live in `database.ts` (tables, rows, SQL,
// policies, migrations, storage, users) and in modules of their own (`logs.ts`, `realtime.ts`,
// `functions.ts`, `health.ts`), all registered on the one Database section.

import {
  cliInvocation,
  type DbEnvelope,
  type DbErrorCode,
  type DbFailure,
  type DbReplies,
  type DbReply,
  type DbRequest,
  type DbSuccess,
  h,
  maskSecrets,
  renderView,
  runDeno,
  UI_CSRF_FIELD,
  type VNode,
  type VNodeChildren,
} from "@denext/denext/internal/ui-host";
import { jsonResponse, panelResponder, type UiContext } from "../html.ts";
import { parseJsonDocument } from "../child-json.ts";
import { DbPanel, Failure, readOnlyNote, type ViewCtx } from "./database-views.ts";

/** How long one child may take, in ms (its queries carry their own statement timeout). */
const CHILD_DEADLINE_MS = 60_000;

/** Runs one envelope in the project. */
export type DbChildRunner = (
  envelope: DbEnvelope,
  dir: string,
  signal: AbortSignal,
) => Promise<DbReply>;

/** The last non-empty line of a child's stderr, masked. */
function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return maskSecrets(lines[lines.length - 1] ?? "");
}

/** The real runner: `denext db-admin --json` with the envelope on stdin. */
async function defaultRunner(
  envelope: DbEnvelope,
  dir: string,
  signal: AbortSignal,
): Promise<DbReply> {
  try {
    const result = await runDeno([...cliInvocation({ dir }), "db-admin", "--json", "--cwd", dir], {
      cwd: dir,
      stdin: JSON.stringify(envelope),
      signal,
    });
    const reply = parseJsonDocument<DbReply>(result.stdout);
    if (reply && typeof reply.ok === "boolean") return reply;
    const why = lastLine(result.stderr);
    return failure("query_failed", why || "the database child printed no answer");
  } catch (error) {
    return failure(
      "query_failed",
      maskSecrets(error instanceof Error ? error.message : String(error)),
    );
  }
}

let runner: DbChildRunner = defaultRunner;

/**
 * Swap the child runner (tests answer in-process).
 *
 * @internal
 * @param next The runner.
 * @returns The runner installed before.
 */
export function setDbChildRunner(next: DbChildRunner): DbChildRunner {
  const previous = runner;
  runner = next;
  return previous;
}

/** A failure reply built on this side. */
export function failure(code: DbErrorCode, reason: string): DbFailure {
  return { ok: false, code, reason };
}

/** Ask the child. */
export function ask<K extends keyof DbReplies>(
  ctx: UiContext,
  request: DbRequest,
): Promise<DbReply<K>> {
  const signal = ctx.signal
    ? AbortSignal.any([ctx.signal, AbortSignal.timeout(CHILD_DEADLINE_MS)])
    : AbortSignal.timeout(CHILD_DEADLINE_MS);
  return runner({ readOnly: ctx.readOnly, request }, ctx.dir, signal) as Promise<DbReply<K>>;
}

/** The HTTP status a failure answers the JSON twin with. */
export const FAILURE_STATUS: Record<DbErrorCode, number> = {
  not_configured: 409,
  // (an `unsupported` refusal is also how an older @denext/backend or auth schema answers)
  unsupported: 501,
  bad_request: 400,
  read_only: 403,
  not_found: 404,
  query_failed: 502,
};

// ── responses ──────────────────────────────────────────────────────────────

const panelResponse = panelResponder("Database", "/database");

/** The view context. */
export function viewCtx(ctx: UiContext): ViewCtx {
  return { csrf: ctx.csrf, readOnly: ctx.readOnly, dashboard: ctx.dashboard === true };
}

/** The panel around `children`, on `tab`. */
export function page(ctx: UiContext, tab: string, children: VNodeChildren, status = 200): Response {
  const body = h(
    DbPanel,
    { tab, dashboard: ctx.dashboard === true },
    readOnlyNote(viewCtx(ctx)),
    children,
  );
  return panelResponse(ctx, renderView(body), status);
}

/**
 * Answer a reply: JSON for the `/api` twin, else the view (a failure as a note — with a 200 for
 * a GET, so `ui.js` swaps it in rather than falling back to a full navigation).
 */
export function answer<K extends keyof DbReplies>(
  ctx: UiContext,
  tab: string,
  reply: DbReply<K>,
  view: (ok: DbSuccess<K>) => VNode,
): Response {
  if (ctx.json) return jsonResponse(reply, reply.ok ? 200 : FAILURE_STATUS[reply.code] ?? 500);
  if (!reply.ok) {
    return page(
      ctx,
      tab,
      h(Failure, { failure: reply }),
      ctx.method === "GET" ? 200 : FAILURE_STATUS[reply.code],
    );
  }
  return page(ctx, tab, view(reply));
}

/** POST/redirect/GET after a write. */
export function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

// ── request fields ─────────────────────────────────────────────────────────

/** One submitted field: the form body, the JSON twin's body, else the query. */
export function field(ctx: UiContext, name: string): string {
  const posted = ctx.form?.get(name);
  if (typeof posted === "string") return posted;
  const body = ctx.body as Record<string, unknown> | null | undefined;
  const value = body && typeof body === "object" ? body[name] : undefined;
  if (typeof value === "string") return value;
  return ctx.url.searchParams.get(name) ?? "";
}

/** Every submitted field whose name starts with `prefix`, the prefix stripped. */
export function prefixed(ctx: UiContext, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (name: string, value: unknown) => {
    if (name.startsWith(prefix) && typeof value === "string") {
      out[name.slice(prefix.length)] = value;
    }
  };
  if (ctx.form) { for (const [name, value] of ctx.form) add(name, value); }
  else if (ctx.body && typeof ctx.body === "object") {
    for (const [name, value] of Object.entries(ctx.body as Record<string, unknown>)) {
      add(name, value);
    }
  } else for (const [name, value] of ctx.url.searchParams) add(name, value);
  return out;
}

/** The fields to carry from a preview into its apply form (everything but CSRF and `op`). */
export function carried(ctx: UiContext): Record<string, string> {
  const out: Record<string, string> = {};
  if (ctx.form) {
    for (const [name, value] of ctx.form) {
      if (typeof value === "string" && name !== "op" && name !== UI_CSRF_FIELD) out[name] = value;
    }
  } else if (ctx.body && typeof ctx.body === "object") {
    for (const [name, value] of Object.entries(ctx.body as Record<string, unknown>)) {
      if (typeof value === "string" && name !== "op" && name !== UI_CSRF_FIELD) out[name] = value;
    }
  }
  return out;
}

/** Whether this POST runs (`op=apply`) rather than previews. */
export function applying(ctx: UiContext): boolean {
  return field(ctx, "op") === "apply";
}
