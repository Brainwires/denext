// `probeApp` / `denext doctor` report a page whose `error.tsx` boundary rendered a caught
// error (a 200 the structural checks accept) as a failure, with the error's message and
// digest — read through the probe's own `onRequestError` hook, so nothing about the error
// reaches the response.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { type ConformanceReport, formatReport, probeApp } from "../src/testing/mod.ts";

const JSX = new URL("../src/jsx/jsx-runtime.ts", import.meta.url).href;
const SUSPENSE = new URL("../src/runtime/suspense.ts", import.meta.url).href;

/** A temp app: a clean home, a page error.tsx catches, and one caught in a streamed hole. */
async function writeApp(dir: string): Promise<void> {
  const files: Record<string, string> = {
    "app/layout.ts": `import { h } from "${JSX}";
export const metadata = { title: "Probe" };
export default function Root({ children }) { return h("main", null, children); }`,
    "app/page.ts": `import { h } from "${JSX}";
export default function Home() { return h("p", null, "home"); }`,
    "app/broken/page.ts": `import { h } from "${JSX}";
export default function Broken() { throw new Error("db down: secret-dsn"); }`,
    "app/broken/error.ts": `import { h } from "${JSX}";
export default function Oops() { return h("p", null, "Something went wrong"); }`,
    // The layout's Suspense streams the page as a hole; error.tsx wraps the page inside it,
    // so the catch happens after the shell (and its report) went out.
    "app/late/layout.ts": `import { h } from "${JSX}";
import { Suspense } from "${SUSPENSE}";
export default function L({ children }) {
  return h("div", null, h(Suspense, { fallback: h("p", null, "…") }, children));
}`,
    "app/late/page.ts": `export default async function Late() {
  await new Promise((r) => setTimeout(r, 5));
  throw new Error("late failure");
}`,
    "app/late/error.ts": `import { h } from "${JSX}";
export default function Oops() { return h("p", null, "Something went wrong"); }`,
  };
  for (const [rel, src] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, src);
  }
}

/** The `no-caught-error` check's detail for `path`, asserting the route failed on it. */
function caughtDetail(report: ConformanceReport, path: string): string {
  const route = report.routes.find((r) => r.path === path);
  assert(route && !route.ok, `${path} fails:\n${formatReport(report)}`);
  const check = route.checks.find((c) => c.name === "no-caught-error");
  assert(check && !check.pass, `${path}'s no-caught-error check failed`);
  return check.detail ?? "";
}

/** Probe the temp app, the server's own error log silenced. */
async function probeTempApp(): Promise<ConformanceReport> {
  const dir = await Deno.makeTempDir({ prefix: "denext_probe_caught_" });
  const origError = console.error;
  console.error = () => {}; // the server logs each caught error
  try {
    await writeApp(dir);
    return await probeApp(dir);
  } finally {
    console.error = origError;
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("probeApp: a page an error.tsx rendered at 200 fails with the error's message and digest", async () => {
  const report = await probeTempApp();
  const home = report.routes.find((r) => r.path === "/");
  assert(home?.rendered && home.ok, "the clean page still passes:\n" + formatReport(report));

  assertEquals(report.routes.find((r) => r.path === "/broken")?.status, 200);
  const detail = caughtDetail(report, "/broken");
  assertStringIncludes(detail, "db down: secret-dsn");
  // The digest is the one the server logged the error under.
  assert(/\[digest [0-9a-f]{16}\]/.test(detail), "the detail carries the digest");

  // A catch in a hole that streams after the shell counts too.
  assertStringIncludes(caughtDetail(report, "/late"), "late failure");

  assertEquals(report.ok, false);
  assertStringIncludes(formatReport(report), "no-caught-error");
});

Deno.test("probeApp: the caught error never reaches the response", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_probe_caught_" });
  const origError = console.error;
  console.error = () => {};
  try {
    await writeApp(dir);
    const { createTestApp, createTestClient } = await import("../src/testing/mod.ts");
    const client = createTestClient(await createTestApp(dir));
    const res = await client.get("/broken");
    assertEquals(res.status, 200);
    assert(!res.text.includes("secret-dsn"), "the message stays out of the body");
    for (const [name, value] of res.headers) {
      assert(!value.includes("secret-dsn"), `the message stays out of the ${name} header`);
    }
  } finally {
    console.error = origError;
    await Deno.remove(dir, { recursive: true });
  }
});
