// `/config/next` — a compat app's `next.config.*`, read once and translated on request.
//
// denext NEVER loads `next.config` at runtime: the drop-in path rewrites `next/*` imports, it
// does not adopt Next's config file. Editing that file would therefore change nothing, so this
// panel is read-only by construction — it evaluates the config in a bounded subprocess (the
// same shape `denext migrate` uses: the app's own directory, so its npm plugin imports resolve,
// with read/env/sys and nothing else), then shows three tables: what denext honors under the
// same name, the `redirects`/`rewrites`/`headers` thunks it can inline, and the keys that have
// no denext equivalent, each with a one-line pointer.
//
// "Translate" is not a second writer: each button posts the honored value to `/config` as an
// ordinary section edit, so the translation lands in the one diff-then-confirm path that every
// other config change goes through.

import { join, toFileUrl } from "@std/path";
import { readConfigModel } from "../../build/config-edit.ts";
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
} from "../html.ts";
import { UI_CSRF_FIELD } from "../security.ts";
import { control } from "../form/control.ts";
import { loadConfigSchema, resolveAt } from "../form/schema.ts";
import { widgetFor } from "../form/widget.ts";
import { encode } from "../form/value.ts";
import { runDeno } from "../proc.ts";

/** The denext config names this panel probes for a `compatibilityMode` opt-in. */
const DENEXT_CONFIGS = ["denext.config.ts", "denext.config.mts", "denext.config.js"];

/** The `next.config.*` names, in the order Next itself resolves them. */
const NEXT_CONFIGS = ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs"];

/** next.config keys denext consumes under the same name and shape. */
const HONORED_KEYS = [
  "cacheComponents",
  "basePath",
  "trailingSlash",
  "assetPrefix",
  "images",
  "i18n",
];

/** The `() => Rule[]` thunks denext takes with the same signature (their result is inlined). */
const RULE_KEYS = ["redirects", "rewrites", "headers"];

/** Where a key with no denext equivalent goes instead (empty: it is simply inert on denext). */
const DROP_NOTES: Record<string, string> = {
  transpilePackages: "not needed — Deno transpiles every dependency natively.",
  env: "expose client-visible keys through `publicEnv`; server code reads `Deno.env` at runtime.",
  output: "pick the task instead: `deno task export` or `deno task build`.",
  reactStrictMode: "wrap a subtree in `<StrictMode>` where you want the dev double-invoke.",
  pageExtensions: "page extensions are conventional in denext, not configurable.",
  experimental: "no denext equivalent, except ppr/useCache/dynamicIO → `cacheComponents: true`.",
  webpack: "",
  compiler: "",
  swcMinify: "",
  poweredByHeader: "",
  productionBrowserSourceMaps: "",
};

/** How long the evaluator may run before the child is aborted and the panel says so. */
const EVAL_TIMEOUT_MS = 15_000;

/** The line prefix the evaluator's result is printed behind. */
const RESULT_MARKER = "__DENEXT_UI_NEXT_CONFIG__";

/**
 * The evaluator, run as a subprocess rooted at the app dir. It imports the config, unwraps a
 * function/promise form, CALLS the rule thunks (a function cannot be serialised; its result
 * can), and prints one marker line. It exits explicitly: a config wrapper may keep the event
 * loop alive or crash asynchronously long after it handed the object over.
 */
const EVAL_PROGRAM = `
const HONORED = ${JSON.stringify(HONORED_KEYS)};
const RULES = ${JSON.stringify(RULE_KEYS)};
const mod = await import(Deno.args[0]);
let cfg = mod?.default ?? mod;
if (typeof cfg === "function") cfg = await cfg();
cfg = await cfg;
const out = { fields: {}, rules: {}, other: [] };
if (cfg && typeof cfg === "object") {
  for (const key of Object.keys(cfg)) {
    if (HONORED.includes(key)) out.fields[key] = cfg[key];
    else if (RULES.includes(key) && typeof cfg[key] === "function") {
      try { out.rules[key] = await cfg[key](); } catch { out.rules[key] = null; }
    } else out.other.push(key);
  }
}
console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(out));
Deno.exit(0);
`;

/** What the evaluator found in a `next.config.*`. */
export interface NextConfigRead {
  /** The config file name, or `null` when the app has none. */
  readonly file: string | null;
  /** Keys denext honors under the same name, with their evaluated values. */
  readonly fields: Record<string, unknown>;
  /** The rule thunks, already called (`null` when the call threw). */
  readonly rules: Record<string, unknown>;
  /** Every other key the file sets. */
  readonly other: readonly string[];
  /** The config could not be evaluated (a timeout, a missing dep, a side effect). */
  readonly failed: boolean;
}

/** Reads and evaluates one `next.config.*`. */
export type NextConfigEvaluator = (dir: string, file: string) => Promise<NextConfigRead>;

