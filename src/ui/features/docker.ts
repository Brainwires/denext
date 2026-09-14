// `/docker` — Docker configuration: regenerate the `Dockerfile`, `docker-compose.yml` and
// `.dockerignore` with options (mode, port, Deno tag, Postgres), showing a unified diff against
// what is on disk before anything is written.
//
// The panel is a real `<form method="post">`, so it works with JavaScript disabled; `ui.js`
// upgrades the submit to a fragment swap. "Preview" and "Write files" act on the SAME plan
// ({@linkcode dockerPlan}), so what you read is what lands.
//
// Never-clobber rule: a write only touches files that are absent or still carry the generated-file
// sentinel ({@linkcode DOCKER_SENTINEL}). A hand-edited file is refused and its diff is shown
// anyway, so the change can be copied across by hand — the honest bail the config writer and
// `denext migrate` both take.
//
// rc.1 emits the compose file; it never parses one. Options are re-applied by regenerating, not
// by round-tripping YAML (that needs a YAML parser — 2.5 rc.2).

import { relative } from "@std/path";
import {
  detectDockerMode,
  type DockerMode,
  type DockerOptions,
  dockerPlan,
  type DockerPlanFile,
} from "../../build/docker-template.ts";
import { createUnifiedDiff } from "../../build/patch-diff.ts";
import {
  html,
  htmlResponse,
  jsonResponse,
  layout,
  raw,
  type RawHtml,
  renderPage,
  toHtml,
  UI_NAV,
  type UiContext,
  type UiHandler,
} from "../html.ts";
import { UI_CSRF_FIELD, uiSafeJoin } from "../security.ts";

/** The port the form suggests (and the templates' own default). */
const DEFAULT_PORT = 3000;

/** What the two image modes are called in the picker. */
const MODE_LABEL: Record<DockerMode, string> = {
  server: "server — build + `deno task start` (App Router / SSR)",
  static: "static — `deno task export` + a file server (SPA)",
};

/** How a generated file compares to what is on disk. */
type FileState = "absent" | "generated" | "edited";

/** What each state means, next to the file's name. */
const STATE_LABEL: Record<FileState, string> = {
  absent: "not present — will be created",
  generated: "generated — safe to regenerate",
  edited: "hand-edited — will not be overwritten",
};

/** One of the three files, as the panel and the JSON twin report it. */
interface FileView {
  /** Project-relative path. */
  readonly path: string;
  /** Absent, still generated, or hand-edited. */
  readonly state: FileState;
  /** The unified diff from the current file to the regenerated one (omitted when identical). */
  readonly diff?: string;
}

/** The raw form inputs, kept as typed so a refusal can re-render what was submitted. */
interface FormValues {
  /** `server` | `static` (empty on a first load — auto-detected). */
  readonly mode: string;
  /** The port field, as typed. */
  readonly port: string;
  /** The Deno tag field, as typed. */
  readonly tag: string;
  /** Whether the Postgres service is switched on. */
  readonly postgres: boolean;
}

/** Everything the panel renders from. */
interface PanelState {
  /** The project directory (paths are shown relative to it). */
  readonly dir: string;
  /** The submitted (or query-carried) form inputs. */
  readonly values: FormValues;
  /** The effective mode — the submitted one, else the auto-detected one. */
  readonly mode: DockerMode;
  /** The three files with their current state (and diffs, after a preview). */
  readonly files: readonly FileView[];
  /** `--read-only`: the write button is disabled. */
  readonly readOnly: boolean;
  /** The session CSRF token for the form's hidden field. */
  readonly csrf: string;
  /** Whether the last submit was a preview (diffs are shown). */
  readonly previewed: boolean;
  /** A refusal to show against the form. */
  readonly error?: string;
  /** Files a completed write created or regenerated. */
  readonly written?: readonly string[];
  /** Files a completed write refused to touch (hand-edited). */
  readonly refused?: readonly string[];
}

/**
 * Serve the Docker panel: the current state plus the options form on `GET`, a diff preview or a
 * sentinel-guarded write on `POST`, and the machine twin of both on `/api/docker`.
 */
