// `/wizard` — the nine-step setup wizard that takes a fresh clone to a running dev server.
//
// Shape: the nine steps are a TABLE. Each entry inspects one aspect of the project (from a
// single {@linkcode Survey} taken per request, so nine steps do not re-read the disk nine
// times) and returns a {@linkcode StepView}: a status pill, a one-line summary, optional
// detail, and the operations it offers. Each operation that WRITES previews its change as a
// unified diff and only writes on a second, explicit confirm.
//
// Hard rule of the UI process, obeyed here: no project module is ever imported. Detection is
// filesystem probing (never `resolveProject`, which evaluates `denext.config.ts` — see the
// module note below); `denext doctor`, `deno install` and `denext dev` all run as
// subprocesses through {@linkcode runDeno}; `deno.json` and `.env*` are read as data.
//
// Everything works with JavaScript disabled: every operation is a real `<form method="post">`,
// a completed write answers `303` back to `/wizard#step-<id>`, and a preview re-renders the
// page with the diff in place. `ui.js` upgrades the same forms to fetch + panel swap.

import { createUnifiedDiff } from "../../build/patch-diff.ts";
import { setJsonValue } from "../../build/json-edit.ts";
import { frameworkFileUrl } from "../../build/bundle.ts";
import { denoVersionOk, MIN_DENO_VERSION } from "../../build/deno-version.ts";
import { generateArtifact } from "../../build/generate.ts";
import { scaffoldFiles, scaffoldProject } from "../../build/scaffold.ts";
import { sseSend } from "../../build/sse.ts";
import { type DevInfo, readDevInfo } from "../../mcp/dev-client.ts";
import { FEATURES } from "../../cli/commands/create.ts";
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
import { uiSafeJoin } from "../security.ts";
import { runDeno } from "../proc.ts";
import { envExampleSource, type EnvScan, scanEnvUsage } from "../env-scan.ts";
import { type DenoConfigFile, readDenoConfig, taskMap } from "../tasks.ts";

// ── the project survey ───────────────────────────────────────────────────────

/** How the wizard classifies the directory it was pointed at. */
type ProjectKind = "denext" | "compat" | "empty" | "other";

/** One request's reading of the project. Taken once; every step renders from it. */
interface Survey {
  /** The project directory. */
  readonly dir: string;
  /** What kind of directory this is. */
  readonly kind: ProjectKind;
  /** Its `deno.json` / `deno.jsonc`, when it has one. */
  readonly deno: DenoConfigFile | null;
  /** The wizard-managed `deno.json` keys the file is missing. */
  readonly missing: string[][];
  /** The declared tasks, `name → command`. */
  readonly tasks: Record<string, string>;
  /** The environment scan. */
  readonly env: EnvScan;
  /** A running dev server's published address, when there is one. */
  readonly dev: DevInfo | null;
  /** The App Router directory (`app` or `src/app`), or `null`. */
  readonly appDir: string | null;
  /** Whether a `deno.lock` exists (dependencies have been resolved at least once). */
  readonly hasLock: boolean;
  /** The `nodeModulesDir` setting, when the project declares one. */
  readonly nodeModulesDir: string | null;
}

/** The `deno.json` keys the wizard knows how to fill in, from the scaffold template. */
const DENO_JSON_KEYS: readonly string[][] = [
  ["imports", "denext"],
  ["imports", "denext/jsx-runtime"],
  ["imports", "denext/jsx-dev-runtime"],
  ["imports", "denext/server"],
  ["imports", "denext/client"],
  ["compilerOptions", "jsx"],
  ["compilerOptions", "jsxImportSource"],
  ["tasks", "dev"],
  ["tasks", "build"],
  ["tasks", "start"],
];

/** The scaffold's `deno.json`, parsed once — the template every merge takes its values from. */
let template: Record<string, unknown> | null = null;

/**
 * The `deno.json` `denext create` would write, as data.
 *
 * @returns The parsed template (memoised).
 */
