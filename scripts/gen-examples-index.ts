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

const ROOT = new URL("../", import.meta.url).pathname;
const EXAMPLES_DIR = `${ROOT}examples`;
export const OUT = `${ROOT}apps/web/app/docs/examples/examples.json`;
const REPO_TREE = "https://github.com/Brainwires/denext/tree/main/examples";

/** One row of the generated index. */
export interface ExampleEntry {
  name: string;
  title: string;
  blurb: string;
  url: string;
  tags: string[];
  hasReadme: boolean;
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
  return {
    name,
    title: title || name,
    blurb,
    url: `${REPO_TREE}/${name}`,
    tags: tagsFor(dir),
    hasReadme: readme.length > 0,
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
  return JSON.stringify({ examples }, null, 2) + "\n";
}

if (import.meta.main) {
  const json = generateExamplesIndex();
  await Deno.mkdir(new URL(".", `file://${OUT}`).pathname, { recursive: true });
  await Deno.writeTextFile(OUT, json);
  const { examples } = JSON.parse(json) as { examples: ExampleEntry[] };
  console.log(`examples index: ${examples.length} examples → ${OUT}`);
}
