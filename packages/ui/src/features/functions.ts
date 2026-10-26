// `/database/functions` — Edge Functions: the functions deployed from `functions/` (name,
// `verifyJwt`, when the entry file last changed) and their recent invocations (status, duration,
// time), per function or all of them.
//
// The running app knows both — its registry has each function's effective `verifyJwt`, and its
// functions runtime keeps the last invocations in a small bounded ring — and reports them through
// the backend's admin endpoint, behind the secret key. Without a running app the page still lists
// the files under `functions/`, `verifyJwt` unknown. An invocation is only ever its function,
// status, duration and time: no request body, header, query or caller is recorded, so none can be
// shown; every text the page renders is redacted like the Logs page besides.

import { join } from "@std/path";
import {
  Badge,
  h,
  Mono,
  Note,
  renderView,
  Table,
  uiSafeJoin,
  type VNode,
} from "@denext/denext/internal/ui-host";
import { jsonResponse, panelResponder, type UiContext } from "../html.ts";
import { type AdminFunction, type AdminInvocation, adminStatus, appTarget } from "../app-admin.ts";
import { knownSecrets, redact } from "../logs/source.ts";
import { DbPanel, readOnlyNote } from "./database-views.ts";
import { Choice } from "./database-admin-views.ts";

/** The entry files a function directory may hold (as `@denext/backend` looks for them). */
const ENTRIES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs"];

/** A function name, as the backend accepts one. */
const FUNCTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A function as the page lists it (`verifyJwt` `null`: no running app to say). */
interface ListedFunction {
  readonly name: string;
  readonly verifyJwt: boolean | null;
  readonly modified: number | null;
}

/** A loose file that is a function module (not a test or a declaration file). */
function isModule(file: string): boolean {
  return /\.(tsx?|jsx?|mjs)$/.test(file) && !/\.(test|spec|d)\./.test(file);
}

/** One directory entry's entry file and function name, or `null`. */
async function entryOf(
  root: string,
  entry: Deno.DirEntry,
): Promise<{ name: string; file: string } | null> {
  if (entry.name.startsWith("_") || entry.name.startsWith(".")) return null;
  if (entry.isDirectory) {
    const file = await firstEntry(join(root, entry.name));
    return file ? { name: entry.name, file } : null;
  }
  return isModule(entry.name)
    ? { name: entry.name.replace(/\.[^.]+$/, ""), file: join(root, entry.name) }
    : null;
}

/** One directory entry as a function, or `null` (not a module, a test, or a bad name). */
async function listed(root: string, entry: Deno.DirEntry): Promise<ListedFunction | null> {
  const found = await entryOf(root, entry);
  if (!found || !FUNCTION_NAME.test(found.name)) return null;
  const stat = await Deno.stat(found.file).catch(() => null);
  return { name: found.name, verifyJwt: null, modified: stat?.mtime?.getTime() ?? null };
}