function templateJson(): Record<string, unknown> {
  if (template === null) {
    const file = scaffoldFiles({ dir: "." }).find((f) => f.path === "deno.json");
    template = JSON.parse(file?.content ?? "{}") as Record<string, unknown>;
  }
  return template;
}

/** Read everything the nine steps need, without importing a single project module. */
async function surveyProject(dir: string): Promise<Survey> {
  const deno = await readDenoConfig(dir);
  const [entries, pkg, appDir, hasLock, dev, env] = await Promise.all([
    dirEntries(dir),
    readPackageJson(dir),
    firstExisting(dir, ["app", "src/app"]),
    exists(await safe(dir, "deno.lock")),
    readDevInfo(dir),
    scanEnvUsage(dir),
  ]);
  const missing = DENO_JSON_KEYS.filter((path) => !hasAt(deno?.data ?? null, path));
  return {
    dir,
    kind: classify(entries, deno, pkg),
    deno,
    missing,
    tasks: taskMap(deno),
    env,
    dev,
    appDir,
    hasLock,
    nodeModulesDir: stringAt(deno?.data ?? null, ["nodeModulesDir"]),
  };
}

/** Classify the directory: a denext app, a Next drop-in, an empty dir, or something else. */
function classify(
  entries: string[],
  deno: DenoConfigFile | null,
  pkg: Record<string, unknown> | null,
): ProjectKind {
  if (entries.length === 0) return "empty";
  const denextImport = stringAt(deno?.data ?? null, ["imports", "denext"]);
  const hasConfig = entries.some((name) => /^denext\.config\.(ts|mts|js|mjs)$/.test(name));
  if (denextImport !== null || hasConfig) return "denext";
  if (pkg !== null && dependsOnNext(pkg)) return "compat";
  return "other";
}

/** Whether a `package.json` declares `next` or `react` (the Next drop-in signature). */
function dependsOnNext(pkg: Record<string, unknown>): boolean {
  const deps = { ...asRecord(pkg.dependencies), ...asRecord(pkg.devDependencies) };
  return "next" in deps || "react" in deps;
}

/** A value as a plain record (`{}` when it is anything else). */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** The directory's entry names (empty when it is empty, missing, or unreadable). */
async function dirEntries(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  } catch { /* missing or unreadable — treat as empty */ }
  return names;
}

/** The project's `package.json` as data, or `null`. */
async function readPackageJson(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(JSON.parse(await Deno.readTextFile(await safe(dir, "package.json"))));
  } catch {
    return null;
  }
}

/** The first of `candidates` that exists under `dir` (absolute), or `null`. */
async function firstExisting(dir: string, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const path = await safe(dir, candidate);
    if (await exists(path)) return path;
  }
  return null;
}

/** Contained join: every path the wizard reads or writes goes through the containment gate. */
function safe(dir: string, rel: string): Promise<string> {
  return uiSafeJoin(dir, rel);
}

