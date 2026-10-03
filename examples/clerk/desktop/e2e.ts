// The desktop e2e harness (e2e/desktop-test.ts), as a desktop extension: enabled ONLY when the
// config is evaluated with DENEXT_CLERK_E2E=1 (the runner's `desktop run`), never in a normal
// build. It reads the plan the runner wrote into the app's data folder (`clerk-e2e-plan.json`:
// the phase, a `+clerk_test` address and a testing token) and hands the page's report back as a
// file next to it; the page then quits the app.

import { defineDesktopExtension } from "denext/desktop";
import { join } from "@std/path";

/** The runner's plan file, in the app's data folder. */
const PLAN_FILE = "clerk-e2e-plan.json";

export default defineDesktopExtension({
  name: "clerkE2e",
  methods: {
    /** The plan for this launch, or null (opened by hand). */
    plan: {
      handler: async (_args, ctx) => {
        try {
          return JSON.parse(await Deno.readTextFile(join(ctx.appSupportDir, PLAN_FILE)));
        } catch {
          return null;
        }
      },
    },
    /** Append a progress line to `clerk-e2e.log` (what the runner prints when a phase fails). */
    log: {
      handler: async (args, ctx) => {
        const line = typeof (args as { line?: unknown })?.line === "string"
          ? (args as { line: string }).line.slice(0, 500)
          : "?";
        await Deno.writeTextFile(join(ctx.appSupportDir, "clerk-e2e.log"), line + "\n", {
          append: true,
        });
        return { ok: true };
      },
    },
    /** Write the page's report for the runner (`report-<phase>.json`). */
    report: {
      handler: async (args, ctx) => {
        const report = args as { phase?: unknown };
        const phase = typeof report?.phase === "string" ? report.phase.replace(/\W/g, "") : "x";
        await Deno.writeTextFile(
          join(ctx.appSupportDir, `clerk-e2e-report-${phase}.json`),
          JSON.stringify(report),
        );
        return { ok: true };
      },
    },
  },
});
