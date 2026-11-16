// What denext prints (CLI output, error messages, the desktop capability catalog, generated files)
// describes a runtime gate by the capability and how to get it, never by a runtime release number:
// a number goes stale as releases ship, and a reader can't tell from it what they lack. The
// version-gate CONSTANTS stay (`FIRST_PTY_RUNTIME = "3.0.0-denext.12"`) and so do the comparisons
// against them; only text that reaches a user is checked. The CHANGELOG, the dated record, is
// the one place a version names a gate (tests/docs-runtime-gates.test.ts checks the docs).

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join, relative } from "@std/path";
import { DESKTOP_CAPABILITIES } from "../src/build/desktop-capabilities.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** A runtime release number: denext's Deno / Deno Desktop runtime. */
const RUNTIME_RELEASE = /\b(?:3\.0\.0-(?:rc|denext)\.\d+|2\.9\.[78]-denext\.\d+)\b/;

/** A version-gate constant's definition: `[export] const NAME = "<release>";`. */
const VERSION_CONSTANT =
  /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*"(?:3\.0\.0-(?:rc|denext)\.\d+|2\.9\.[78]-denext\.\d+)";/;

/**
 * Source lines that keep a release number, each with why. Matched by path and a substring of the
 * line. Only code that is not user-facing text belongs here, never a message.
 */
const ALLOWLIST: { path: string; line: string; why: string }[] = [
  // A maintainer's pin-consistency check (scripts/desktop-pin-runtime.ts runs it when the pin
  // moves): it tells whoever moves the runtime pin which constant to fix, by name and value.
  {
    path: "src/build/deno-version.ts",
    line: "`(${FIRST_MEDIA_CAPTURE_RUNTIME}) but records laufey API ${",
    why: "maintainer-only pin check naming the constant to move",
  },
];

/** Every shipped TypeScript source under `src/` and `packages/` (tests and fixtures excluded). */
async function sources(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function visit(dir: string): Promise<void> {
    for await (const e of Deno.readDir(dir)) {
      const path = join(dir, e.name);
      if (e.isDirectory) {
        if (["node_modules", "testdata", "tests", "fixtures", "__tests__"].includes(e.name)) {
          continue;
        }
        await visit(path);
      } else if (/\.tsx?$/.test(e.name) && !/[._]test\.tsx?$|\.d\.ts$/.test(e.name)) {
        // POSIX keys on every OS (the allowlist and the messages name them so).
        out.set(relative(ROOT, path).replaceAll("\\", "/"), await Deno.readTextFile(path));
      }
    }
  }
  await visit(join(ROOT, "src"));
  await visit(join(ROOT, "packages"));
  return out;
}

/** The line without a trailing ` // comment` (a URL's `://` has no space before it). */
const stripTrailingComment = (line: string): string => line.replace(/\s\/\/\s.*$/, "");

/** Each line's number and text, outside `//` lines, JSDoc / block comments and gate constants. */
function codeLines(text: string): [number, string][] {
  const out: [number, string][] = [];
  let inBlockComment = false;
  text.split("\n").forEach((raw, i) => {
    const trimmed = raw.trim();
    const opens = trimmed.startsWith("/*");
    if (inBlockComment || opens) {
      inBlockComment = !trimmed.includes("*/");
      return;
    }
    const comment = trimmed.startsWith("//") || trimmed.startsWith("*");
    if (!comment && !VERSION_CONSTANT.test(raw)) out.push([i + 1, raw]);
  });
  return out;
}

/** The names of every version-gate constant the sources define. */
function versionConstants(files: Map<string, string>): Set<string> {
  const constants = new Set<string>();
  for (const text of files.values()) {
    for (const m of text.matchAll(new RegExp(VERSION_CONSTANT.source, "gm"))) constants.add(m[1]);
  }
  return constants;
}

/**
 * `<path>:<line>: <text>` for every non-comment source line that names a runtime release or
 * interpolates a version-gate constant into a template literal, outside the allowlist.
 */
export function messageGateOffenders(files: Map<string, string>): string[] {
  const constants = versionConstants(files);
  const offenders: string[] = [];
  for (const [path, text] of files) {
    for (const [n, raw] of codeLines(text)) {
      const line = stripTrailingComment(raw);
      const interpolated = [...line.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)]
        .some((m) => constants.has(m[1]));
      if (!RUNTIME_RELEASE.test(line) && !interpolated) continue;
      if (ALLOWLIST.some((a) => a.path === path && raw.includes(a.line))) continue;
      offenders.push(`${path}:${n}: ${raw.trim()}`);
    }
  }
  return offenders;
}

Deno.test("messages: no runtime release number in shipped user-facing text", async () => {
  const files = await sources();
  assert(files.has("src/build/desktop-capabilities.ts"));
  assertEquals(messageGateOffenders(files), []);
});

Deno.test("messages: the desktop capability catalog names capabilities, not releases", () => {
  const offenders: string[] = [];
  for (const [name, entry] of Object.entries(DESKTOP_CAPABILITIES)) {
    for (const text of [entry.notes, ...(entry.manual ?? [])]) {
      if (typeof text === "string" && RUNTIME_RELEASE.test(text)) {
        offenders.push(`${name}: ${text}`);
      }
    }
  }
  assertEquals(offenders, []);
});

Deno.test("messageGateOffenders: flags a message, skips comments and gate constants", () => {
  const files = new Map([
    [
      "src/a.ts",
      [
        'export const FIRST_X_RUNTIME = "3.0.0-denext.12";',
        "// works from 3.0.0-denext.12",
        "/**",
        " * from 3.0.0-denext.12",
        " */",
        'if (compare(v, FIRST_X_RUNTIME) < 0) throw new Error("needs runtime 3.0.0-denext.12");',
        "const m = `needs ${FIRST_X_RUNTIME} or later`;",
        "const ok = `needs a runtime with X`; // the pinned one has it (3.0.0-denext.12)",
      ].join("\n"),
    ],
  ]);
  assertEquals(messageGateOffenders(files), [
    'src/a.ts:6: if (compare(v, FIRST_X_RUNTIME) < 0) throw new Error("needs runtime 3.0.0-denext.12");',
    "src/a.ts:7: const m = `needs ${FIRST_X_RUNTIME} or later`;",
  ]);
});