/** Whether `path` exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Walk `path` through nested records; `undefined` when any hop is missing. */
function valueAt(root: Record<string, unknown> | null, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Whether `path` is present (and not `undefined`). */
function hasAt(root: Record<string, unknown> | null, path: readonly string[]): boolean {
  return valueAt(root, path) !== undefined;
}

/** `path`'s value when it is a string, else `null`. */
function stringAt(root: Record<string, unknown> | null, path: readonly string[]): string | null {
  const value = valueAt(root, path);
  return typeof value === "string" ? value : null;
}

// ── the step table ───────────────────────────────────────────────────────────

/** How a step reads: green, needs work, worth a look, or purely informational. */
type StepStatus = "ok" | "todo" | "warn" | "info";

/** One operation a step offers (a real form post). */
interface StepAction {
  /** The `op` field value, validated against {@linkcode OPS} before anything runs. */
  readonly op: string;
  /** The button label. */
  readonly label: string;
  /** Extra hidden/visible fields the form carries. */
  readonly fields?: RawHtml;
  /** Post somewhere other than `/wizard` (step 8 posts to the kernel's task runner). */
  readonly action?: string;
}

/** What one step renders as. */
interface StepView {
  /** The step id (also its anchor: `#step-<id>`). */
  readonly id: string;
  /** The step heading. */
  readonly title: string;
  /** The status pill. */
  readonly status: StepStatus;
  /** The one-line summary. */
  readonly summary: string;
  /** Optional extra markup. */
  readonly detail?: RawHtml;
  /** The operations offered. */
  readonly actions: StepAction[];
}

/** The nine steps, in order. Each renders from the one survey; none of them touches disk. */
const STEPS: readonly { id: string; title: string; view: (s: Survey) => StepView }[] = [
  { id: "detect", title: "Detect the project", view: stepDetect },
  { id: "runtime", title: "Deno runtime", view: stepRuntime },
  { id: "denojson", title: "deno.json", view: stepDenoJson },
  { id: "deps", title: "Dependencies", view: stepDeps },
  { id: "env", title: "Environment variables", view: stepEnv },
  { id: "doctor", title: "Doctor", view: stepDoctor },
  { id: "features", title: "Features", view: stepFeatures },
  { id: "tasks", title: "Tasks", view: stepTasks },
  { id: "finish", title: "Finish", view: stepFinish },
];

/** What each project kind reads as in step 1. */
const KIND_SUMMARY: Record<ProjectKind, string> = {
  denext: "A denext app.",
  compat: "A Next.js app — denext runs it through the compatibility aliases.",
  empty: "An empty directory — the wizard can scaffold a new app into it.",
  other: "A directory with no denext project in it yet.",
};

/** Step 1 — what is this directory, and is a dev server already running against it? */
function stepDetect(s: Survey): StepView {
  const dev = s.dev
    ? html`<p>Dev server running at <a href="${s.dev.origin}">${s.dev.origin}</a> (pid ${s.dev.pid}).</p>`
    : html`<p class="note">No dev server is running (no <code>.denext/dev.json</code>).</p>`;
  return {
    id: "detect",
    title: "Detect the project",
    status: s.kind === "denext" ? "ok" : s.kind === "empty" ? "todo" : "info",
    summary: KIND_SUMMARY[s.kind],
    detail: html`<p class="mono">${s.dir}</p>
<p>App directory: ${s.appDir ?? "— none yet"}</p>${dev}`,
    actions: [],
  };
}

/** Step 2 — is the Deno running the UI new enough for denext? */
function stepRuntime(_s: Survey): StepView {
  const version = Deno.version.deno;
  const ok = denoVersionOk(version);
  return {
    id: "runtime",
    title: "Deno runtime",
    status: ok ? "ok" : "warn",
    summary: ok
      ? `Deno ${version} (denext needs ${MIN_DENO_VERSION} or newer).`
      : `Deno ${version} is older than the required ${MIN_DENO_VERSION} — run \`deno upgrade\`.`,
    actions: [],
  };
}

/** Step 3 — the `deno.json` denext needs: the import map, the JSX options, the three tasks. */
function stepDenoJson(s: Survey): StepView {
  const label = s.deno === null ? "Write deno.json" : "Add the missing keys";
  const missing = s.missing.map((path) => path.join("."));
  return {
    id: "denojson",
    title: "deno.json",
    status: s.deno !== null && missing.length === 0 ? "ok" : "todo",
    summary: s.deno === null
      ? "No deno.json — a denext project is configured by one."
      : missing.length === 0
      ? `${s.deno.name} declares the denext imports, the JSX options and the dev/build/start tasks.`
      : `${s.deno.name} is missing ${missing.length} key(s): ${missing.join(", ")}.`,
    actions: s.deno !== null && missing.length === 0
      ? []
      : [{ op: "denojson", label: `${label} (preview first)` }],
  };
}

/** Step 4 — are the dependencies in the import map resolved? */
function stepDeps(s: Survey): StepView {
  const npm = s.nodeModulesDir === "manual"
    ? html`<p class="note">This project sets <code>nodeModulesDir: "manual"</code>: its npm
packages come from <code>node_modules</code>, so run your package manager's install
(<code>npm install</code>) as well.</p>`
    : undefined;
  return {
    id: "deps",
    title: "Dependencies",
    status: s.hasLock ? "ok" : "todo",
    summary: s.hasLock
      ? "deno.lock exists — the import map has been resolved at least once."
      : "No deno.lock yet — `deno install` resolves and caches the import map.",
    detail: npm,
    actions: [{ op: "install", label: "Run deno install" }],
  };
}

/** Step 5 — which environment variables does the source read that nothing declares? */
function stepEnv(s: Survey): StepView {
  const { used, missing, declared, files, scanned } = s.env;
  return {
    id: "env",
    title: "Environment variables",
    status: missing.length === 0 ? "ok" : "todo",
    summary: missing.length === 0
      ? `${used.length} variable(s) read across ${scanned} file(s); all of them are declared.`
      : `${missing.length} variable(s) are read but declared nowhere: ${missing.join(", ")}.`,
    detail: html`<p>Declared in ${files.length > 0 ? files.join(", ") : "no .env file"}: ${
      declared.length > 0 ? declared.join(", ") : "—"
    }. Values are never read, and <code>.env</code> is never written.</p>`,
    actions: missing.length === 0
      ? []
      : [{ op: "envexample", label: "Write .env.example (preview first)" }],
  };
}

/** Step 6 — the full `denext doctor` report, run as a subprocess. */
function stepDoctor(s: Survey): StepView {
  const actions: StepAction[] = [{ op: "doctor", label: "Run denext doctor" }];
  if (s.appDir === null) actions.push(APP_DIR_ACTION);
  return {
    id: "doctor",
    title: "Doctor",
    status: s.appDir === null ? "todo" : "info",
    summary: s.appDir === null
      ? "There is no app/ directory yet — doctor will report the routes it cannot find."
      : "`denext doctor --json` runs in a subprocess and reports every check.",
    actions,
  };
}

/** The offer that answers doctor's "app dir missing": scaffold `app/page.tsx`. */
const APP_DIR_ACTION: StepAction = { op: "scaffold-page", label: "Create app/page.tsx" };

/** Step 7 — the scaffold feature toggles (`denext create`'s own list). */
function stepFeatures(s: Survey): StepView {
  const boxes = FEATURES.map((f) =>
    html`<label><input type="checkbox" name="feature.${f.key}"> ${f.label}</label>`
  );
  const empty = s.kind === "empty";
  return {
    id: "features",
    title: "Features",
    status: empty ? "todo" : "info",
    summary: empty
      ? "Pick the features to scaffold into this empty directory."
      : "This project already exists — these are the features `denext create` offers; add them by hand.",
    detail: empty ? undefined : html`<ul>${FEATURES.map((f) => html`<li>${f.label}</li>`)}</ul>`,
    actions: empty
      ? [{ op: "scaffold", label: "Scaffold the project", fields: html`${boxes}` }]
      : [],
  };
}

/** Step 8 — the project's own tasks, each runnable through the kernel's SSE task runner. */
function stepTasks(s: Survey): StepView {
  const names = Object.keys(s.tasks);
  return {
    id: "tasks",
    title: "Tasks",
    status: names.length > 0 ? "ok" : "todo",
    summary: names.length > 0
      ? `${names.length} task(s) declared: ${names.join(", ")}.`
      : "No tasks are declared yet — step 3 adds dev, build and start.",
    detail: names.length > 0 ? html`<pre class="out"></pre>` : undefined,
    actions: names.map((name) => ({
      op: "task",
      label: `deno task ${name}`,
      action: "/tasks/run",
      fields: html`<input type="hidden" name="task" value="${name}">`,
    })),
  };
}

/** Step 9 — start the dev server and wait for it to publish its address. */
function stepFinish(s: Survey): StepView {
  return {
    id: "finish",
    title: "Finish",
    status: s.dev ? "ok" : "todo",
    summary: s.dev
      ? `The dev server is up at ${s.dev.origin}.`
      : "Start the dev server; its address appears here once it publishes .denext/dev.json.",
    detail: s.dev
      ? html`<p><a href="${s.dev.origin}">Open the app</a></p>`
      : html`<pre class="out"></pre>`,
    actions: s.dev ? [] : [{ op: "dev", label: "Start denext dev" }],
  };
}

// ── operations ───────────────────────────────────────────────────────────────

/** One check line of `denext doctor --json` (the JSON twin of its `Check` interface). */
export interface DoctorCheck {
  /** The check's name. */
  readonly name: string;
  /** Whether it passed. */
  readonly ok: boolean;
  /** Its one-line detail. */
  readonly detail: string;
  /** Whether failing it is fatal. */
  readonly critical: boolean;
}

/** What an operation answers with. */
interface OpOutcome {
  /** The step it belongs to (the anchor a `303` returns to). */
  readonly step: string;
  /** Whether it succeeded. */
  readonly ok: boolean;
  /** A one-line message. */
  readonly message?: string;
  /** The unified diff of a proposed write. */
  readonly diff?: string;
  /** The op to post to confirm that write. */
  readonly confirmOp?: string;
  /** A subprocess's captured output. */
  readonly output?: string;
  /** A doctor report. */
  readonly checks?: DoctorCheck[];
  /** Whether the write completed (answer `303`, re-render otherwise). */
  readonly redirect?: boolean;
}

/** An operation implementation. */
type Op = (ctx: UiContext, survey: Survey, form: FormData) => Promise<OpOutcome>;

/** Every operation `/wizard` accepts. An `op` outside this table never reaches a subprocess. */
const OPS: Record<string, Op> = {
  denojson: opDenoJson,
  install: opInstall,
  envexample: opEnvExample,
  doctor: opDoctor,
  "scaffold-page": opScaffoldPage,
  scaffold: opScaffold,
  dev: opStartDev,
};

/** Step 3's write: merge the missing template keys into the project's own `deno.json`. */
async function opDenoJson(ctx: UiContext, s: Survey, form: FormData): Promise<OpOutcome> {
  const name = s.deno?.name ?? "deno.json";
  const current = s.deno?.source ?? "";
  const next = s.deno === null
    ? JSON.stringify(templateJson(), null, 2) + "\n"
    : await mergeDenoJson(current, s.missing);
  if (next === null) {
    return { step: "denojson", ok: false, message: `denext ui could not splice ${name} safely.` };
  }
  if (next === current) {
    return { step: "denojson", ok: true, message: `${name} is already set up.` };
  }
  if (form.get("confirm") !== "1") {
    return {
      step: "denojson",
      ok: true,
      message: `Review the change to ${name}:`,
      diff: createUnifiedDiff(current, next, `a/${name}`, `b/${name}`),
      confirmOp: "denojson",
    };
  }
  await Deno.writeTextFile(await safe(ctx.dir, name), next);
  return { step: "denojson", ok: true, redirect: true, message: `${name} updated.` };
}

/** Splice each missing key's template value into `source`; `null` when a splice bails. */
async function mergeDenoJson(source: string, missing: string[][]): Promise<string | null> {
  let current = source;
  for (const path of missing) {
    const value = valueAt(templateJson(), path);
    if (value === undefined) continue;
    const result = await setJsonValue(current, path, value);
    if (!result.ok) return null;
    current = result.source;
  }
  return current;
}

/** Step 4's operation: `deno install`, as a subprocess with a deadline. */
async function opInstall(ctx: UiContext): Promise<OpOutcome> {
  const run = await runDeno(["install"], {
    cwd: ctx.dir,
    signal: AbortSignal.timeout(300_000),
  });
  return {
    step: "deps",
    ok: run.code === 0,
    message: run.code === 0 ? "deno install finished." : `deno install exited ${run.code}.`,
    output: tail(run.stdout + run.stderr),
  };
}

/** Step 5's write: `.env.example` gains a `KEY=` line per undeclared name. `.env` is never touched. */
async function opEnvExample(ctx: UiContext, s: Survey, form: FormData): Promise<OpOutcome> {
  const path = await safe(ctx.dir, ".env.example");
  const current = await readOrNull(path);
  const next = envExampleSource(current, s.env.missing);
  if (next === (current ?? "")) {
    return { step: "env", ok: true, message: ".env.example already documents every name." };
  }
  if (form.get("confirm") !== "1") {
    return {
      step: "env",
      ok: true,
      message: "Review the proposed .env.example (values are never filled in):",
      diff: createUnifiedDiff(current ?? "", next, "a/.env.example", "b/.env.example"),
      confirmOp: "envexample",
    };
  }
  await Deno.writeTextFile(path, next);
  return { step: "env", ok: true, redirect: true, message: ".env.example written." };
}

/** A file's text, or `null` when it does not exist. */
async function readOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/** Step 6's operation: the doctor report, through the (injectable) subprocess runner. */
async function opDoctor(ctx: UiContext): Promise<OpOutcome> {
  try {
    const checks = await doctorRunner(ctx.dir);
    const failed = checks.filter((c) => !c.ok).length;
    return {
      step: "doctor",
      ok: failed === 0,
      message: failed === 0
        ? `All ${checks.length} checks passed.`
        : `${failed} of ${checks.length} checks failed.`,
      checks,
    };
  } catch (error) {
    return { step: "doctor", ok: false, message: `denext doctor failed: ${reason(error)}` };
  }
}

/** Step 6's repair: scaffold `app/page.tsx` when the app directory is missing. */
async function opScaffoldPage(ctx: UiContext): Promise<OpOutcome> {
  try {
    const result = await generateArtifact(ctx.dir, "page", "/");
    return {
      step: "doctor",
      ok: true,
      redirect: true,
      message: `Wrote ${result.written.length} file(s); skipped ${result.skipped.length}.`,
    };
  } catch (error) {
    return { step: "doctor", ok: false, message: `generate page failed: ${reason(error)}` };
  }
}

/** Step 7's write: scaffold a whole project into an empty directory. */
async function opScaffold(ctx: UiContext, s: Survey, form: FormData): Promise<OpOutcome> {
  if (s.kind !== "empty") {
    return { step: "features", ok: false, message: "The directory is not empty — refusing." };
  }
  const on = (key: string): boolean => form.get(`feature.${key}`) !== null;
  try {
    const written = await scaffoldProject({
      dir: ctx.dir,
      tailwind: on("tailwind"),
      srcDir: on("srcDir"),
      compiler: on("compiler"),
      desktop: on("desktop"),
      capacitor: on("capacitor"),
      compatibilityMode: on("compatibility"),
    });
    return {
      step: "features",
      ok: true,
      redirect: true,
      message: `Wrote ${written.length} files.`,
    };
  } catch (error) {
    return { step: "features", ok: false, message: `scaffold failed: ${reason(error)}` };
  }
}

/** Step 9's operation: start `denext dev` in the background and stream it to every open page. */
function opStartDev(ctx: UiContext, s: Survey): Promise<OpOutcome> {
  if (s.dev !== null) {
    return Promise.resolve({
      step: "finish",
      ok: true,
      redirect: true,
      message: `Already running at ${s.dev.origin}.`,
    });
  }
  startDevServer(ctx);
  return Promise.resolve({
    step: "finish",
    ok: true,
    redirect: true,
    message: "Starting denext dev — its output is streaming to this page.",
  });
}

/**
 * Spawn `denext dev` (the framework's own `cli.ts`, in whatever scheme denext itself runs
 * under), stream its output to every open UI page, and announce the address as soon as the
 * dev server publishes `.denext/dev.json`. Deliberately not awaited: the request returns
 * immediately and the page follows the SSE channel.
 */
function startDevServer(ctx: UiContext): void {
  const push = (event: unknown): void => sseSend(ctx.events, JSON.stringify(event));
  runDeno(["run", "-A", frameworkFileUrl("cli.ts"), "dev", ctx.dir], {
    cwd: ctx.dir,
    onLine: (line) => push({ type: "dev-output", line }),
  })
    .then((run) => push({ type: "dev-exit", code: run.code }))
    .catch((error) => push({ type: "dev-output", line: `denext dev failed: ${reason(error)}` }));
  pollDevInfo(ctx.dir, push).catch(() => {/* the UI shut down */});
}

/** Poll `.denext/dev.json` for at most 30 s, then push the address it published. */
async function pollDevInfo(dir: string, push: (event: unknown) => void): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const info = await readDevInfo(dir);
    if (info !== null) {
      push({ type: "dev-ready", url: info.origin });
      return;
    }
  }
}

