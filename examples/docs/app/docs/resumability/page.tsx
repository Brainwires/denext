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
      lead="Resumability makes a route interactive with no up-front hydration: the browser adopts the server-rendered HTML as-is and runs a component only when that part of the page is first interacted with. It brings Qwik-style resumption to the React programming model — something React and Next.js cannot offer, because their hydration is architecturally required to re-execute your whole component tree on load just to reattach event handlers. denext skips that pass entirely; your ordinary components resume on demand, unchanged."
    >
      <h2>What it is</h2>
      <p>
        There are two ways to make server-rendered HTML interactive in the
        browser:
      </p>
      <ul>
        <li>
          <strong>Hydration</strong>{" "}
          (React, Next.js). On load, the client re-executes the whole component
          tree to rebuild state and attach event handlers over the existing DOM.
          The cost scales with how much interactive UI the page has — and it is
          paid up front, whether or not the visitor ever touches any of it.
        </li>
        <li>
          <strong>Resumption</strong>{" "}
          (denext). The client attaches nothing on load. It adopts the server
          DOM as-is and runs a component only when that part of the page is
          first used — then replays the triggering event to the now-live
          handler. Time-to-interactive stays flat no matter how large the page
          grows.
        </li>
      </ul>
      <Callout kind="note">
        Resumability is not a denext invention — <strong>Qwik</strong>{" "}
        pioneered it (with related prior art in{" "}
        <strong>Marko</strong>). denext&#39;s contribution is running it behind
        the ordinary <strong>React</strong>{" "}
        programming model: your components stay plain React, and they resume.
        That combination is what React and Next.js cannot offer, since their
        hydration is defined as re-running components — so this is resumability
        you can adopt without leaving React.
      </Callout>

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

      <h2>When to reach for it</h2>
      <p>
        Resumability pays off wherever up-front hydration is the bottleneck. It
        is opt-in per route, so turn it on where it helps and leave the rest of
        your app on normal hydration.
      </p>
      <ul>
        <li>
          <strong>Large, interactive pages</strong>{" "}
          — dashboards, editors, feeds, data tables with many widgets. Hydration
          wakes all of them on load; resumption wakes only the ones a visitor
          touches, so time-to-interactive stays flat as the page grows instead
          of climbing with every widget you add.
        </li>
        <li>
          <strong>Content with sparse interactivity</strong>{" "}
          — long articles or marketing pages with a few interactive pieces. Ship
          the HTML instantly and pay for a widget only if the reader actually
          uses it.
        </li>
        <li>
          <strong>Slow devices and cold loads</strong>{" "}
          — the hydration pass is exactly the main-thread work that makes a
          fresh page feel janky on a phone. Removing it is the most direct win
          for first-load responsiveness.
        </li>
      </ul>
      <p>
        When <em>not</em>{" "}
        to bother: a small or mostly-static page will not notice the difference,
        and it does add a few moving parts (a per-island runtime chunk, the
        delegated listener). Reach for it when the interactive surface is
        genuinely large or the audience is latency-sensitive — not by default on
        every route.
      </p>

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
