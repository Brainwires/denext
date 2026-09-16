// `/docker` → the compose editor: round-trip edits of an existing compose file, service
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
// The operation set is compose-edit's closed one: adding and removing a service; image,
// restart and build (a context path, or a mapping's context / dockerfile / target / args);
// ports and volumes (a long-syntax entry key by key); environment; depends_on and its
// conditions; networks; commenting a service out / back in; the top-level volume and network
// declarations. Every posted service name,
// variable key, list index and dependency is checked against the parsed model first — the editor
// never writes a service or key the file did not report. A file the model cannot follow (several
// documents, a document marker carrying content, …) is "opaque": shown read-only, with the
// reason, next to the regeneration diff.

import {
  applyComposeEdits,
  BUILD_KEYS,
  type BuildKey,
  type ComposeModel,
  type ComposeOp,
  type ComposeService,
  DEPENDS_CONDITIONS,
  type DependsCondition,
  inspectCompose,
  readCompose,
} from "../../build/compose-edit.ts";
import { createUnifiedDiff } from "../../build/patch-diff.ts";
import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeChildren } from "../../jsx/types.ts";
import { jsonResponse, panelResponder, type UiContext } from "../html.ts";
import { DiffBlock, Note, OpForm, Out, Panel, PreviewLead, Row } from "../components.ts";
import { Raw, type RawHtml, renderView } from "../view.ts";
import { control, field as labelled, opButton } from "../form/control.ts";
import { OP_FIELD, parseOp } from "../form/value.ts";
import type { WidgetOption } from "../form/widget.ts";
import { StaleWriteError, UI_CSRF_FIELD, uiSafeJoin, writeFileAtomic } from "../security.ts";
import { DEFAULT_COMPOSE_FILE, findComposeFile } from "../../build/docker-template.ts";

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

/** How a long-syntax entry's key is written. */
type KeyType = "string" | "integer" | "boolean";

/** The keys of a long-syntax port or volume the form edits, with how each is written. */
const LONG_KEYS: Readonly<Record<"ports" | "volumes", Readonly<Record<string, KeyType>>>> = {
  ports: {
    target: "integer",
    published: "string",
    host_ip: "string",
    protocol: "string",
    mode: "string",
    name: "string",
    app_protocol: "string",
  },
  volumes: {
    type: "string",
    source: "string",
    target: "string",
    read_only: "boolean",
    consistency: "string",
  },
};
/** Keys a long-syntax entry cannot do without — clearing one is refused. */
const REQUIRED_KEYS: Readonly<Record<"ports" | "volumes", readonly string[]>> = {
  ports: ["target"],
  volumes: ["type", "target"],
};
/** Keys offered as a picker, with the choices Compose defines. */
const LONG_CHOICES: Readonly<Record<string, readonly string[]>> = {
  protocol: ["tcp", "udp"],
  mode: ["host", "ingress"],
  type: ["bind", "volume", "tmpfs", "npipe", "cluster"],
  read_only: ["true", "false"],
};
/** The form-field prefix of a long entry's keys (`port.0.target`), by field. */
const LONG_PREFIX = { ports: "port", volumes: "volume" } as const;

type Dict = Record<string, unknown>;

/** A posted field by name: a form field, or a JSON body's scalar; `null` when absent. */
type Get = (key: string) => string | null;

/** The compose file as it stands on disk, read once per request. */
interface Snapshot {
  /** Its name: the one Docker Compose would pick, else the name a new one gets. */
  readonly name: string;
  /** Its contents (`undefined` when there is none). */
  readonly text?: string;
  /** The parsed model (`null` when the file is absent or opaque). */
  readonly model: ComposeModel | null;
  /** Why the editor cannot follow the file (an opaque one only). */
  readonly reason?: string;
  /** SHA-256 hex of the contents (`""` when there is no file). */
  readonly base: string;
}