export const dockerPanel: UiHandler = (
  _request: Request,
  ctx: UiContext,
): Promise<Response> => ctx.method === "POST" ? submitPanel(ctx) : showPanel(ctx);

// ── requests ─────────────────────────────────────────────────────────────────

/** `GET`: the current file states and the form, plus the result of a just-applied write. */
async function showPanel(ctx: UiContext): Promise<Response> {
  const params = ctx.url.searchParams;
  const values = formValues((key) => params.get(key) ?? "");
  const mode = await effectiveMode(ctx.dir, values);
  const files = viewOf(ctx.dir, await dockerPlan(ctx.dir, optionsOf(values, mode)), false);
  if (ctx.json) return jsonResponse({ ok: true, mode, files });
  return respond({
    dir: ctx.dir,
    values,
    mode,
    files,
    readOnly: ctx.readOnly,
    csrf: ctx.csrf,
    previewed: false,
    written: params.getAll("w"),
    refused: params.getAll("r"),
  }, ctx);
}

/** `POST`: validate the options, then diff (default) or write (`confirm=1`). */
async function submitPanel(ctx: UiContext): Promise<Response> {
  const values = formValues((key) => field(ctx, key));
  let options: DockerOptions;
  try {
    options = optionsOf(values, await validatedMode(ctx.dir, values), true);
  } catch (error) {
    return await refuse(ctx, values, error instanceof Error ? error.message : String(error), 400);
  }
  const write = field(ctx, "confirm") === "1";
  if (write && ctx.readOnly) return await refuse(ctx, values, "read-only", 403);
  const plan = await dockerPlan(ctx.dir, options);
  const files = viewOf(ctx.dir, plan, true);
  const state = {
    dir: ctx.dir,
    values,
    mode: options.mode,
    files,
    readOnly: ctx.readOnly,
    csrf: ctx.csrf,
  };
  if (!write) {
    if (ctx.json) return jsonResponse({ ok: true, mode: options.mode, files });
    return respond({ ...state, previewed: true }, ctx);
  }
  const { written, refused } = await applyPlan(ctx.dir, plan);
  if (ctx.json) {
    return jsonResponse({ ok: true, mode: options.mode, files, written, refused });
  }
  return seeResult(values, options.mode, written, refused);
}

/**
 * Write every file the plan may touch — absent, or still carrying the sentinel — and report the
 * hand-edited ones it refused. Each path goes back through {@linkcode uiSafeJoin} (lexical plus a
 * realpath re-check) even though the three names are constants: containment is checked at the
 * write, never assumed from the caller.
 */
async function applyPlan(
  dir: string,
  plan: readonly DockerPlanFile[],
): Promise<{ written: string[]; refused: string[] }> {
  const written: string[] = [];
  const refused: string[] = [];
  for (const file of plan) {
    const rel = relative(dir, file.path) || file.path;
    if (file.existing !== undefined && !file.generated) {
      refused.push(rel);
      continue;
    }
    await Deno.writeTextFile(await uiSafeJoin(dir, rel), file.contents);
    written.push(rel);
  }
  return { written, refused };
}

/** A refusal: the JSON envelope on the API twin, the panel with an error note otherwise. */
async function refuse(
  ctx: UiContext,
  values: FormValues,
  reason: string,
  status: number,
): Promise<Response> {
  if (ctx.json) return jsonResponse({ ok: false, reason }, status);
  const mode = await effectiveMode(ctx.dir, values);
  const files = viewOf(ctx.dir, await dockerPlan(ctx.dir, optionsOf(values, mode)), false);
  return respond(
    {
      dir: ctx.dir,
      values,
      mode,
      files,
      readOnly: ctx.readOnly,
      csrf: ctx.csrf,
      previewed: false,
      error: reason,
    },
    ctx,
    status,
  );
}

