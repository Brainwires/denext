// `/docker` → the compose editor: round-trip edits of an existing `docker-compose.yml`, service
// by service, through `src/build/compose-edit.ts` — never through a regeneration.
//
// Every service gets its own real `<form method="post" action="/docker">` (the Docker panel's own
// path; the hidden `editor=compose` field routes the POST here), so the editor works with
// JavaScript disabled and `ui.js` upgrades the same submits to fragment swaps. The flow is the
// config and plugin panels' two POSTs: the first decodes the form into `ComposeOp`s, applies them
// in memory to the file on disk and answers a diff preview whose confirm form carries the
// OPERATIONS (never the edited text) as a hidden field; the second re-reads the file, checks it is
// still the one the page was rendered from (`_base`, a SHA-256), re-applies the same operations
// and writes only when they still apply.
//
// The operation set is compose-edit's closed one (image, restart, ports, environment, depends_on,
// volumes, commenting a service out / back in). Every posted service name, variable key, list
// index and dependency is checked against the parsed model first — the editor never writes a
// service or key the file did not report. A file the model cannot follow (anchors, flow style,
// several documents, …) is "opaque": shown read-only, next to the regeneration diff.

import { join } from "@std/path";
import {
  applyComposeEdits,
  type ComposeModel,
  type ComposeOp,
  type ComposeService,
  readCompose,
} from "../../build/compose-edit.ts";
import { createUnifiedDiff } from "../../build/patch-diff.ts";
import {
  diffHtml,
  esc,
  html,
  jsonResponse,
  opForm,
  panelResponder,
  raw,
  type RawHtml,
  type UiContext,
} from "../html.ts";
import { control, field as labelled, opButton } from "../form/control.ts";
import { OP_FIELD, parseOp } from "../form/value.ts";
import type { WidgetOption } from "../form/widget.ts";
import { UI_CSRF_FIELD, writeFileAtomic } from "../security.ts";

/** The compose file the editor reads and writes, at the project root. */
export const COMPOSE_FILE = "docker-compose.yml";

/** The hidden field that routes a Docker-panel POST to the compose editor… */
const EDITOR_FIELD = "editor";
/** …and its value. */
const EDITOR_VALUE = "compose";
/** The optimistic-concurrency stamp every editor form carries (config.ts's `_base`, too). */
const BASE_FIELD = "_base";
/** The hidden field the confirm form re-posts the previewed operations in, as JSON. */
const OPS_FIELD = "ops";
/** How many operations one request may carry. */
const MAX_OPS = 100;
/** The restart policies the picker offers (plus "unset", plus a hand-written one). */
const RESTART_POLICIES: readonly string[] = ["no", "always", "on-failure", "unless-stopped"];

type Raw = Record<string, unknown>;

/** A posted field by name: a form field, or a JSON body's scalar; `null` when absent. */
type Get = (key: string) => string | null;

/** The compose file as it stands on disk, read once per request. */
interface Snapshot {
  /** Its contents (`undefined` when there is none). */
  readonly text?: string;
  /** The parsed model (`null` when the file is absent or opaque). */
  readonly model: ComposeModel | null;
  /** SHA-256 hex of the contents (`""` when there is no file). */
  readonly base: string;
}

/** A snapshot the editor may act on: present and parseable. */
interface Editable {
  readonly text: string;
  readonly model: ComposeModel;
  readonly base: string;
}

/** Why a submit cannot act on the file at all. */
interface Blocked {
  readonly reason: string;
  readonly status: number;
}

/** What a preview or a write reports (the JSON twin's payload, the preview page's inputs). */
interface Outcome {
  readonly ok: true;
  /** False for a preview, true once the file was written. */
  readonly applied: boolean;
  /** The file as it reads after the change. */
  readonly model: ComposeModel | null;
  /** Named volumes a service mounts that the file does not declare. */
  readonly warnings: string[];
  /** The unified diff of the change (omitted when there is none). */
  readonly diff?: string;
}

/** Re-render the whole Docker panel with a refusal notice (the Docker module supplies it). */
type RefusePanel = (notice: RawHtml, status: number) => Promise<Response>;