/** The last 8 KB of a subprocess's output (a page is not a log file). */
function tail(text: string): string {
  return text.length > 8192 ? "…\n" + text.slice(-8192) : text;
}

/** One error as a message. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── the doctor seam ──────────────────────────────────────────────────────────

/** Runs `denext doctor` for a project and returns its checks. */
export type DoctorRunner = (dir: string) => Promise<DoctorCheck[]>;

/** The active runner (the subprocess, unless a test injected a fixture). */
let doctorRunner: DoctorRunner = runDoctorSubprocess;

/**
 * Replace the `denext doctor --json` subprocess.
 *
 * @internal Test seam: lets a test render the doctor panel from a fixture report without
 * spawning a process — and therefore without any chance of loading a project module.
 * @param runner The stand-in, or `null` to restore the subprocess.
 */
export function setDoctorRunner(runner: DoctorRunner | null): void {
  doctorRunner = runner ?? runDoctorSubprocess;
}

/**
 * Run `denext doctor --json` as a subprocess. `doctor` is a `loadsModules` verb — it resolves
 * the project's config and probes its routes — so it must never run inside the UI process.
 */
async function runDoctorSubprocess(dir: string): Promise<DoctorCheck[]> {
  const run = await runDeno(
    ["run", "-A", frameworkFileUrl("cli.ts"), "doctor", "--json", "--cwd", dir],
    { cwd: dir, signal: AbortSignal.timeout(120_000) },
  );
  const parsed = run.json();
  if (!Array.isArray(parsed)) {
    throw new Error(run.stderr.trim() || `doctor exited ${run.code} without a JSON report`);
  }
  return parsed.filter(isCheck);
}

