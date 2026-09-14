// `/generate` — a GUI over `denext generate`: pick a kind, name it, preview the exact files that
// would be written (with their contents), then write them.
//
// The panel is a real `<form method="post">`, so it works with JavaScript disabled; `ui.js`
// upgrades the submit to a fragment swap. "Preview" is `generateArtifact(…, { dryRun: true })` —
// the same plan the write uses, so what you read is what lands. "Write files" answers `303`
// (POST/redirect/GET) with the result in the query, so a reload never re-scaffolds.
//
// This module never calls the CLI verb: `src/cli/commands/generate.ts` reports bad input by
// printing and calling `Deno.exit`, which would take the whole UI server down. Every refusal
// here is a `400`/`403` response instead.

import { relative } from "@std/path";
import {
  GENERATE_KINDS,
  generateArtifact,
  type GenerateKind,
  type GeneratePreviewFile,
  safeJoin,
} from "../../build/generate.ts";
import {
  html,
  jsonResponse,
  panelResponder,
  raw,
  type RawHtml,
  type UiContext,
  type UiHandler,
} from "../html.ts";
import { UI_CSRF_FIELD, uiSafeJoin } from "../security.ts";

/** One line per kind: what it writes and where. */
const KIND_LEAD: Record<GenerateKind, string> = {
  "page": "app/<name>/page.tsx — a Server Component route",
  "route": "synonym for page — app/<name>/page.tsx",
  "layout": "app/<name>/layout.tsx — a shell wrapped around a segment",
  "loading": "app/<name>/loading.tsx — the Suspense fallback (root when unnamed)",
  "error": "app/<name>/error.tsx — a Client Component error boundary",
  "not-found": "app/<name>/not-found.tsx — the 404 boundary",
  "component": "components/<Name>.tsx — an interactive Client Component",
  "api": "app/<name>/route.ts — a route handler returning a Response",
  "action": 'actions/<name>.ts — a "use server" Server Action',
  "middleware": "middleware.ts beside app/ — runs before matched routes",
  "task": "tasks/<name>.ts — a defineTask job for cron or runTask()",
  "test": "tests/<Name>.test.tsx — a component test using denext/testing",
  "docker": "Dockerfile + docker-compose.yml + .dockerignore",
};

/**
 * Kinds whose name is optional — mirrors `NO_NAME` in `src/cli/commands/generate.ts`, so the
 * GUI refuses exactly what the verb refuses. `docker` still *uses* the field (as the
 * `server`|`spa` mode override) and the boundaries still take an optional route path; only
 * `middleware` has nothing to name.
 */
const NO_NAME: ReadonlySet<string> = new Set([
  "docker",
  "middleware",
  "loading",
  "error",
  "not-found",
]);

/** What the name field suggests for each kind. */
const NAME_HINT: Partial<Record<GenerateKind, string>> = {
  "docker": "server | spa (optional — auto-detected)",
  "loading": "route path (optional — root segment when empty)",
  "error": "route path (optional — root segment when empty)",
  "not-found": "route path (optional — root segment when empty)",
};

/** Everything the panel renders from. */
interface PanelState {
  /** The selected artifact kind. */
  readonly kind: GenerateKind;
  /** The name/path typed into the form. */
  readonly name: string;
  /** The project directory (paths are shown relative to it). */
  readonly dir: string;
  /** `--read-only`: the write button is disabled. */
  readonly readOnly: boolean;
  /** The session CSRF token for the form's hidden field. */
  readonly csrf: string;
  /** A refusal to show against the form. */
  readonly error?: string;
  /** The dry-run plan, when the last submit was a preview. */
  readonly preview?: readonly GeneratePreviewFile[];
  /** Project-relative paths written (or, on a preview, that would be written). */
  readonly written?: readonly string[];
  /** Project-relative paths left alone because they already exist. */
  readonly skipped?: readonly string[];
}

/**
 * Serve the scaffolding panel: the form on `GET`, a dry-run preview or a real write on `POST`,
 * and the machine twin of both on `/api/generate`.
 */
export const generatePanel: UiHandler = (
  _request: Request,
  ctx: UiContext,
): Promise<Response> => ctx.method === "POST" ? submitPanel(ctx) : Promise.resolve(showPanel(ctx));