/** POST/redirect/GET after a write, so a reload does not regenerate. */
function seeResult(
  values: FormValues,
  mode: DockerMode,
  written: readonly string[],
  refused: readonly string[],
): Response {
  const params = new URLSearchParams({ mode, port: values.port, tag: values.tag });
  if (values.postgres) params.set("postgres", "on");
  for (const [key, paths] of [["w", written], ["r", refused]] as const) {
    for (const path of paths) params.append(key, path);
  }
  return new Response(null, { status: 303, headers: { location: `/docker?${params}` } });
}

/**
 * Answer with the panel — the whole document, or only the `<section>` when `ui.js` asked for a
 * fragment to swap in place.
 */
function respond(state: PanelState, ctx: UiContext, status = 200): Response {
  const section = panelSection(state);
  const markup = ctx.fragment ? toHtml(section) : renderPage(layout, {
    title: "Docker",
    nav: UI_NAV,
    body: section,
    csrf: state.csrf,
    active: "/docker",
  });
  return htmlResponse(markup, status);
}

// ── options ──────────────────────────────────────────────────────────────────

/** One submitted field, from a form body or the JSON twin's body (numbers/booleans included). */
function field(ctx: UiContext, key: string): string {
  const posted = ctx.form?.get(key);
  if (typeof posted === "string") return posted;
  const value = (ctx.body as Record<string, unknown> | undefined)?.[key];
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value === "string" ? value : "";
}

/** The four inputs, as submitted (or as carried in the redirect query). */
function formValues(get: (key: string) => string): FormValues {
  return {
    mode: get("mode").trim(),
    port: get("port").trim(),
    tag: get("tag").trim(),
    postgres: ["on", "1", "true", "yes"].includes(get("postgres").trim().toLowerCase()),
  };
}

/** The submitted mode when it is one, else the mode detected from the project's config. */
function effectiveMode(dir: string, values: FormValues): Promise<DockerMode> {
  if (values.mode === "server" || values.mode === "static") {
    return Promise.resolve(values.mode);
  }
  return detectDockerMode(dir);
}

/** Like {@linkcode effectiveMode}, but a mode that is neither known nor empty is a refusal. */
function validatedMode(dir: string, values: FormValues): Promise<DockerMode> {
  if (values.mode !== "" && values.mode !== "server" && values.mode !== "static") {
    return Promise.reject(
      new Error(`unknown mode "${values.mode}" (expected: server | static)`),
    );
  }
  return effectiveMode(dir, values);
}

/**
 * The template options for these inputs. `strict` validates the port and tag (a submit); without
 * it an unusable value silently falls back to the default, so rendering the form can never fail.
 */
function optionsOf(values: FormValues, mode: DockerMode, strict = false): DockerOptions {
  return {
    mode,
    port: parsePort(values.port, strict),
    denoTag: parseTag(values.tag, strict),
    postgres: values.postgres,
  };
}

/** The port field as a number in 1–65535. */
function parsePort(value: string, strict: boolean): number {
  if (value === "") return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    if (!strict) return DEFAULT_PORT;
    throw new Error(`invalid port "${value}" (expected a whole number between 1 and 65535)`);
  }
  return port;
}

/** The Deno image tag, restricted to what may appear after `denoland/deno:`. */
function parseTag(value: string, strict: boolean): string {
  if (value === "") return Deno.version.deno;
  if (!/^[\w.\-]+$/.test(value)) {
    if (!strict) return Deno.version.deno;
    throw new Error(`invalid Deno tag "${value}" (letters, digits, dot, dash and underscore only)`);
  }
  return value;
}

/** Each planned file as the panel reports it — its state, and (after a preview) its diff. */
function viewOf(
  dir: string,
  plan: readonly DockerPlanFile[],
  withDiff: boolean,
): FileView[] {
  return plan.map((file) => {
    const path = relative(dir, file.path) || file.path;
    const state: FileState = file.existing === undefined
      ? "absent"
      : file.generated
      ? "generated"
      : "edited";
    const diff = withDiff ? createUnifiedDiff(file.existing ?? "", file.contents, path) : "";
    return diff === "" ? { path, state } : { path, state, diff };
  });
}

