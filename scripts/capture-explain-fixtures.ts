// Capture the diagnostics the explainer snapshot tests replay (tests/explain-diagnostics.test.ts).
//
//   deno run -A scripts/capture-explain-fixtures.ts            # re-capture raw + explained
//   deno run -A scripts/capture-explain-fixtures.ts --explain  # only re-render explained
//
// Every `tests/fixtures/explain/<case>.<ext>.txt` is a source file with a deliberate mistake.
// The script writes them into a temporary app (with two API routes and their generated
// `.denext/api.ts`, so the typed-client cases see a real schema), runs `deno check` (or
// `deno lint` with denext's lint plugin, for the `lint-` cases) on each, and stores the
// output as `<case>.raw.txt` with the temporary directory rewritten to `/app`. Then each raw
// capture is run through the explainer and written as `<case>.explained.txt`, the snapshot
// the test compares against. A `_<name>.txt` file is a helper module, written but not a case.

import { fromFileUrl, join } from "@std/path";
import { scanRoutes } from "../src/router/manifest.ts";
import { generateApiTypes } from "../src/build/api-types.ts";
import { explainDiagnosticsText } from "../src/build/explain/mod.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const FIXTURES = join(ROOT, "tests/fixtures/explain");
const REPO_CONFIG = join(ROOT, "deno.json");

/** The directory every capture's temporary paths are rewritten to. */
export const FIXTURE_APP_DIR = "/app";
/** The directory the denext checkout's paths are rewritten to. */
const FIXTURE_DENEXT_DIR = "/denext";

const SCHEMA_MODULE = `
import type { StandardSchemaV1 } from "denext/server";
export function schema<T>(): StandardSchemaV1<T> & { "~standard": { types: { input: T; output: T } } } {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (v: unknown) => ({ value: v as T }),
      types: undefined as unknown as { input: T; output: T },
    },
  };
}
`;

const ROUTES: Record<string, string> = {
  "app/api/posts/route.ts": `
import { defineApi } from "denext/server";
import { schema } from "../../../schema.ts";
export const POST = defineApi({
  body: schema<{ title: string }>(),
  query: schema<{ page: number }>(),
  response: schema<{ id: number }>(),
}, ({ body }) => ({ id: body.title.length }));
`,
  "app/api/user/[id]/route.ts": `
import { json, type TypedResponse } from "denext/server";
export function GET(): TypedResponse<{ id: string; name: string }> {
  return json({ id: "1", name: "Ada" });
}
`,
};

/** The case name and the file name it is written as (`define-api.ts.txt` → `define-api.ts`). */
function fixtureFiles(): Array<{ txt: string; name: string; helper: boolean }> {
  const out = [];
  for (const entry of Deno.readDirSync(FIXTURES)) {
    if (!entry.isFile || !entry.name.endsWith(".txt")) continue;
    if (/\.(raw|explained)\.txt$/.test(entry.name)) continue;
    const name = entry.name.slice(0, -".txt".length);
    const helper = name.startsWith("_");
    out.push({ txt: entry.name, name: helper ? name.slice(1) : name, helper });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The case id of a fixture file name (`define-api.ts` → `define-api`). */
function caseId(name: string): string {
  return name.replace(/\.(tsx?|jsx?)$/, "");
}

async function writeApp(dir: string): Promise<void> {
  await Deno.writeTextFile(join(dir, "schema.ts"), SCHEMA_MODULE);
  for (const [rel, src] of Object.entries(ROUTES)) {
    await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), src);
  }
  const outDir = join(dir, ".denext");
  await Deno.mkdir(outDir, { recursive: true });
  const manifest = await scanRoutes(join(dir, "app"));
  const api = await generateApiTypes(manifest, { outDir, configPath: REPO_CONFIG });
  await Deno.writeTextFile(join(outDir, "api.ts"), api);
  for (const f of fixtureFiles()) {
    await Deno.writeTextFile(join(dir, f.name), await Deno.readTextFile(join(FIXTURES, f.txt)));
  }
}