// ── reading ──────────────────────────────────────────────────────────────────

/** The hex SHA-256 of a file's text — the `_base` stamp. */
async function stampOf(text: string): Promise<string> {
  const data = new TextEncoder().encode(text) as BufferSource;
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read the compose file, its model and its stamp. */
async function readSnapshot(dir: string): Promise<Snapshot> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(dir, COMPOSE_FILE));
  } catch {
    return { model: null, base: "" };
  }
  return { text, model: readCompose(text), base: await stampOf(text) };
}

/**
 * The compose file's model and stamp, for the `/api/docker` twin's `GET`.
 *
 * @param dir The project root.
 * @returns `model` (`null` when the file is absent or opaque) and `base`, the SHA-256 a JSON
 * client may post back to have a stale write refused.
 */
export async function composeJson(
  dir: string,
): Promise<{ model: ComposeModel | null; base: string }> {
  const { model, base } = await readSnapshot(dir);
  return { model, base };
}

// ── the request ──────────────────────────────────────────────────────────────

/** Whether `value` is a plain object. */
function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read posted fields from the form body, else from the JSON body. */
function getter(ctx: UiContext): Get {
  const body = isRecord(ctx.body) ? ctx.body : {};
  return (key) => {
    const posted = ctx.form?.get(key);
    if (typeof posted === "string") return posted;
    const value = body[key];
    if (typeof value === "string") return value;
    return typeof value === "number" || typeof value === "boolean" ? String(value) : null;
  };
}

/**
 * Whether a Docker-panel POST is a compose-editor submit (it carries `editor=compose`) rather
 * than a regeneration.
 *
 * @param ctx The request context.
 * @returns True when {@linkcode composeSubmit} should answer it.
 */
export function isComposeSubmit(ctx: UiContext): boolean {
  return getter(ctx)(EDITOR_FIELD) === EDITOR_VALUE;
}

/** The file, when it can be edited against the stamp the page was rendered with. */
function editableFile(snap: Snapshot, base: string): Editable | Blocked {
  if (snap.text === undefined) {
    return {
      reason: `there is no ${COMPOSE_FILE} to edit — write the Docker files first`,
      status: 400,
    };
  }
  if (snap.model === null) {
    return {
      reason: `${COMPOSE_FILE} uses YAML the editor cannot follow — it is read-only here`,
      status: 400,
    };
  }
  if (base !== "" && base !== snap.base) {
    return {
      reason: `${COMPOSE_FILE} changed on disk since this page was rendered — nothing was ` +
        "written. Reload the page and re-apply your change.",
      status: 409,
    };
  }
  return { text: snap.text, model: snap.model, base: snap.base };
}

/**
 * Answer one compose-editor POST: decode the operations, validate them against the file's model,
 * apply them in memory, then answer a diff preview — or, with `confirm=1`, write the result.
 *
 * @param ctx The request context (past the kernel's origin, CSRF and `--read-only` gates).
 * @param refusePanel Re-renders the whole Docker panel with a refusal notice (HTML only).
 * @returns The preview, the JSON twin's payload, a `303` back to the panel, or a refusal.
 */
export async function composeSubmit(
  ctx: UiContext,
  refusePanel: RefusePanel,
): Promise<Response> {
  const get = getter(ctx);
  const snap = await readSnapshot(ctx.dir);
  const write = get("confirm") === "1" || get("confirm") === "true";
  const deny = (reason: string, status: number, diff?: string): Promise<Response> =>
    ctx.json
      ? Promise.resolve(jsonResponse({ ok: false, reason, model: snap.model, diff }, status))
      : refusePanel(refusalHtml(reason, diff), status);
  if (write && ctx.readOnly) return await deny("read-only", 403);
  const file = editableFile(snap, get(BASE_FIELD) ?? get("base") ?? "");
  if ("reason" in file) return await deny(file.reason, file.status);
  const ops = requestedOps(ctx, get, file.model);
  if (typeof ops === "string") return await deny(ops, 400);
  const result = applyComposeEdits(file.text, ops);
  if (!result.ok) return await deny(result.reason, 400, result.diff);
  const outcome = outcomeOf(result.source, result.diff, write);
  if (!write) {
    if (ctx.json) return jsonResponse({ ...outcome, base: file.base });
    return panelResponse(ctx, previewSection(ctx, file.base, ops, outcome));
  }
  if (result.source !== file.text) {
    await writeFileAtomic(ctx.dir, COMPOSE_FILE, result.source);
  }
  if (ctx.json) return jsonResponse(outcome);
  return new Response(null, {
    status: 303,
    headers: { location: `/docker?saved=${EDITOR_VALUE}` },
  });
}

