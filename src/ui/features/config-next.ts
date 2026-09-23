// `/config/next` — a compat app's `next.config.*`, read once and translated on request.
//
// denext NEVER loads `next.config` at runtime: the drop-in path rewrites `next/*` imports, it
// does not adopt Next's config file. Editing that file would therefore change nothing, so this
// panel is read-only by construction — it evaluates the config through the same bounded
// subprocess evaluator `denext migrate` uses (`build/next-config-eval.ts`: the app's own
// directory, so its npm plugin imports resolve, with read/env/sys and nothing else, under
// `DENEXT_NEXT_EVAL_TIMEOUT_MS`), then shows three tables: what denext honors under the
// same name, the `redirects`/`rewrites`/`headers` thunks it can inline, and the keys that have
// no denext equivalent, each with a one-line pointer.
//
// "Translate" is not a second writer: each button posts the honored value to `/config` as an
// ordinary section edit, so the translation lands in the one diff-then-confirm path that every
// other config change goes through.

import { readConfigModel } from "../../build/config-edit.ts";
import { evalNextConfigProgram, LOAD_NEXT_CONFIG } from "../../build/next-config-eval.ts";
import { CONFIG_FILES } from "../../build/paths.ts";
import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { jsonResponse, panelResponder, type UiContext } from "../html.ts";
import { Mono, Note, OpForm, Panel, Table } from "../components.ts";
import { renderView } from "../view.ts";
import { loadConfigSchema, resolveAt } from "../form/schema.ts";
import { widgetFor } from "../form/widget.ts";
import { encode } from "../form/value.ts";
import { uiSafeJoin } from "../security.ts";

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
  experimental:
    "no denext equivalent, except ppr/useCache/dynamicIO → `cacheComponents: true` and " +
    "optimizePackageImports → top-level `optimizePackageImports`.",
  webpack: "",
  compiler: "",
  swcMinify: "",
  poweredByHeader: "",
  productionBrowserSourceMaps: "",
};

/** The line prefix the evaluator's result is printed behind. */
const RESULT_MARKER = "__DENEXT_UI_NEXT_CONFIG__";

/**
 * The evaluator program, piped to `deno run -` by the shared bounded evaluator (so it never
 * exists as a file or a `data:` URL). It imports the config, unwraps a
 * function/promise form, CALLS the rule thunks (a function cannot be serialised; its result
 * can), and prints one marker line. It exits explicitly: a config wrapper may keep the event
 * loop alive or crash asynchronously long after it handed the object over.
 */