/**
 * A lint config for the `lint-` cases: denext's plugin with its opt-in rules enabled, so the
 * `exhaustive-switch` / `no-throw` reports are captured too (the default rules are unchanged).
 */
async function writeLintConfig(dir: string): Promise<string> {
  const plugin = join(dir, "_lint-plugin.ts");
  await Deno.writeTextFile(
    plugin,
    `import { denextLintPlugin } from ${JSON.stringify(`${ROOT}src/lint/denext-plugin.ts`)};\n` +
      `export default denextLintPlugin({ exhaustiveSwitch: true });\n`,
  );
  const config = join(dir, "_lint.json");
  await Deno.writeTextFile(config, JSON.stringify({ lint: { plugins: ["./_lint-plugin.ts"] } }));
  return config;
}

/** Run `deno check` / `deno lint` on one case; its combined output, uncoloured. */
async function capture(dir: string, name: string): Promise<string> {
  const lint = name.startsWith("lint-");
  const args = lint
    ? ["lint", "--config", await writeLintConfig(dir), join(dir, name)]
    : ["check", "--config", REPO_CONFIG, join(dir, name)];
  const { stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args,
    cwd: dir,
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
  return normalize(text, dir);
}

/** Rewrite the temporary directory (and its real path) to {@linkcode FIXTURE_APP_DIR}. */
function normalize(text: string, dir: string): string {
  let out = text;
  for (const d of new Set([Deno.realPathSync(dir), dir])) out = out.replaceAll(d, FIXTURE_APP_DIR);
  out = out.replaceAll(ROOT, `${FIXTURE_DENEXT_DIR}/`);
  // The check banner and Deno's npm lifecycle-script notice box are not diagnostics.
  return out.split("\n").filter((l) => !/^(Check|Download) |^[╭│╰]/.test(l)).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** A fixture source read by the explainer, keyed by its `/app/...` path. */
function fixtureSources(): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of fixtureFiles()) {
    map.set(`${FIXTURE_APP_DIR}/${f.name}`, Deno.readTextFileSync(join(FIXTURES, f.txt)));
  }
  return map;
}

/**
 * The explained rendering of one raw capture, exactly as the snapshot test computes it.
 *
 * @param raw The captured `deno check` / `deno lint` output.
 * @returns The explained text (no colour).
 */
export function explainFixture(raw: string): string {
  const sources = fixtureSources();
  // The captures print `file:///app/…`, which Windows reads back as `\app\…`: the fixture
  // sources are keyed by the POSIX spelling either way.
  const posix = (path: string) => path.replaceAll("\\", "/");
  return explainDiagnosticsText(raw, {
    rootDir: FIXTURE_APP_DIR,
    readSource: (path) => sources.get(posix(path)),
    listDir: (dir) =>
      posix(dir) === FIXTURE_APP_DIR
        ? [...sources.keys()].map((p) => p.slice(FIXTURE_APP_DIR.length + 1))
        : [],
  }).text + "\n";
}

async function main(): Promise<void> {
  const explainOnly = Deno.args.includes("--explain");
  const cases = fixtureFiles().filter((f) => !f.helper);
  if (!explainOnly) {
    const dir = await Deno.makeTempDir({ prefix: "denext-explain-" });
    try {
      await writeApp(dir);
      for (const f of cases) {
        const raw = await capture(dir, f.name);
        await Deno.writeTextFile(join(FIXTURES, `${caseId(f.name)}.raw.txt`), raw);
        console.log(`captured ${f.name}`);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
  for (const f of cases) {
    const raw = await Deno.readTextFile(join(FIXTURES, `${caseId(f.name)}.raw.txt`));
    await Deno.writeTextFile(
      join(FIXTURES, `${caseId(f.name)}.explained.txt`),
      explainFixture(raw),
    );
  }
  console.log(`explained ${cases.length} case(s)`);
}

if (import.meta.main) await main();
