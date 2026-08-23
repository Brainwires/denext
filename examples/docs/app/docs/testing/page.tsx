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
        returns Testing-Library-style queries plus <code>fireEvent</code>.
      </p>
      <Code lang="ts">
        {`import { fireEvent, render } from "denext/testing";
import { h } from "denext/jsx-runtime";

const screen = await render(h(Counter, null));
await screen.fireEvent.click(screen.getByRole("button"));
assertEquals(screen.getByRole("button").textContent, "Count: 1");`}
      </Code>
      <p>
        <code>render</code>, <code>fireEvent</code>, <code>rerender</code>, and <code>unmount</code>
        {" "}
        are async — <code>await</code>{" "}
        them so effects and state updates settle before you assert. Queries include{" "}
        <code>getByRole</code>, <code>getByText</code>, <code>getByLabelText</code>,{" "}
        <code>getByTestId</code>, and their <code>query*</code>/<code>getAll*</code> variants.
      </p>
    </DocsShell>
  );
}