/** The "it did not evaluate" answer, so every failure looks the same to the views. */
function unreadable(file: string): NextConfigRead {
  return { file, fields: {}, rules: {}, other: [], failed: true };
}

/** Evaluate `next.config.*` in a bounded, least-privilege subprocess. */
const evalNextConfig: NextConfigEvaluator = async (dir, file) => {
  const program = "data:application/typescript," + encodeURIComponent(EVAL_PROGRAM);
  try {
    const result = await runDeno([
      "run",
      "--no-prompt",
      `--allow-read=${dir}`,
      "--allow-env",
      "--allow-sys",
      program,
      toFileUrl(join(dir, file)).href,
    ], { cwd: dir, signal: AbortSignal.timeout(EVAL_TIMEOUT_MS) });
    const line = result.stdout.split("\n").find((l) => l.startsWith(RESULT_MARKER));
    if (!line) return unreadable(file);
    return { file, failed: false, ...JSON.parse(line.slice(RESULT_MARKER.length)) };
  } catch {
    return unreadable(file);
  }
};

/** The evaluator this panel uses. */
let evaluate: NextConfigEvaluator = evalNextConfig;

/**
 * Swap the `next.config` evaluator.
 *
 * @internal Test seam only: the suite reads a fixture without paying for a subprocess.
 * Passing nothing restores the real, bounded evaluator.
 * @param evaluator The replacement, or `undefined` to restore the default.
 */
export function setNextConfigEvaluator(evaluator?: NextConfigEvaluator): void {
  evaluate = evaluator ?? evalNextConfig;
}

// ── detection ────────────────────────────────────────────────────────────────

/** Why this project counts (or does not count) as a Next.js compat app. */
interface Compat {
  /** Whether the panel has anything to do. */
  readonly compat: boolean;
  /** What said so (`package.json`, `compatibilityMode`), for the page to quote. */
  readonly reason: string;
  /** The `next.config.*` the project has, if any. */
  readonly file: string | null;
}

/** Whether the project's `package.json` depends on `next`. */
async function dependsOnNext(dir: string): Promise<boolean> {
  const text = await Deno.readTextFile(join(dir, "package.json")).catch(() => null);
  if (text === null) return false;
  try {
    const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    return (pkg.dependencies?.next ?? pkg.devDependencies?.next) !== undefined;
  } catch {
    return false;
  }
}

/** Whether the denext config opts into the compat pipeline. */
async function usesCompatMode(dir: string): Promise<boolean> {
  for (const name of DENEXT_CONFIGS) {
    const text = await Deno.readTextFile(join(dir, name)).catch(() => null);
    if (text === null) continue;
    const info = (await readConfigModel(text)).keys.compatibilityMode;
    return info !== undefined && info.value !== false;
  }
  return false;
}

/** Decide whether this is a compat app, and find its `next.config.*`. */
async function detect(dir: string): Promise<Compat> {
  let file: string | null = null;
  for (const name of NEXT_CONFIGS) {
    if (await Deno.stat(join(dir, name)).then(() => true).catch(() => false)) {
      file = name;
      break;
    }
  }
  if (await dependsOnNext(dir)) {
    return { compat: true, reason: "package.json depends on next", file };
  }
  if (await usesCompatMode(dir)) {
    return { compat: true, reason: "compatibilityMode is set in your denext config", file };
  }
  return { compat: false, reason: "", file };
}

// ── the views ────────────────────────────────────────────────────────────────

