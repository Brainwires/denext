// The /docs/tutorial page narrates the REAL examples/notes app, so every fenced code
// block on it must be a verbatim excerpt of a file in the repository — not a paraphrase
// that drifts the day the example changes. Each block names its source as its first
// line (`// examples/notes/lib/db.ts`, or `# …` in a shell block); this test reads that
// file and asserts the rest of the block is a literal substring of it.

import { assert } from "@std/assert";

const REPO = new URL("../", import.meta.url);
const DOC = "apps/web/app/docs/tutorial/content.md";

/** One fenced block of the tutorial: its declared source file and its code. */
interface Block {
  path: string;
  code: string;
  line: number;
}

const read = (path: string): string =>
  Deno.readTextFileSync(new URL(path, REPO)).replace(/\r\n/g, "\n");

/** Every fenced block whose first line is a `// <path>` / `# <path>` source marker. */
function sourcedBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("```")) continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && !lines[end].startsWith("```")) end++;
    const body = lines.slice(start, end);
    i = end;
    const marker = body[0]?.match(/^(?:\/\/|#) ([\w./[\]@-]+\.[a-z]+)$/);
    if (marker) blocks.push({ path: marker[1], code: body.slice(1).join("\n"), line: start + 1 });
  }
  return blocks;
}

/** The first line of `code` that is not present in `source`, for a useful failure. */
function firstDifferingLine(code: string, source: string): string {
  for (const line of code.split("\n")) {
    if (line.trim() !== "" && !source.includes(line)) return line;
  }
  return code.split("\n")[0] ?? "";
}

Deno.test("docs: every tutorial code block is verbatim from examples/notes", () => {
  const blocks = sourcedBlocks(read(DOC));
  assert(blocks.length >= 10, `expected the tutorial to cite its sources, found ${blocks.length}`);

  let fromExample = 0;
  for (const block of blocks) {
    if (block.path.startsWith("examples/notes/")) fromExample++;
    let source: string;
    try {
      source = read(block.path);
    } catch {
      throw new Error(`${DOC}:${block.line} cites ${block.path}, which does not exist`);
    }
    const code = block.code.trim();
    assert(
      source.includes(code),
      `${DOC}:${block.line} is not verbatim from ${block.path}.\n` +
        `  first differing line: ${firstDifferingLine(code, source)}`,
    );
  }

  assert(fromExample >= 8, `the tutorial must narrate examples/notes, cited ${fromExample} times`);
});
