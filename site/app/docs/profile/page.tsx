import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Profiling (denext profile)",
  description:
    "A first-party CPU + heap profiler for your app: builds it unminified, drives headless Chromium, and reports CPU self-time by function plus heap growth and a leak check — startup or interaction, with an optional budget gate. Also a denext_profile MCP tool.",
};

export default function Profile() {
  return (
    <DocsShell
      active="profile"
      title="Profiling"
      lead="denext profile builds your app unminified, serves it, drives headless Chromium, and reports where time goes — CPU self-time by function — plus heap growth and a leak check. Profile startup or a real interaction, and gate a regression in CI. The same engine is a denext_profile MCP tool, so coding agents can profile too."
    >
      <h2>The idea</h2>
      <p>
        <code>denext profile</code>{" "}
        answers "where does runtime time actually go, and does this interaction leak?" It builds the
        app <strong>unminified</strong>{" "}
        (so the profile shows real function names), serves it on an ephemeral port, and drives a
        headless Chromium through the CDP <code>Profiler</code> and <code>HeapProfiler</code>{" "}
        domains. You get a table of <strong>CPU self-time by function</strong>, the{" "}
        <strong>heap growth</strong> across the run, and a <strong>leak check</strong>.
      </p>

      <h2>Run it</h2>
      <Code lang="bash">
        {`denext profile                       # profile startup of "/" (default)
denext profile --route /dashboard    # a specific route
denext profile --interact burst.js   # profile an interaction, not just startup
denext profile --json                # machine-readable output`}
      </Code>

      <h2>Two modes</h2>
      <p>
        <strong>Startup</strong> (the default, no{" "}
        <code>--interact</code>): the profiler is armed before navigation, so it captures the
        initial load, hydration, and first render — the reconciler/hydration work.
      </p>
      <p>
        <strong>Interaction</strong>{" "}
        (<code>--interact &lt;file&gt;</code>): the app loads and settles first (so the heap
        baseline is the idle, loaded app — a valid leak signal), then the JS in your file runs in
        the page each iteration. Use it to profile a re-render burst or a user flow:
      </p>
      <Code lang="js">
        {`// burst.js — evaluated in the page each iteration
globalThis.__burst?.(200); // e.g. trigger 200 state updates the app exposes`}
      </Code>

      <h2>Gate a regression (CI)</h2>
      <p>
        Snapshot a baseline once, then fail the build when a later run exceeds it — a breach exits
        non-zero, so it works as a CI gate:
      </p>
      <Code lang="bash">
        {`denext profile --interact burst.js --write-budget perf.budget.json   # record a baseline
denext profile --interact burst.js --budget perf.budget.json         # fail (exit 1) on a regression`}
      </Code>

      <h2>Compare two runs</h2>
      <p>
        Save a run with <code>--out</code>, change the code, and run again with{" "}
        <code>--compare</code>: the report adds the CPU total, heap growth and retained-after-GC of
        both runs, and each function's self time before and after, largest change first. Functions
        are matched by name, since chunk URLs change between builds. <code>--json</code> then prints
        {" "}
        <code>{"{ result, comparison }"}</code>.
      </p>
      <Code lang="bash">
        {`denext profile --interact burst.js --out before.json
# …change the code…
denext profile --interact burst.js --compare before.json`}
      </Code>
      <p>
        <code>--filter &lt;text&gt;</code>{" "}
        narrows the self-time table to functions whose name or source URL contains the text (any
        case): a component (<code>--filter TodoList</code>), a module (<code>cart.tsx</code>) or a
        package (<code>node_modules/zod</code>). The totals and shares stay those of the whole run,
        and a <code>--budget</code> is judged on the whole run.
      </p>

      <h2>Flags</h2>
      <ul>
        <li>
          <code>--route &lt;path&gt;</code> — the route to profile (default <code>/</code>).
        </li>
        <li>
          <code>--interact &lt;file&gt;</code>{" "}
          — JS evaluated in the page each iteration (switches to interaction mode).
        </li>
        <li>
          <code>--iterations &lt;n&gt;</code> — repeat the interaction N times (default 1).
        </li>
        <li>
          <code>--sampling &lt;µs&gt;</code> — CPU sampling interval (default 100).
        </li>
        <li>
          <code>--top &lt;n&gt;</code> — max self-time rows to show (default 20).
        </li>
        <li>
          <code>--budget &lt;file&gt;</code>{" "}
          — fail (exit 1) if the run exceeds this recorded budget.
        </li>
        <li>
          <code>--write-budget &lt;file&gt;</code> — write the current run as a baseline budget.
        </li>
        <li>
          <code>--minify</code>{" "}
          — profile a minified build (default is unminified for readable names).
        </li>
        <li>
          <code>--filter &lt;text&gt;</code>{" "}
          — show only functions whose name or source contains the text.
        </li>
        <li>
          <code>--out &lt;file&gt;</code> — save the run as JSON.
        </li>
        <li>
          <code>--compare &lt;file&gt;</code> — compare with a run saved by <code>--out</code>.
        </li>
      </ul>

      <Callout kind="note">
        The same engine backs the <code>denext_profile</code>{" "}
        MCP tool, so an AI agent can profile a route or interaction and read the result. Chromium is
        launched only when the tool runs, so the MCP server's other tools stay browser-free. See the
        {" "}
        <a href="/docs/mcp">MCP server</a> page.
      </Callout>

      <Callout kind="warn">
        Profiling launches headless Chromium and builds unminified, so it is slower than a normal
        build — run it when you're investigating a hot path or wiring a perf gate, not on every
        save.
      </Callout>
    </DocsShell>
  );
}