/** What a preview or a write of `source` reports. */
function outcomeOf(source: string, diff: string, applied: boolean): Outcome {
  const model = readCompose(source);
  const warnings = model ? volumeWarnings(model) : [];
  return diff
    ? { ok: true, applied, model, warnings, diff }
    : { ok: true, applied, model, warnings };
}

// ── decoding ─────────────────────────────────────────────────────────────────

/** The `ops` field — a JSON list in a form body, or a list in a JSON body. */
function postedOps(ctx: UiContext): unknown[] | string | undefined {
  const value = ctx.form?.get(OPS_FIELD) ?? (isRecord(ctx.body) ? ctx.body[OPS_FIELD] : undefined);
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value;
  const invalid = `${OPS_FIELD} must be a JSON list of compose operations`;
  if (typeof value !== "string") return invalid;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : invalid;
  } catch {
    return invalid;
  }
}

/** The submit's operations — posted as `ops`, or decoded from a service form — all validated. */
function requestedOps(ctx: UiContext, get: Get, model: ComposeModel): ComposeOp[] | string {
  const posted = postedOps(ctx);
  const ops = posted === undefined ? formOps(get, model) : posted;
  if (typeof ops === "string") return ops;
  if (ops.length > MAX_OPS) return `at most ${MAX_OPS} compose operations per request`;
  const checked: ComposeOp[] = [];
  for (const op of ops) {
    const valid = checkOp(op, model);
    if (typeof valid === "string") return valid;
    checked.push(valid);
  }
  return checked;
}

/**
 * Decode one service form: every field that differs from the model, every filled "add" row, then
 * the pressed button's own operation (a row removal) last — so indices still name the rows the
 * page showed. The Enable/Comment-out button is its own operation.
 */
function formOps(get: Get, model: ComposeModel): ComposeOp[] | string {
  const name = get("service") ?? "";
  const svc = model.services.find((s) => s.name === name);
  if (!svc) return `unknown service ${JSON.stringify(name)}`;
  const button = get(OP_FIELD) ?? "apply";
  if (button === "toggle") return [{ op: "toggleService", service: svc.name }];
  const ops = [...scalarEdits(get, svc), ...portEdits(get, svc), ...envEdits(get, svc)];
  ops.push(...additions(get, svc));
  if (button === "apply") return ops;
  const removal = removalOf(button, svc);
  return removal ? [...ops, removal] : `unknown compose operation ${JSON.stringify(button)}`;
}

/** `image` / `restart`: set when changed, delete when cleared. */
function scalarEdits(get: Get, svc: ComposeService): ComposeOp[] {
  const ops: ComposeOp[] = [];
  for (const field of ["image", "restart"] as const) {
    const posted = get(field)?.trim();
    if (posted === undefined || posted === (svc[field] ?? "")) continue;
    ops.push({ op: "set", service: svc.name, field, value: posted === "" ? null : posted });
  }
  return ops;
}

/** A port row whose text changed (long-syntax rows are remove-only). */
function portEdits(get: Get, svc: ComposeService): ComposeOp[] {
  return svc.ports.flatMap((port, index): ComposeOp[] => {
    const value = get(`port.${index}`)?.trim();
    if (!value || value === port || isLong(port)) return [];
    return [{ op: "ports", service: svc.name, action: "update", index, value }];
  });
}

/** A variable whose value changed. */
function envEdits(get: Get, svc: ComposeService): ComposeOp[] {
  return svc.environment.flatMap((entry, index): ComposeOp[] => {
    const value = get(`env.${index}`);
    if (value === null || value === entry.value) return [];
    return [{ op: "env", service: svc.name, action: "set", key: entry.key, value }];
  });
}

