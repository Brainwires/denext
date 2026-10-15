// The diagnostics explainer (src/build/explain): real `deno check` / `deno lint` output captured
// from the fixtures in tests/fixtures/explain becomes the explained text committed beside it
// (`scripts/capture-explain-fixtures.ts` re-captures both), plus the parser and rules on their
// own, the `denext_explain_error` MCP tool, and the dev-server and build hooks.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { explainFixture, FIXTURE_APP_DIR } from "../scripts/capture-explain-fixtures.ts";
import {
  explainDiagnostic,
  explainDiagnosticsText,
  formatExplanation,
  fromStructured,
  parseDiagnostics,
} from "../src/build/explain/mod.ts";
import { knownDenextNames } from "../src/build/explain/rules-modules.ts";
import { explainBuildFailure } from "../src/cli/explain-output.ts";
import { runTool } from "../src/mcp/tools.ts";
import { projectExplainContext } from "../src/mcp/explain.ts";
import { codeframe } from "../src/build/dev-codeframe.ts";

const FIXTURES = fromFileUrl(new URL("./fixtures/explain/", import.meta.url));

/** Every captured case: `<case>.raw.txt` beside its `<case>.explained.txt` snapshot. */
function cases(): string[] {
  return [...Deno.readDirSync(FIXTURES)]
    .filter((e) => e.name.endsWith(".raw.txt"))
    .map((e) => e.name.slice(0, -".raw.txt".length))
    .sort();
}

for (const name of cases()) {
  Deno.test(`explain snapshot: ${name}`, () => {
    const raw = Deno.readTextFileSync(join(FIXTURES, `${name}.raw.txt`));
    const expected = Deno.readTextFileSync(join(FIXTURES, `${name}.explained.txt`));
    const actual = explainFixture(raw);
    assertEquals(
      actual,
      expected,
      `${name}: run \`deno run -A scripts/capture-explain-fixtures.ts --explain\` if intended`,
    );
    // Never hide information: every original diagnostic is still in the output, verbatim.
    for (const d of parseDiagnostics(raw)) {
      for (const line of d.raw.split("\n")) assertStringIncludes(actual, line);
    }
  });
}

Deno.test("explain snapshots: every common case is captured and explained", () => {
  const all = cases();
  for (
    const required of [
      "define-api-response", // TS2322 through defineApi's handler type
      "api-client-body", // TS2345 through createApiClient's RequestOf<InferEndpoint<…>>
      "use-api-query", // TS2322 inside a useApi call
      "api-client-path", // unknown route path → did-you-mean
      "api-client-param", // unknown route param → did-you-mean
      "possibly-undefined", // TS18048
      "possibly-null", // TS18047
      "object-possibly-undefined", // TS2532
      "non-exhaustive-switch", // TS2322 into never
      "missing-return-switch", // TS2366
      "react-import", // react / next/* in new code
      "missing-import", // TS2304
      "module-not-found", // TS2307 + did-you-mean
      "lint-directive",
      "lint-hooks-async",
      "lint-rules-of-hooks",
      "lint-exhaustive-switch", // the opt-in rule, with the union declared in the file
    ]
  ) {
    assert(all.includes(required), `missing fixture ${required}`);
    const text = Deno.readTextFileSync(join(FIXTURES, `${required}.explained.txt`));
    assertStringIncludes(text, "Fix:", `${required} is explained`);
  }
});

Deno.test("explain: a long generic chain collapses to the one mismatching property path", () => {
  const raw = Deno.readTextFileSync(join(FIXTURES, "api-client-body.raw.txt"));
  const [d] = parseDiagnostics(raw);
  assertEquals(d.code, "TS2345");
  assert(d.message.includes("RequestOf<NonNullable<InferEndpoint<"), "the raw chain is long");
  const e = explainDiagnostic(d)!;
  assertEquals(e.title, "Type mismatch at `body.title`");
  assert(!e.why.includes("InferEndpoint"), e.why);
});

