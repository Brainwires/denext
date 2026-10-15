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
// Regenerating re-applies the options by re-rendering the templates. An existing
// `docker-compose.yml` is ALSO editable in place, service by service, below the form: that
// round-trip editor lives in `docker-compose.ts` (its POSTs carry `editor=compose` and are
// routed there), and it splices lines through `src/build/compose-edit.ts` rather than
// regenerating. A compose file the editor cannot follow is "opaque" and stays read-only.

import { relative } from "@std/path";
import { readCompose } from "../../build/compose-edit.ts";
import { denoReleaseVersion } from "../../build/deno-version.ts";
import {
  COMPOSE_FILE_NAMES,
  type DockerMode,
  type DockerOptions,
  dockerPlan,
  type DockerPlanFile,
  renderCompose,
} from "../../build/docker-template.ts";
import {
  type DockerRequest,
  resolveDocker,
  STACK_FEATURES,
  type StackDetection,
  type StackFeature,
} from "../../build/docker-detect.ts";
import { createUnifiedDiff } from "../../build/patch-diff.ts";
import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { jsonResponse, panelResponder, type UiContext, type UiHandler } from "../html.ts";
import {
  Badge,
  type BadgeTone,
  CsrfField,
  DiffBlock,
  FileDetails,
  Note,
  Panel,
  type ResultGroup,
  ResultList,
  Tabs,
} from "../components.ts";
import { renderView } from "../view.ts";
import { writeFileAtomic } from "../security.ts";
import { composeJson, composeSection, composeSubmit, isComposeSubmit } from "./docker-compose.ts";

/**
 * The panel's three views. The page used to stack all of them — the three files' states, the
 * regeneration form, every service's form, and the named volumes/networks — which is a lot of
 * unrelated machinery to scroll past to reach the one thing you came for.
 *
 * `files` is the default, so a bare `/docker` is the regeneration panel it has always been.
 */
const DOCKER_TABS = ["files", "services", "names"] as const;

/** One of {@linkcode DOCKER_TABS}. */
type DockerTab = typeof DOCKER_TABS[number];

/** What each tab is called in the strip. */
const TAB_LABEL: Record<DockerTab, string> = {
  files: "Files",
  services: "Services",
  names: "Names",
};

/**
 * Which view this request is for: `?tab=`, or `files` when it says nothing recognisable.
 *
 * A compose write redirects with `?tab=services&saved=compose`. Any `?saved=` selects the
 * services view even without `?tab=`, so a link saved before this split — or one that drops the
 * tab — still lands on the editor that produced it rather than on the regeneration form.
 *
 * @param ctx The request context.
 * @returns The tab to render.
 */
function tabOf(ctx: UiContext): DockerTab {
  const asked = ctx.url.searchParams.get("tab");
  if (DOCKER_TABS.includes(asked as DockerTab)) return asked as DockerTab;
  return ctx.url.searchParams.has("saved") ? "services" : "files";
}

/** The tab strip, with the current view marked. */
function DockerTabs({ tab }: { readonly tab: DockerTab }): VNode {
  return h(Tabs, {
    items: DOCKER_TABS.map((name) => ({
      href: name === "files" ? "/docker" : `/docker?tab=${name}`,
      label: TAB_LABEL[name],
    })),
    active: tab === "files" ? "/docker" : `/docker?tab=${tab}`,
    label: "Docker views",
  });
}

/** The port the form suggests (and the templates' own default). */
const DEFAULT_PORT = 3000;

/** What the two image modes are called in the picker. */
const MODE_LABEL: Record<DockerMode, string> = {
  server: "server — build + `deno task start` (App Router / SSR)",
  static: "static — `deno task export` + a file server (SPA)",
};

/**
 * How a generated file compares to what is on disk. `edited` is hand-edited (no sentinel) — for
 * the compose file that also means the editor can follow it; `opaque` is a hand-edited compose
 * file the editor cannot follow (several documents, …), shown read-only.
 */
type FileState = "absent" | "generated" | "edited" | "opaque";

/** How each state reads: absent is a to-do, a hand-edit is a fact, opaque is a caution. */
const STATE_TONE: Record<FileState, BadgeTone> = {
  absent: "todo",
  generated: "ok",
  edited: "info",
  opaque: "warn",
};

/** What each state means, next to the file's name. */
const STATE_LABEL: Record<FileState, string> = {
  absent: "not present — will be created",
  generated: "generated — safe to regenerate",
  edited: "hand-edited — will not be overwritten",
  opaque: "hand-edited, YAML the editor cannot follow — read-only, will not be overwritten",
};