/** Whether a parsed JSON value is one doctor check. */
function isCheck(value: unknown): value is DoctorCheck {
  const check = value as Partial<DoctorCheck> | null;
  return typeof check?.name === "string" && typeof check?.ok === "boolean";
}

// ── rendering ────────────────────────────────────────────────────────────────

/** One operation, as the real form that works without JavaScript. */
function actionForm(ctx: UiContext, action: StepAction): RawHtml {
  return html`<form method="post" action="${action.action ?? "/wizard"}" class="op">
<input type="hidden" name="_csrf" value="${ctx.csrf}">
<input type="hidden" name="op" value="${action.op}">
${action.fields ?? ""}
<button type="submit"${ctx.readOnly ? raw(" disabled") : ""}>${action.label}</button>
</form>`;
}

/** The result of the operation that was just posted, rendered inside its own step. */
function renderOutcome(ctx: UiContext, outcome: OpOutcome): RawHtml {
  const confirm: StepAction | null = outcome.confirmOp === undefined ? null : {
    op: outcome.confirmOp,
    label: "Apply this change",
    fields: raw('<input type="hidden" name="confirm" value="1">'),
  };
  return html`<div class="outcome">
${outcome.message ? html`<p class="note">${outcome.message}</p>` : ""}
${outcome.diff ? html`<pre class="out">${outcome.diff}</pre>` : ""}
${confirm ? actionForm(ctx, confirm) : ""}
${outcome.output ? html`<pre class="out">${outcome.output}</pre>` : ""}
${outcome.checks ? renderChecks(ctx, outcome.checks) : ""}
</div>`;
}