// ── requests ─────────────────────────────────────────────────────────────────

/** `GET`: the form, plus the result of a just-applied run carried in the query. */
function showPanel(ctx: UiContext): Response {
  if (ctx.json) {
    return jsonResponse({
      ok: true,
      kinds: GENERATE_KINDS.map((kind) => ({
        kind,
        lead: KIND_LEAD[kind],
        needsName: !NO_NAME.has(kind),
      })),
    });
  }
  const params = ctx.url.searchParams;
  return page({
    kind: asKind(params.get("kind")) ?? "page",
    name: params.get("name") ?? "",
    dir: ctx.dir,
    readOnly: ctx.readOnly,
    csrf: ctx.csrf,
    written: params.getAll("w"),
    skipped: params.getAll("s"),
  }, ctx);
}

/** `POST`: validate, then preview (`op=preview`) or write (`op=apply`). */
async function submitPanel(ctx: UiContext): Promise<Response> {
  const requested = field(ctx, "kind");
  const kind = asKind(requested);
  const name = field(ctx, "name").trim().replace(/^[\\/]+|[\\/]+$/g, "");
  if (kind === null) return refuse(ctx, "page", name, `unknown kind "${requested}"`, 400);
  const problem = await checkName(ctx.dir, kind, name);
  if (problem) return refuse(ctx, kind, name, problem, 400);
  const apply = field(ctx, "op") === "apply";
  if (apply && ctx.readOnly) return refuse(ctx, kind, name, "read-only", 403);
  let result;
  try {
    result = await generateArtifact(ctx.dir, kind, name, { dryRun: !apply });
  } catch (error) {
    return refuse(ctx, kind, name, error instanceof Error ? error.message : String(error), 400);
  }
  const written = rels(ctx.dir, result.written);
  const skipped = rels(ctx.dir, result.skipped);
  const preview = result.preview?.map((file) => ({
    path: relative(ctx.dir, file.path) || file.path,
    contents: file.contents,
  }));
  if (ctx.json) {
    return jsonResponse({ ok: true, written, skipped, ...(preview ? { preview } : {}) });
  }
  if (apply) return seeResult(kind, name, written, skipped);
  const state = { kind, name, dir: ctx.dir, readOnly: ctx.readOnly, csrf: ctx.csrf };
  return page({ ...state, preview, written, skipped }, ctx);
}

/**
 * Is this name safe to scaffold under? Runs both containment checks: the engine's lexical
 * {@linkcode safeJoin} and the kernel's {@linkcode uiSafeJoin} (lexical plus a realpath
 * re-check, so a symlink inside the project cannot point the writer out of it).
 */