/** A snapshot the editor may act on: present and parseable. */
interface Editable {
  readonly name: string;
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
type RefusePanel = (notice: VNode, status: number) => Promise<Response>;

// ── reading ──────────────────────────────────────────────────────────────────

/** The hex SHA-256 of a file's text — the `_base` stamp. */
async function stampOf(text: string): Promise<string> {
  const data = new TextEncoder().encode(text) as BufferSource;
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read the compose file, its model and its stamp. */
async function readSnapshot(dir: string): Promise<Snapshot> {
  const name = (await findComposeFile(dir)) ?? DEFAULT_COMPOSE_FILE;
  let text: string;
  try {
    // Through the containment gate: a compose file symlinked out of the project is never read
    // into the panel (it reads as absent; a write there is refused too).
    text = await Deno.readTextFile(await uiSafeJoin(dir, name));
  } catch {
    return { name, model: null, base: "" };
  }
  const { model, reason } = inspectCompose(text);
  const base = await stampOf(text);
  return reason === undefined ? { name, text, model, base } : { name, text, model, reason, base };
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
function isRecord(value: unknown): value is Dict {
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
      reason: `there is no ${snap.name} to edit — write the Docker files first`,
      status: 400,
    };
  }
  if (snap.model === null) {
    return {
      reason: `${snap.name} is read-only here — the editor cannot follow it: ${snap.reason}`,
      status: 400,
    };
  }
  if (base !== "" && base !== snap.base) {
    return {
      reason: `${snap.name} changed on disk since this page was rendered — nothing was ` +
        "written. Reload the page and re-apply your change.",
      status: 409,
    };
  }
  return { name: snap.name, text: snap.text, model: snap.model, base: snap.base };
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
      : refusePanel(h(Refusal, { reason, diff }), status);
  if (write && ctx.readOnly) return await deny("read-only", 403);
  const file = editableFile(snap, get(BASE_FIELD) ?? get("base") ?? "");
  if ("reason" in file) return await deny(file.reason, file.status);
  const ops = requestedOps(ctx, get, file.model);
  if (typeof ops === "string") return await deny(ops, 400);
  const result = applyComposeEdits(file.text, ops, file.name);
  if (!result.ok) return await deny(result.reason, 400, result.diff);
  const outcome = outcomeOf(result.source, result.diff, write, result.notes);
  if (!write) {
    if (ctx.json) return jsonResponse({ ...outcome, base: file.base });
    const preview = {
      name: file.name,
      csrf: ctx.csrf,
      readOnly: ctx.readOnly,
      base: file.base,
      ops,
      outcome,
    };
    return panelResponse(ctx, renderView(h(ComposePreview, preview)));
  }
  const refused = result.source === file.text
    ? null
    : await writeCompose(ctx, file.name, file.text, result.source);
  if (refused) return await deny(refused.reason, refused.status);
  if (ctx.json) return jsonResponse(outcome);
  return new Response(null, {
    status: 303,
    headers: { location: `/docker?tab=services&saved=${EDITOR_VALUE}` },
  });
}

/**
 * Write the edited compose file over exactly the text the edit was based on.
 *
 * @returns `null` once written, else the refusal to answer with: a `409` when the file changed
 * after it was read, a `403` for a symlink out of the project, a permission error or a
 * read-only filesystem (a refusal at the panel, like the plugin-options writer — never a 500).
 */
async function writeCompose(
  ctx: UiContext,
  name: string,
  base: string,
  source: string,
): Promise<{ reason: string; status: number } | null> {
  try {
    await writeFileAtomic(ctx.dir, name, source, { unchangedFrom: base });
    return null;
  } catch (err) {
    return err instanceof StaleWriteError
      ? {
        reason: `${name} changed on disk while this edit was being applied — ` +
          "nothing was written.",
        status: 409,
      }
      : { reason: `could not write ${name}: ${(err as Error).message}`, status: 403 };
  }
}

/**
 * What a preview or a write of `source` reports: the edit's own notes (what an alias carried it
 * to) first, then what `docker compose up` would refuse.
 */
function outcomeOf(source: string, diff: string, applied: boolean, notes: string[]): Outcome {
  const model = readCompose(source);
  const refusals = model ? [...volumeWarnings(model), ...networkWarnings(model)] : [];
  const warnings = [...notes, ...refusals];
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
  const button = get(OP_FIELD) ?? "apply";
  if (button === "addService") return [newServiceOp(get)];
  if (get("scope") === "top") return declarationOps(get, model, button);
  const name = get("service") ?? "";
  const svc = model.services.find((s) => s.name === name);
  if (!svc) return `unknown service ${JSON.stringify(name)}`;
  if (button === "toggle") return [{ op: "toggleService", service: svc.name }];
  if (button === "removeService") return [{ op: "removeService", service: svc.name }];
  const ops = [
    ...scalarEdits(get, svc),
    ...buildEdits(get, svc),
    ...portEdits(get, svc),
    ...entryEdits(get, svc),
    ...envEdits(get, svc),
    ...conditionEdits(get, svc),
  ];
  ops.push(...additions(get, svc));
  if (button === "apply") return ops;
  const removal = removalOf(button, svc);
  return removal ? [...ops, removal] : `unknown compose operation ${JSON.stringify(button)}`;
}

/** `image` / `restart`: set when changed, delete when cleared. */
function scalarEdits(get: Get, svc: ComposeService): ComposeOp[] {
  const ops: ComposeOp[] = [];
  for (const field of ["image", "restart", "build"] as const) {
    const posted = get(field)?.trim();
    if (posted === undefined || posted === scalarOf(svc, field)) continue;
    ops.push({ op: "set", service: svc.name, field, value: posted === "" ? null : posted });
  }
  return ops;
}

/** A scalar field's current text (`""` when unset; `build` is the build context). */
function scalarOf(svc: ComposeService, field: "image" | "restart" | "build"): string {
  if (field !== "build") return svc[field] ?? "";
  if (typeof svc.build === "string") return svc.build;
  return isRecord(svc.build) ? textOf(svc.build.context) : "";
}

/** A service's build args as name/value pairs, from either form (none without a mapping). */
function argsOf(build: unknown): { key: string; value: string }[] {
  const args = isRecord(build) ? build.args : undefined;
  if (isRecord(args)) {
    return Object.entries(args).map(([key, value]) => ({ key, value: textOf(value) }));
  }
  if (!Array.isArray(args)) return [];
  return args.map((item) => {
    const text = textOf(item);
    const eq = text.indexOf("=");
    return eq === -1
      ? { key: text, value: "" }
      : { key: text.slice(0, eq), value: text.slice(eq + 1) };
  });
}

/** A mapping `build:`'s dockerfile / target and build args whose posted value changed. */
function buildEdits(get: Get, svc: ComposeService): ComposeOp[] {
  const mapping = isRecord(svc.build) ? svc.build : {};
  const service = svc.name;
  const ops: ComposeOp[] = [];
  for (const key of ["dockerfile", "target"] as const) {
    const posted = get(`build.${key}`)?.trim();
    if (posted === undefined || posted === textOf(mapping[key])) continue;
    ops.push({ op: "build", service, key, value: posted === "" ? null : posted });
  }
  argsOf(svc.build).forEach((entry, i) => {
    const value = get(`build.arg.${i}`);
    if (value !== null && value !== entry.value) {
      ops.push({ op: "buildArg", service, action: "set", key: entry.key, value });
    }
  });
  const key = get("build.arg.new.key")?.trim();
  if (key) {
    ops.push({
      op: "buildArg",
      service,
      action: "set",
      key,
      value: get("build.arg.new.value") ?? "",
    });
  }
  return ops;
}

/** The add-a-service form's operation. */
function newServiceOp(get: Get): ComposeOp {
  const image = get("new.image")?.trim();
  const build = get("new.build")?.trim();
  return {
    op: "addService",
    service: get("new.name")?.trim() ?? "",
    ...(image ? { image } : {}),
    ...(build ? { build } : {}),
  };
}

/** The declarations form: every filled add row, then the pressed ✕ (`remove:<row>:top.<kind>`). */
function declarationOps(get: Get, model: ComposeModel, button: string): ComposeOp[] | string {
  const ops: ComposeOp[] = [];
  for (const kind of ["volumes", "networks"] as const) {
    const name = get(`declare.${kind}.new`)?.trim();
    if (name) ops.push({ op: "declare", kind, action: "add", name });
  }
  if (button === "apply") return ops;
  const parsed = parseOp(button);
  const kind = parsed?.list === "top.volumes" || parsed?.list === "top.networks"
    ? (parsed.list.slice(4) as "volumes" | "networks")
    : null;
  const name = kind && parsed ? model[kind][parsed.at] : undefined;
  if (kind === null || name === undefined) {
    return `unknown compose operation ${JSON.stringify(button)}`;
  }
  return [...ops, { op: "declare", kind, action: "remove", name }];
}

/** A parsed value as a form field's text (`""` when absent). */
function textOf(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Every key of a long-syntax port or volume row whose posted value differs from the file. */
function entryEdits(get: Get, svc: ComposeService): ComposeOp[] {
  return (["ports", "volumes"] as const).flatMap((field) =>
    svc[field].flatMap((entry, index) =>
      isLong(entry) ? longRowEdits(get, svc.name, field, index, JSON.parse(entry)) : []
    )
  );
}

/** One long-syntax row's changed keys, as posted text (`checkOp` types them). */
function longRowEdits(
  get: Get,
  service: string,
  field: "ports" | "volumes",
  index: number,
  entry: Dict,
): ComposeOp[] {
  return Object.keys(LONG_KEYS[field]).flatMap((key): ComposeOp[] => {
    const posted = get(`${LONG_PREFIX[field]}.${index}.${key}`)?.trim();
    if (posted === undefined || posted === textOf(entry[key])) return [];
    return [{ op: "entry", service, field, index, key, value: posted }];
  });
}

/** Every dependency whose posted condition differs from the file's. */
function conditionEdits(get: Get, svc: ComposeService): ComposeOp[] {
  return svc.dependsOn.flatMap((name, i): ComposeOp[] => {
    const posted = get(`dep.${i}.condition`);
    if (posted === null || posted === (svc.conditions[name] ?? DEPENDS_CONDITIONS[0])) return [];
    return [{
      op: "condition",
      service: svc.name,
      value: name,
      condition: posted as DependsCondition,
    }];
  });
}

/** A short-syntax port row whose text changed. */
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
  const network = get("network.new")?.trim();
  if (network) ops.push({ op: "networks", service, action: "add", value: network });
  return ops;
}

/** The remover for a named list: the row's text, removed by value. */
function namedRemover(
  op: "dependsOn" | "volumes" | "networks",
  list: (svc: ComposeService) => readonly string[],
): (svc: ComposeService, at: number) => ComposeOp | undefined {
  return (svc, at) => {
    const value = list(svc)[at];
    return value === undefined ? undefined : { op, service: svc.name, action: "remove", value };
  };
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
  depends_on: namedRemover("dependsOn", (svc) => svc.dependsOn),
  volumes: namedRemover("volumes", (svc) => svc.volumes),
  networks: namedRemover("networks", (svc) => svc.networks),
  "build.args": (svc, at) => {
    const entry = argsOf(svc.build)[at];
    return entry && { op: "buildArg", service: svc.name, action: "delete", key: entry.key };
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
type Check = (o: Dict, svc: ComposeService, model: ComposeModel) => ComposeOp | string;

/** The closed operation set, each with its checker. */
const CHECKS: Readonly<Record<string, Check>> = {
  set: checkSet,
  ports: checkPorts,
  env: checkEnv,
  dependsOn: checkNamed,
  volumes: checkNamed,
  networks: checkNamed,
  entry: checkEntry,
  condition: checkCondition,
  build: checkBuild,
  buildArg: checkBuildArg,
  toggleService: (_o, svc) => ({ op: "toggleService", service: svc.name }),
  removeService: (_o, svc) => ({ op: "removeService", service: svc.name }),
};

/** Operations that name no existing service, each with its checker. */
const FILE_CHECKS: Readonly<Record<string, (o: Dict, model: ComposeModel) => ComposeOp | string>> =
  {
    addService: checkAddService,
    declare: checkDeclare,
  };

/**
 * Validate one posted operation against the model: a known operation, on a service the file
 * reports, naming only rows, keys and dependencies the file reports (a new variable name and a
 * new port/volume excepted — compose-edit validates those as it writes them).
 */
function checkOp(value: unknown, model: ComposeModel): ComposeOp | string {
  if (!isRecord(value)) return "a compose operation must be an object";
  if (typeof value.op === "string" && Object.hasOwn(FILE_CHECKS, value.op)) {
    return FILE_CHECKS[value.op](value, model);
  }
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

/**
 * `set`: `image` (any string, or `null`) / `restart` (a known policy, or `null`) / `build` (a
 * context path, or `null`; not over a mapping `build:`).
 */
function checkSet(o: Dict, svc: ComposeService): ComposeOp | string {
  const { field, value } = o;
  if (field !== "image" && field !== "restart" && field !== "build") {
    return `unknown field ${JSON.stringify(field ?? null)} (expected image | restart | build)`;
  }
  if (value !== null && typeof value !== "string") return `${field} needs a string or null`;
  if (field === "restart" && value !== null && !restartAllowed(value, svc)) {
    return `unknown restart policy ${JSON.stringify(value)}`;
  }
  return { op: "set", service: svc.name, field, value };
}

/** `ports`: add a mapping, or update/remove a row the file has. */
function checkPorts(o: Dict, svc: ComposeService): ComposeOp | string {
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
function checkEnv(o: Dict, svc: ComposeService): ComposeOp | string {
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

/**
 * `dependsOn` / `volumes` / `networks`: add (a dependency must be another service) or remove a
 * listed one.
 */
function checkNamed(o: Dict, svc: ComposeService, model: ComposeModel): ComposeOp | string {
  const op = o.op === "dependsOn" || o.op === "networks" ? o.op : "volumes";
  const { action, value } = o;
  if (typeof value !== "string" || value === "") return `${op} needs a value`;
  const lists = { dependsOn: svc.dependsOn, volumes: svc.volumes, networks: svc.networks };
  const listed = lists[op].includes(value);
  if (action === "remove") {
    return listed
      ? { op, service: svc.name, action, value }
      : `${op} of "${svc.name}" does not list ${value}`;
  }
  if (action !== "add") return `unknown ${op} action ${JSON.stringify(action ?? null)}`;
  if (op === "dependsOn" && !dependable(model, svc).includes(value)) {
    return `"${value}" is not another service in the compose file`;
  }
  if (op !== "dependsOn" || o.condition === undefined) {
    return { op, service: svc.name, action, value };
  }
  return isCondition(o.condition)
    ? { op, service: svc.name, action, value, condition: o.condition }
    : `unknown condition ${JSON.stringify(o.condition)}`;
}

/** `build`: a key of a mapping `build:`, set to a string or cleared. */
function checkBuild(o: Dict, svc: ComposeService): ComposeOp | string {
  const { key, value } = o;
  if (!(BUILD_KEYS as readonly unknown[]).includes(key)) {
    return `unknown build key ${JSON.stringify(key ?? null)} (expected ${BUILD_KEYS.join(" | ")})`;
  }
  if (value !== null && typeof value !== "string") {
    return `build ${String(key)} needs a string or null`;
  }
  return { op: "build", service: svc.name, key: key as BuildKey, value };
}

/** `buildArg`: set a build argument (new or listed), or delete a listed one. */
function checkBuildArg(o: Dict, svc: ComposeService): ComposeOp | string {
  const { action, key, value } = o;
  if (typeof key !== "string") return "a build argument operation needs a key";
  const service = svc.name;
  if (action === "delete") {
    return argsOf(svc.build).some((entry) => entry.key === key)
      ? { op: "buildArg", service, action, key }
      : `the build args of "${service}" have no ${key}`;
  }
  if (action !== "set") return `unknown buildArg action ${JSON.stringify(action ?? null)}`;
  return typeof value === "string"
    ? { op: "buildArg", service, action, key, value }
    : `setting ${key} needs a value`;
}

/** `addService`: a name the file does not use yet, with an optional image and build context. */
function checkAddService(o: Dict, model: ComposeModel): ComposeOp | string {
  const { service, image, build } = o;
  if (typeof service !== "string" || service === "") return "a new service needs a name";
  if (model.services.some((s) => s.name === service)) {
    return `a service named "${service}" already exists`;
  }
  if (
    (image !== undefined && typeof image !== "string") ||
    (build !== undefined && typeof build !== "string")
  ) {
    return "a new service's image and build are strings";
  }
  return {
    op: "addService",
    service,
    ...(image ? { image } : {}),
    ...(build ? { build } : {}),
  };
}

/** `declare`: declare a new top-level volume or network, or drop one the file declares. */
function checkDeclare(o: Dict, model: ComposeModel): ComposeOp | string {
  const { kind, action, name } = o;
  if (kind !== "volumes" && kind !== "networks") {
    return `unknown declaration ${JSON.stringify(kind ?? null)} (expected volumes | networks)`;
  }
  if (typeof name !== "string" || name === "") return `a ${kind} declaration needs a name`;
  if (action === "remove") {
    return model[kind].includes(name)
      ? { op: "declare", kind, action, name }
      : `the top-level ${kind}: does not declare ${name}`;
  }
  return action === "add"
    ? { op: "declare", kind, action, name }
    : `unknown declare action ${JSON.stringify(action ?? null)}`;
}

/** Whether a posted value is one of the conditions Compose defines. */
function isCondition(value: unknown): value is DependsCondition {
  return (DEPENDS_CONDITIONS as readonly unknown[]).includes(value);
}

/** `condition`: a dependency the service lists, and a condition Compose defines. */
function checkCondition(o: Dict, svc: ComposeService): ComposeOp | string {
  const { value, condition } = o;
  if (typeof value !== "string" || !svc.dependsOn.includes(value)) {
    return `depends_on of "${svc.name}" does not list ${JSON.stringify(value ?? null)}`;
  }
  if (!isCondition(condition)) return `unknown condition ${JSON.stringify(condition ?? null)}`;
  return { op: "condition", service: svc.name, value, condition };
}

/** A posted whole number (a number, or a run of digits), or undefined. */
function integerOf(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** A posted boolean (a boolean, or the words `true` / `false`), or undefined. */
function booleanOf(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  return value === false || value === "false" ? false : undefined;
}

/** A posted key value as the type the key is written as; undefined when it is not one. */
function coerceKey(value: unknown, type: KeyType): string | number | boolean | null | undefined {
  if (value === null || value === "") return null;
  if (type === "integer") return integerOf(value);
  if (type === "boolean") return booleanOf(value);
  return typeof value === "string" ? value : undefined;
}

/** The long-syntax field and entry an `entry` op names, when the service has them. */
function longField(o: Dict, svc: ComposeService): "ports" | "volumes" | string {
  const field = o.field === "ports" || o.field === "volumes" ? o.field : null;
  if (field === null) {
    return `unknown entry field ${JSON.stringify(o.field ?? null)} (expected ports | volumes)`;
  }
  const { index } = o;
  const entry = typeof index === "number" ? svc[field][index] : undefined;
  if (!Number.isInteger(index) || entry === undefined || !isLong(entry)) {
    return `${field} of "${svc.name}" has no long-syntax entry #${String(index)}`;
  }
  return field;
}

/** `entry`: a key the form knows, on a long-syntax entry the file has, typed as that key is. */
function checkEntry(o: Dict, svc: ComposeService): ComposeOp | string {
  const field = longField(o, svc);
  if (field !== "ports" && field !== "volumes") return field;
  const key = typeof o.key === "string" && Object.hasOwn(LONG_KEYS[field], o.key) ? o.key : null;
  if (key === null) return `unknown ${field} key ${JSON.stringify(o.key ?? null)}`;
  const value = coerceKey(o.value, LONG_KEYS[field][key]);
  if (value === undefined) return `${key} needs a ${LONG_KEYS[field][key]} value`;
  if (value === null && REQUIRED_KEYS[field].includes(key)) {
    return `${key} is required in a long-syntax ${field} entry`;
  }
  return { op: "entry", service: svc.name, field, index: o.index as number, key, value };
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
 * Networks an active service joins that the top-level `networks:` does not declare (the implicit
 * `default` excepted) — `docker compose up` refuses such a file.
 */
function networkWarnings(model: ComposeModel): string[] {
  return model.services.flatMap((svc) =>
    svc.commented ? [] : svc.networks
      .filter((network) => network !== "default" && !model.networks.includes(network))
      .map((network) =>
        `service "${svc.name}" joins the network "${network}", but the top-level networks: ` +
        `does not declare it — declare it under "Named volumes and networks" before running ` +
        "docker compose."
      )
  );
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
          `volumes: does not declare it — declare it under "Named volumes and networks" ` +
          "before running docker compose.",
      );
    }
  }
  return warnings;
}

// ── views ────────────────────────────────────────────────────────────────────

/** The preview page shell (a fragment for `ui.js`, the whole document otherwise). */
const panelResponse = panelResponder("Docker", "/docker");

/** Each warning as an alert note — a warning the reader must see. */
function Warnings({ warnings }: { readonly warnings: readonly string[] }): VNode {
  return h(
    Fragment,
    null,
    warnings.map((warning) => h(Note, { key: warning, role: "alert" }, warning)),
  );
}

/** A refusal against the panel, with the diff of a splice that failed to read back. */
function Refusal({ reason, diff }: { readonly reason: string; readonly diff?: string }): VNode {
  return h(
    Fragment,
    null,
    h(Note, { role: "alert" }, `denext ui: ${reason}`),
    diff ? h("p", { class: "lead" }, "The refused edit:") : null,
    diff ? h(DiffBlock, { diff }) : null,
  );
}

/** Props of {@linkcode ComposePreview}. */
interface PreviewProps {
  /** The compose file's name. */
  readonly name: string;
  /** The session CSRF token. */
  readonly csrf: string;
  /** `--read-only`: the confirm button is disabled. */
  readonly readOnly: boolean;
  /** The stamp of the file the operations were applied to. */
  readonly base: string;
  /** The validated operations the confirm form re-posts. */
  readonly ops: readonly ComposeOp[];
  /** What applying them in memory produced. */
  readonly outcome: Outcome;
}

/** The preview: nothing is written yet; the confirm form re-posts the same operations. */
function ComposePreview({ name, csrf, readOnly, base, ops, outcome }: PreviewProps): VNode {
  const fields = {
    [EDITOR_FIELD]: EDITOR_VALUE,
    [BASE_FIELD]: base,
    [OPS_FIELD]: JSON.stringify(ops),
    confirm: "1",
  };
  const label = `Write ${name}`;
  return h(
    Panel,
    { name: "Docker", title: `Edit ${name}` },
    h(PreviewLead, null),
    h(Warnings, { warnings: outcome.warnings }),
    outcome.diff ? h(DiffBlock, { diff: outcome.diff }) : null,
    outcome.diff
      ? h(OpForm, { csrf, action: "/docker", label, fields, disabled: readOnly })
      : h(Note, null, "Nothing to change — the file already reads this way."),
    h("p", null, h("a", { href: "/docker?tab=services" }, "Back to the Docker panel")),
  );
}

/**
 * The compose editor block of the Docker panel: one form per service for a parseable file, the
 * read-only file and its regeneration diff for an opaque one, a pointer for a missing one.
 *
 * @param ctx The request context (CSRF token, `--read-only`, the `?saved=` notice).
 * @param regenerated What the template would write for the panel's current options.
 * @returns The block's element tree.
 */
export async function composeSection(
  ctx: UiContext,
  regenerated: string,
  view: ComposeView = "services",
): Promise<VNode> {
  const snap = await readSnapshot(ctx.dir);
  return h(
    Fragment,
    null,
    h("h2", { id: "compose" }, `Edit ${snap.name}`),
    composeBody(ctx, snap, regenerated, view),
  );
}

/** Which half of the editor to render: the services, or the top-level names they refer to. */
export type ComposeView = "services" | "names";

/** The block under the heading, by what is on disk: nothing, an opaque file, or an editable one. */
function composeBody(
  ctx: UiContext,
  snap: Snapshot,
  regenerated: string,
  view: ComposeView,
): VNode {
  if (snap.text === undefined) {
    return h(
      "p",
      { class: "lead" },
      "There is no ",
      h("code", null, snap.name),
      " yet — write the Docker files under ",
      h("a", { href: "/docker" }, "Files"),
      ", then edit its services here.",
    );
  }
  if (snap.model === null) {
    const reason = snap.reason ?? "";
    return h(OpaqueFile, { name: snap.name, text: snap.text, reason, regenerated });
  }
  return h(ComposeEditor, {
    ctx,
    view,
    file: { name: snap.name, text: snap.text, model: snap.model, base: snap.base },
  });
}

/** An opaque file: read-only, with the reason, next to what the template would write instead. */
function OpaqueFile(
  { name, text, reason, regenerated }: {
    readonly name: string;
    readonly text: string;
    readonly reason: string;
    readonly regenerated: string;
  },
): VNode {
  const diff = createUnifiedDiff(text, regenerated, name);
  return h(
    Fragment,
    null,
    h(
      Note,
      null,
      `This ${name} is read-only here — the editor cannot follow it line by line: ${reason}. ` +
        "Edit it by hand; the regeneration diff shows what the template would write instead.",
    ),
    h("details", null, h("summary", null, "Current file"), h(Out, null, text)),
    h("h3", null, "Regeneration diff"),
    diff === "" ? h(Note, null, "Identical to the template.") : h(DiffBlock, { diff }),
  );
}

/** Props of the views that render one editable file for one request. */
interface EditorProps {
  /** The request context (CSRF token, `--read-only`, the `?saved=` notice). */
  readonly ctx: UiContext;
  /** The file, parsed. */
  readonly file: Editable;
}

/**
 * A parseable file: the notices that describe the whole file, then the half this view asks for.
 *
 * The notices (saved, sentinel, read-only) and the warnings are deliberately on BOTH views: an
 * undeclared volume is raised by a service and fixed under Names, so hiding it on either side
 * would hide it from exactly the person about to act on it.
 *
 * `?service=` narrows the services list to one — every service form already posts its own name,
 * so this only filters what is rendered, and source order is kept when it is absent.
 */
function ComposeEditor({ ctx, file, view }: EditorProps & { readonly view: ComposeView }): VNode {
  const saved = ctx.url.searchParams.get("saved") === EDITOR_VALUE;
  const only = ctx.url.searchParams.get("service");
  const services = only === null
    ? file.model.services
    : file.model.services.filter((svc) => svc.name === only);
  const notices = h(
    Fragment,
    null,
    saved ? h(Note, null, `Saved ${file.name}.`) : null,
    file.model.sentinel ? h(SentinelNote, null) : null,
    ctx.readOnly ? h(Note, null, "Read-only mode — editing is refused.") : null,
    h(Warnings, { warnings: [...volumeWarnings(file.model), ...networkWarnings(file.model)] }),
  );
  if (view === "names") {
    return h(
      Fragment,
      null,
      h(
        "p",
        { class: "lead" },
        "The top-level named volumes and networks a service may refer to. Declaring one here " +
          "does not attach it to anything — a service joins it under ",
        h("a", { href: "/docker?tab=services" }, "Services"),
        ".",
      ),
      notices,
      h(DeclarationsForm, { ctx, file }),
    );
  }
  return h(
    Fragment,
    null,
    h(
      "p",
      { class: "lead" },
      "Edit services in place: only the lines an edit touches change — comments and " +
        "everything else stay byte for byte. Every change is previewed as a diff first.",
    ),
    notices,
    only !== null && services.length === 0
      ? h(Note, { role: "alert" }, `No service named "${only}" in ${file.name}.`)
      : null,
    services.length
      ? services.map((svc) => h(ServiceForm, { key: svc.name, ctx, file, svc }))
      : only === null
      ? h("p", { class: "lead" }, "No services.")
      : null,
    h(AddServiceForm, { ctx, file }),
  );
}

/** The routing and stamp fields every compose-editor form carries, plus its own. */
function hiddenFields(ctx: UiContext, file: Editable, extra: readonly string[][] = []): VNode[] {
  return [
    [UI_CSRF_FIELD, ctx.csrf],
    [EDITOR_FIELD, EDITOR_VALUE],
    [BASE_FIELD, file.base],
    ...extra,
  ].map(([name, value]) => h("input", { key: name, name, type: "hidden", value }));
}

/** One labelled text input of a form (the form renderer's controls). */
function labelledInput(
  id: string,
  name: string,
  label: string,
  value: string,
  placeholder: string,
): VNode {
  const body = control({ tag: "input", name, id, value, placeholder });
  return h(Raw, { key: name, html: labelled({ id, label, body }) });
}

/** A new service: a name plus an image, a build context, or both. */
function AddServiceForm({ ctx, file }: EditorProps): VNode {
  const id = "compose-new-service";
  return h(
    "form",
    { method: "post", action: "/docker", id, class: "step" },
    hiddenFields(ctx, file),
    h(
      Row,
      null,
      h("h3", { class: "grow flush" }, "Add a service"),
      h(SubmitButton, {
        value: "addService",
        label: "Preview new service",
        disabled: ctx.readOnly,
      }),
    ),
    labelledInput(`${id}-name`, "new.name", "name", "", "e.g. cache"),
    labelledInput(`${id}-image`, "new.image", "image", "", "e.g. redis:7"),
    labelledInput(`${id}-build`, "new.build", "build", "", "or a build context, e.g. ./worker"),
  );
}

/** The top-level named volumes and networks: a ✕ per declaration and an add row for each. */
function DeclarationsForm({ ctx, file }: EditorProps): VNode {
  const disabled = ctx.readOnly;
  const list = (kind: "volumes" | "networks", noun: string) => {
    const rows = file.model[kind].map((name, i) =>
      h(
        Row,
        { key: name },
        h("code", { class: "grow" }, name),
        removeButton(`top.${kind}`, i, `Drop the ${noun} ${name}`, disabled),
      )
    );
    const add = h(
      Row,
      null,
      textInput(`declare.${kind}.new`, `New ${noun}`, "", `declare — a ${noun} name`),
    );
    return h(ListEditor, { legend: `top-level ${kind}:`, rows, add });
  };
  return h(
    "form",
    { method: "post", action: "/docker", id: "compose-declarations", class: "step" },
    hiddenFields(ctx, file, [["scope", "top"]]),
    h(
      Row,
      null,
      h("h3", { class: "grow flush" }, "Named volumes and networks"),
      h(SubmitButton, { value: "apply", label: "Preview changes", disabled }),
    ),
    list("volumes", "volume"),
    list("networks", "network"),
  );
}

/** Why an edit made here is lost to the next regeneration while the sentinel is present. */
function SentinelNote(): VNode {
  return h(
    Note,
    null,
    "This file still carries the generated-file header, so ",
    h("strong", null, "Write files"),
    " above regenerates it and discards edits made here — delete that first line to keep them.",
  );
}

/** One service's form: the routing/stamp hidden fields, then its editable or commented body. */
function ServiceForm(
  { ctx, file, svc }: EditorProps & { readonly svc: ComposeService },
): VNode {
  const id = `compose-${svc.name}`;
  const hidden = hiddenFields(ctx, file, [["service", svc.name]]);
  const disabled = ctx.readOnly;
  return h(
    "form",
    { method: "post", action: "/docker", id, class: "step" },
    hidden,
    svc.commented
      ? h(CommentedService, { svc, disabled })
      : h(ActiveService, { model: file.model, svc, id, disabled }),
  );
}

/** Props of one `op` submit button. */
interface SubmitProps {
  /** The operation it posts. */
  readonly value: string;
  /** Its label. */
  readonly label: string;
  /** Render disabled (`--read-only`). */
  readonly disabled: boolean;
  /** The secondary look. */
  readonly ghost?: boolean;
}

/** One `op` submit button. */
function SubmitButton({ value, label, disabled, ghost }: SubmitProps): VNode {
  const className = ghost ? "ghost" : undefined;
  return h("button", { type: "submit", name: OP_FIELD, value, class: className, disabled }, label);
}

/** The service heading with its buttons (first in the form, so Enter previews). */
function HeadRow(
  { svc, badge, children }: {
    readonly svc: ComposeService;
    readonly badge: string;
    readonly children?: VNodeChildren;
  },
): VNode {
  return h(
    Row,
    null,
    h(
      "h3",
      { class: "grow flush" },
      h("code", null, svc.name),
      " ",
      h("span", { class: "badge" }, badge),
    ),
    children,
  );
}

/** A commented-out service: a summary and the Enable button (the only edit it accepts). */
function CommentedService(
  { svc, disabled }: { readonly svc: ComposeService; readonly disabled: boolean },
): VNode {
  const parts = [
    svc.image ? `image ${svc.image}` : "",
    svc.ports.length ? `ports ${svc.ports.join(", ")}` : "",
    svc.environment.length ? `environment ${svc.environment.map((e) => e.key).join(", ")}` : "",
    svc.volumes.length ? `volumes ${svc.volumes.join(", ")}` : "",
  ].filter((part) => part !== "");
  return h(
    Fragment,
    null,
    h(
      HeadRow,
      { svc, badge: `commented out · line ${svc.line}` },
      h(SubmitButton, { value: "toggle", label: "Enable", disabled }),
      h(SubmitButton, { value: "removeService", label: "Remove", disabled, ghost: true }),
    ),
    h("p", { class: "lead" }, parts.length ? parts.join(" · ") : "An empty service block."),
  );
}

/** Props of the views that edit one active service. */
interface ServiceProps {
  /** The file's model (the dependency picker offers its other services). */
  readonly model: ComposeModel;
  /** The service. */
  readonly svc: ComposeService;
  /** Render every button disabled (`--read-only`). */
  readonly disabled: boolean;
}

/** An active service: image, restart and the four list editors. */
function ActiveService(props: ServiceProps & { readonly id: string }): VNode {
  const { svc, id, disabled } = props;
  return h(
    Fragment,
    null,
    h(
      HeadRow,
      { svc, badge: `line ${svc.line}` },
      h(SubmitButton, { value: "apply", label: "Preview changes", disabled }),
      h(SubmitButton, { value: "toggle", label: "Comment out", disabled, ghost: true }),
      h(SubmitButton, { value: "removeService", label: "Remove", disabled, ghost: true }),
    ),
    provenanceNote(svc),
    h(ScalarFields, { svc, id, disabled }),
    h(PortsEditor, { svc, id, disabled }),
    h(EnvEditor, { svc, disabled }),
    h(DepsEditor, { model: props.model, svc, disabled }),
    h(EntryListEditor, {
      list: "volumes",
      entries: svc.volumes,
      addField: "volume.new",
      noun: "volume",
      placeholder: "add — ./data:/data or name:/path",
      id,
      disabled,
    }),
    h(EntryListEditor, {
      list: "networks",
      entries: svc.networks,
      addField: "network.new",
      noun: "network",
      placeholder: "add — a network name",
      id,
      disabled,
    }),
  );
}

/**
 * Where a service's fields come from when the file does not spell them out in the service: a
 * merge key, an alias of another service, or a flow mapping — and what an edit does about it.
 */
function provenanceNote(svc: ComposeService): VNode | null {
  const parts: string[] = [];
  if (svc.inherited.length) {
    parts.push(
      `takes ${svc.inherited.join(", ")} from its merge key (<<) — a value set here overrides it`,
    );
  }
  if (svc.inline === "alias") {
    parts.push("is an alias of another service — the first edit gives it its own copy");
  }
  if (svc.inline === "flow") {
    parts.push("is written in flow style — the first edit rewrites it in block style");
  }
  return parts.length ? h("p", { class: "lead" }, `This service ${parts.join("; ")}.`) : null;
}

/** The picker's choices: unset, the four policies, and the file's own value when it is other. */
function restartOptions(current: string | undefined): WidgetOption[] {
  const values = [...RESTART_POLICIES];
  if (current !== undefined && !values.includes(current)) values.push(current);
  return [{ value: "", label: "— unset —" }, ...values.map((value) => ({ value, label: value }))];
}

/** `image` (text) and `restart` (select), through the form renderer's labelled controls. */
function ScalarFields(
  { svc, id, disabled }: {
    readonly svc: ComposeService;
    readonly id: string;
    readonly disabled: boolean;
  },
): VNode {
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
  return h(
    Fragment,
    null,
    h(Raw, { html: labelled({ id: `${id}-image`, label: "image", body: image }) }),
    h(Raw, { html: labelled({ id: `${id}-restart`, label: "restart", body: restart }) }),
    h(BuildEditor, { svc, id, disabled }),
  );
}

/**
 * `build`: the context, the Dockerfile and target (setting either writes a mapping `build:`),
 * and a row editor for the build args.
 */
function BuildEditor(
  { svc, id, disabled }: {
    readonly svc: ComposeService;
    readonly id: string;
    readonly disabled: boolean;
  },
): VNode {
  const mapping = isRecord(svc.build) ? svc.build : {};
  return h(
    Fragment,
    null,
    labelledInput(
      `${id}-build`,
      "build",
      "build",
      scalarOf(svc, "build"),
      "optional — a build context path, e.g. .",
    ),
    labelledInput(
      `${id}-dockerfile`,
      "build.dockerfile",
      "dockerfile",
      textOf(mapping.dockerfile),
      "optional — e.g. Dockerfile.prod",
    ),
    labelledInput(
      `${id}-target`,
      "build.target",
      "target",
      textOf(mapping.target),
      "optional — a build stage",
    ),
    h(VarsEditor, {
      legend: "build args",
      entries: argsOf(svc.build),
      prefix: "build.arg",
      list: "build.args",
      noun: "build argument ",
      disabled,
    }),
  );
}

/** One text input with an accessible name (the form renderer's control). */
function textInput(name: string, label: string, value = "", placeholder?: string): VNode {
  return h(Raw, { html: control({ tag: "input", name, value, placeholder, ariaLabel: label }) });
}

/** A row's ✕ button — a `remove:<row>:<list>` submit (the form renderer's row button). */
function removeButton(list: string, at: number, title: string, disabled: boolean): VNode {
  return h(Raw, { html: opButton({ op: "remove", at, list, label: "✕", title, disabled }) });
}

/** A list editor: its legend, its rows (or "none"), then its add row. */
function ListEditor(
  { legend, rows, add }: {
    readonly legend: string;
    readonly rows: VNode[];
    readonly add: VNodeChild;
  },
): VNode {
  return h(
    "fieldset",
    null,
    h("legend", null, legend),
    rows.length ? rows : h("p", { class: "lead flush-sm" }, "none"),
    add,
  );
}

/** Props of {@linkcode LongEntry}. */
interface LongEntryProps {
  /** The field the entry belongs to. */
  readonly field: "ports" | "volumes";
  /** Its position in the field. */
  readonly index: number;
  /** The entry as parsed. */
  readonly entry: Dict;
  /** The service form's id (control ids derive from it). */
  readonly id: string;
  /** `--read-only`. */
  readonly disabled: boolean;
}

/** A key picker's choices: unset, Compose's, and the file's own value when it is other. */
function choiceOptions(choices: readonly string[], current: string): WidgetOption[] {
  const values = current !== "" && !choices.includes(current) ? [...choices, current] : choices;
  return [{ value: "", label: "— unset —" }, ...values.map((value) => ({ value, label: value }))];
}

/** One key's control: a picker where Compose fixes the choices, else a text input. */
function longControl(name: string, id: string, key: string, current: unknown): RawHtml {
  const value = textOf(current);
  const choices = LONG_CHOICES[key];
  if (!choices) return control({ tag: "input", name, id, value, placeholder: "unset" });
  return control({ tag: "select", name, id, value, options: choiceOptions(choices, value) });
}

/**
 * A long-syntax port or volume row: a labelled control per key the form knows, the keys it does
 * not know named as kept (a write never touches them), and the row's ✕.
 */
function LongEntry({ field, index, entry, id, disabled }: LongEntryProps): VNode {
  const prefix = LONG_PREFIX[field];
  const controls = Object.keys(LONG_KEYS[field]).map((key) => {
    const cid = `${id}-${prefix}-${index}-${key}`;
    const body = longControl(`${prefix}.${index}.${key}`, cid, key, entry[key]);
    return h(Raw, { key, html: labelled({ id: cid, label: key, body }) });
  });
  const kept = Object.keys(entry).filter((key) => !Object.hasOwn(LONG_KEYS[field], key));
  return h(
    Row,
    { key: index },
    h(
      "div",
      { class: "grow" },
      controls,
      kept.length ? h(Note, null, `Kept as written: ${kept.join(", ")}.`) : null,
    ),
    removeButton(field, index, `Remove ${prefix} entry ${index + 1}`, disabled),
  );
}

/** `ports`: an editable row per mapping (a long-syntax one key by key), plus an add row. */
function PortsEditor(
  { svc, id, disabled }: Omit<ServiceProps, "model"> & { readonly id: string },
): VNode {
  const rows = svc.ports.map((port, i) =>
    isLong(port)
      ? h(LongEntry, { key: i, field: "ports", index: i, entry: JSON.parse(port), id, disabled })
      : h(
        Row,
        { key: i },
        textInput(`port.${i}`, `Port mapping ${i + 1}`, port),
        removeButton("ports", i, `Remove port ${port}`, disabled),
      )
  );
  const add = h(Row, null, textInput("port.new", "New port mapping", "", "add — host:container"));
  return h(ListEditor, { legend: "ports", rows, add });
}

/** `environment`: a value row per variable, plus a name/value add row. */
function EnvEditor({ svc, disabled }: Omit<ServiceProps, "model">): VNode {
  return h(VarsEditor, {
    legend: `environment (${svc.envForm} form)`,
    entries: svc.environment,
    prefix: "env",
    list: "environment",
    noun: "",
    disabled,
  });
}

/** Props of {@linkcode VarsEditor}. */
interface VarsProps {
  /** The fieldset's legend. */
  readonly legend: string;
  /** The pairs, in order. */
  readonly entries: readonly { key: string; value: string }[];
  /** The form-field prefix (`env`, `build.arg`). */
  readonly prefix: string;
  /** The remove buttons' list name. */
  readonly list: string;
  /** What one pair is called, for labels (`""` for an environment variable). */
  readonly noun: string;
  /** `--read-only`. */
  readonly disabled: boolean;
}

/**
 * A KEY = value row editor: the name, an editable value and a ✕ per pair, then a name/value add
 * row. `environment` and a build's `args` are both written this way.
 */
function VarsEditor({ legend, entries, prefix, list, noun, disabled }: VarsProps): VNode {
  const rows = entries.map((entry, i) =>
    h(
      Row,
      { key: entry.key },
      h("code", null, entry.key),
      textInput(`${prefix}.${i}`, `Value of ${noun}${entry.key}`, entry.value),
      removeButton(list, i, `Remove ${noun}${entry.key}`, disabled),
    )
  );
  const named = noun === "" ? "variable " : noun;
  const add = h(
    Row,
    null,
    textInput(`${prefix}.new.key`, `New ${named}name`, "", "add — NAME"),
    textInput(`${prefix}.new.value`, `New ${named}value`, "", "value"),
  );
  return h(ListEditor, { legend, rows, add });
}

/** `depends_on`: a chip per dependency, plus a select of the other services. */
function DepsEditor({ model, svc, disabled }: ServiceProps): VNode {
  const chips = svc.dependsOn.map((name, i) =>
    h(
      "span",
      { key: name, class: "badge" },
      h("code", null, name),
      " ",
      conditionPicker(svc, name, i),
      " ",
      removeButton("depends_on", i, `Stop depending on ${name}`, disabled),
    )
  );
  const candidates = dependable(model, svc);
  const options: WidgetOption[] = [
    { value: "", label: "— add a dependency —" },
    ...candidates.map((value) => ({ value, label: value })),
  ];
  const picker = control({
    tag: "select",
    name: "dep.new",
    options,
    ariaLabel: "Add a dependency",
  });
  const add = candidates.length ? h(Row, null, h(Raw, { html: picker })) : null;
  return h(ListEditor, {
    legend: "depends_on",
    rows: chips.length ? [h(Row, null, chips)] : [],
    add,
  });
}

/**
 * What one dependency waits for: Compose's conditions, plus the file's own value when it is
 * other. Choosing one on a short `depends_on` list rewrites it in the long form.
 */
function conditionPicker(svc: ComposeService, name: string, i: number): VNode {
  const current = svc.conditions[name] ?? DEPENDS_CONDITIONS[0];
  const options: WidgetOption[] = DEPENDS_CONDITIONS.map((value) => ({ value, label: value }));
  if (!isCondition(current)) options.push({ value: current, label: current });
  const html = control({
    tag: "select",
    name: `dep.${i}.condition`,
    value: current,
    options,
    ariaLabel: `Condition for ${name}`,
  });
  return h(Raw, { html });
}

/** Props of {@linkcode EntryListEditor}. */
interface EntryListProps {
  /** The field it edits (also the remove buttons' list name). */
  readonly list: "volumes" | "networks";
  /** The service's entries, in order. */
  readonly entries: readonly string[];
  /** The add row's field name. */
  readonly addField: string;
  /** What one entry is called, for labels. */
  readonly noun: string;
  /** The add row's placeholder. */
  readonly placeholder: string;
  /** The service form's id (a long-syntax volume's control ids derive from it). */
  readonly id: string;
  /** `--read-only`. */
  readonly disabled: boolean;
}

/**
 * A list of plain entries (`volumes`, `networks`): a remove button per row and an add row. A
 * long-syntax volume is edited key by key.
 */
function EntryListEditor(props: EntryListProps): VNode {
  const { list, entries, addField, noun, placeholder, id, disabled } = props;
  const rows = entries.map((entry, i) =>
    list === "volumes" && isLong(entry)
      ? h(LongEntry, { key: entry, field: list, index: i, entry: JSON.parse(entry), id, disabled })
      : h(
        Row,
        { key: entry },
        h("code", { class: "grow" }, entry),
        removeButton(list, i, `Remove ${noun} ${entry}`, disabled),
      )
  );
  const add = h(Row, null, textInput(addField, `New ${noun}`, "", placeholder));
  return h(ListEditor, { legend: list, rows, add });
}