/** One of the three files, as the panel and the JSON twin report it. */
interface FileView {
  /** Project-relative path. */
  readonly path: string;
  /** Absent, still generated, hand-edited, or (compose only) hand-edited and opaque. */
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
  /**
   * Whether the stack switches below were submitted. A first load (or a link without them) has
   * none, so the stack is the detected one; a submitted form says exactly what it wants.
   */
  readonly explicit: boolean;
  /** Each stack service's checkbox (only meaningful when {@linkcode explicit}). */
  readonly features: Readonly<Record<StackFeature, boolean>>;
  /** Publish Postgres on loopback. */
  readonly exposeDb: boolean;
  /** Also write `compose.dev.yml`. */
  readonly dev: boolean;
  /** The dashboard's log relay (it mounts the Docker socket). */
  readonly dashboardLogs: boolean;
}

/** Everything the panel renders from. */
interface PanelState {
  /** The project directory (paths are shown relative to it). */
  readonly dir: string;
  /** The submitted (or query-carried) form inputs. */
  readonly values: FormValues;
  /** The effective mode — the submitted one, else the auto-detected one. */
  readonly mode: DockerMode;
  /** The options the files below are rendered with (the stack switches resolved). */
  readonly options: DockerOptions;
  /** What the project's own files say the stack needs (the checkboxes' defaults and reasons). */
  readonly detection: StackDetection;
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
  /** A compose-editor refusal (its reason, and the diff of a splice that failed to read back). */
  readonly notice?: VNode;
  /** Files a completed write created or regenerated. */
  readonly written?: readonly string[];
  /** Files a completed write refused to touch (hand-edited). */
  readonly refused?: readonly string[];
}

