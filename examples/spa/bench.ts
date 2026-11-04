// Bundle-size benchmark: the SAME tiny SPA (this example's app), bundled two ways
// with the SAME bundler (`deno bundle`, minified + code-split), gzipped:
//
//   1. on denext's own React-equivalent runtime (what `denext build` ships here);
//   2. on real React 19 + ReactDOM 19 (`npm:react` / `npm:react-dom`).
//
// This isolates the ONE variable that matters for download size — the runtime —
// because the app code and the bundler are identical on both sides. React
// Compiler is deliberately NOT a factor: it is a re-render optimization (a babel
// pass that adds memoization + a small `react/compiler-runtime`), so it does not
// shrink the bundle — if anything it adds a few bytes. Size is a runtime story.
//
// Run:  deno run -A bench.ts     (needs network the first time, to fetch npm React)

import { basename, dirname, fromFileUrl, join } from "@std/path";
import { pruneUnreachable } from "../../src/build/sourcemap-attribution.ts";

const here = dirname(fromFileUrl(import.meta.url));
const denoBin = Deno.env.get("DENO_BIN") ?? Deno.execPath();

async function gzipSize(bytes: Uint8Array): Promise<number> {
  const stream = new Response(bytes as BodyInit).body!.pipeThrough(
    new CompressionStream("gzip"),
  );
  return (await new Response(stream).arrayBuffer()).byteLength;
}

/** Raw + gzip bytes. */
interface Size {
  raw: number;
  gz: number;
}

/** What a page downloads: its first load, and every file it can ever load. */
interface Sizes {
  /** The entry plus every chunk it imports statically (the first load). */
  startup: Size;
  /** Every file the entry can reach, `import()` chunks included. */
  loadable: Size;
}

/** A sibling file an emitted file imports statically (`from"./chunk-X.js"`, `import"./x.js"`). */
const STATIC_IMPORT = /(?:from|import)\s*"\.\/([\w$.-]+\.js)"/g;

/** Every `.js` file directly in `dir`, by name. */
async function readJs(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.endsWith(".js")) {
      files.set(e.name, await Deno.readTextFile(join(dir, e.name)));
    }
  }
  return files;
}

/** `entry` and every file it reaches through static imports: the first load. */
function staticClosure(files: Map<string, string>, entry: string): string[] {
  const seen = new Set([entry]);
  // A Set iterates the names added while iterating, so this walks the whole static graph.
  for (const name of seen) {
    for (const m of (files.get(name) ?? "").matchAll(STATIC_IMPORT)) seen.add(m[1]);
  }
  return [...seen].filter((name) => files.has(name));
}

/** Raw + gzip bytes of `names`. */
async function sizeOf(files: Map<string, string>, names: Iterable<string>): Promise<Size> {
  const size = { raw: 0, gz: 0 };
  for (const name of names) {
    const bytes = new TextEncoder().encode(files.get(name)!);
    size.raw += bytes.byteLength;
    size.gz += await gzipSize(bytes);
  }
  return size;
}

/**
 * Size the `.js` files directly in `dir` the way a page loads them. A chunk whose only `import()`
 * site was tree-shaken after code splitting is still emitted by `deno bundle`, but no page can
 * load it and `denext build` does not write it (`pruneUnreachable`), so it is not counted.
 */
async function sizeOfJs(dir: string, entry: string): Promise<Sizes> {
  const files = await readJs(dir);
  pruneUnreachable(files, [entry]);
  return {
    startup: await sizeOf(files, staticClosure(files, entry)),
    loadable: await sizeOf(files, files.keys()),
  };
}

/** Bundle `entry` with `config` into a temp dir and return total raw + gzip bytes. */
async function bundle(
  entry: string,
  config: string,
): Promise<Sizes> {
  const out = await Deno.makeTempDir({ prefix: "spa_bench_" });
  try {
    const { code, stderr } = await new Deno.Command(denoBin, {
      args: [
        "bundle",
        "--platform=browser",
        "--minify",
        "--code-splitting",
        "--outdir",
        out,
        "--config",
        config,
        entry,
      ],
      stderr: "piped",
    }).output();
    if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
    return await sizeOfJs(out, basename(entry).replace(/\.tsx?$/, ".js"));
  } finally {
    await Deno.remove(out, { recursive: true });
  }
}

// ── denext side: bundle THIS example's real entry on denext's runtime ──────────
const denext = await bundle(
  join(here, "src", "main.tsx"),
  join(here, "deno.json"),
);

// ── React side: the same app, re-pointed at real React (written to a temp dir) ─
const rdir = await Deno.makeTempDir({ prefix: "spa_bench_react_" });
try {
  await Deno.mkdir(join(rdir, "src"));
  await Deno.writeTextFile(
    join(rdir, "deno.json"),
    JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        lib: ["deno.window", "dom", "dom.iterable"],
      },
      imports: {
        "react": "npm:react@19",
        "react-dom": "npm:react-dom@19",
        "react-dom/client": "npm:react-dom@19/client",
        "react/jsx-runtime": "npm:react@19/jsx-runtime",
      },
    }),
  );
  // The app, on real React (no denext, no CSS import — same component shape).
  await Deno.writeTextFile(
    join(rdir, "src", "app.tsx"),
    `import { useEffect, useState } from "react";
function useHashRoute(): [string, (to: string) => void] {
  const [route, setRoute] = useState(() => location.hash.slice(1) || "/");
  useEffect(() => {
    const onHash = () => setRoute(location.hash.slice(1) || "/");
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  return [route, (to: string) => { location.hash = to; }];
}
function Counter() {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN((c) => c + 1)}>Clicked {n} times</button>;
}
export function App() {
  const [route, navigate] = useHashRoute();
  const tab = (to: string, label: string) => (
    <button type="button" aria-current={route === to} onClick={() => navigate(to)}><span>{label}</span></button>
  );
  return (
    <div className="card">
      <nav>{tab("/", "Home")}{tab("/about", "About")}</nav>
      {route === "/about" ? <p>A React SPA.</p> : <><h1>Hello from a React SPA</h1><Counter /></>}
    </div>
  );
}
`,
  );
  await Deno.writeTextFile(
    join(rdir, "src", "main.tsx"),
    `import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
`,
  );
  const react = await bundle(
    join(rdir, "src", "main.tsx"),
    join(rdir, "deno.json"),
  );

  const kb = (n: number) => (n / 1024).toFixed(1) + " KB";
  const x = (a: number, b: number) => (b / a).toFixed(1) + "×";
  const row = (label: string, d: Size, r: Size) =>
    console.log(
      `  ${label.padEnd(26)}${kb(d.raw).padStart(10)}${kb(d.gz).padStart(10)}${
        kb(r.raw).padStart(10)
      }${kb(r.gz).padStart(10)}${x(d.raw, r.raw).padStart(8)}${x(d.gz, r.gz).padStart(8)}`,
    );
  console.log(
    "\n  Same SPA, same bundler (deno bundle, minified). Client JS:\n",
  );
  console.log(
    `  ${"".padEnd(26)}${"denext".padStart(20)}${"React 19".padStart(20)}${
      "smaller by".padStart(16)
    }`,
  );
  console.log(
    `  ${"".padEnd(26)}${"raw".padStart(10)}${"gzip".padStart(10)}${"raw".padStart(10)}${
      "gzip".padStart(10)
    }${"raw".padStart(8)}${"gzip".padStart(8)}`,
  );
  row("first load", denext.startup, react.startup);
  row("everything loadable", denext.loadable, react.loadable);
  console.log("");
} finally {
  await Deno.remove(rdir, { recursive: true });
}
