// The diagnostics explainer on what only the native TypeScript 7 checker says, or says another
// way than the in-process TypeScript 6.0.3 does. tests/fixtures/explain-ts7/ holds `deno check`
// output captured on runtime 3.0.0-rc.1 under both engines (`<case>.native.raw.txt` natively,
// `<case>.tsc.raw.txt` with `DENO_CHECK_ENGINE=tsc`), the checked source (`<case>.main.<ext>.txt`)
// and the explained snapshots. Re-render the snapshots with `DENEXT_UPDATE_SNAPSHOTS=1`.
//
// - bare-specifier: TS2307 "Cannot find module 'zod' …" (native) / `Import "zod" not a
//   dependency` + a `deno add` hint (in-process): one explanation.
// - export-assignment: TS1203 on both.
// - import-require: TS1202, native only (the in-process checker let `import = require()` pass).
// - jsx-runtime: TS2875 and TS7026 for an unmapped `jsxImportSource`.
// - removed-options: TS5102 / TS5108 / TS5090 (TypeScript 7 refuses `baseUrl`,
//   `moduleResolution: node`, `target: es5`) and TS5101 (TypeScript 6 deprecates `baseUrl`).
// - one-character-span: a `^` under a one-character span is a squiggle, not part of the message.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { explainDiagnosticsText, parseDiagnostics } from "../src/build/explain/mod.ts";

const DIR = fromFileUrl(new URL("./fixtures/explain-ts7/", import.meta.url));
const UPDATE = Deno.env.get("DENEXT_UPDATE_SNAPSHOTS") === "1";

/** The case's checked source, keyed by the path the captures print (`/app/main.<ext>`). */
function sources(name: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of Deno.readDirSync(DIR)) {
    const m = new RegExp(`^${name}\\.(main\\.tsx?)\\.txt$`).exec(e.name);
    if (m) map.set(`/app/${m[1]}`, Deno.readTextFileSync(join(DIR, e.name)));
  }
  return map;
}

function explain(name: string, engine: "native" | "tsc"): { raw: string; text: string } {
  const raw = Deno.readTextFileSync(join(DIR, `${name}.${engine}.raw.txt`));
  const files = sources(name);
  const text = explainDiagnosticsText(raw, {
    rootDir: "/app",
    readSource: (path) => files.get(path.replaceAll("\\", "/")),
    listDir: () => [...files.keys()].map((p) => p.slice("/app/".length)),
  }).text + "\n";
  return { raw, text };
}

/** Each explanation's `TSxxxx: title` and first `Fix:` line, in order. */
function verdicts(text: string): string[] {
  return text.split("\n").filter((l) => /^TS\d+: /.test(l) || l.startsWith("  Fix: "));
}

function cases(): Array<[string, "native" | "tsc"]> {
  return [...Deno.readDirSync(DIR)]
    .map((e) => /^(.+)\.(native|tsc)\.raw\.txt$/.exec(e.name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m): [string, "native" | "tsc"] => [m[1], m[2] as "native" | "tsc"])
    .sort();
}

for (const [name, engine] of cases()) {
  Deno.test(`explain (TypeScript 7 differences): ${name}, ${engine}`, () => {
    const { raw, text } = explain(name, engine);
    const snapshot = join(DIR, `${name}.${engine}.explained.txt`);
    if (UPDATE) Deno.writeTextFileSync(snapshot, text);
    assertEquals(text, Deno.readTextFileSync(snapshot), `${name}.${engine}: snapshot`);
    // Every original line is kept, and every type error is explained.
    for (const d of parseDiagnostics(raw)) {
      for (const line of d.raw.split("\n")) assertStringIncludes(text, line);
      assertStringIncludes(text, `${d.code}: `, `${name}.${engine}: ${d.code} unexplained`);
    }
  });
}

Deno.test("explain (TypeScript 7 differences): both checkers' wording, one fix", () => {
  for (const name of ["bare-specifier", "export-assignment", "one-character-span"]) {
    assertEquals(
      verdicts(explain(name, "native").text),
      verdicts(explain(name, "tsc").text),
      name,
    );
  }
  assertEquals(verdicts(explain("bare-specifier", "native").text), [
    'TS2307: "zod" is not a dependency',
    '  Fix: Add it: `denext add npm:zod`, or map "zod" in deno.json `imports`.',
  ]);
  // The JSX runtime: the in-process checker adds Deno's TS2307 for it; the TS2875 fix is shared.
  const runtimeFix = (text: string) =>
    verdicts(text).filter((l) => /TS2875|Fix: Add "preact"/.test(l));
  assertEquals(
    runtimeFix(explain("jsx-runtime", "native").text),
    runtimeFix(explain("jsx-runtime", "tsc").text),
  );
  // `baseUrl`: removed (native) or deprecated (in-process), the same fix.
  const baseUrlFix = (text: string) => {
    const lines = text.split("\n");
    return lines.find((l, i) => l.startsWith("  Fix: Delete `baseUrl`") && i > 0);
  };
  const native = baseUrlFix(explain("removed-options", "native").text);
  assert(native, "native baseUrl fix");
  assertEquals(native, baseUrlFix(explain("removed-options", "tsc").text));
});

Deno.test("parse: a `^` under a one-character span is the squiggle", () => {
  const [d] = parseDiagnostics(
    Deno.readTextFileSync(join(DIR, "one-character-span.native.raw.txt")),
  );
  assertEquals(d.chain, []);
  assertEquals(d.length, 1);
  assertEquals([d.line, d.column], [1, 14]);
});
