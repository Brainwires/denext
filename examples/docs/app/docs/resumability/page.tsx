import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Resumability",
  description:
    "Make a route interactive with no up-front hydration. Plain components resume on first interaction — no re-running the tree on load.",
};

export default function Resumability() {
  return (
    <DocsShell
      active="resumability"
      title="Resumability"
      lead="Opt a route into resumable rendering and it is interactive with no up-front hydration. Islands resume on demand — a handler island wakes on the first interaction, and the triggering event is replayed to the resumed handler — so plain components (useState + onClick) work unchanged. React cannot do this: its hydration must re-run the tree to attach handlers."
    >
      <h2>Turn it on</h2>
      <p>
        Add one export to a page (or layout). Everything under it renders
        resumably; the rest of your app keeps React-style hydration.
      </p>
      <Code lang="tsx">
        {`// app/dashboard/page.tsx
export const resumable = true;

// A perfectly ordinary client component — no special API.
"use client";
import { useState } from "@denext/denext";

export function Counter() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>Clicked {n} times</button>;
}`}
      </Code>

      <h2>What happens</h2>
      <ul>
        <li>
          <strong>No hydration on load.</strong>{" "}
          The server renders each client island into a layout-neutral wrapper
          the page root <em>adopts but never executes</em>{" "}
          — so no component runs at load. The page is interactive immediately.
        </li>
        <li>
          <strong>Resume on first interaction.</strong>{" "}
          A single delegated listener catches the first event, hydrates just
          that island (running its component, adopting its state), and{" "}
          <em>replays the event</em> so your real <code>onClick</code>{" "}
          fires. Only the island you touched wakes up.
        </li>
        <li>
          <strong>State is transported, not recomputed.</strong> Pair it with
          {" "}
          <code>useSignal</code>/<code>useStore</code>{" "}
          and the server value is adopted on resume instead of re-deriving it.
        </li>
      </ul>

      <Callout kind="note">
        Resumability is{" "}
        <strong>off by default</strong>. A route keeps normal hydration until it
        sets{" "}
        <code>resumable</code>, and an app that never opts in bundles none of
        the resumability runtime.
      </Callout>

      <h2>
        Serializable state — <code>useSignal</code> / <code>useStore</code>
      </h2>
      <p>
        Regular React state works in a resumable route — the island re-derives
        it when it resumes. To go further and have the server value{" "}
        <em>adopted</em>{" "}
        on resume instead of recomputed, reach for signals: reactive state whose
        value is transported from server to client.
      </p>
      <Code lang="tsx">
        {`"use client";
import { useSignal, useStore } from "@denext/denext";

export function Cart() {
  const count = useSignal(0);           // count.value to read/write
  const totals = useStore({ items: 0, price: 0 });

  return (
    <button onClick={() => { count.value += 1; totals.items += 1; }}>
      {count.value} in cart
    </button>
  );
}`}
      </Code>
      <ul>
        <li>
          <code>useSignal(initial)</code> returns a stable box — read{" "}
          <code>signal.value</code>, assign <code>signal.value = next</code>
          {" "}
          to update (re-rendering the component); <code>signal.peek()</code>
          {" "}
          reads without subscribing.
        </li>
        <li>
          <code>useStore(obj)</code>{" "}
          returns a shallow reactive object — assigning a top-level property
          re-renders.
        </li>
        <li>
          Both are opt-in and orthogonal to the React hooks: the value is
          written into the page and adopted on resume, so the initializer does
          not run again on the client.
        </li>
      </ul>

      <h2>
        Load handlers on demand — <code>qrl</code>
      </h2>
      <p>
        For a handler whose code you want code-split and fetched only when it
        first runs — and dispatched{" "}
        <em>without mounting the component at all</em> — wrap its import in{" "}
        <code>qrl</code>:
      </p>
      <Code lang="tsx">
        {`import { qrl } from "@denext/denext/client";

// Its code lives in a separate chunk, loaded on first activation.
const onExport = qrl(() => import("./export.ts").then((m) => m.run), "toolbar#export");

<button onClick={onExport}>Export</button>`}
      </Code>
      <p>
        A <code>qrl</code>{" "}
        is a plain event-handler value — use it anywhere. In resumable mode the
        framework runs it directly on the first event, with no component render.
      </p>

      <h2>Choosing when islands wake</h2>
      <p>
        Resumable mode picks each island wake moment automatically from what it
        does: an island with only event handlers waits for the first interaction
        (maximal laziness), while one that runs an effect (a clock, a
        subscription) hydrates when the main thread is idle — so it ticks
        without needing a click. You never have to annotate the common cases.
      </p>
      <p>
        Override any island with a directive when you want a specific moment:
      </p>
      <Code lang="tsx">
        {`<Panel client:interaction /> {/* wait for the first interaction */}
<Chart client:visible />     {/* hydrate when it scrolls into view */}
<Widget client:load />       {/* hydrate immediately, but still per-island */}`}
      </Code>

      <Callout kind="note">
        Resumable mode applies to routes that use the client/server (Flight)
        boundary — any app with a <code>"use client"</code>{" "}
        component. Events that do not bubble (e.g. raw{" "}
        <code>focus</code>/<code>blur</code>) are not caught by the delegated
        listener; use their bubbling forms (<code>onFocus</code> maps to{" "}
        <code>focusin</code>).
      </Callout>
    </DocsShell>
  );
}
