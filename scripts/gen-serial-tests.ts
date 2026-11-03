// Rewrite `SERIAL_TESTS` in tests/serial-tests.ts from the scan (scripts/lib/serial-scan.ts): a
// test file that started changing process-wide state is added in path order, one that stopped is
// dropped with the comment above it, and every kept entry keeps its comment. A
// `SERIAL_SOURCE_EXEMPT` entry whose module is gone is dropped too. Run by
// `deno task regen`; tests/serial-tests.test.ts is the backstop.
//
//   deno run -A scripts/gen-serial-tests.ts

import { fromFileUrl } from "@std/path";
import { mutatingTestFiles } from "./lib/serial-scan.ts";

/** The list's file. */
export const SERIAL_LIST = fromFileUrl(new URL("../tests/serial-tests.ts", import.meta.url));

const OPEN = "export const SERIAL_TESTS: readonly string[] = [\n";

/**
 * `text` (tests/serial-tests.ts) with its `SERIAL_TESTS` entries made exactly `wanted`: entries
 * not wanted are removed with the comment lines directly above them, missing ones are inserted
 * before the first entry that sorts after them. Everything outside the array is untouched.
 */
export function rewriteSerialList(text: string, wanted: readonly string[]): string {
  const start = text.indexOf(OPEN);
  if (start < 0) throw new Error("tests/serial-tests.ts: SERIAL_TESTS not found");
  const bodyStart = start + OPEN.length;
  const bodyEnd = text.indexOf("];\n", bodyStart);
  const lines = text.slice(bodyStart, bodyEnd).split("\n").filter((l, i, a) =>
    i < a.length - 1 || l !== ""
  );
  // Group each entry with the comment lines above it.
  const groups: { path: string; lines: string[] }[] = [];
  let pending: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*"([^"]+)",\s*$/);
    if (m) {
      groups.push({ path: m[1], lines: [...pending, line] });
      pending = [];
    } else pending.push(line);
  }
  const want = new Set(wanted);
  const kept = groups.filter((g) => want.has(g.path));
  const have = new Set(kept.map((g) => g.path));
  for (const path of [...want].filter((p) => !have.has(p)).sort()) {
    const at = kept.findIndex((g) => g.path > path);
    const group = { path, lines: [`  "${path}",`] };
    if (at < 0) kept.push(group);
    else kept.splice(at, 0, group);
  }
  const body = [...kept.flatMap((g) => g.lines), ...pending].map((l) => `${l}\n`).join("");
  return text.slice(0, bodyStart) + body + text.slice(bodyEnd);
}

const EXEMPT_OPEN = "export const SERIAL_SOURCE_EXEMPT: Readonly<Record<string, string>> = {\n";

/**
 * `text` (tests/serial-tests.ts) without the `SERIAL_SOURCE_EXEMPT` entries whose module no longer
 * exists (`exists` says so), each removed with its reason and the comment lines directly above it.
 * Everything else is untouched.
 */
export function dropStaleExemptions(text: string, exists: (path: string) => boolean): string {
  const start = text.indexOf(EXEMPT_OPEN);
  if (start < 0) throw new Error("tests/serial-tests.ts: SERIAL_SOURCE_EXEMPT not found");
  const bodyStart = start + EXEMPT_OPEN.length;
  const bodyEnd = text.indexOf("};\n", bodyStart);
  const lines = text.slice(bodyStart, bodyEnd).split("\n").filter((l, i, a) =>
    i < a.length - 1 || l !== ""
  );
  // Group each entry (its key line and the continuation lines) with the comments above it.
  const groups: { path: string; lines: string[] }[] = [];
  let pending: string[] = [];
  for (const line of lines) {
    const key = line.match(/^ {2}"([^"]+)":/);
    if (key) {
      groups.push({ path: key[1], lines: [...pending, line] });
      pending = [];
    } else if (/^ {2}\/\//.test(line)) pending.push(line);
    else groups[groups.length - 1].lines.push(line);
  }
  const body = [...groups.filter((g) => exists(g.path)).flatMap((g) => g.lines), ...pending]
    .map((l) => `${l}\n`).join("");
  return text.slice(0, bodyStart) + body + text.slice(bodyEnd);
}

if (import.meta.main) {
  const root = fromFileUrl(new URL("..", import.meta.url));
  const original = await Deno.readTextFile(SERIAL_LIST);
  const text = dropStaleExemptions(original, (path) => {
    try {
      return Deno.statSync(`${root}${path}`).isFile;
    } catch {
      return false;
    }
  });
  const next = rewriteSerialList(text, await mutatingTestFiles());
  if (next !== original) await Deno.writeTextFile(SERIAL_LIST, next);
  console.log(
    next === original ? "tests/serial-tests.ts is current" : "rewrote tests/serial-tests.ts",
  );
}
