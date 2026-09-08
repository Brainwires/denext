import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Scheduled & background tasks",
  description:
    "Define a task once and run it on a cron schedule or on demand — Deno.cron on Deno Deploy, a dependency-free minute-tick scheduler elsewhere. UTC, no overlap, no startup fire. No npm cron dependency.",
};

export default function Tasks() {
  return (
    <DocsShell
      active="tasks"
      title="Scheduled & background tasks"
      lead="Put a task in tasks/<name>.ts, give it a cron schedule, and denext runs it — on Deno.cron where the platform manages it, on a dependency-free minute-tick scheduler everywhere else. Or trigger it on demand from app code or the CLI. No npm cron library."
    >
      <h2>The idea</h2>
      <p>
        A task is a named unit of server work — purge expired sessions, send a digest, warm a cache.
        Define it with <code>defineTask</code> in a <code>tasks/&lt;name&gt;.ts</code>{" "}
        file; denext discovers it at boot and runs it on a cron schedule and/or on demand. When the
        runtime exposes <code>Deno.cron</code> (Deno Deploy, or a self-host started with{" "}
        <code>--unstable-cron</code>) denext uses the platform's <em>managed</em>{" "}
        scheduler; otherwise it falls back to a tiny, dependency-free minute-tick scheduler with a
        5-field Vixie-cron matcher. No npm cron dependency, on either path.
      </p>

      <h2>Define a task</h2>
      <Code lang="ts">
        {`// tasks/cleanup.ts
import { defineTask } from "denext/server";

export default defineTask({
  description: "purge expired sessions", // shown by \`denext task --list\`
  schedule: "0 3 * * *",                 // optional — or schedule it in denext.config.ts
  handler: async ({ payload, trigger, signal }) => {
    await db.exec("DELETE FROM sessions WHERE expires_at < now()");
  },
});`}
      </Code>
      <p>
        The handler receives a <code>TaskContext</code>: the task <code>name</code>, the{" "}
        <code>payload</code> from an on-demand run, how it was triggered (<code>"schedule"</code> or
        {" "}
        <code>"manual"</code>), and an <code>AbortSignal</code>{" "}
        that fires on server shutdown (best-effort drain). A malformed cron expression in{" "}
        <code>defineTask</code>{" "}
        throws early, so a bad schedule is caught at import, never silently ignored.
      </p>

      <h2>Schedule tasks</h2>
      <p>
        A task can carry its own <code>schedule</code>, and/or you can map schedules to tasks in
        {" "}
        <code>denext.config.ts</code> — the value is one task name or an array:
      </p>
      <Code lang="ts">
        {`// denext.config.ts
export default {
  scheduledTasks: {
    "0 3 * * *": "cleanup",              // 03:00 UTC daily
    "0 0 * * 1": ["digest", "warm-cache"], // Mondays at 00:00 UTC
  },
} satisfies import("denext/server").DenextConfig;`}
      </Code>
      <Callout kind="warn">
        Cron expressions are evaluated in <strong>UTC</strong> on both the <code>Deno.cron</code>
        {" "}
        and userland paths (so a schedule fires at the same instant on every platform). Like{" "}
        <code>Deno.cron</code>, a schedule <strong>never fires on startup</strong> and{" "}
        <strong>never overlaps</strong>{" "}
        a still-running instance of the same task — a run that overruns its interval is skipped, not
        stacked.
      </Callout>

      <h2>Run on demand</h2>
      <p>
        Trigger a task yourself from a route handler or a Server Action with{" "}
        <code>runTask</code>, which returns the handler's result:
      </p>
      <Code lang="ts">
        {`import { runTask } from "denext/server";

// e.g. inside a route handler or an action
await runTask("cleanup");
const result = await runTask("report", { month: "2026-01" }); // typed payload → ctx.payload`}
      </Code>
      <p>
        Or from the CLI:
      </p>
      <Code lang="bash">
        {`denext task cleanup                    # run it once, now
denext task report --payload '{"month":"2026-01"}'
denext task --list                    # every task + its description`}
      </Code>

      <h2>Registering a task programmatically</h2>
      <p>
        The <code>tasks/</code>{" "}
        directory is the convention, but you can register a task by hand (useful in a plugin or a
        test) with <code>registerTask</code>; <code>getTask</code>, <code>taskNames</code>, and{" "}
        <code>isTask</code> round out the API. All are exported from <code>denext/server</code>.
      </p>
      <Code lang="ts">
        {`import { defineTask, registerTask } from "denext/server";

registerTask("cleanup", defineTask({ handler: () => {/* … */} }));`}
      </Code>

      <Callout kind="note">
        A scheduled run that throws is logged and never crashes the process; an unknown task name or
        a malformed schedule entry is skipped at boot with an error. An app that defines no tasks
        pays nothing — the scheduler isn't started.
      </Callout>
    </DocsShell>
  );
}