/** The filled "add" rows: a port, a variable, a dependency, a volume. */
function additions(get: Get, svc: ComposeService): ComposeOp[] {
  const service = svc.name;
  const ops: ComposeOp[] = [];
  const port = get("port.new")?.trim();
  if (port) ops.push({ op: "ports", service, action: "add", value: port });
  const key = get("env.new.key")?.trim();
  if (key) ops.push({ op: "env", service, action: "set", key, value: get("env.new.value") ?? "" });
  const dependency = get("dep.new")?.trim();
  if (dependency) ops.push({ op: "dependsOn", service, action: "add", value: dependency });
  const volume = get("volume.new")?.trim();
  if (volume) ops.push({ op: "volumes", service, action: "add", value: volume });
  return ops;
}

/** How a row-removal button (`remove:<row>:<list>`) becomes an operation, per list. */
const REMOVERS: Readonly<
  Record<string, (svc: ComposeService, at: number) => ComposeOp | undefined>
> = {
  ports: (svc, at) =>
    at < svc.ports.length
      ? { op: "ports", service: svc.name, action: "remove", index: at }
      : undefined,
  environment: (svc, at) => {
    const entry = svc.environment[at];
    return entry && { op: "env", service: svc.name, action: "delete", key: entry.key };
  },
  depends_on: (svc, at) => {
    const value = svc.dependsOn[at];
    return value === undefined
      ? undefined
      : { op: "dependsOn", service: svc.name, action: "remove", value };
  },
  volumes: (svc, at) => {
    const value = svc.volumes[at];
    return value === undefined
      ? undefined
      : { op: "volumes", service: svc.name, action: "remove", value };
  },
};

/** The operation a row-removal button names, or `undefined` for anything else. */
function removalOf(button: string, svc: ComposeService): ComposeOp | undefined {
  const parsed = parseOp(button);
  if (parsed?.op !== "remove" || !Object.hasOwn(REMOVERS, parsed.list)) return undefined;
  return REMOVERS[parsed.list](svc, parsed.at);
}

// ── validation ───────────────────────────────────────────────────────────────

/** One operation's shape checked against one (model-reported) service. */
type Check = (o: Raw, svc: ComposeService, model: ComposeModel) => ComposeOp | string;

/** The closed operation set, each with its checker. */
const CHECKS: Readonly<Record<string, Check>> = {
  set: checkSet,
  ports: checkPorts,
  env: checkEnv,
  dependsOn: checkNamed,
  volumes: checkNamed,
  toggleService: (_o, svc) => ({ op: "toggleService", service: svc.name }),
};

/**
 * Validate one posted operation against the model: a known operation, on a service the file
 * reports, naming only rows, keys and dependencies the file reports (a new variable name and a
 * new port/volume excepted — compose-edit validates those as it writes them).
 */
function checkOp(value: unknown, model: ComposeModel): ComposeOp | string {
  if (!isRecord(value)) return "a compose operation must be an object";
  const op = typeof value.op === "string" && Object.hasOwn(CHECKS, value.op) ? value.op : "";
  if (op === "") return `unknown compose operation ${JSON.stringify(value.op ?? null)}`;
  const svc = model.services.find((s) => s.name === value.service);
  if (!svc) return `unknown service ${JSON.stringify(value.service ?? null)}`;
  return CHECKS[op](value, svc, model);
}

/** Whether a restart value is one the picker offers, the file's own, or `on-failure:<n>`. */
function restartAllowed(value: string, svc: ComposeService): boolean {
  return RESTART_POLICIES.includes(value) || value === svc.restart ||
    /^on-failure:\d+$/.test(value);
}

/** `set`: `image` (any string, or `null`) / `restart` (a known policy, or `null`). */
function checkSet(o: Raw, svc: ComposeService): ComposeOp | string {
  const { field, value } = o;
  if (field !== "image" && field !== "restart") {
    return `unknown field ${JSON.stringify(field ?? null)} (expected image | restart)`;
  }
  if (value !== null && typeof value !== "string") return `${field} needs a string or null`;
  if (field === "restart" && value !== null && !restartAllowed(value, svc)) {
    return `unknown restart policy ${JSON.stringify(value)}`;
  }
  return { op: "set", service: svc.name, field, value };
}