const EVAL_PROGRAM = `
const HONORED = ${JSON.stringify(HONORED_KEYS)};
const RULES = ${JSON.stringify(RULE_KEYS)};
${LOAD_NEXT_CONFIG}
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
  try {
    const result = await evalNextConfigProgram({
      dir,
      file: await uiSafeJoin(dir, file), // the containment gate: a symlink out is refused
      program: EVAL_PROGRAM,
      marker: RESULT_MARKER,
    });
    if (!result.ok) return unreadable(file);
    return { file, failed: false, ...(result.value as Omit<NextConfigRead, "file" | "failed">) };
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

/** The text of `dir/name`, or `null` — via the containment gate, so a symlink out is refused. */
async function readContained(dir: string, name: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(await uiSafeJoin(dir, name));
  } catch {
    return null;
  }
}

/** Whether the project's `package.json` depends on `next`. */
async function dependsOnNext(dir: string): Promise<boolean> {
  const text = await readContained(dir, "package.json");
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
  for (const name of CONFIG_FILES) {
    const text = await readContained(dir, name);
    if (text === null) continue;
    const info = (await readConfigModel(text)).keys.compatibilityMode;
    return info !== undefined && info.value !== false;
  }
  return false;
}

/**
 * Whether the project at `dir` is a Next.js compat app — the one fact `/config` needs to decide
 * whether to offer its `next.config` tab. A native denext app has no `next.config` to read, so
 * the tab would lead somewhere that exists only to say "there is nothing here".
 *
 * Lives here, beside {@linkcode detect}, because the dependency runs `config.ts` →
 * `config-next.ts` and must keep running that way.
 *
 * @param dir The project directory.
 * @returns Whether the compat pipeline applies.
 */
export async function isCompatApp(dir: string): Promise<boolean> {
  return (await detect(dir)).compat;
}

/** Decide whether this is a compat app, and find its `next.config.*`. */
async function detect(dir: string): Promise<Compat> {
  let file: string | null = null;
  for (const name of NEXT_CONFIGS) {
    const path = await uiSafeJoin(dir, name).catch(() => null);
    if (path !== null && await Deno.stat(path).then(() => true).catch(() => false)) {
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

/** A value, as the compact JSON the table shows. */
function preview(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  return text.length > 120 ? text.slice(0, 117) + "…" : text;
}

/** One translatable key: the request (token, read-only), the key and its evaluated value. */
interface HonoredProps {
  /** The current request. */
  readonly ctx: UiContext;
  /** The next.config key (also the denext config section it lands in). */
  readonly name: string;
  /** Its evaluated value. */
  readonly value: unknown;
}

/**
 * A "translate this key" button: it posts the evaluated value to `/config` as an ordinary
 * section edit, so the user lands on the same diff-then-confirm preview as any other change.
 */
function TranslateForm({ ctx, name, value }: HonoredProps): VNode {
  const path = [name];
  const spec = widgetFor(resolveAt(loadConfigSchema(), path), path, false);
  return h(OpForm, {
    csrf: ctx.csrf,
    action: `/config?section=${encodeURIComponent(name)}`,
    label: "Translate",
    fields: Object.fromEntries(encode(spec, value).map((entry) => [entry.name, entry.value])),
    disabled: ctx.readOnly,
  });
}

/** One honored key: its value, and the button that writes it into the denext config. */
function HonoredRow({ ctx, name, value }: HonoredProps): VNode {
  return h(
    "tr",
    null,
    h("td", null, h(Mono, null, name)),
    h("td", null, h(Mono, null, preview(value))),
    h("td", null, h(TranslateForm, { ctx, name, value })),
  );
}

/** One dropped key and where its behaviour went instead. */
function DroppedRow({ name }: { readonly name: string }): VNode {
  const note = DROP_NOTES[name];
  return h(
    "tr",
    null,
    h("td", null, h(Mono, null, name)),
    h("td", null, note ? note : "no denext equivalent — nothing to port."),
  );
}

/** What the evaluated-config views are rendered from. */
interface ReadProps {
  /** The current request. */
  readonly ctx: UiContext;
  /** What the evaluator found. */
  readonly read: NextConfigRead;
}

/** The honored + rules tables (everything this panel can translate). */
function Translatable({ ctx, read }: ReadProps): VNode {
  const rules = Object.entries(read.rules).filter(([, value]) => Array.isArray(value));
  const rows = [...Object.entries(read.fields), ...rules].map(([name, value]) =>
    h(HonoredRow, { key: name, ctx, name, value })
  );
  return h(
    Fragment,
    null,
    h("h2", null, "Honored the same way"),
    rows.length === 0
      ? h("p", { class: "lead" }, "Nothing in this file maps onto a denext config key.")
      : h(Table, { head: ["key", "value", ""], rows }),
  );
}

/** The "no denext equivalent" table. */
function Dropped({ names }: { readonly names: readonly string[] }): VNode {
  const rows = names.map((name) => h(DroppedRow, { key: name, name }));
  return h(
    Fragment,
    null,
    h("h2", null, "No denext equivalent"),
    h(Table, { head: ["key", "where it went"], rows }),
  );
}

/** A compat app's `next.config.*`: missing, unreadable, or tabled with its translations. */
function TranslatePreview(
  { ctx, read }: { readonly ctx: UiContext; readonly read: NextConfigRead | null },
): VNode {
  if (read === null) {
    return h(Note, null, "No ", h(Mono, null, "next.config.*"), " in this project.");
  }
  if (read.failed) {
    return h(
      Note,
      null,
      "Could not evaluate ",
      h(Mono, null, read.file),
      " — it may import a dependency that is not installed, take too long, or have side " +
        "effects. Port it by hand.",
    );
  }
  return h(
    Fragment,
    null,
    h("p", { class: "lead mono" }, read.file),
    h(Translatable, { ctx, read }),
    read.other.length > 0 ? h(Dropped, { names: read.other }) : null,
  );
}

/** The panel for a project that is not a Next.js compat app. */
function NotCompatView(): VNode {
  return h(
    Panel,
    { name: "next.config", title: "Config" },
    // Reached by visiting `/config/next` directly: a native app is offered no such tab, so the
    // strip here shows only the tab that does exist rather than one marked current-but-absent.
    h(
      "p",
      { class: "lead" },
      "This project is not a Next.js compat app: nothing here depends on ",
      h(Mono, null, "next"),
      ", and your denext config does not set ",
      h(Mono, null, "compatibilityMode"),
      ". Native denext apps configure everything through ",
      h("a", { href: "/config" }, "denext.config.ts"),
      "; there is no ",
      h(Mono, null, "next.config"),
      " to read, and denext would not load one if there were.",
    ),
  );
}

/** The panel for a compat app: what the file says, and what denext will do with it. */
function NextConfigView(
  { ctx, compat, read }: {
    readonly ctx: UiContext;
    readonly compat: Compat;
    readonly read: NextConfigRead | null;
  },
): VNode {
  return h(
    Panel,
    { name: "next.config", title: "Config" },
    h(
      "p",
      { class: "lead" },
      "denext never loads ",
      h(Mono, null, "next.config"),
      " at runtime — the compat pipeline rewrites ",
      h(Mono, null, "next/*"),
      " imports, it does not adopt Next's config file. This panel reads it once, here, and " +
        "offers to translate what denext honors into ",
      h("a", { href: "/config" }, "denext.config.ts"),
      `. Detected because ${compat.reason}.`,
    ),
    h(TranslatePreview, { ctx, read }),
  );
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

/** The panel shell: the bare section for `ui.js`, the whole document for a navigation. */
const panelResponse = panelResponder("next.config", "/config/next");

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
  const view = compat.compat ? h(NextConfigView, { ctx, compat, read }) : h(NotCompatView, null);
  return panelResponse(ctx, renderView(view));
}
