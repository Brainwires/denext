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

      <h2 id="cron-syntax">Cron syntax</h2>
      <p>
        Standard five-field Vixie cron: minute (0–59), hour (0–23), day of month (1–31), month
        (1–12), day of week. Each field is <code>*</code>, a number, an <code>a-b</code>{" "}
        range, or one of those with a{" "}
        <code>/step</code>, and a comma list of any of them. Tokens are{" "}
        <strong>plain digits</strong>: <code>-5</code>, <code>0x10</code>, <code>1e1</code>,{" "}
        <code>5.</code>{" "}
        and an empty item (<code>5,,</code>) are refused, so an expression that parses here is one
        {" "}
        <code>Deno.cron</code> accepts too. Names (<code>JAN</code>,{" "}
        <code>MON</code>) are not accepted — keep it numeric.
      </p>
      <ul>
        <li>
          <strong>Weekdays are POSIX:</strong> <code>0–6</code> with <code>0</code>{" "}
          = Sunday (<code>7</code> is Sunday too), so <code>0 0 * * 1</code> is Monday.{" "}
          <code>Deno.cron</code> numbers them <code>1–7</code> from Sunday and rejects{" "}
          <code>0</code>, which is why denext never hands it the expression verbatim: the
          day-of-week field is translated into names (<code>MON</code>,{" "}
          <code>MON-FRI</code>, an exact list for anything stepped), which both conventions agree
          on. Write POSIX and nothing fires a day late.
        </li>
        <li>
          <code>?</code> is accepted as an alias for <code>*</code>{" "}
          (a Quartz habit) and translated to <code>*</code> for{" "}
          <code>Deno.cron</code>, which rejects it.
        </li>
        <li>
          <code>N/S</code> on a lone number means <em>N to the field's maximum, step S</em>:{" "}
          <code>5/15</code> in the minute field is <code>5-59/15</code>, as Vixie and{" "}
          <code>Deno.cron</code> read it.
        </li>
        <li>
          When <strong>both</strong>{" "}
          day fields are restricted (<code>0 0 5 * 1</code>), Vixie fires when <em>either</em>{" "}
          matches — the 5th <em>and</em>{" "}
          every Monday. denext does the same; the Project UI's builder reports such an expression as
          custom rather than misdescribing it.
        </li>
      </ul>

      <h2 id="run-history">Run history</h2>
      <p>
        Off by default: denext records nothing and writes no file until you ask. With{" "}
        <code>tasks: {"{ history: true }"}</code> in <code>denext.config.ts</code>{" "}
        every run is recorded — the scheduler's, <code>runTask</code> from app code, and{" "}
        <code>denext task &lt;name&gt;</code>{" "}
        from the command line — and the Project UI's Cron page shows each task's last result, its
        duration, and its successes and failures over the last seven days.
      </p>
      <Code lang="ts">
        {`// denext.config.ts
export default {
  tasks: {
    history: true,       // record every run to .denext/tasks.db
    historyMaxRuns: 500, // runs kept per task (default 500); 14 days either way
  },
} satisfies import("denext/server").DenextConfig;`}
      </Code>
      <ul>
        <li>
          <strong>Where:</strong> <code>.denext/tasks.db</code>{" "}
          (a SQLite file through Deno's built-in <code>node:sqlite</code>, with its{" "}
          <code>-wal</code>/<code>-shm</code>{" "}
          siblings), created owner-only (<code>0600</code>) on the first recorded run. The recorder
          is installed at server boot, so turning it on takes effect the next time the app starts —
          under <code>denext dev</code> too.
        </li>
        <li>
          <strong>What is recorded:</strong>{" "}
          the task, trigger, start time, duration and status, plus the run's output in{" "}
          <strong>plain text</strong>: the tail of a string the handler returned (up to 2 KB) and,
          for a failure, the error's message and the head of its stack (2 KB). A task that would
          return a token, a DSN or another secret should return nothing instead.
        </li>
        <li>
          <strong>Retention:</strong> 14 days, and <code>tasks.historyMaxRuns</code>{" "}
          per task (default 500; per task, so a minute-cron task cannot evict a daily task's
          history). Both are applied on the <em>first</em>{" "}
          recorded run of every process and then amortised, so a one-shot <code>denext task</code>
          {" "}
          from system cron prunes as well.
        </li>
        <li>
          <strong>Never in the way:</strong>{" "}
          recording can neither fail nor delay a run. A read-only filesystem, a full disk, a locked
          file or a denied write permission degrades to no history, not to a broken job.
        </li>
        <li>
          <strong>Clearing:</strong>{" "}
          the Cron page's Clear button deletes the rows (two steps, with the count) and leaves the
          file in place, because the running app may hold it open.
        </li>
        <li>
          <strong>Deno Deploy:</strong>{" "}
          the file is per-isolate and ephemeral, so what you see is one isolate's fragment that
          resets when it cycles. Recording still happens and a warning says so at boot — a history
          that is quietly wrong is worse than none.
        </li>
      </ul>

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