/**
 * Serve the Docker panel: the current state plus the options form on `GET`, a diff preview or a
 * sentinel-guarded write on `POST` (a compose-editor preview or write when the POST carries
 * `editor=compose`), and the machine twin of both on `/api/docker`.
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
  const { options, detection } = await resolvedOf(ctx.dir, values);
  const mode = options.mode;
  const files = viewOf(ctx.dir, await dockerPlan(ctx.dir, options), false);
  if (ctx.json) {
    return jsonResponse({
      ok: true,
      mode,
      stack: stackJson(options, detection),
      files,
      ...await composeJson(ctx.dir),
    });
  }
  return await respond({
    dir: ctx.dir,
    values,
    mode,
    options,
    detection,
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
  if (isComposeSubmit(ctx)) {
    const defaults = formValues(() => "");
    return await composeSubmit(
      ctx,
      (notice, status) => renderPanel(ctx, defaults, { notice }, status),
    );
  }
  const values = formValues((key) => field(ctx, key));
  let options: DockerOptions;
  let detection: StackDetection;
  try {
    ({ options, detection } = await resolvedOf(ctx.dir, values, true));
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
    options,
    detection,
    files,
    readOnly: ctx.readOnly,
    csrf: ctx.csrf,
  };
  if (!write) {
    if (ctx.json) {
      return jsonResponse({
        ok: true,
        mode: options.mode,
        stack: stackJson(options, detection),
        files,
      });
    }
    return await respond({ ...state, previewed: true }, ctx);
  }
  const { written, refused } = await applyPlan(ctx.dir, plan);
  if (ctx.json) {
    return jsonResponse({
      ok: true,
      mode: options.mode,
      stack: stackJson(options, detection),
      files,
      written,
      refused,
    });
  }
  return seeResult(values, options.mode, written, refused);
}

/**
 * Write every file the plan may touch — absent, or still carrying the sentinel — and report the
 * hand-edited ones it refused. Each path goes back through {@linkcode writeFileAtomic}, which
 * re-checks containment (lexical plus a realpath re-check) even though the three names are
 * constants, and writes through a `.tmp` + rename so a reader never sees half a Dockerfile.
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
    await writeFileAtomic(dir, rel, file.contents);
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
  return await renderPanel(ctx, values, { error: reason }, status);
}

/** The panel in its resting state (no preview), with a refusal shown against it. */
async function renderPanel(
  ctx: UiContext,
  values: FormValues,
  refusal: { readonly error?: string; readonly notice?: VNode },
  status: number,
): Promise<Response> {
  const { options, detection } = await resolvedOf(ctx.dir, values);
  const files = viewOf(ctx.dir, await dockerPlan(ctx.dir, options), false);
  return await respond(
    {
      dir: ctx.dir,
      values,
      mode: options.mode,
      options,
      detection,
      files,
      readOnly: ctx.readOnly,
      csrf: ctx.csrf,
      previewed: false,
      ...refusal,
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
  if (values.explicit) {
    params.set("stack", "1");
    for (const f of STACK_FEATURES) if (values.features[f]) params.set(f, "on");
  }
  if (values.exposeDb) params.set("expose-db", "on");
  if (values.dev) params.set("dev", "on");
  if (values.dashboardLogs) params.set("dashboard-logs", "on");
  for (const [key, paths] of [["w", written], ["r", refused]] as const) {
    for (const path of paths) params.append(key, path);
  }
  return new Response(null, { status: 303, headers: { location: `/docker?${params}` } });
}

/** The panel shell: the bare section for `ui.js`, the whole document for a navigation. */
const panelResponse = panelResponder("Docker", "/docker");

/**
 * Answer with the panel — the whole document, or only the `<section>` when `ui.js` asked for a
 * fragment to swap in place. The compose editor block is read fresh from disk each time.
 */
async function respond(state: PanelState, ctx: UiContext, status = 200): Promise<Response> {
  const tab = tabOf(ctx);
  const compose = tab === "files"
    ? null
    : await composeSection(ctx, renderCompose(state.options), tab);
  return panelResponse(
    ctx,
    renderView(h(DockerPanel, { state, compose, tab })),
    status,
    `Docker · ${TAB_LABEL[tab]}`,
  );
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

/** Whether a checkbox-style field is on. */
function isOn(value: string): boolean {
  return ["on", "1", "true", "yes"].includes(value.trim().toLowerCase());
}

/** The inputs, as submitted (or as carried in the redirect query). */
function formValues(get: (key: string) => string): FormValues {
  const features = Object.fromEntries(
    STACK_FEATURES.map((f) => [f, isOn(get(f))]),
  ) as Record<StackFeature, boolean>;
  // The form posts `stack=1` beside its checkboxes; a JSON body or a link that names any switch
  // is explicit too (`{ postgres: true }` means exactly that).
  const explicit = isOn(get("stack")) || STACK_FEATURES.some((f) => get(f) !== "");
  return {
    mode: get("mode").trim(),
    port: get("port").trim(),
    tag: get("tag").trim(),
    explicit,
    features,
    exposeDb: isOn(get("expose-db")),
    dev: isOn(get("dev")),
    dashboardLogs: isOn(get("dashboard-logs")),
  };
}

/**
 * The template options for these inputs, resolved against the project (detected mode and stack,
 * the submitted switches on top). `strict` validates the mode, port and tag and refuses a stack
 * service on the static image (a submit); without it an unusable value silently falls back to the
 * default, so rendering the form can never fail.
 */
async function resolvedOf(
  dir: string,
  values: FormValues,
  strict = false,
): Promise<{ options: DockerOptions; detection: StackDetection }> {
  const request = requestOf(values, strict);
  try {
    return await resolveDocker(dir, request);
  } catch (error) {
    if (strict) throw new Error((error as Error).message.replace(/^denext: /, ""));
    return await resolveDocker(dir, { ...request, overrides: {} });
  }
}

/** The form's mode as a Docker target: `server` | `static`, or none (detect). */
function targetOf(mode: string, strict: boolean): string | undefined {
  if (mode === "server" || mode === "static") return mode;
  if (strict && mode !== "") {
    throw new Error(`unknown mode "${mode}" (expected: server | static)`);
  }
  return undefined;
}

/** The {@linkcode DockerRequest} the inputs ask for (the switches only once submitted). */
function requestOf(values: FormValues, strict: boolean): DockerRequest {
  return {
    target: targetOf(values.mode, strict),
    overrides: values.explicit ? { ...values.features } : {},
    port: parsePort(values.port, strict),
    denoTag: parseTag(values.tag, strict),
    exposeDb: values.exposeDb,
    dev: values.dev,
    dashboardLogs: values.dashboardLogs,
  };
}

/** The stack as the JSON twin reports it: each service on/off, and why detection would add it. */
function stackJson(options: DockerOptions, detection: StackDetection): Record<string, unknown> {
  return {
    ...Object.fromEntries(STACK_FEATURES.map((f) => [f, options[f] === true])),
    exposeDb: options.exposeDb === true,
    dev: options.dev === true,
    dashboardLogs: options.dashboardLogs === true,
    detected: detection.features,
    reasons: detection.reasons,
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
  if (value === "") return denoReleaseVersion(Deno.version.deno);
  if (!/^[\w.\-]+$/.test(value)) {
    if (!strict) return denoReleaseVersion(Deno.version.deno);
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
    const state = stateOf(file, path);
    const diff = withDiff ? createUnifiedDiff(file.existing ?? "", file.contents, path) : "";
    return diff === "" ? { path, state } : { path, state, diff };
  });
}

/** One planned file's state; a hand-edited compose file is `opaque` when the editor bails. */
function stateOf(file: DockerPlanFile, path: string): FileState {
  if (file.existing === undefined) return "absent";
  if (file.generated) return "generated";
  return COMPOSE_FILE_NAMES.includes(path) && readCompose(file.existing) === null
    ? "opaque"
    : "edited";
}

// ── views ────────────────────────────────────────────────────────────────────

/** Every view below renders from the one panel state. */
interface ViewProps {
  /** The panel state. */
  readonly state: PanelState;
}

/** The whole `<section id="panel">` — the piece `ui.js` swaps. */
function DockerPanel(
  { state, compose, tab }: {
    readonly state: PanelState;
    readonly compose: VNode | null;
    readonly tab: DockerTab;
  },
): VNode {
  const results = state.written?.length || state.refused?.length;
  // A refusal or a result belongs to the view whose form raised it, and both submits post from
  // Files — so they render there. The compose editor renders its own refusals through `compose`.
  return h(
    Panel,
    { name: "Docker", title: "Docker" },
    h(PanelLead, { dir: state.dir }),
    h(DockerTabs, { tab }),
    state.error ? h(Note, { tone: "warn" }, `denext ui: ${state.error}`) : null,
    state.notice ?? null,
    tab === "files"
      ? h(
        Fragment,
        null,
        h(FileStates, { files: state.files }),
        h(DockerForm, { state }),
        state.previewed ? h(PreviewList, { files: state.files }) : null,
        results ? h(ResultList, { groups: resultGroups(state) }) : null,
      )
      : compose,
  );
}

/** A file name in the lead, set in the monospace face. */
function mono(text: string): VNode {
  return h("span", { class: "mono" }, text);
}

/** What the panel does, and for which project. */
function PanelLead({ dir }: { readonly dir: string }): VNode {
  return h(
    "p",
    { class: "lead" },
    "Regenerate ",
    mono("Dockerfile"),
    ", ",
    "the compose file",
    " and ",
    mono(".dockerignore"),
    " for ",
    mono(dir),
    ". Files you have edited by hand are never overwritten — their diff is shown so you can " +
      "copy it across; an existing compose file's services are edited in place under Services. ",
    h("a", { href: "https://denext.dev/docs/ui#docker" }, "Docker ↗"),
  );
}

/** The three files and what would happen to each. */
function FileStates({ files }: { readonly files: readonly FileView[] }): VNode {
  const rows = files.map((file) =>
    h(
      "li",
      { key: file.path },
      h("code", null, file.path),
      " ",
      h(Badge, { tone: STATE_TONE[file.state] }, STATE_LABEL[file.state]),
    )
  );
  return h(Fragment, null, h("h2", null, "Current files"), h("ul", null, rows));
}

/** The options form: the fields, then the two submits. */
function DockerForm({ state }: ViewProps): VNode {
  return h(
    "form",
    { method: "post", action: "/docker" },
    h(CsrfField, { csrf: state.csrf }),
    h(OptionFields, { state }),
    h("button", { type: "submit", name: "op", value: "preview" }, "Preview diff"),
    " ",
    h(
      "button",
      { type: "submit", name: "confirm", value: "1", class: "ghost", disabled: state.readOnly },
      "Write files",
    ),
    state.readOnly ? h(Note, { tone: "warn" }, "Read-only mode — writing is refused.") : null,
  );
}

/** The mode picker, the port, the Deno tag and the Postgres toggle. */
function OptionFields({ state }: ViewProps): VNode {
  const modes = (["server", "static"] as const).map((mode) =>
    h("option", { key: mode, value: mode, selected: mode === state.mode }, MODE_LABEL[mode])
  );
  return h(
    "fieldset",
    null,
    h("label", { for: "dk-mode" }, "Image"),
    h("select", { id: "dk-mode", name: "mode" }, modes),
    h("label", { for: "dk-port" }, "Port"),
    h("input", {
      id: "dk-port",
      name: "port",
      type: "number",
      min: "1",
      max: "65535",
      value: state.values.port || String(DEFAULT_PORT),
    }),
    h("label", { for: "dk-tag" }, "Deno image tag"),
    h("input", {
      id: "dk-tag",
      name: "tag",
      autocomplete: "off",
      value: state.values.tag || denoReleaseVersion(Deno.version.deno),
    }),
    h(StackFields, { state }),
  );
}

/** What each stack switch adds, next to its checkbox. */
const FEATURE_LABEL: Record<StackFeature, string> = {
  postgres: "Postgres 17 service (DATABASE_URL wired into the app)",
  pgvector: "pgvector image (pgvector/pgvector:pg17)",
  storage: "MinIO S3 store + a one-shot bucket bootstrap",
  migrate: "Migrations service (denext job migrate before the app starts)",
  dashboard: "Database dashboard on 127.0.0.1:3100 (behind DASHBOARD_PASSWORD)",
};

/** One labelled checkbox, with an optional muted hint after the label. */
function Check(
  { id, name, checked, label, hint }: {
    readonly id: string;
    readonly name: string;
    readonly checked: boolean;
    readonly label: string;
    readonly hint?: string;
  },
): VNode {
  return h(
    "label",
    { for: id },
    h("input", { id, name, type: "checkbox", value: "on", checked }),
    ` ${label}`,
    hint ? h("small", null, ` — ${hint}`) : null,
  );
}

/**
 * The stack's switches, each checked as detected until the form is submitted, with the reason
 * detection gave. `stack=1` marks the checkboxes as explicit (an unchecked box posts nothing).
 */
function StackFields({ state }: ViewProps): VNode {
  const { options, detection } = state;
  return h(
    "fieldset",
    null,
    h("legend", null, "Self-hosted stack"),
    h("input", { type: "hidden", name: "stack", value: "1" }),
    STACK_FEATURES.map((f) =>
      h(Check, {
        key: f,
        id: `dk-${f}`,
        name: f,
        checked: options[f] === true,
        label: FEATURE_LABEL[f],
        hint: detection.reasons[f] ? `detected: ${detection.reasons[f]}` : "not detected",
      })
    ),
    h(Check, {
      id: "dk-expose-db",
      name: "expose-db",
      checked: options.exposeDb === true,
      label: "Publish Postgres on 127.0.0.1:5432",
    }),
    h(Check, {
      id: "dk-dev",
      name: "dev",
      checked: options.dev === true,
      label: "Write compose.dev.yml (denext dev on a bind mount)",
    }),
    h(Check, {
      id: "dk-dashboard-logs",
      name: "dashboard-logs",
      checked: options.dashboardLogs === true,
      label: "The dashboard's Logs page: a relay service that mounts the Docker socket",
    }),
    detection.warnings.map((w) => h(Note, { key: w, tone: "warn" }, w)),
  );
}

/** Every file's unified diff, with the hand-edited ones flagged as refusals. */
function PreviewList({ files }: { readonly files: readonly FileView[] }): VNode {
  return h(
    Fragment,
    null,
    h("h2", null, "Preview"),
    files.map((file) => h(FilePreview, { key: file.path, file })),
  );
}

/** One file of the preview: its path, what the write would do, and its diff. */
function FilePreview({ file }: { readonly file: FileView }): VNode {
  return h(
    FileDetails,
    {
      path: file.path,
      badge: previewBadge(file),
      tone: previewTone(file),
      open: file.diff !== undefined,
    },
    file.diff === undefined
      ? h(Note, null, "Identical to what is on disk.")
      : h(DiffBlock, { diff: file.diff }),
  );
}

/** How a preview reads: a caution when the write would refuse, else a pending change. */
function previewTone(file: FileView): BadgeTone {
  if (file.diff === undefined) return "info";
  return file.state === "edited" || file.state === "opaque" ? "warn" : "todo";
}

/** What a write would do to one file, as its preview badge says. */
function previewBadge(file: FileView): string {
  if (file.diff === undefined) return "no change";
  if (file.state === "edited" || file.state === "opaque") {
    return "will not overwrite — copy the diff";
  }
  return file.state === "absent" ? "will be created" : "will be regenerated";
}

/** What a completed write did: the regenerated files, then the ones it left alone. */
function resultGroups(state: PanelState): ResultGroup[] {
  return [
    { marker: "+ ", paths: state.written ?? [] },
    { marker: "• hand-edited, left alone: ", paths: state.refused ?? [] },
  ];
}
