// Generate the in-site examples index from the `examples/` directories themselves.
// Each example's title + blurb come from its own README (H1 + first paragraph) and its
// "wired as" tags are read out of `denext.config.ts` (and, for the hand-served next-compat
// examples, `serve.ts`) AS TEXT — nothing is imported, so this runs without any of the
// examples' dependencies being installed.
//
//   deno task docs:examples   # regenerate examples.json
//   deno task docs:build      # regenerate + export the site

// The README title/blurb extractor is shared with `scripts/gen-plugin-catalog.ts`;
// re-exported so this module stays the single import for the examples-index tests.
import { readmeSummary } from "./readme-blurb.ts";
export { plainText, readmeSummary, truncate } from "./readme-blurb.ts";

import { stripComments } from "../src/utils/strip-comments.ts";
import { dirname, fromFileUrl } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const EXAMPLES_DIR = `${ROOT}examples`;
export const OUT = `${ROOT}site/app/docs/examples/examples.json`;
const REPO_TREE = "https://github.com/Brainwires/denext/tree/main/examples";

/** One row of the generated index. */
export interface ExampleEntry {
  name: string;
  title: string;
  blurb: string;
  url: string;
  tags: string[];
  hasReadme: boolean;
  /** The {@link CATEGORIES} id the example is grouped under on the docs site. */
  category: string;
  /** The commands that run it, as its README gives them (`deno task dev` when it gives none). */
  run: string;
  /** Where {@link run} is meant to be typed: the example's directory or the repo root. */
  runFrom: "example" | "root";
}

/** A group on the examples index, in display order. */
export interface ExampleCategory {
  id: string;
  label: string;
}

/** The docs-site groups, in the order the index shows them. */
export const CATEGORIES: readonly ExampleCategory[] = [
  { id: "start", label: "Start here" },
  { id: "rendering", label: "Rendering & data" },
  { id: "apis", label: "APIs, auth & services" },
  { id: "databases", label: "Databases" },
  { id: "routers", label: "Routers & plugins" },
  { id: "compat", label: "npm React libraries & migration" },
  { id: "native", label: "Mobile & desktop" },
];

/**
 * Which group each example belongs to — the one fact about an example its README and config do
 * not state. A new example directory without a line here fails generation (and so the drift test).
 */
export const EXAMPLE_CATEGORY: Readonly<Record<string, string>> = {
  hello: "start",
  notes: "start",
  tailwind: "start",
  fonts: "start",
  image: "start",
  instrumentation: "start",
  spa: "start",
  actions: "rendering",
  streaming: "rendering",
  caching: "rendering",
  "cache-components": "rendering",
  islands: "rendering",
  resumability: "rendering",
  transitions: "rendering",
  concurrency: "rendering",
  live: "rendering",
  "content-collections": "rendering",
  "typed-api": "apis",
  openapi: "apis",
  graphql: "apis",
  auth: "apis",
  clerk: "apis",
  htmx: "apis",
  "effect-runtime": "apis",
  drizzle: "databases",
  prisma: "databases",
  "postgres-load": "databases",
  "pages-router": "routers",
  "react-router": "routers",
  "tanstack-router": "routers",
  "plugin-aliases": "routers",
  "next-compat": "compat",
  "next-compat-recharts": "compat",
  "next-compat-feasibility": "compat",
  animation: "compat",
  game: "compat",
  effect: "compat",
  native: "native",
  mobile: "native",
  "native-views": "native",
  "capacitor-ci": "native",
  "desktop-kitchen-sink": "native",
  "rn-desktop": "native",
  "expo-app": "native",
  "scroll-bench": "native",
};

/** A README heading whose section says how to run the example. */
const RUN_HEADING = /^(?:run\b|running\b|try\b|quick ?start\b|getting started\b|setup\b)/i;
/** A fenced block a shell reads. */
const SHELL_FENCE = /^```(?:sh|bash|shell|console|zsh)?[ \t]*$/;
/** A block that actually starts something. */
const RUNS_SOMETHING = /\bdeno\s+(?:task|run|install)\b|\bdenext\s+\w/;

/** One `##` / `###` section of a README: its runnable shell blocks and inline commands. */
interface ReadmeSection {
  heading: string;
  blocks: string[];
  inline: string[];
}

/** The inline code spans on a line that run something (`` `deno task dev` ``). */
function inlineCommands(line: string): string[] {
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter((c) =>
    RUNS_SOMETHING.test(c)
  );
}

/** The index of the line closing the fence opened at `open` (or the last line). */
function fenceEnd(lines: string[], open: number): number {
  let j = open + 1;
  while (j < lines.length && !lines[j].startsWith("```")) j++;
  return j;
}

/** A README split at its `##` / `###` headings (the part above the first is heading ""). */
function readmeSections(md: string): ReadmeSection[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: ReadmeSection[] = [{ heading: "", blocks: [], inline: [] }];
  for (let i = 0; i < lines.length; i++) {
    const h = /^#{2,3}[ \t]+(.+?)[ \t]*$/.exec(lines[i]);
    if (h) {
      out.push({ heading: h[1], blocks: [], inline: [] });
      continue;
    }
    const cur = out[out.length - 1];
    if (!lines[i].startsWith("```")) {
      cur.inline.push(...inlineCommands(lines[i]));
      continue;
    }
    const end = fenceEnd(lines, i);
    const body = lines.slice(i + 1, end).join("\n").trim();
    if (SHELL_FENCE.test(lines[i]) && RUNS_SOMETHING.test(body)) cur.blocks.push(body);
    i = end;
  }
  return out;
}