/** A doctor report: one line per check, plus the repair offer when the app dir is missing. */
function renderChecks(ctx: UiContext, checks: DoctorCheck[]): RawHtml {
  const rows = checks.map((check) =>
    html`<li><span class="badge">${
      check.ok ? "ok" : check.critical ? "fail" : "warn"
    }</span> <strong>${check.name}</strong> — ${check.detail}</li>`
  );
  const needsApp = checks.some((check) => !check.ok && /app dir/i.test(check.name));
  return html`<ul class="checks">${rows}</ul>${needsApp ? actionForm(ctx, APP_DIR_ACTION) : ""}`;
}

/** One step's `<section>`: heading, status pill, summary, detail, operations, outcome. */
function renderStep(
  ctx: UiContext,
  index: number,
  view: StepView,
  outcome?: OpOutcome,
): RawHtml {
  return html`<section id="step-${view.id}" class="step">
<h2>${index + 1}. ${view.title} <span class="badge">${view.status}</span></h2>
<p class="lead">${view.summary}</p>
${view.detail ?? ""}
${view.actions.map((action) => actionForm(ctx, action))}
${outcome && outcome.step === view.id ? renderOutcome(ctx, outcome) : ""}
</section>`;
}

/** The whole panel: the one `<section id="panel">` `ui.js` swaps, with the nine steps inside. */
function renderWizard(ctx: UiContext, views: StepView[], outcome?: OpOutcome): RawHtml {
  return html`<section id="panel" data-panel="Wizard">
<h1>Setup wizard</h1>
<p class="lead mono">${ctx.dir}</p>
${ctx.readOnly ? html`<p class="note">Read-only mode — every write is refused.</p>` : ""}
${views.map((view, index) => renderStep(ctx, index, view, outcome))}
</section>`;
}