/** `ports`: add a mapping, or update/remove a row the file has. */
function checkPorts(o: Raw, svc: ComposeService): ComposeOp | string {
  const { action, index, value } = o;
  const service = svc.name;
  if (action === "add") {
    return typeof value === "string"
      ? { op: "ports", service, action, value }
      : "a port mapping needs a value";
  }
  if (action !== "remove" && action !== "update") {
    return `unknown ports action ${JSON.stringify(action ?? null)}`;
  }
  if (typeof index !== "number" || !Number.isInteger(index) || !(index in svc.ports)) {
    return `ports of "${service}" has no entry #${String(index)}`;
  }
  if (action === "remove") return { op: "ports", service, action, index };
  return typeof value === "string"
    ? { op: "ports", service, action, index, value }
    : "a port mapping needs a value";
}

/** `env`: set a variable (new or existing), or delete one the file has. */
function checkEnv(o: Raw, svc: ComposeService): ComposeOp | string {
  const { action, key, value } = o;
  if (typeof key !== "string") return "an environment operation needs a key";
  const service = svc.name;
  if (action === "delete") {
    return svc.environment.some((e) => e.key === key)
      ? { op: "env", service, action, key }
      : `environment of "${service}" has no ${key}`;
  }
  if (action !== "set") return `unknown env action ${JSON.stringify(action ?? null)}`;
  return typeof value === "string"
    ? { op: "env", service, action, key, value }
    : `setting ${key} needs a value`;
}

/** `dependsOn` / `volumes`: add (a dependency must be another service) or remove a listed one. */
function checkNamed(o: Raw, svc: ComposeService, model: ComposeModel): ComposeOp | string {
  const op = o.op === "dependsOn" ? "dependsOn" : "volumes";
  const { action, value } = o;
  if (typeof value !== "string" || value === "") return `${op} needs a value`;
  const listed = (op === "dependsOn" ? svc.dependsOn : svc.volumes).includes(value);
  if (action === "remove") {
    return listed
      ? { op, service: svc.name, action, value }
      : `${op} of "${svc.name}" does not list ${value}`;
  }
  if (action !== "add") return `unknown ${op} action ${JSON.stringify(action ?? null)}`;
  if (op === "dependsOn" && !dependable(model, svc).includes(value)) {
    return `"${value}" is not another service in ${COMPOSE_FILE}`;
  }
  return { op, service: svc.name, action, value };
}

/** The services `svc` may be made to depend on: every other one it does not list yet. */
function dependable(model: ComposeModel, svc: ComposeService): string[] {
  return model.services.map((s) => s.name)
    .filter((name) => name !== svc.name && !svc.dependsOn.includes(name));
}

// ── warnings ─────────────────────────────────────────────────────────────────

/** A long-syntax (mapping) port or volume entry, which compose-edit reports as JSON text. */
function isLong(entry: string): boolean {
  return entry.startsWith("{");
}

/** The named-volume source of a short-syntax mount (`name:/path`), or `null` for a path. */
function namedSource(entry: string): string | null {
  const colon = entry.indexOf(":");
  if (isLong(entry) || colon <= 0) return null;
  const source = entry.slice(0, colon);
  return /^[.~/$]/.test(source) ? null : source;
}

/**
 * Named volumes an active service mounts that the top-level `volumes:` does not declare —
 * enabling the generated file's commented Postgres example leaves `# volumes: denext-db:`
 * commented, and `docker compose up` refuses such a file.
 */
function volumeWarnings(model: ComposeModel): string[] {
  const warnings: string[] = [];
  for (const svc of model.services) {
    if (svc.commented) continue;
    for (const entry of svc.volumes) {
      const source = namedSource(entry);
      if (source === null || model.volumes.includes(source)) continue;
      warnings.push(
        `service "${svc.name}" mounts the named volume "${source}", but the top-level ` +
          `volumes: does not declare it — add (or uncomment) "volumes:" with "${source}:" ` +
          "before running docker compose.",
      );
    }
  }
  return warnings;
}

