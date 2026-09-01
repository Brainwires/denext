// Dev error-overlay helpers: stack-frame parsing, codeframe rendering, and the
// editor-launch command shaping (all pure — no spawn, no IO).

import { assert, assertEquals } from "@std/assert";
import { codeframe, parseStackFrame } from "../src/build/dev-codeframe.ts";
import { editorCommand } from "../src/build/dev-server.ts";

Deno.test("parseStackFrame returns the first in-project frame, skipping deps", () => {
  const stack = [
    "Error: boom",
    "    at dep (file:///proj/node_modules/x/x.ts:1:1)",
    "    at gen (file:///proj/.denext/entry.js:2:2)",
    "    at Page (file:///proj/app/page.tsx:12:5)",
    "    at run (file:///other/root/main.ts:3:3)",
  ].join("\n");
  assertEquals(parseStackFrame(stack, "/proj"), {
    file: "/proj/app/page.tsx",
    line: 12,
    column: 5,
  });
});

Deno.test("parseStackFrame returns null when no frame is inside the project", () => {
  const stack = "Error\n    at x (file:///elsewhere/a.ts:1:1)";
  assertEquals(parseStackFrame(stack, "/proj"), null);
  assertEquals(parseStackFrame(undefined, "/proj"), null);
});

Deno.test("codeframe marks the error line and places a caret at the column", () => {
  const src = "const a = 1;\nconst b = 2;\nboom();\nconst d = 4;\nconst e = 5;";
  const frame = codeframe(src, 3, 1, 1);
  const lines = frame.split("\n");
  // One line of context each side (line 2 and 4), the error line marked with `>`.
  assert(lines.some((l) => l.startsWith("  2 | ")), frame);
  assert(lines.some((l) => l.startsWith("> 3 | boom();")), frame);
  assert(lines.some((l) => l.startsWith("  4 | ")), frame);
  // A caret line follows the error line.
  const errIdx = lines.findIndex((l) => l.startsWith("> 3 |"));
  assert(lines[errIdx + 1].trimEnd().endsWith("^"), frame);
  // Out-of-range line yields nothing.
  assertEquals(codeframe(src, 99, 1), "");
});

Deno.test("editorCommand shapes args per editor family (env-driven)", () => {
  const env = (map: Record<string, string>) => (k: string) => map[k];
  // Default (nothing set) → VS Code's `code --goto file:line:col`.
  assertEquals(editorCommand("/p/a.ts", 10, 2, () => undefined), {
    cmd: "code",
    args: ["--goto", "/p/a.ts:10:2"],
  });
  // A terminal editor → `+line file`.
  assertEquals(editorCommand("/p/a.ts", 10, 2, env({ EDITOR: "nvim" })), {
    cmd: "nvim",
    args: ["+10", "/p/a.ts"],
  });
  // JetBrains → `--line N --column C file`; DENEXT_EDITOR wins over EDITOR.
  assertEquals(
    editorCommand("/p/a.ts", 10, 2, env({ DENEXT_EDITOR: "webstorm", EDITOR: "vim" })),
    { cmd: "webstorm", args: ["--line", "10", "--column", "2", "/p/a.ts"] },
  );
  // Sublime → `file:line:col`.
  assertEquals(editorCommand("/p/a.ts", 10, 2, env({ VISUAL: "subl" })), {
    cmd: "subl",
    args: ["/p/a.ts:10:2"],
  });
});
