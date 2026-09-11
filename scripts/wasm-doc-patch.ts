// Add JSDoc to the members of a wasmbuild-generated `.d.ts` that wasm-bindgen emits WITHOUT
// docs — the per-class `free()` / `[Symbol.dispose]()` boilerplate and `export enum`
// declarations (Rust `///` comments only reach the generated fn/class/method docs). JSR's
// "has docs for most symbols" score and `deno task doc-lint` count those members, so every
// wasm package re-runs this after `wasmbuild`:
//
//   deno task docs:wasm            # patch every packages/*/lib/*.d.ts
//   deno task docs:wasm -- photon  # one package
//
// Idempotent: a member that already has a doc block above it is left alone. Enum members get
// a doc naming the member; hand-written per-member docs (in ENUM_DOCS below) win when present.

import { fromFileUrl, join } from "@std/path";

const PACKAGES_DIR = fromFileUrl(new URL("../packages", import.meta.url));

/** Hand-written docs for enum members whose names alone don't explain them. */
const ENUM_DOCS: Record<string, Record<string, string>> = {
  SamplingFilter: {
    _: "The resampling filter `resize` uses — a speed / quality trade-off, cheapest first.",
    Nearest: "Nearest-neighbour: fastest, blocky (pixel art).",
    Triangle: "Linear (triangle) interpolation: fast, slightly soft.",
    CatmullRom: "Catmull-Rom cubic: a good general-purpose default.",
    Gaussian: "Gaussian: smooth, blurs fine detail.",
    Lanczos3: "Lanczos (a=3): sharpest, slowest — the usual choice for photos.",
  },
};

/** Is the line before `i` (skipping blanks) the end of a JSDoc block? */
function documented(lines: string[], i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const l = lines[j].trim();
    if (l === "") continue;
    return l.endsWith("*/");
  }
  return false;
}

const FREE_DOC =
  "Release the wasm memory behind this object. Call it when done (or use `using`); a freed object must not be used again.";
const DISPOSE_DOC =
  "`using` support: the same as `free()`, run automatically at the end of the block.";

/** The enum a scan is currently inside, if any (member lines are only docs-worthy inside one). */
interface Scan {
  enumName: string | null;
}

/** The doc a line needs (given the scan state, which it updates), or `null` when it needs none. */
function memberDoc(line: string, scan: Scan): string | null {
  const enumOpen = line.match(/^export enum (\w+) \{/);
  if (enumOpen) {
    scan.enumName = enumOpen[1];
    return ENUM_DOCS[scan.enumName]?._ ?? `The \`${scan.enumName}\` enumeration.`;
  }
  if (scan.enumName) {
    if (/^\}/.test(line)) {
      scan.enumName = null;
      return null;
    }
    const member = line.match(/^\s*(\w+)\s*=/);
    if (!member) return null;
    return ENUM_DOCS[scan.enumName]?.[member[1]] ?? `\`${scan.enumName}.${member[1]}\`.`;
  }
  if (/^\s*free\(\): void;$/.test(line)) return FREE_DOC;
  if (/^\s*\[Symbol\.dispose\]\(\): void;$/.test(line)) return DISPOSE_DOC;
  return null;
}

/** Patch one `.d.ts` text; returns the new text and how many docs were added. */
export function patchDts(text: string): { text: string; added: number } {
  const lines = text.split("\n");
  const out: string[] = [];
  const scan: Scan = { enumName: null };
  let added = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const doc = memberDoc(line, scan);
    if (doc !== null && !documented(lines, i)) {
      out.push(`${line.match(/^\s*/)![0]}/** ${doc} */`);
      added++;
    }
    out.push(line);
  }
  return { text: out.join("\n"), added };
}

if (import.meta.main) {
  const only = Deno.args.filter((a) => !a.startsWith("--"));
  for await (const pkg of Deno.readDir(PACKAGES_DIR)) {
    if (!pkg.isDirectory || (only.length > 0 && !only.includes(pkg.name))) continue;
    const lib = join(PACKAGES_DIR, pkg.name, "lib");
    let entries: Deno.DirEntry[] = [];
    try {
      for await (const e of Deno.readDir(lib)) entries.push(e);
    } catch {
      continue; // no lib/ — not a wasm package
    }
    entries = entries.filter((e) => e.isFile && e.name.endsWith(".d.ts"));
    for (const e of entries) {
      const path = join(lib, e.name);
      const { text, added } = patchDts(await Deno.readTextFile(path));
      if (added > 0) await Deno.writeTextFile(path, text);
      console.log(`${pkg.name}/lib/${e.name}: ${added} doc block(s) added`);
    }
  }
}