/** `functions/<name>/index.*` and `functions/<name>.*` on disk (no import, no evaluation). */
async function diskFunctions(dir: string): Promise<ListedFunction[]> {
  const out: ListedFunction[] = [];
  try {
    const root = await uiSafeJoin(dir, "functions");
    for await (const entry of Deno.readDir(root)) {
      const fn = await listed(root, entry);
      if (fn) out.push(fn);
    }
  } catch { /* no functions/ directory, or one outside the project */ }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The entry file of a function directory, or `null`. */
async function firstEntry(dir: string): Promise<string | null> {
  for (const file of ENTRIES) {
    if ((await Deno.stat(join(dir, file)).catch(() => null))?.isFile) return join(dir, file);
  }
  return null;
}

/** What the page shows. */
interface FunctionsState {
  readonly functions: ListedFunction[];
  /** The recent invocations, or why there are none to show. */
  readonly invocations: AdminInvocation[] | string;
  /** Where the list came from. */
  readonly source: "app" | "disk";
}

/** Read the functions: the running app's view, else the files. */
async function readFunctions(ctx: UiContext): Promise<FunctionsState> {
  const target = await appTarget(ctx);
  const status = target ? await adminStatus(target, ctx.signal) : null;
  if (status?.ok && status.functions) {
    return {
      functions: status.functions.functions.map((f: AdminFunction) => ({ ...f })),
      invocations: status.functions.invocations,
      source: "app",
    };
  }
  const why = status === null
    ? "No running app: start the dev server (or the stack) to see invocations."
    : status.ok
    ? "The running app serves no Edge Functions (backend({ functions }))."
    : status.reason;
  return { functions: await diskFunctions(ctx.dir), invocations: why, source: "disk" };
}

/** An epoch-ms time as ISO, or `""`. */
function when(ms: number | null): string {
  return ms === null ? "" : new Date(ms).toISOString();
}

/** The deployed functions, with their invocation counts. */
function FunctionsTable(
  { state }: { readonly state: FunctionsState },
): VNode {
  const calls = Array.isArray(state.invocations) ? state.invocations : [];
  const rows = state.functions.map((f) => {
    const mine = calls.filter((c) => c.name === f.name);
    const failed = mine.filter((c) => c.status === 0 || c.status >= 500).length;
    return h(
      "tr",
      { key: f.name },
      h(
        "td",
        null,
        h("a", { href: `/database/functions?fn=${encodeURIComponent(f.name)}` }, f.name),
      ),
      h(
        "td",
        null,
        f.verifyJwt === null
          ? h(Badge, { tone: "info" }, "unknown")
          : f.verifyJwt
          ? h(Badge, { tone: "ok" }, "verifyJwt")
          : h(Badge, { tone: "warn" }, "public"),
      ),
      h("td", null, when(f.modified)),
      h("td", null, String(mine.length)),
      h("td", null, failed ? h(Badge, { tone: "fail" }, String(failed)) : "0"),
    );
  });
  return rows.length
    ? h(Table, { head: ["Function", "Callers", "Modified", "Recent calls", "Failed"], rows })
    : h(Note, null, "No functions under functions/ (denext generate function <name>).");
}

/** The recent invocations, newest first, of one function or all. */
function InvocationsTable(
  { calls, secrets }: { readonly calls: AdminInvocation[]; readonly secrets: readonly string[] },
): VNode {
  if (calls.length === 0) return h(Note, null, "No invocations since the app started.");
  const rows = calls.map((c, index) =>
    h(
      "tr",
      { key: index },
      h("td", null, h(Mono, null, redact(c.name, secrets))),
      h(
        "td",
        null,
        h(
          Badge,
          { tone: c.status === 0 || c.status >= 500 ? "fail" : c.status >= 400 ? "warn" : "ok" },
          c.status === 0 ? "error" : String(c.status),
        ),
      ),
      h("td", null, `${c.ms} ms`),
      h("td", null, when(c.at)),
    )
  );
  return h(Table, { head: ["Function", "Status", "Duration", "Finished"], rows });
}

const panelResponse = panelResponder("Database", "/database");

/**
 * Serve `/database/functions` (and its `/api` twin).
 *
 * @param ctx The request.
 * @returns The page.
 */
export async function functionsPage(ctx: UiContext): Promise<Response> {
  const state = await readFunctions(ctx);
  const names = state.functions.map((f) => f.name);
  const picked = ctx.url.searchParams.get("fn") ?? "";
  const fn = names.includes(picked) ? picked : "";
  const calls = Array.isArray(state.invocations)
    ? state.invocations.filter((c) => fn === "" || c.name === fn)
    : [];
  if (ctx.json) {
    return jsonResponse({
      ok: true,
      source: state.source,
      functions: state.functions,
      invocations: calls,
    });
  }
  const secrets = await knownSecrets(ctx.dir);
  const body = h(
    DbPanel,
    { tab: "/database/functions", dashboard: ctx.dashboard === true },
    readOnlyNote({ csrf: ctx.csrf, readOnly: ctx.readOnly }),
    h(
      "p",
      { class: "lead" },
      state.source === "app"
        ? "The functions the running app serves, and its recent invocations (status, duration and time only: never a request's body or headers)."
        : "The files under functions/.",
    ),
    h(FunctionsTable, { state }),
    h("h2", null, "Recent invocations"),
    h(
      "form",
      { method: "get", action: "/database/functions", class: "filter" },
      h(Choice, {
        name: "fn",
        label: "Function",
        options: [
          { value: "", label: "Every function" },
          ...names.map((n) => ({ value: n, label: n })),
        ],
        value: fn,
      }),
      h("button", { type: "submit" }, "Show"),
    ),
    typeof state.invocations === "string"
      ? h(Note, null, state.invocations)
      : h(InvocationsTable, { calls, secrets }),
  );
  return panelResponse(ctx, renderView(body));
}