/** One `<table>` with a header row. */
function table(head: readonly string[], rows: readonly RawHtml[]): RawHtml {
  return html`
    <table style="width:100%;border-collapse:collapse;text-align:left">
      <thead>
        <tr>${head.map((cell) => html`<th style="padding:4px 8px">${cell}</th>`)}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/** A value, as the compact JSON the table shows. */
function preview(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  return text.length > 120 ? text.slice(0, 117) + "…" : text;
}

/**
 * A "translate this key" button: it posts the evaluated value to `/config` as an ordinary
 * section edit, so the user lands on the same diff-then-confirm preview as any other change.
 */
function translateForm(ctx: UiContext, key: string, value: unknown): RawHtml {
  const path = [key];
  const spec = widgetFor(resolveAt(loadConfigSchema(), path), path, false);
  const fields = encode(spec, value).map((entry) =>
    control({ tag: "input", type: "hidden", name: entry.name, value: entry.value })
  );
  return html`<form method="post" action="/config?section=${encodeURIComponent(key)}">
${control({ tag: "input", type: "hidden", name: UI_CSRF_FIELD, value: ctx.csrf })}${fields}
<button type="submit"${ctx.readOnly ? raw(" disabled") : ""}>Translate</button>
</form>`;
}

/** One honored key: its value, and the button that writes it into the denext config. */
function honoredRow(ctx: UiContext, key: string, value: unknown): RawHtml {
  return html`
    <tr>
      <td style="padding:4px 8px"><code class="mono">${key}</code></td>
      <td style="padding:4px 8px"><code class="mono">${preview(value)}</code></td>
      <td style="padding:4px 8px">${translateForm(ctx, key, value)}</td>
    </tr>
  `;
}

/** One dropped key and where its behaviour went instead. */
function droppedRow(key: string): RawHtml {
  const note = DROP_NOTES[key];
  return html`
    <tr>
      <td style="padding:4px 8px"><code class="mono">${key}</code></td>
      <td style="padding:4px 8px">${note === undefined || note === ""
        ? "no denext equivalent — nothing to port."
        : note}</td>
    </tr>
  `;
}

/** The honored + rules tables (everything this panel can translate). */
function translatable(ctx: UiContext, read: NextConfigRead): RawHtml {
  const fields = Object.entries(read.fields).map(([key, value]) => honoredRow(ctx, key, value));
  const rules = Object.entries(read.rules)
    .filter(([, value]) => Array.isArray(value))
    .map(([key, value]) => honoredRow(ctx, key, value));
  return html`<h2>Honored the same way</h2>
${
    fields.length + rules.length === 0
      ? html`<p class="lead">Nothing in this file maps onto a denext config key.</p>`
      : table(["key", "value", ""], [...fields, ...rules])
  }`;
}

/** The "no denext equivalent" table. */
function dropped(read: NextConfigRead): RawHtml {
  if (read.other.length === 0) return html``;
  return html`<h2>No denext equivalent</h2>
${table(["key", "where it went"], read.other.map(droppedRow))}`;
}

/** The panel for a project that is not a Next.js compat app. */
function notCompatBody(): RawHtml {
  return html`
    <section id="panel" data-panel="next.config">
      <h1>next.config</h1>
      <p class="lead">This project is not a Next.js compat app: nothing here depends on
    <code class="mono">next</code>, and your denext config does not set
    <code class="mono">compatibilityMode</code>. Native denext apps configure everything through
    <a href="/config">denext.config.ts</a>; there is no <code class="mono">next.config</code> to
    read, and denext would not load one if there were.</p>
    </section>
  `;
}

/** The panel for a compat app: what the file says, and what denext will do with it. */
function readBody(ctx: UiContext, compat: Compat, read: NextConfigRead | null): RawHtml {
  return html`<section id="panel" data-panel="next.config">
<h1>next.config</h1>
<p class="lead">denext never loads <code class="mono">next.config</code> at runtime — the compat
pipeline rewrites <code class="mono">next/*</code> imports, it does not adopt Next's config
file. This panel reads it once, here, and offers to translate what denext honors into
<a href="/config">denext.config.ts</a>. Detected because ${compat.reason}.</p>
${
    read === null
      ? html`<p class="note">No <code class="mono">next.config.*</code> in this project.</p>`
      : read.failed
      ? html`<p class="note">Could not evaluate
<code class="mono">${read.file}</code> — it may import a dependency that is not installed, take
too long, or have side effects. Port it by hand.</p>`
      : html`<p class="lead mono">${read.file}</p>${translatable(ctx, read)}${dropped(read)}`
  }
</section>`;
}

/** The machine view of the panel (the `/api/config/next` payload). */
function payload(compat: Compat, read: NextConfigRead | null): Record<string, unknown> {
  return {
    compat: compat.compat,
    reason: compat.reason,
    file: read?.file ?? null,
    failed: read?.failed ?? false,
    honored: read?.fields ?? {},
    rules: read?.rules ?? {},
    dropped: (read?.other ?? []).map((key) => ({ key, note: DROP_NOTES[key] ?? "" })),
  };
}

/**
 * Serve the `next.config` panel: a one-paragraph note for a native denext app, and for a compat
 * app the evaluated config as three tables, each honored key offering to translate itself into
 * `denext.config.ts` through `/config`'s ordinary diff-then-confirm write.
 *
 * @param _request The incoming request (this panel answers `GET` only).
 * @param ctx The kernel's request context.
 * @returns The panel, or its JSON twin on `/api/config/next`.
 */
export async function nextConfigPanel(_request: Request, ctx: UiContext): Promise<Response> {
  const compat = await detect(ctx.dir);
  const read = compat.compat && compat.file ? await evaluate(ctx.dir, compat.file) : null;
  if (ctx.json) return jsonResponse({ ok: true, ...payload(compat, read) });
  const body = compat.compat ? readBody(ctx, compat, read) : notCompatBody();
  if (ctx.fragment) return htmlResponse(toHtml(body));
  return htmlResponse(renderPage(layout, {
    title: "next.config",
    nav: UI_NAV,
    body,
    csrf: ctx.csrf,
    active: "/config/next",
  }));
}