// ── views ────────────────────────────────────────────────────────────────────

/** The preview page shell (a fragment for `ui.js`, the whole document otherwise). */
const panelResponse = panelResponder("Docker", "/docker");

/** Each warning as an alert note. */
function warningsHtml(warnings: readonly string[]): RawHtml[] {
  return warnings.map((warning) => html`<p class="note" role="alert">${warning}</p>`);
}

/** A refusal against the panel, with the diff of a splice that failed to read back. */
function refusalHtml(reason: string, diff?: string): RawHtml {
  return html`<p class="note" role="alert">denext ui: ${reason}</p>${
    diff ? html`<p class="lead">The refused edit:</p>${diffHtml(diff)}` : ""
  }`;
}

/** The preview: nothing is written yet; the confirm form re-posts the same operations. */
function previewSection(
  ctx: UiContext,
  base: string,
  ops: readonly ComposeOp[],
  outcome: Outcome,
): RawHtml {
  const fields = {
    [EDITOR_FIELD]: EDITOR_VALUE,
    [BASE_FIELD]: base,
    [OPS_FIELD]: JSON.stringify(ops),
    confirm: "1",
  };
  const confirm = opForm(ctx.csrf, {
    action: "/docker",
    label: `Write ${COMPOSE_FILE}`,
    fields,
    disabled: ctx.readOnly,
  });
  return html`<section id="panel" data-panel="Docker">
<h1>Edit ${COMPOSE_FILE}</h1>
<p class="lead">Nothing has been written yet — review the change, then apply it.</p>
${warningsHtml(outcome.warnings)}
${
    outcome.diff
      ? html`${diffHtml(outcome.diff)}${confirm}`
      : html`<p class="note">Nothing to change — the file already reads this way.</p>`
  }
<p><a href="/docker#compose">Back to the Docker panel</a></p>
</section>`;
}

/**
 * The compose editor block of the Docker panel: one form per service for a parseable file, the
 * read-only file and its regeneration diff for an opaque one, a pointer for a missing one.
 *
 * @param ctx The request context (CSRF token, `--read-only`, the `?saved=` notice).
 * @param regenerated What the template would write for the panel's current options.
 * @returns The block's markup.
 */
export async function composeSection(ctx: UiContext, regenerated: string): Promise<RawHtml> {
  const snap = await readSnapshot(ctx.dir);
  let body: RawHtml;
  if (snap.text === undefined) {
    body = html`<p class="lead">There is no <code>${COMPOSE_FILE}</code> yet — write the Docker
      files above, then edit its services here.</p>`;
  } else if (snap.model === null) {
    body = opaqueView(snap.text, regenerated);
  } else {
    body = editorView(ctx, { text: snap.text, model: snap.model, base: snap.base });
  }
  return html`<h2 id="compose">Edit ${COMPOSE_FILE}</h2>${body}`;
}

/** An opaque file: read-only, next to what the template would write instead. */
function opaqueView(text: string, regenerated: string): RawHtml {
  const diff = createUnifiedDiff(text, regenerated, COMPOSE_FILE);
  return html`
    <p class="note">This ${COMPOSE_FILE} uses YAML the editor cannot follow line by line
      (anchors, aliases, merge keys, flow-style services, several documents or mixed line
      endings), so it is read-only here — edit it by hand. The regeneration diff shows what the
      template would write instead.</p>
    <details>
      <summary>Current file</summary>
      <pre class="out">${text}</pre>
    </details>
    <h3>Regeneration diff</h3>
    ${diff === "" ? html`<p class="note">Identical to the template.</p>` : diffHtml(diff)}
  `;
}

