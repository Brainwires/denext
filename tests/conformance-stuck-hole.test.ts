// `probeApp` / `denext doctor` report a streamed Suspense hole whose render threw with nothing
// inside the hole to catch it: the hole streams no `<template>`, so its fallback stays in a
// 200 page. The server reports the throw to `onRequestError` (Next reports every render error
// there), and the probe names the stuck hole with that error.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { type ConformanceReport, formatReport, probeApp } from "../src/testing/mod.ts";
import { stuckHoles } from "../src/testing/conformance.ts";
import { renderShell } from "../src/jsx/render-to-stream.ts";
import { renderFlightShell } from "../src/jsx/render-to-flight-stream.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { SWAP_RUNTIME } from "../src/server/swap-runtime.ts";

const JSX = new URL("../src/jsx/jsx-runtime.ts", import.meta.url).href;
const SUSPENSE = new URL("../src/runtime/suspense.ts", import.meta.url).href;

/** A temp app: a clean streamed page, and one whose hole throws with no error.tsx inside it. */
async function writeApp(dir: string): Promise<void> {
  const hole = (body: string) =>
    `import { h } from "${JSX}";
import { Suspense } from "${SUSPENSE}";
async function Slow() {
  await new Promise((r) => setTimeout(r, 5));
  ${body}
}
export default function P() {
  return h("div", null, h("h1", null, "shell"), h(Suspense, { fallback: h("p", null, "Loading…") }, h(Slow, null)));
}`;
  const files: Record<string, string> = {
    "app/layout.ts": `import { h } from "${JSX}";
export const metadata = { title: "Probe" };
export default function Root({ children }) { return h("main", null, children); }`,
    "app/page.ts": hole(`return h("p", null, "loaded");`),
    "app/stuck/page.ts": hole(`throw new Error("upstream exploded");`),
  };
  for (const [rel, src] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, src);
  }
}

/** Probe the temp app, the server's own error log silenced. */
async function probeTempApp(): Promise<ConformanceReport> {
  const dir = await Deno.makeTempDir({ prefix: "denext_probe_stuck_" });
  const origError = console.error;
  console.error = () => {}; // the server logs the failed hole
  try {
    await writeApp(dir);
    return await probeApp(dir);
  } finally {
    console.error = origError;
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("probeApp: a streamed hole stuck on its fallback by an uncaught error fails", async () => {
  const report = await probeTempApp();
  const home = report.routes.find((r) => r.path === "/");
  assert(home?.rendered && home.ok, "a hole that streams in passes:\n" + formatReport(report));

  const stuck = report.routes.find((r) => r.path === "/stuck");
  assert(stuck, formatReport(report));
  assertEquals(stuck.status, 200);
  assert(!stuck.ok, "the stuck hole fails the route:\n" + formatReport(report));
  const check = stuck.checks.find((c) => c.name === "no-stuck-hole");
  assert(check && !check.pass, "the no-stuck-hole check failed");
  assertStringIncludes(check.detail ?? "", "upstream exploded");
  assert(/\[digest [0-9a-f]{16}\]/.test(check.detail ?? ""), "the detail carries the digest");
  assertEquals(report.ok, false);
  assertStringIncludes(formatReport(report), "no-stuck-hole");
});

Deno.test("stuckHoles: only an unfilled placeholder of a streamed document", () => {
  const streamed = (body: string) =>
    `<!DOCTYPE html><html><body>${SWAP_RUNTIME}${body}</body></html>`;
  assertEquals(
    stuckHoles(streamed(`<div data-dnx-b="dnx0">…</div><template data-dnx-r="dnx0">ok</template>`)),
    [],
  );
  assertEquals(
    stuckHoles(streamed(
      `<div data-dnx-b="dnx0">…</div><div data-dnx-b="dnx1">…</div>` +
        `<template data-dnx-r="dnx1">ok</template>`,
    )),
    ["dnx0"],
  );
  // A buffered document (no swap runtime) has no streamed holes to be stuck.
  assertEquals(stuckHoles(`<div data-dnx-b="dnx0">…</div>`), []);
});

/** A component that throws after a tick: the error lands in the hole, not the shell. */
async function Throws(): Promise<never> {
  await Promise.resolve();
  throw new Error("hole threw");
}

Deno.test("renderShell: an uncaught hole error is handed to onHoleError", async () => {
  const seen: unknown[] = [];
  const origError = console.error;
  console.error = () => {};
  try {
    const tree = h(Suspense, { fallback: h("p", null, "…") }, h(Throws, null));
    const shell = await renderShell(tree, null, false, (e) => seen.push(e));
    const holes = await Promise.all(shell.holes);
    assertEquals(holes.map((x) => x.ok), [false]);
  } finally {
    console.error = origError;
  }
  assertEquals(seen.map((e) => (e as Error).message), ["hole threw"]);
});

Deno.test("renderFlightShell: an uncaught hole error is handed to onHoleError", async () => {
  const seen: unknown[] = [];
  const origError = console.error;
  console.error = () => {};
  try {
    const tree = h(Suspense, { fallback: h("p", null, "…") }, h(Throws, null));
    const contained = await renderFlightShell(tree, false, null, () => {
      throw new Error("a throwing reporter is contained");
    });
    const reported = await renderFlightShell(tree, false, null, (e) => seen.push(e));
    const sink = { enqueue() {} } as unknown as ReadableStreamDefaultController<Uint8Array>;
    await contained.streamHoles(sink, new TextEncoder(), undefined, false);
    await reported.streamHoles(sink, new TextEncoder(), undefined, false);
  } finally {
    console.error = origError;
  }
  assertEquals(seen.map((e) => (e as Error).message), ["hole threw"]);
});