/** The JSON twin of one step. */
function jsonStep(view: StepView): Record<string, unknown> {
  return {
    id: view.id,
    status: view.status,
    summary: view.summary,
    actions: view.actions.map((action) => action.op),
  };
}

/** Render the wizard as a page, a fragment, or the JSON twin. */
function respond(ctx: UiContext, survey: Survey, outcome?: OpOutcome): Response {
  const views = STEPS.map((step) => step.view(survey));
  if (ctx.json) {
    return jsonResponse({
      ok: outcome?.ok ?? true,
      dir: survey.dir,
      kind: survey.kind,
      steps: views.map(jsonStep),
      ...(outcome ? { outcome } : {}),
    }, outcome && !outcome.ok ? 400 : 200);
  }
  const body = renderWizard(ctx, views, outcome);
  if (ctx.fragment) return htmlResponse(toHtml(body));
  return htmlResponse(renderPage(layout, {
    title: "Wizard",
    nav: UI_NAV,
    body,
    csrf: ctx.csrf,
    active: "/wizard",
  }));
}

/** A completed write: `303` back to the step that did it, so a reload never re-posts. */
function seeStep(step: string): Response {
  return new Response(null, { status: 303, headers: { location: `/wizard#step-${step}` } });
}

/**
 * Serve the setup wizard: `GET` renders the nine steps (or their JSON twin), `POST` runs one
 * table-listed operation — previewing every write before it happens.
 */
export const wizardPanel: UiHandler = async (
  _request: Request,
  ctx: UiContext,
): Promise<Response> => {
  const survey = await surveyProject(ctx.dir);
  if (ctx.method !== "POST") return respond(ctx, survey);
  const form = ctx.form ?? new FormData();
  const op = String(form.get("op") ?? "");
  if (!Object.hasOwn(OPS, op)) {
    return jsonResponse({ ok: false, reason: `unknown wizard operation "${op}"` }, 400);
  }
  const outcome = await OPS[op](ctx, survey, form);
  if (ctx.json) return respond(ctx, survey, outcome);
  if (outcome.redirect === true && outcome.ok) return seeStep(outcome.step);
  return respond(ctx, await surveyProject(ctx.dir), outcome);
};