/** A parseable file: the notices, then one form per service in source order. */
function editorView(ctx: UiContext, file: Editable): RawHtml {
  const saved = ctx.url.searchParams.get("saved") === EDITOR_VALUE;
  const services = file.model.services;
  return html`
    <p class="lead">Edit services in place: only the lines an edit touches change — comments and
      everything else stay byte for byte. Every change is previewed as a diff first.</p>
    ${saved ? html`<p class="note">Saved ${COMPOSE_FILE}.</p>` : ""}
    ${file.model.sentinel
      ? html`<p class="note">This file still carries the generated-file header, so
        <strong>Write files</strong> above regenerates it and discards edits made here — delete
        that first line to keep them.</p>`
      : ""}
    ${ctx.readOnly ? html`<p class="note">Read-only mode — editing is refused.</p>` : ""}
    ${warningsHtml(volumeWarnings(file.model))}
    ${services.length
      ? services.map((svc) => serviceForm(ctx, file, svc))
      : html`<p class="lead">No services.</p>`}
  `;
}

/** One service's form: the routing/stamp hidden fields, then its editable or commented body. */
function serviceForm(ctx: UiContext, file: Editable, svc: ComposeService): RawHtml {
  const id = `compose-${svc.name}`;
  const hidden = [
    [UI_CSRF_FIELD, ctx.csrf],
    [EDITOR_FIELD, EDITOR_VALUE],
    ["service", svc.name],
    [BASE_FIELD, file.base],
  ].map(([name, value]) => control({ tag: "input", type: "hidden", name, value }));
  const body = svc.commented
    ? commentedBody(svc, ctx.readOnly)
    : activeBody(file.model, svc, id, ctx.readOnly);
  return html`<form method="post" action="/docker" id="${id}" class="step">${hidden}${body}</form>`;
}

/** One `op` submit button. */
function submitButton(value: string, label: string, disabled: boolean, ghost = false): RawHtml {
  const extra = `${ghost ? ' class="ghost"' : ""}${disabled ? " disabled" : ""}`;
  const attrs = `type="submit" name="${OP_FIELD}" value="${esc(value)}"${extra}`;
  return raw(`<button ${attrs}>${esc(label)}</button>`);
}

/** The service heading with its buttons (first in the form, so Enter previews). */
function headRow(svc: ComposeService, badge: string, buttons: readonly RawHtml[]): RawHtml {
  return html`<div class="row"><h3 class="grow" style="margin:0"><code>${svc.name}</code>
    <span class="badge">${badge}</span></h3>${buttons}</div>`;
}

/** A commented-out service: a summary and the Enable button (the only edit it accepts). */
function commentedBody(svc: ComposeService, disabled: boolean): RawHtml {
  const parts = [
    svc.image ? `image ${svc.image}` : "",
    svc.ports.length ? `ports ${svc.ports.join(", ")}` : "",
    svc.environment.length ? `environment ${svc.environment.map((e) => e.key).join(", ")}` : "",
    svc.volumes.length ? `volumes ${svc.volumes.join(", ")}` : "",
  ].filter((part) => part !== "");
  return html`${
    headRow(svc, `commented out · line ${svc.line}`, [
      submitButton("toggle", "Enable", disabled),
    ])
  }
    <p class="lead">${parts.length ? parts.join(" · ") : "An empty service block."}</p>`;
}

/** An active service: image, restart and the four list editors. */
function activeBody(
  model: ComposeModel,
  svc: ComposeService,
  id: string,
  disabled: boolean,
): RawHtml {
  return html`${
    headRow(svc, `line ${svc.line}`, [
      submitButton("apply", "Preview changes", disabled),
      submitButton("toggle", "Comment out", disabled, true),
    ])
  }
    ${scalarFields(svc, id)}
    ${portsBlock(svc, disabled)}
    ${envBlock(svc, disabled)}
    ${depsBlock(model, svc, disabled)}
    ${volumesBlock(svc, disabled)}`;
}

/** The picker's choices: unset, the four policies, and the file's own value when it is other. */
function restartOptions(current: string | undefined): WidgetOption[] {
  const values = [...RESTART_POLICIES];
  if (current !== undefined && !values.includes(current)) values.push(current);
  return [{ value: "", label: "— unset —" }, ...values.map((value) => ({ value, label: value }))];
}

