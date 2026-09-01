import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = { title: "Testing" };

export default function Testing() {
  return (
    <DocsShell
      active="testing"
      title="Testing"
      lead="Two levels, both in-process and browser-free: whole-app testing via a fetch client, and component testing that mounts with real hooks and events."
    >
      <h2>App testing (the JS-disabled path)</h2>
      <p>
        <code>createTestApp</code>{" "}
        builds an in-process handler — no build, no socket — that renders Server Components, runs
        Server Actions and <code>middleware.ts</code>, and reads cookies.{" "}
        <code>createTestClient</code>{" "}
        wraps it with a cookie jar and form parse-and-submit, so you drive the app exactly as a
        JavaScript-disabled browser would.
      </p>
      <Code lang="ts">
        {`import { createTestApp, createTestClient } from "denext/testing";

const client = createTestClient(await createTestApp("./"));

// Log in through the rendered form — no client JS.
const page = await client.get("/login");
const res = await client.submit(client.form(page.text), { email, password });
// res.status === 303; the session cookie is now in client.cookies.
const home = await client.get("/");`}
      </Code>
      <Callout kind="note">
        This is how the <code>examples/notes</code>{" "}
        app asserts progressive enhancement in CI: every flow runs with no hydration. If a flow
        needed JavaScript, the test would fail.
      </Callout>

      <h2>Component testing</h2>
      <p>
        <code>render</code>{" "}
        mounts a single component into an in-memory DOM with real hooks, effects, and events, and
        returns Testing-Library-style queries plus{" "}
        <code>fireEvent</code>. For higher-fidelity interactions, <code>userEvent</code>{" "}
        dispatches the full DOM-event sequence a real click or keystroke produces.
      </p>
      <Code lang="ts">
        {`import { render, userEvent } from "denext/testing";
import { h } from "denext/jsx-runtime";

const screen = await render(h(Counter, null));
await userEvent.click(screen.getByRole("button"));
assertEquals(screen.getByRole("button").textContent, "Count: 1");`}
      </Code>
      <p>
        <code>render</code>, <code>fireEvent</code>, <code>rerender</code>, and <code>unmount</code>
        {" "}
        are async — <code>await</code>{" "}
        them so effects and state updates settle before you assert. Sync queries include{" "}
        <code>getByRole</code> (over a broad implicit-ARIA role table), <code>getByText</code>,{" "}
        <code>getByLabelText</code>, <code>getByPlaceholderText</code>,{" "}
        <code>getByTestId</code>, and their <code>query*</code>/<code>getAll*</code> variants.
      </p>
      <p>
        For state that settles <em>after</em> an async effect, use the async <code>findBy*</code>
        {" "}
        queries (or <code>waitFor</code>){" "}
        — they retry, flushing pending work between attempts, until the match appears or a timeout
        elapses.
      </p>
      <Code lang="ts">
        {`import { render, userEvent, waitFor } from "denext/testing";

const screen = await render(h(Profile, null));
await userEvent.type(screen.getByLabelText("Search"), "ada");

// findBy* resolves once the async result lands.
const row = await screen.findByText("Ada Lovelace");
// …or wait on any assertion:
await waitFor(() => assertEquals(screen.getByRole("status").textContent, "1 result"));`}
      </Code>
      <p>
        <code>userEvent</code> covers <code>click</code>, <code>dblClick</code>, <code>type</code>,
        {" "}
        <code>clear</code>, <code>keyboard</code>, and <code>selectOptions</code>; call{" "}
        <code>userEvent.setup()</code> for Testing-Library compatibility.
      </p>
    </DocsShell>
  );
}
