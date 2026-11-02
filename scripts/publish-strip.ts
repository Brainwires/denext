// Keeps @denext/denext clear of JSR's 20 MiB cap, which counts the uncompressed bytes of every
// file in the package (jsr-io/jsr api/src/tarball.rs, MAX_TOTAL_FILE_SIZE). About 40% of the
// published source is comments, nearly all of it for whoever reads this repository. publish.yml
// blanks the comments no reader of the package needs, in its own checkout, right before `deno
// publish`: whole-line `//` comments, and JSDoc outside the public API. The public API's JSDoc
// (what JSR's docs and an editor's hover show) stays, every remaining line keeps its line number
// (stack traces and JSR's source links match the tag), and the code is unchanged.
//
//   deno run -A scripts/publish-strip.ts            # measure; exit 1 over the guard
//   deno run -A scripts/publish-strip.ts --write    # also rewrite the files (publish.yml only)

// deno-lint-ignore no-import-prefix -- denext's release tooling only; never published.
import ts from "npm:typescript@5";
import { publishedFiles } from "./lib/published-files.ts";

/** Over this many stripped bytes the release stops: JSR refuses 20 MiB, after the tag is pushed. */
export const PUBLISH_GUARD_BYTES: number = 18.5 * 1024 * 1024;

/** Comments a tool reads, whatever they sit on. */
const TOOL_LINE_COMMENT = /^\/\/(?:\/|\s*(?:@|deno-|#))/;
const TOOL_JSDOC = /@(?:module|jsx|ts-|__)/;
/** A notice has to stay with its code: a file carrying one, or vendored, is published untouched. */
const NOTICE = /copyright|licensed under|spdx-license|\(c\) \d{4}/i;

function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((d) =>
      ts.isIdentifier(d.name) ? [d.name.text] : []
    );
  }
  const name = (statement as ts.Statement & { name?: ts.Node }).name;
  return name && ts.isIdentifier(name) ? [name.text] : [];
}

function isExportedStatement(statement: ts.Statement): boolean {
  return ts.isExportAssignment(statement) || ts.isExportDeclaration(statement) ||
    ts.isModuleDeclaration(statement) || // `declare global` / `declare module`
    (ts.canHaveModifiers(statement) &&
      !!ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

/** `Foo.bar = …`: API docs read it as a member of `Foo`. */
function isExpandoAssignment(statement: ts.Statement): boolean {
  return ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
    statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(statement.expression.left);
}

/** The identifiers a statement names outside function bodies. */
function signatureNames(statement: ts.Statement): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isBlock(node)) return;
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return names;
}

/**
 * The top-level statements API docs can show: the exported ones, members assigned onto a function,
 * and every local declaration those name (`export { a }`, or a private type in a signature).
 */
function publicStatements(file: ts.SourceFile): Set<ts.Statement> {
  const open = file.statements.filter((s) => isExportedStatement(s) || isExpandoAssignment(s));
  const found = new Set<ts.Statement>(open);
  while (open.length) {
    const names = signatureNames(open.pop()!);
    for (const statement of file.statements) {
      if (found.has(statement) || !declaredNames(statement).some((n) => names.has(n))) continue;
      found.add(statement);
      open.push(statement);
    }
  }
  return found;
}

/** What to blank for one comment, or `null` to keep it. */
function blankRange(
  text: string,
  range: ts.CommentRange,
  inPublicApi: boolean,
): [number, number] | null {
  const lineStart = text.lastIndexOf("\n", range.pos - 1) + 1;
  const ownLine = text.slice(lineStart, range.pos).trim() === "";
  const comment = text.slice(range.pos, range.end);
  if (comment.startsWith("//")) {
    return ownLine && !TOOL_LINE_COMMENT.test(comment) ? [lineStart, range.end] : null;
  }
  if (!comment.startsWith("/**") || inPublicApi || TOOL_JSDOC.test(comment)) return null;
  const after = text.indexOf("\n", range.end);
  const restOfLine = text.slice(range.end, after === -1 ? text.length : after);
  return [ownLine && restOfLine.trim() === "" ? lineStart : range.pos, range.end];
}

/**
 * The source `deno publish` should send for a published file: internal comments blanked, with
 * every newline kept. Anything but a plain `.ts` module, and any file with a licence notice or
 * under a `vendor/` directory, comes back unchanged.
 *
 * @param path The file's repo-relative path.
 * @param text The file's source.
 * @returns The text to publish.
 */
export function stripForPublish(path: string, text: string): string {
  if (!/\.m?ts$/.test(path) || path.endsWith(".d.ts") || /(^|\/)vendor\//.test(path)) return text;
  if (NOTICE.test(text)) return text;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const publicScope = publicStatements(file);
  const blanks: [number, number][] = [];
  const seen = new Set<number>();
  const visit = (node: ts.Node, inPublicApi: boolean) => {
    for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const blank = blankRange(text, range, inPublicApi);
      if (blank) blanks.push(blank);
    }
    ts.forEachChild(node, (child) => visit(child, inPublicApi && !ts.isBlock(child)));
  };
  for (const statement of file.statements) {
    visit(statement, publicScope.has(statement));
  }
  let out = text;
  for (const [start, end] of blanks.sort((a, b) => b[0] - a[0])) {
    const newlines = text.slice(start, end).replace(/[^\n]/g, "");
    out = out.slice(0, start) + newlines + out.slice(end);
  }
  return out;
}

/**
 * Why a publish set of `bytes` must not go out, or `null` when it is under the guard.
 *
 * @param bytes The set's size after {@link stripForPublish}.
 * @returns The message to stop the release with.
 */
export function publishSizeProblem(bytes: number): string | null {
  if (bytes <= PUBLISH_GUARD_BYTES) return null;
  const mib = (n: number) => (n / 1024 / 1024).toFixed(2);
  return `@denext/denext is ${mib(bytes)} MiB as published, over the ` +
    `${mib(PUBLISH_GUARD_BYTES)} MiB guard (JSR refuses 20 MiB after the tag is pushed). Move ` +
    "data or a verb's modules out of the package, or raise the guard with the reason.";
}

/**
 * Measure the publish set as it goes out, optionally rewriting it in place.
 *
 * @param write Rewrite the files too (publish.yml's checkout only).
 * @returns The set's size before and after stripping, `null` outside a git checkout.
 */
export async function measurePublishSet(
  write = false,
): Promise<{ before: number; after: number } | null> {
  const files = await publishedFiles();
  if (!files) return null;
  const root = new URL("../", import.meta.url);
  const encoder = new TextEncoder();
  let before = 0, after = 0;
  for (const [path, size] of files) {
    before += size;
    if (!/\.m?ts$/.test(path)) {
      after += size;
      continue;
    }
    const url = new URL(path, root);
    const text = await Deno.readTextFile(url);
    const stripped = stripForPublish(path, text);
    after += encoder.encode(stripped).length;
    if (write && stripped !== text) await Deno.writeTextFile(url, stripped);
  }
  return { before, after };
}

if (import.meta.main) {
  const measured = await measurePublishSet(Deno.args.includes("--write"));
  if (!measured) {
    console.error("publish-strip: not a git checkout");
    Deno.exit(1);
  }
  const mib = (n: number) => (n / 1024 / 1024).toFixed(2);
  console.log(`@denext/denext: ${mib(measured.before)} MiB → ${mib(measured.after)} MiB published`);
  const problem = publishSizeProblem(measured.after);
  if (problem) {
    console.error(problem);
    Deno.exit(1);
  }
}