/**
 * The commands a README gives for running its example: the first shell block under a
 * "Run" / "Run it" / "Setup" / "Try …" / "Quick start" heading; else, when the first such section
 * spells its steps in prose, the inline commands in it (`` `deno task dev` ``), one per line;
 * else, when the README has no such heading, the first shell block that runs `deno task` /
 * `deno run` / `deno install` / `denext`. `null` when there is none.
 */
export function runCommands(md: string): string | null {
  const sections = readmeSections(md);
  const run = sections.filter((s) => RUN_HEADING.test(s.heading));
  if (run.length === 0) return sections.flatMap((s) => s.blocks)[0] ?? null;
  const block = run.flatMap((s) => s.blocks)[0];
  if (block !== undefined) return block;
  return run[0].inline.length ? run[0].inline.join("\n") : null;
}

/** Commands that name a root task (`deno task example:x`) or a repo path run from the repo root. */
export function runsFromRoot(commands: string): boolean {
  return /\bdeno task example:|(?:^|\s)(?:\.\/)?cli\.ts\b|(?:^|\s)examples\//m.test(commands);
}

export { stripComments } from "../src/utils/strip-comments.ts";

/** The text inside `<key>: [ … ]`, bracket-matched, or `null` when the key is absent. */
export function arrayBody(src: string, key: string): string | null {
  const open = new RegExp(`\\b${key}\\s*:\\s*\\[`).exec(src);
  if (!open) return null;
  const start = open.index + open[0].length;
  let depth = 1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]" && --depth === 0) return src.slice(start, i);
  }
  return null;
}

const CALL_OR_BRACKET = /[[\]{}()]|[A-Za-z_$][\w$]*(?=\s*\()/g;

/** Identifiers called at the top level of `body` — `[openapi({…}), htmx()]` → `["openapi","htmx"]`. */
export function topLevelCalls(body: string): string[] {
  const names: string[] = [];
  let depth = 0;
  for (const m of body.matchAll(CALL_OR_BRACKET)) {
    const t = m[0];
    if (t === "[" || t === "{" || t === "(") depth++;
    else if (t === "]" || t === "}" || t === ")") depth--;
    else if (depth === 0) names.push(t);
  }
  return names;
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

function readOr(path: string, fallback: string): string {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return fallback;
  }
}

/** The `denext.config.ts`-derived half of the tags. */
export function configTags(configSrc: string): string[] {
  const src = stripComments(configSrc);
  const tags: string[] = [];
  if (/\bmode\s*:\s*["']spa["']/.test(src)) tags.push("spa");
  if (/\bcompatibilityMode\s*:\s*true\b/.test(src)) tags.push("compat");
  const plugins = arrayBody(src, "plugins");
  for (const name of plugins ? topLevelCalls(plugins) : []) tags.push(`plugin:${name}`);
  return tags;
}

/** A hand-rolled `serve.ts` that drives the next-compat build layer marks a compat example. */
export function isCompatEntry(serveSrc: string): boolean {
  return /\b(?:serveCompat|buildNextCompatPages)\s*\(/.test(stripComments(serveSrc));
}

/** The Capacitor config file names `denext mobile add` itself looks for. */
const CAPACITOR_CONFIGS = [
  "capacitor.config.ts",
  "capacitor.config.js",
  "capacitor.config.mjs",
  "capacitor.config.cjs",
  "capacitor.config.json",
];

function tagsFor(dir: string): string[] {
  const tags = configTags(readOr(`${dir}/denext.config.ts`, ""));
  if (!tags.includes("compat") && isCompatEntry(readOr(`${dir}/serve.ts`, ""))) tags.push("compat");
  if (exists(`${dir}/desktop.ts`)) tags.push("desktop");
  if (CAPACITOR_CONFIGS.some((name) => exists(`${dir}/${name}`))) tags.push("mobile");
  if (exists(`${dir}/pages`)) tags.push("pages-router");
  if (exists(`${dir}/app`) && !tags.includes("spa")) tags.push("app-router");
  return tags;
}

function entryFor(name: string): ExampleEntry {
  const dir = `${EXAMPLES_DIR}/${name}`;
  const readme = readOr(`${dir}/README.md`, "");
  const { title, blurb } = readme ? readmeSummary(readme) : { title: "", blurb: "" };
  const category = EXAMPLE_CATEGORY[name];
  if (!category || !CATEGORIES.some((c) => c.id === category)) {
    throw new Error(
      `examples/${name} has no docs category — add it to EXAMPLE_CATEGORY in ${import.meta.url}`,
    );
  }
  const run = (readme && runCommands(readme)) || "deno task dev";
  return {
    name,
    title: title || name,
    blurb,
    url: `${REPO_TREE}/${name}`,
    tags: tagsFor(dir),
    hasReadme: readme.length > 0,
    category,
    run,
    runFrom: runsFromRoot(run) ? "root" : "example",
  };
}

/** Every runnable example directory, sorted. `_`-prefixed directories are shared helpers. */
export function exampleNames(): string[] {
  return [...Deno.readDirSync(EXAMPLES_DIR)]
    .filter((e) => e.isDirectory && !e.name.startsWith("_") && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/** The examples index as the exact JSON text that belongs in `examples.json`. */
export function generateExamplesIndex(): string {
  const examples = exampleNames().map(entryFor);
  return JSON.stringify({ categories: CATEGORIES, examples }, null, 2) + "\n";
}

if (import.meta.main) {
  const json = generateExamplesIndex();
  await Deno.mkdir(dirname(OUT), { recursive: true });
  await Deno.writeTextFile(OUT, json);
  const { examples } = JSON.parse(json) as { examples: ExampleEntry[] };
  console.log(`examples index: ${examples.length} examples → ${OUT}`);
}