/** `image` (text) and `restart` (select). */
function scalarFields(svc: ComposeService, id: string): RawHtml {
  const image = control({
    tag: "input",
    name: "image",
    id: `${id}-image`,
    value: svc.image ?? "",
    placeholder: svc.build === undefined ? "e.g. nginx:1.27" : "optional — built from build:",
  });
  const restart = control({
    tag: "select",
    name: "restart",
    id: `${id}-restart`,
    value: svc.restart ?? "",
    options: restartOptions(svc.restart),
  });
  return html`${labelled({ id: `${id}-image`, label: "image", body: image })}${
    labelled({
      id: `${id}-restart`,
      label: "restart",
      body: restart,
    })
  }`;
}

/** One flex row of cells. */
function row(cells: readonly RawHtml[]): RawHtml {
  return html`<div class="row">${cells}</div>`;
}

/** One text input with an accessible name. */
function textInput(name: string, label: string, value = "", placeholder?: string): RawHtml {
  return control({ tag: "input", name, value, placeholder, ariaLabel: label });
}

/** A row's ✕ button — a `remove:<row>:<list>` submit. */
function removeButton(list: string, at: number, title: string, disabled: boolean): RawHtml {
  return opButton({ op: "remove", at, list, label: "✕", title, disabled });
}

/** A list editor: its legend, its rows (or "none"), then its add row. */
function listBlock(legend: string, rows: readonly RawHtml[], add: RawHtml): RawHtml {
  return html`<fieldset><legend>${legend}</legend>${
    rows.length ? rows : html`<p class="lead" style="margin:0 0 6px">none</p>`
  }${add}</fieldset>`;
}

/** `ports`: an editable row per mapping (long syntax is remove-only), plus an add row. */
function portsBlock(svc: ComposeService, disabled: boolean): RawHtml {
  const rows = svc.ports.map((port, i) =>
    row([
      isLong(port)
        ? html`<code class="grow">${port}</code>`
        : textInput(`port.${i}`, `Port mapping ${i + 1}`, port),
      removeButton("ports", i, `Remove port ${port}`, disabled),
    ])
  );
  const add = row([textInput("port.new", "New port mapping", "", "add — host:container")]);
  return listBlock("ports", rows, add);
}

/** `environment`: a value row per variable, plus a name/value add row. */
function envBlock(svc: ComposeService, disabled: boolean): RawHtml {
  const rows = svc.environment.map((entry, i) =>
    row([
      html`<code>${entry.key}</code>`,
      textInput(`env.${i}`, `Value of ${entry.key}`, entry.value),
      removeButton("environment", i, `Remove ${entry.key}`, disabled),
    ])
  );
  const add = row([
    textInput("env.new.key", "New variable name", "", "add — NAME"),
    textInput("env.new.value", "New variable value", "", "value"),
  ]);
  return listBlock(`environment (${svc.envForm} form)`, rows, add);
}

/** `depends_on`: a chip per dependency, plus a select of the other services. */
function depsBlock(model: ComposeModel, svc: ComposeService, disabled: boolean): RawHtml {
  const chips = svc.dependsOn.map((name, i) =>
    html`<span class="badge"><code>${name}</code> ${
      removeButton(
        "depends_on",
        i,
        `Stop depending on ${name}`,
        disabled,
      )
    }</span>`
  );
  const candidates = dependable(model, svc);
  const options: WidgetOption[] = [
    { value: "", label: "— add a dependency —" },
    ...candidates.map((value) => ({ value, label: value })),
  ];
  const add = candidates.length
    ? row([control({ tag: "select", name: "dep.new", options, ariaLabel: "Add a dependency" })])
    : html``;
  return listBlock("depends_on", chips.length ? [row(chips)] : [], add);
}

/** `volumes`: a row per mount (remove-only), plus an add row. */
function volumesBlock(svc: ComposeService, disabled: boolean): RawHtml {
  const rows = svc.volumes.map((volume, i) =>
    row([
      html`<code class="grow">${volume}</code>`,
      removeButton("volumes", i, `Remove volume ${volume}`, disabled),
    ])
  );
  const add = row([textInput("volume.new", "New volume", "", "add — ./data:/data or name:/path")]);
  return listBlock("volumes", rows, add);
}
