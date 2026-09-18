import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Testing",
  description:
    "Two levels, both in-process and browser-free: whole-app testing via a fetch client, and component testing that mounts with real hooks and events.",
};

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

      <h2 id="route-handlers">Route handlers and defineApi</h2>
      <p>
        The same in-process handler serves <code>route.ts</code>{" "}
        modules, so an API is tested through the client too. <code>post</code> takes{" "}
        <code>{"{ json }"}</code> (sets <code>content-type: application/json</code>) or{" "}
        <code>{"{ form }"}</code>; a response's body is already read into <code>text</code>, and
        {" "}
        <code>json()</code> parses it. A <code>defineApi</code>{" "}
        route answers a schema mismatch with the structured <code>400</code>{" "}
        envelope and a declared error code with its status — assert on those rather than on prose.
      </p>
      <Code lang="ts">
        {`import { assertEquals } from "@std/assert";
import { createTestApp, createTestClient } from "denext/testing";

const client = createTestClient(await createTestApp("./"));

const ok = await client.post("/api/notes", { json: { title: "hello" } });
assertEquals(ok.status, 200);
assertEquals(ok.json(), { id: 1, title: "hello" });

const bad = await client.post("/api/notes", { json: { title: "" } });
assertEquals(bad.status, 400);
assertEquals((bad.json() as { error: { code: string } }).error.code, "validation");
// bad.json().error.fieldErrors.title carries the schema's message

const long = await client.post("/api/notes", { json: { title: "x".repeat(30) } });
assertEquals(long.status, 422); // errors: { too_long: 422 } in the route

const wrongMethod = await client.get("/api/notes");
assertEquals(wrongMethod.status, 405);
assertEquals(wrongMethod.headers.get("allow"), "POST");`}
      </Code>
      <p>
        The client sets <code>Host</code> and, on unsafe methods, a same-origin{" "}
        <code>Origin</code>, so a Server Action or the batch endpoint passes its CSRF check without
        ceremony; pass <code>{'{ headers: { origin: "https://evil.example" } }'}</code>{" "}
        to test the rejection.
      </p>

      <h2 id="server-actions">Calling a Server Action directly</h2>
      <p>
        A <code>"use server"</code> function is an ordinary async function: import it and call it. A
        {" "}
        <code>defineAction</code> action has the <code>useActionState</code> shape —{" "}
        <code>(prevState, formData)</code> — so pass <code>idleActionState()</code>{" "}
        as the first argument and a <code>FormData</code>{" "}
        as the second, and assert on the typed result.
      </p>
      <Code lang="ts">
        {`import { assertEquals } from "@std/assert";
import { idleActionState } from "denext";
import { createNote } from "../app/actions.ts";

const fd = new FormData();
fd.set("title", "  direct  ");
assertEquals(await createNote(idleActionState(), fd), { ok: true, data: { id: 7, title: "direct" } });

const bad = await createNote(idleActionState(), new FormData());
assertEquals(bad, { ok: false, error: "bad", fieldErrors: { title: "Title is required" } });`}
      </Code>
      <p>
        That exercises the handler without a request context, so <code>cookies()</code> /{" "}
        <code>headers()</code>{" "}
        inside it are unavailable; drive an action that reads them through the client instead
        (render the form, <code>submit</code> it), which is also the progressive-enhancement proof.
      </p>

      <h2 id="tasks">Running a task</h2>
      <p>
        <code>createTestApp</code> does not scan{" "}
        <code>tasks/</code>; register the module you want and run it. <code>runTask</code>{" "}
        returns the handler's value.
      </p>
      <Code lang="ts">
        {`import { registerTask, runTask } from "denext/server";

registerTask("cleanup", (await import("../tasks/cleanup.ts")).default);
assertEquals(await runTask("cleanup", { dry: true }), "cleaned 0 rows (dry run)");`}
      </Code>

      <h2 id="environment">Environment and a throwaway database</h2>
      <p>
        Tests run under plain <code>deno test</code>, which loads no <code>.env</code>. Call{" "}
        <code>loadEnv</code> yourself with the <code>test</code> mode — it reads <code>.env</code>,
        {" "}
        <code>.env.test</code> and <code>.env.test.local</code> (never{" "}
        <code>.env.local</code>, as in Next) and sets what the shell has not already set. Or export
        {" "}
        <code>DENEXT_ENV=test</code> in the task and let <code>loadEnv()</code> pick the mode up.
      </p>
      <Code lang="ts">
        {`// tests/setup.ts — import it first from every test file
import { loadEnv } from "denext/server";
await loadEnv({ mode: "test" }); // .env.test: DB_PATH=:memory:`}
      </Code>
      <p>
        A database module that opens <code>Deno.env.get("DB_PATH")</code>{" "}
        once at module scope then gets a private in-memory database per test{" "}
        <em>process</em>. For a fresh file per test, make the path a parameter and use a temp dir:
      </p>
      <Code lang="ts">
        {`import { DatabaseSync } from "node:sqlite";

Deno.test("notes round-trip", async () => {
  const dir = await Deno.makeTempDir();
  const db = new DatabaseSync(\`\${dir}/test.db\`);
  try {
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL)");
    db.prepare("INSERT INTO notes (title) VALUES (?)").run("hi");
    assertEquals(db.prepare("SELECT count(*) AS n FROM notes").get(), { n: 1 });
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});`}
      </Code>

      <h2 id="stubbing-fetch">Stubbing fetch</h2>
      <p>
        Server code calls the global{" "}
        <code>fetch</code>, so replacing it for the duration of a test is enough — do it{" "}
        <em>after</em> <code>createTestApp</code>{" "}
        (which installs the fetch-cache wrapper once, capturing the fetch it found) and restore it
        in <code>finally</code>. <code>stub</code> from <code>@std/testing/mock</code>{" "}
        does the same with call assertions.
      </p>
      <Code lang="ts">
        {`const handler = await createTestApp("./");
const real = globalThis.fetch;
globalThis.fetch = (input) =>
  Promise.resolve(
    String(input).endsWith("/products")
      ? Response.json([{ id: 1, title: "stubbed" }])
      : new Response("unexpected fetch: " + input, { status: 599 }),
  );
try {
  const page = await createTestClient(handler).get("/");
  assertStringIncludes(page.text, "stubbed");
} finally {
  globalThis.fetch = real;
}`}
      </Code>
      <p>
        A <code>fetch</code> stub does <em>not</em> reach{" "}
        <code>safeFetch</code>: it resolves the host and opens the socket to the pinned address
        itself, precisely so nothing can redirect it — and it refuses loopback, so a local test
        server is out too. Put the <code>safeFetch</code>{" "}
        call behind a small module of your own (<code>
          fetchPreview(url)
        </code>) and stub that module's export in the test.
      </p>

      <h2 id="ci">Continuous integration</h2>
      <p>
        Nothing here needs a browser or a service, so CI is <code>deno test</code>. Define one{" "}
        <code>check</code> task and run it:
      </p>
      <Code lang="json">
        {`// deno.json
{
  "tasks": {
    "check": "deno fmt --check && deno lint && deno test -A"
  }
}`}
      </Code>
      <Code lang="yaml">
        {`# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - run: deno install          # from deno.lock
      - run: deno task check
      - run: deno run -A jsr:@denext/denext@^2/cli doctor   # renders every route, exits 1 on a bad document
      - run: deno run -A jsr:@denext/denext@^2/cli audit --strict`}
      </Code>
      <p>
        <code>denext doctor</code>{" "}
        is the conformance gate (every route rendered, a well-formed document asserted) and{" "}
        <code>denext audit --strict</code> fails the build if runtime source imports npm — see{" "}
        <a href="/docs/doctor-audit">Doctor &amp; audit</a>. Add <code>--coverage</code>{" "}
        to the test step and <code>deno coverage</code> after it for a report.
      </p>

      <h2 id="browser-tests">Browser tests with astral</h2>
      <p>
        When a flow needs real JavaScript — hydration, a Live socket, a client-only widget — drive
        headless Chromium with <a href="https://jsr.io/@astral/astral">@astral/astral</a>{" "}
        (Deno's Puppeteer-shaped driver; it downloads a browser on first use) against{" "}
        <code>denext dev</code> on a fixed port. This is how denext's own e2e suite works (<code>
          tests/e2e/
        </code>).
      </p>
      <Code lang="ts">
        {`// tests/e2e/counter.test.ts — run with: deno test -A tests/e2e/
import { assertEquals } from "@std/assert";
import { launch } from "@astral/astral";

const PORT = 3123;
const ORIGIN = \`http://127.0.0.1:\${PORT}\`;

async function startDev(): Promise<() => Promise<void>> {
  const child = new Deno.Command("deno", {
    args: ["run", "-A", "jsr:@denext/denext@^2/cli", "dev", ".", "--port", String(PORT)],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  for (let i = 0; i < 100; i++) { // wait until it answers
    try {
      if ((await fetch(ORIGIN + "/")).ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return async () => {
    child.kill("SIGTERM");
    await child.status;
  };
}

Deno.test("the counter hydrates and increments", async () => {
  const stop = await startDev();
  const browser = await launch({ headless: true });
  try {
    const page = await browser.newPage(ORIGIN + "/");
    await page.waitForSelector("button", { timeout: 20_000 });
    const button = await page.$("button");
    await button!.click();
    const text = await page.evaluate(() => document.querySelector("button")?.textContent);
    assertEquals(text, "Clicked 1");
  } finally {
    await browser.close();
    await stop();
  }
});`}
      </Code>
      <p>
        Keep browser tests in their own directory and out of <code>deno task check</code> (add{" "}
        <code>--ignore=tests/e2e/</code>{" "}
        to the unit run) so the fast suite stays fast; run them on a schedule or before a release.
        Against a production build, replace <code>dev</code> with <code>build</code> then{" "}
        <code>start --port</code>. In CI, Chromium needs <code>--no-sandbox</code> on most runners:
        {" "}
        <code>launch({"{"} args: ["--no-sandbox"] {"}"})</code>.
      </p>
    </DocsShell>
  );
}