Deno.test("parseDiagnostics: TS blocks, related locations, lint blocks, Deno and esbuild errors", () => {
  const ts = parseDiagnostics(
    Deno.readTextFileSync(join(FIXTURES, "assignable-object.raw.txt")),
  );
  assertEquals(ts.length, 1);
  assertEquals(ts[0].file, `${FIXTURE_APP_DIR}/assignable-object.ts`);
  assertEquals([ts[0].line, ts[0].column, ts[0].length], [8, 12, 4]);
  assertEquals(ts[0].related[0].line, 3);

  const lint = parseDiagnostics(
    Deno.readTextFileSync(join(FIXTURES, "lint-hooks-async.raw.txt")),
  );
  assertEquals(lint.map((d) => d.code), [
    "denext/no-hooks-in-async",
    "denext/no-handlers-in-async",
  ]);
  assert(!lint[0].message.endsWith("]"), "the trailing [rule] tag is dropped");

  const deno = parseDiagnostics(
    'error: Module not found "file:///app/x.ts".\n    at file:///app/main.ts:1:21\n',
  );
  assertEquals([deno[0].code, deno[0].file, deno[0].line], ["module-not-found", "/app/main.ts", 1]);

  const esbuild = parseDiagnostics(
    'Build failed with 1 error:\napp/page.tsx:2:26: ERROR: Could not resolve "./utlis"',
    "/proj",
  );
  assertEquals(esbuild[0].file, "/proj/app/page.tsx");
  assertEquals(esbuild[0].column, 27, "esbuild columns are 0-based");

  assertEquals(
    parseDiagnostics("\x1b[1mTS2304 \x1b[0m[ERROR]: Cannot find name 'x'.")[0].code,
    "TS2304",
  );
  assertEquals(parseDiagnostics("all good\n"), []);
});

Deno.test("explain: the opt-in exhaustive-switch (no local type) and no-throw rules", () => {
  const unknownType = explainDiagnostic(fromStructured({
    code: "denext/exhaustive-switch",
    message: "This switch over `shape.kind` has only literal cases and no `default`.",
  }))!;
  assertEquals(unknownType.title, "This switch over `shape.kind` may not handle every case");
  assertStringIncludes(unknownType.fix, "assertNever(shape.kind)");
  const thrown = explainDiagnostic(fromStructured({
    code: "denext/no-throw",
    message: "`throw` in a no-throw directory.",
  }))!;
  assertStringIncludes(thrown.fix, "err(");
});

Deno.test("fromStructured: a TypeScript message chain and a lint rule id", () => {
  const d = fromStructured({
    code: 2322,
    message: {
      messageText: "Type '{ a: number; }' is not assignable to type 'X'.",
      next: [{
        messageText: "Types of property 'a' are incompatible.",
        next: [{ messageText: "Type 'number' is not assignable to type 'string'." }],
      }],
    },
  });
  assertEquals(d.code, "TS2322");
  const e = explainDiagnostic(d)!;
  assertEquals(e.title, "Type mismatch at `a`");
  assertStringIncludes(e.why, "`number`");

  const lint = fromStructured({
    code: "denext/rules-of-hooks",
    message: "`useState` is called conditionally.",
    file: "/x/a.tsx",
    line: 3,
    column: 5,
  });
  assertEquals(lint.source, "lint");
  assertEquals(explainDiagnostic(lint)?.title, "`useState` is called conditionally");
});

Deno.test("explainDiagnosticsText: an unknown diagnostic and other lines pass through unchanged", () => {
  const output = "TS9999 [ERROR]: Something exotic.\n    at file:///a.ts:1:1\n\nFound 1 error.\n";
  const { text, explanations, diagnostics } = explainDiagnosticsText(output);
  assertEquals(diagnostics.length, 1);
  assertEquals(explanations, []);
  assertEquals(text, output);
});

Deno.test("explainDiagnosticsText: colour wraps the title, and the original stays in place", () => {
  const raw = Deno.readTextFileSync(join(FIXTURES, "possibly-undefined.raw.txt"));
  const { text } = explainDiagnosticsText(raw, {}, { color: true });
  assertStringIncludes(text, "\x1b[1;31mTS18048:\x1b[0m");
  assertStringIncludes(text, "error: Type checking failed.");
});

Deno.test("explain: the literal-union and excess-property did-you-means", () => {
  const method = fromStructured({
    code: 2345,
    message: `Argument of type '"GETT"' is not assignable to parameter of type '"GET" | "POST"'.`,
  });
  assertEquals(
    explainDiagnostic(method)?.title,
    `"GETT" is not allowed here — did you mean "GET"?`,
  );
  const extra = fromStructured({
    code: 2561,
    message: "Object literal may only specify known properties, but 'nme' does not exist in type " +
      "'{ name: string; }'. Did you mean to write 'name'?",
  });
  assertEquals(explainDiagnostic(extra)?.fix, "Rename `nme` to `name`.");
});

