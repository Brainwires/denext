// Unit tests for the deploy adapter engine: entrypoint auto-detection, adapter
// resolution, and the Deno Deploy adapter's dry-run plan (no network, no spawn).

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  denoDeployAdapter,
  detectEntrypoint,
  listAdapters,
  resolveAdapter,
} from "../src/build/deploy.ts";

Deno.test("detectEntrypoint picks the highest-priority existing file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_deploy_" });
  try {
    await Deno.writeTextFile(join(dir, "serve.ts"), "");
    await Deno.writeTextFile(join(dir, "main.ts"), "");
    // main.ts outranks serve.ts in ENTRY_CANDIDATES.
    assertEquals(await detectEntrypoint(dir), "main.ts");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("detectEntrypoint returns null when nothing matches", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_deploy_" });
  try {
    assertEquals(await detectEntrypoint(dir), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveAdapter defaults to deno-deploy and rejects unknown", () => {
  assertEquals(resolveAdapter().name, "deno-deploy");
  assertEquals(resolveAdapter("deno-deploy").name, "deno-deploy");
  let threw = false;
  try {
    resolveAdapter("nope");
  } catch {
    threw = true;
  }
  assert(threw);
  assert(listAdapters().length >= 1);
});

Deno.test("Deno Deploy adapter dry-run prints a deployctl plan and does not spawn", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    await denoDeployAdapter.deploy({
      projectDir: "/tmp/app",
      entrypoint: "server.ts",
      prod: true,
      project: "my-app",
      dryRun: true,
      args: ["--region", "us"],
    });
  } finally {
    console.log = orig;
  }
  const plan = lines.join("\n");
  assert(plan.includes("deployctl deploy"));
  assert(plan.includes("--project my-app"));
  assert(plan.includes("--prod"));
  assert(plan.includes("--entrypoint server.ts"));
  assert(plan.includes("--region us"));
});

Deno.test("dry-run never rejects (no real deploy attempted)", async () => {
  // A missing token/network would fail a real deploy; dry-run must be inert (no
  // spawn), so a test run never needs deployctl or the network.
  await denoDeployAdapter.deploy({
    projectDir: "/tmp/app",
    entrypoint: "server.ts",
    prod: false,
    dryRun: true,
    args: [],
  });
});
