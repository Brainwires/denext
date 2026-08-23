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

import { dirname, fromFileUrl, join } from "@std/path";

const here = dirname(fromFileUrl(import.meta.url));
const denoBin = Deno.env.get("DENO_BIN") ?? Deno.execPath();

async function gzipSize(bytes: Uint8Array): Promise<number> {
  const stream = new Response(bytes).body!.pipeThrough(
    new CompressionStream("gzip"),
  );
  return (await new Response(stream).arrayBuffer()).byteLength;
}

/** Bundle `entry` with `config` into a temp dir and return total raw + gzip bytes. */
async function bundle(
  entry: string,
  config: string,
): Promise<{ raw: number; gz: number }> {
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
    let raw = 0, gz = 0;
    for await (const e of Deno.readDir(out)) {
      if (!e.isFile || !e.name.endsWith(".js")) continue;
      const bytes = await Deno.readFile(join(out, e.name));
      raw += bytes.byteLength;
      gz += await gzipSize(bytes);
    }
    return { raw, gz };
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
  console.log(
    "\n  Same SPA, same bundler (deno bundle, minified). Client JS:\n",
  );
  console.log(`  ${"".padEnd(28)}${"raw".padStart(10)}${"gzip".padStart(10)}`);
  console.log(
    `  ${"denext (own React-equiv)".padEnd(28)}${kb(denext.raw).padStart(10)}${
      kb(denext.gz).padStart(10)
    }`,
  );
  console.log(
    `  ${"React 19 + ReactDOM 19".padEnd(28)}${kb(react.raw).padStart(10)}${
      kb(react.gz).padStart(10)
    }`,
  );
  console.log(
    `  ${"denext is smaller by".padEnd(28)}${x(denext.raw, react.raw).padStart(10)}${
      x(denext.gz, react.gz).padStart(10)
    }`,
  );
  console.log("");
} finally {
  await Deno.remove(rdir, { recursive: true });
}
