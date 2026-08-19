// The rendered-app conformance probe: render every route of a real denext app in
// process and assert each produces a valid HTML document with no server crash.
// This upgrades the dependency-LOAD probes (examples/next-compat-feasibility) into
// a render-AND-assert harness, exercised here against the shipped example apps.

import { assert, assertEquals } from "@std/assert";
import { formatReport, probeApp } from "denext/testing";

const DOCS = new URL("../examples/docs", import.meta.url).pathname;
const NOTES = new URL("../examples/notes", import.meta.url).pathname;

Deno.test("conformance: examples/docs renders every route as static 0-JS HTML", async () => {
  const report = await probeApp(DOCS);

  assert(report.ok, "docs must conform:\n" + formatReport(report));
  assertEquals(report.failed, 0);
  assert(report.total >= 8, `expected the doc pages + landing, got ${report.total}`);
  // The docs site is the "0 KB JS" showcase — EVERY route must be static.
  assertEquals(report.static, report.total, "every docs route must be static");
  assertEquals(report.skipped, 0, "no docs route should be skipped");
  // The landing page is present and rendered a full document.
  const home = report.routes.find((r) => r.path === "/");
  assert(home?.rendered, "landing page must render");
  assert(home.checks.some((c) => c.name === "doctype" && c.pass), "doctype check must run + pass");
});

Deno.test("conformance: examples/notes handles auth gate, dynamic skip, interactivity", async () => {
  Deno.env.set("NOTES_DB", ":memory:");
  Deno.env.set("SESSION_SECRET", "conformance-test-secret");

  const report = await probeApp(NOTES, { expect: { "/notes": 307 } });

  assert(report.ok, "notes must conform:\n" + formatReport(report));

  // Home + login render full documents; both carry an interactive island.
  const home = report.routes.find((r) => r.path === "/");
  assert(home?.rendered && home.interactive, "home renders and is interactive");
  const login = report.routes.find((r) => r.path === "/login");
  assert(login?.rendered, "login renders");

  // The middleware auth gate redirects /notes to /login — recorded, not failed,
  // and its expected 307 was verified.
  const notes = report.routes.find((r) => r.path === "/notes");
  assertEquals(notes?.status, 307);
  assert(!notes?.rendered, "an auth redirect is not a rendered document");
  assert(notes?.ok, "an expected redirect conforms");

  // The dynamic edit route has no generateStaticParams → skipped, not failed.
  const edit = report.routes.find((r) => r.routePath.includes("[id]"));
  assert(edit && !edit.rendered && edit.ok, "dynamic route without params is skipped");
});

Deno.test("conformance: a violated status expectation is reported as a failure", async () => {
  Deno.env.set("NOTES_DB", ":memory:");
  Deno.env.set("SESSION_SECRET", "conformance-test-secret");

  // Assert the home page 404s — it doesn't, so the probe must flag it.
  const report = await probeApp(NOTES, { expect: { "/": 404 } });

  assert(!report.ok, "a broken expectation must fail the report");
  assert(report.failed >= 1, "at least one route failed");
  const home = report.routes.find((r) => r.path === "/");
  assert(home && !home.ok, "home is the failing route");
  const statusCheck = home.checks.find((c) => c.name === "status");
  assert(statusCheck && !statusCheck.pass, "the status check failed");
});

Deno.test("conformance: extraPaths probes paths beyond the manifest", async () => {
  const report = await probeApp(DOCS, { extraPaths: ["/docs/getting-started"] });
  // The extra path is probed in addition to the manifest walk.
  const hits = report.routes.filter((r) => r.path === "/docs/getting-started");
  assert(hits.length >= 2, "extraPaths adds a probe for the given path");
});

Deno.test("conformance: formatReport summarizes pass/skip/fail and static count", async () => {
  const report = await probeApp(DOCS);
  const text = formatReport(report);
  assert(text.includes("static (0 KB JS)"), "summary reports the static count");
  assert(text.includes("PASS"), "a clean run reports PASS");
});