Deno.test("explain: a missing property in the chain, and a lint directive conflict", () => {
  const missing = fromStructured({
    code: 2322,
    message: "Property 'email' is missing in type '{ name: string; }' but required in type 'U'.",
  });
  assertEquals(explainDiagnostic(missing)?.title, "Missing property `email`");
  const both = fromStructured({
    code: "denext/directive-placement",
    message: 'A module cannot declare both "use client" and "use server".',
  });
  assertStringIncludes(explainDiagnostic(both)!.fix, "Split it");
});

Deno.test("explain: every name the missing-import rule suggests is really exported there", async () => {
  const modules: Record<string, Record<string, unknown>> = {
    denext: await import("../mod.ts"),
    "denext/server": await import("../src/server/mod.ts"),
  };
  for (const [mod, name] of knownDenextNames()) {
    assert(name in modules[mod], `${name} is not exported by ${mod}`);
  }
});

Deno.test("codeframe: the caret sits under the column, `width` wide", () => {
  const frame = codeframe("const x = 1;\nreturn user.name;\n", 2, 8, 0, 4).split("\n");
  assertEquals(frame[0], "> 2 | return user.name;");
  assertEquals(frame[1].indexOf("^"), frame[0].indexOf("user"));
  assertEquals(frame[1].trim(), "^^^^");
});

// ── where it shows up ──────────────────────────────────────────────────────────────────────

/** A temp project holding the possibly-undefined fixture, and its `deno check` output. */
async function tempProject(): Promise<{ dir: string; raw: string }> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-explain-" }));
  const src = Deno.readTextFileSync(join(FIXTURES, "possibly-undefined.ts.txt"));
  await Deno.writeTextFile(join(dir, "possibly-undefined.ts"), src);
  const raw = Deno.readTextFileSync(join(FIXTURES, "possibly-undefined.raw.txt"))
    .replaceAll(FIXTURE_APP_DIR, dir);
  return { dir, raw };
}

Deno.test("denext_explain_error: explains tool output against the project's files", async () => {
  const { dir, raw } = await tempProject();
  try {
    const res = await runTool("denext_explain_error", { output: raw, dir });
    assert(!res.isError);
    const text = res.content[0].text;
    assertStringIncludes(text, "1 diagnostic(s), 1 explained.");
    assertStringIncludes(text, "`user` may be `undefined`");
    assertStringIncludes(text, ">  9 |   return user.name;", "a codeframe from the real file");
    assertStringIncludes(text, "TS18048 [ERROR]: 'user' is possibly 'undefined'.", "the original");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext_explain_error: a structured diagnostic; nothing to explain is an error", async () => {
  const res = await runTool("denext_explain_error", {
    diagnostic: { code: 2304, message: "Cannot find name 'useEffect'." },
  });
  assertStringIncludes(res.content[0].text, 'import { useEffect } from "denext";');
  const none = await runTool("denext_explain_error", { output: "nothing here" });
  assert(none.isError);
  const unknown = await runTool("denext_explain_error", {
    diagnostic: { code: 9999, message: "Exotic." },
  });
  assertStringIncludes(unknown.content[0].text, "TS9999: no specific explanation");
});

Deno.test("denext_explain_error: never reads a file outside the project", async () => {
  const { dir, raw } = await tempProject();
  const outside = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-outside-" }));
  try {
    await Deno.writeTextFile(join(outside, "possibly-undefined.ts"), "SECRET\n".repeat(12));
    const ctx = projectExplainContext(dir);
    assertEquals(ctx.readSource!(join(outside, "possibly-undefined.ts")), undefined);
    assertEquals(ctx.listDir!(outside), []);
    const [d] = parseDiagnostics(raw.replaceAll(dir, outside));
    const e = explainDiagnostic(d, ctx)!;
    assertEquals(e.codeframe, undefined);
    assert(!formatExplanation(e).includes("SECRET"));
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("explainBuildFailure: an unresolved import gets a did-you-mean after the message", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-explain-" }));
  try {
    await Deno.mkdir(join(dir, "app"));
    await Deno.writeTextFile(join(dir, "app/utils.ts"), "export const x = 1;\n");
    await Deno.writeTextFile(join(dir, "app/page.tsx"), 'import { x } from "./utlis.ts";\n');
    const detail =
      'Build failed with 1 error:\napp/page.tsx:1:18: ERROR: Could not resolve "./utlis.ts"';
    const note = explainBuildFailure(detail, dir);
    assertStringIncludes(note, 'Module "./utlis.ts" not found — did you mean "./utils.ts"?');
    assertEquals(explainBuildFailure("TypeError: boom", dir), "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