async function checkName(
  dir: string,
  kind: GenerateKind,
  name: string,
): Promise<string | null> {
  if (!name) return NO_NAME.has(kind) ? null : `missing name for "${kind}"`;
  try {
    safeJoin(dir, name);
    await uiSafeJoin(dir, name);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

/** A refusal: the JSON envelope on the API twin, the panel with an error note otherwise. */
function refuse(
  ctx: UiContext,
  kind: GenerateKind,
  name: string,
  reason: string,
  status: number,
): Response {
  if (ctx.json) return jsonResponse({ ok: false, reason }, status);
  const state: PanelState = {
    kind,
    name,
    dir: ctx.dir,
    readOnly: ctx.readOnly,
    csrf: ctx.csrf,
    error: reason,
  };
  return page(state, ctx, status);
}

/** POST/redirect/GET after a write, so a reload does not scaffold again. */
function seeResult(
  kind: GenerateKind,
  name: string,
  written: readonly string[],
  skipped: readonly string[],
): Response {
  const params = new URLSearchParams({ kind, name });
  for (const path of written) params.append("w", path);
  for (const path of skipped) params.append("s", path);
  return new Response(null, { status: 303, headers: { location: `/generate?${params}` } });
}

/** The panel shell: the bare section for `ui.js`, the whole document for a navigation. */
const panelResponse = panelResponder("Generate", "/generate");

/** The panel as a full document, or as the bare `<section>` on a fragment request. */
function page(state: PanelState, ctx: UiContext, status = 200): Response {
  return panelResponse(ctx, panelSection(state), status);
}

// ── views ────────────────────────────────────────────────────────────────────

/** The whole `<section id="panel">` — the piece `ui.js` swaps. */
function panelSection(state: PanelState): RawHtml {
  const results = state.preview
    ? previewView(state)
    : (state.written?.length || state.skipped?.length)
    ? resultView(state)
    : "";
  return html`
    <section id="panel" data-panel="Generate">
      <h1>Generate</h1>
      <p class="lead">Scaffold a route, boundary, component, API handler, action, task, test or
        Docker setup into <span class="mono">${state.dir}</span>.</p>
      ${state.error ? html`<p class="note">denext generate: ${state.error}</p>` : ""}
      ${formView(state)}
      ${results}
    </section>
  `;
}

/** The kind picker, the name field and the two submits. */
function formView(state: PanelState): RawHtml {
  const options = GENERATE_KINDS.map((kind) =>
    html`
      <option value="${kind}" ${kind === state.kind
        ? raw(" selected")
        : ""}>${kind} — ${KIND_LEAD[kind]}</option>
    `
  );
  const unnamed = state.kind === "middleware";
  return html`
    <form method="post" action="/generate">
      <input type="hidden" name="${UI_CSRF_FIELD}" value="${state.csrf}">
      <fieldset>
        <label for="gen-kind">Artifact</label>
        <select id="gen-kind" name="kind">${options}</select>
        <label for="gen-name">Name${unnamed ? " (not used by this kind)" : ""}</label>
        <input id="gen-name" name="name" value="${state.name}" autocomplete="off"
          placeholder="${NAME_HINT[state.kind] ?? "dashboard/settings"}"${unnamed
            ? raw(" disabled")
            : ""}${NO_NAME.has(state.kind) ? "" : raw(" required")}>
      </fieldset>
      <button type="submit" name="op" value="preview">Preview</button>
      <button type="submit" name="op" value="apply" class="ghost"${state.readOnly
        ? raw(" disabled")
        : ""}>Write files</button>
      ${state.readOnly ? html`<p class="note">Read-only mode — writing is refused.</p>` : ""}
    </form>
  `;
}

/** Every planned file with its contents, and whether it would be skipped. */
function previewView(state: PanelState): RawHtml {
  const skipped = new Set(state.skipped ?? []);
  const files = (state.preview ?? []).map((file) => {
    const exists = skipped.has(file.path);
    return html`
      <details${exists ? "" : raw(" open")}>
        <summary><code>${file.path}</code> <span class="badge">${exists
          ? "exists — would be skipped"
          : "would be written"}</span></summary>
        <pre class="out">${file.contents}</pre>
        </details>
    `;
  });
  if (files.length === 0) return html`<p class="note">This kind writes nothing here.</p>`;
  return html`<h2>Preview</h2>${files}`;
}

/** What a completed write did. */
function resultView(state: PanelState): RawHtml {
  const items = [
    ...(state.written ?? []).map((path) => html`<li>+ <code>${path}</code></li>`),
    ...(state.skipped ?? []).map((path) => html`<li>• exists, skipped: <code>${path}</code></li>`),
  ];
  return html`
    <h2>Result</h2>
    <ul>${items}</ul>
  `;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** One submitted field, from a form body or the JSON twin's body. */
function field(ctx: UiContext, key: string): string {
  const posted = ctx.form?.get(key);
  if (typeof posted === "string") return posted;
  const body = ctx.body as Record<string, unknown> | null | undefined;
  const value = body && typeof body === "object" ? body[key] : undefined;
  return typeof value === "string" ? value : "";
}

/** `value` as a known kind, or `null`. */
function asKind(value: string | null): GenerateKind | null {
  const kinds: readonly string[] = GENERATE_KINDS;
  return value !== null && kinds.includes(value) ? value as GenerateKind : null;
}

/** Absolute paths as project-relative ones, for display. */
function rels(dir: string, paths: readonly string[]): string[] {
  return paths.map((path) => relative(dir, path) || path);
}
