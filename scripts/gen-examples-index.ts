// Generate the in-site examples index from the `examples/` directories themselves.
// Each example's title + blurb come from its own README (H1 + first paragraph) and its
// "wired as" tags are read out of `denext.config.ts` AS TEXT — the config is never
// imported, so this runs without any of the examples' dependencies being installed.
//
//   deno task docs:examples   # regenerate examples.json
//   deno task docs:build      # regenerate + export the site

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

const BLURB_MAX = 200;

/** Strings and template literals survive; `//` and block comments are dropped. */
const COMMENT_OR_STRING =
  /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

export function stripComments(src: string): string {
  return src.replace(
    COMMENT_OR_STRING,
    (m) => (m.startsWith("//") || m.startsWith("/*") ? "" : m),
  );
}

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

function tagsFor(dir: string): string[] {
  const tags = configTags(readOr(`${dir}/denext.config.ts`, ""));
  if (exists(`${dir}/desktop.ts`)) tags.push("desktop");
  if (exists(`${dir}/pages`)) tags.push("pages-router");
  if (exists(`${dir}/app`) && !tags.includes("spa")) tags.push("app-router");
  return tags;
}

/** Markdown inline syntax → plain text (links keep their text, emphasis/code lose their marks). */
export function plainText(md: string): string {
  return md
    .replace(/\s+/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[\s(])[*_]([^*_]+)[*_]/g, "$1$2")
    .trim();
}

/** ~200 chars, cut at the last sentence end that fits; otherwise at a word boundary. */
export function truncate(text: string, max = BLURB_MAX): string {
  if (text.length <= max) return text;
  let sentence = -1;
  for (const m of text.matchAll(/[.!?](?=\s|$)/g)) {
    if (m.index >= max) break;
    sentence = m.index;
  }
  if (sentence > max / 3) return text.slice(0, sentence + 1);
  const head = text.slice(0, max);
  const word = head.lastIndexOf(" ");
  return `${head.slice(0, word > 0 ? word : max).trimEnd()}…`;
}

/** The README's first `# H1` and the first paragraph under it, both as plain text. */
export function readmeSummary(md: string): { title: string; blurb: string } {
  const h1 = /^#[ \t]+(.+)$/m.exec(md);
  const title = h1 ? plainText(h1[1]) : "";
  const rest = h1 ? md.slice(h1.index + h1[0].length) : "";
  const para = rest
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !/^[#>|<[\]!-]|^```/.test(p));
  return { title, blurb: para ? truncate(plainText(para)) : "" };
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