// ── views ────────────────────────────────────────────────────────────────────

/** The whole `<section id="panel">` — the piece `ui.js` swaps. */
function panelSection(state: PanelState): RawHtml {
  const results = (state.written?.length || state.refused?.length) ? resultView(state) : "";
  return html`
    <section id="panel" data-panel="Docker">
      <h1>Docker</h1>
      <p class="lead">Regenerate <span class="mono">Dockerfile</span>,
        <span class="mono">docker-compose.yml</span> and <span class="mono">.dockerignore</span>
        for <span class="mono">${state.dir}</span>. Files you have edited by hand are never
        overwritten — their diff is shown so you can copy it across.</p>
      ${state.error ? html`<p class="note">denext ui: ${state.error}</p>` : ""}
      ${stateView(state)}
      ${formView(state)}
      ${state.previewed ? previewView(state) : ""}
      ${results}
    </section>
  `;
}

/** The three files and what would happen to each. */
function stateView(state: PanelState): RawHtml {
  const rows = state.files.map((file) =>
    html`<li><code>${file.path}</code> <span class="badge">${STATE_LABEL[file.state]}</span></li>`
  );
  return html`
    <h2>Current files</h2>
    <ul>${rows}</ul>
  `;
}

/** The mode picker, the port, the Deno tag, the Postgres toggle and the two submits. */
function formView(state: PanelState): RawHtml {
  const modes = (["server", "static"] as const).map((mode) =>
    html`
      <option value="${mode}" ${mode === state.mode
        ? raw(" selected")
        : ""}>${MODE_LABEL[mode]}</option>
    `
  );
  return html`
    <form method="post" action="/docker">
      <input type="hidden" name="${UI_CSRF_FIELD}" value="${state.csrf}">
      <fieldset>
        <label for="dk-mode">Image</label>
        <select id="dk-mode" name="mode">${modes}</select>
        <label for="dk-port">Port</label>
        <input id="dk-port" name="port" type="number" min="1" max="65535"
          value="${state.values.port || String(DEFAULT_PORT)}">
        <label for="dk-tag">Deno image tag</label>
        <input id="dk-tag" name="tag" autocomplete="off"
          value="${state.values.tag || Deno.version.deno}">
        <label for="dk-pg">
          <input id="dk-pg" name="postgres" type="checkbox" value="on"${state.values.postgres
            ? raw(" checked")
            : ""}> Include a Postgres service
        </label>
      </fieldset>
      <button type="submit" name="op" value="preview">Preview diff</button>
      <button type="submit" name="confirm" value="1" class="ghost"${state.readOnly
        ? raw(" disabled")
        : ""}>Write files</button>
      ${state.readOnly ? html`<p class="note">Read-only mode — writing is refused.</p>` : ""}
    </form>
  `;
}

/** Every file's unified diff, with the hand-edited ones flagged as refusals. */
function previewView(state: PanelState): RawHtml {
  const files = state.files.map((file) => {
    const edited = file.state === "edited";
    const badge = file.diff === undefined
      ? "no change"
      : edited
      ? "will not overwrite — copy the diff"
      : file.state === "absent"
      ? "will be created"
      : "will be regenerated";
    return html`
      <details${file.diff === undefined ? "" : raw(" open")}>
        <summary><code>${file.path}</code> <span class="badge">${badge}</span></summary>
        ${file.diff === undefined
          ? html`<p class="note">Identical to what is on disk.</p>`
          : html`<pre class="out">${file.diff}</pre>`}
      </details>
    `;
  });
  return html`<h2>Preview</h2>${files}`;
}

/** What a completed write did: the regenerated files, then the ones it left alone. */
function resultView(state: PanelState): RawHtml {
  const written = (state.written ?? []).map((path) => html`<li>+ <code>${path}</code></li>`);
  const kept = (state.refused ?? []).map((path) =>
    html`<li>• hand-edited, left alone: <code>${path}</code></li>`
  );
  return html`
    <h2>Result</h2>
    <ul>${written}${kept}</ul>
  `;
}
