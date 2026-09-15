// `denext ui`, end to end through the real binary: spawn `cli.ts ui <tmp> --no-open --json`,
// read the `{ url, port, token }` line it prints, and then drive the server over real HTTP —
// the same way a browser (and a machine client) would.
//
// Everything here is asserted against the *wire*: statuses, headers, form field names, the file
// the write lands on. Nothing imports `src/ui/**`, so this file stays true through any internal
// refactor of the UI modules.
//
// What it covers: the 401 before the handshake · the `?t=` → cookie exchange · every page,
// asset and `/api/*` twin · the hardened header set · the three mutation refusals (no CSRF,
// cross-site, rebound Host) · a config write that changes exactly one value · a `generate`
// write · a Docker diff preview · `--read-only` · SIGTERM draining the port, including with a
// browser tab still holding `/_ui/events` open · an explicit `--port` being required exactly ·
// a too-short `--token` refused at startup · the plugin-options sub-panel (a widget-form preview
// that writes nothing, a confirm that adds exactly one key with the leading comment intact, a
// stale `_base` refused with 409) · the compose editor (an edit that moves only the port line; an
// unparseable file shown read-only and its edit refused with 400) · `--offline` (the JSR search
// box disabled, the offline JSON shape, a verb run holding no net, `deno task` refused with a
// 503, no connection reaching a trap proxy) · the Commands panel's flags form (the argv a
// project verb receives carries exactly the declared flags).

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../../", import.meta.url));
const CLI = join(ROOT, "cli.ts");
const MOD = join(ROOT, "mod.ts");

/** How long the child gets to print its JSON line before the test gives up. */
const SPAWN_TIMEOUT_MS = 30_000;

/** How long a signalled server gets to drain and exit. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** The project's config — the fixture the config editor writes into. */
const CONFIG = `// the app's own config — this comment must survive every write
export default {
  basePath: "/docs",
  trailingSlash: true,
  redirects: () => [
    { source: "/a", destination: "/b", permanent: true }, // keep this comment
  ],
};
`;

/** Every HTML page the UI serves. */
const PAGES = [
  "/",
  "/config",
  "/config/next",
  "/plugins",
  "/plugins/options",
  "/generate",
  "/docker",
  "/wizard",
  "/commands",
];

/** Every `/api/*` JSON twin that answers a `GET`. */
const API_TWINS = [
  "/api/overview",
  "/api/config",
  "/api/config/next",
  "/api/plugins",
  "/api/plugins/options",
  "/api/generate",
  "/api/docker",
  "/api/wizard",
  "/api/commands",
];

/** The catalogued first-party plugin the options sub-panel edits (two string options). */
const PLUGIN = "@denext/react-router";

/** Its options sub-panel. */
const OPTIONS_HREF = `/plugins/options?name=${encodeURIComponent(PLUGIN)}`;

/** A config wiring {@linkcode PLUGIN} with one option set — the options editor's fixture. */
const PLUGIN_CONFIG = `// the app's own config — this comment must survive every write
import { reactRouter } from "@denext/react-router";

export default {
  plugins: [
    reactRouter({ appDirectory: "app" }), // the router
  ],
};
`;

/** {@linkcode PLUGIN_CONFIG} once the options editor has added `routesFile` — and nothing else. */
const PLUGIN_CONFIG_AFTER = PLUGIN_CONFIG.replace(
  'reactRouter({ appDirectory: "app" })',
  'reactRouter({ appDirectory: "app", routesFile: "app/routes.ts" })',
);

/** A hand-written compose file, comments and all — the compose editor's fixture. */
const COMPOSE = `# hand-written compose — every comment here must survive an edit
services:
  web:
    image: denext-app # the app image
    ports:
      - "3000:3000" # host:container
    environment:
      DENO_ENV: production
  db:
    image: postgres:16 # the database
    ports:
      - "5432:5432"
`;

/** A compose file the editor cannot follow (flow style, never closed). */
const UNPARSEABLE_COMPOSE = `# hand-mangled — flow style, never closed
services: {web: {image: denext-app, ports: ["3000:3000"
`;

/** A config contributing two project verbs: one with declared flags, one that reports `net`. */
const COMMANDS_CONFIG = `// project verbs the Commands panel runs
export default {
  commands: [
    {
      name: "echo-flags",
      summary: "Print the argv the UI built",
      flags: [
        { name: "loud", type: "boolean", help: "Shout it" },
        { name: "greeting", type: "string", help: "What to say" },
      ],
      run: () => console.log("ARGV " + JSON.stringify(Deno.args)),
    },
    {
      name: "net-state",
      summary: "Print whether this process may reach the network",
      run: async () => console.log("NET " + (await Deno.permissions.query({ name: "net" })).state),
    },
  ],
};
`;

// ── the project ──────────────────────────────────────────────────────────────

/**
 * A throwaway project for the UI to manage: a `deno.json` aliasing `denext` at this checkout,
 * one page, and a `denext.config.ts` (by default one with a scalar and a rule thunk).
 *
 * @param config The `denext.config.ts` source.
 * @param files Extra project-relative files to write.
 * @returns The project directory.
 */
async function project(
  config = CONFIG,
  files: Readonly<Record<string, string>> = {},
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_e2e_" });
  const deno = { imports: { "denext": MOD, "denext/": ROOT }, tasks: { hello: "eval 1" } };
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(deno, null, 2) + "\n");
  await Deno.mkdir(join(dir, "app"));
  await Deno.writeTextFile(
    join(dir, "app", "page.tsx"),
    "export default function Page() {\n  return <h1>hi</h1>;\n}\n",
  );
  await Deno.writeTextFile(join(dir, "denext.config.ts"), config);
  for (const [name, text] of Object.entries(files)) await Deno.writeTextFile(join(dir, name), text);
  return dir;
}

// ── spawning the real verb ───────────────────────────────────────────────────

/** One running `denext ui` child process. */
interface Launch {
  /** The child. */
  readonly proc: Deno.ChildProcess;
  /** Its captured stderr (resolves at exit). */
  readonly errors: Promise<string>;
  /** The background drain of the rest of stdout (resolves at exit). */
  readonly rest: Promise<void>;
  /** The bound port, from the `--json` line. */
  readonly port: number;
  /** The launch token, from the `--json` line. */
  readonly token: string;
  /** The URL the verb printed. */
  readonly url: string;
}

/** One authenticated browser-ish session against a launch. */
interface Ui {
  /** `http://127.0.0.1:<port>`. */
  readonly base: string;
  /** The bound port. */
  readonly port: number;
  /** The handshake token. */
  readonly token: string;
  /** The project directory. */
  readonly dir: string;
  /** The session cookie, once the handshake has run. */
  cookie: string;
  /** The CSRF token read out of the page's `<meta>`, once the handshake has run. */
  csrf: string;
}

/**
 * Reject `work` if it has not settled within `ms`.
 *
 * @param work The promise to bound.
 * @param ms The budget in milliseconds.
 * @param what What is being waited for (for the message).
 * @returns The value `work` resolved to.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** Read a stream to the end as text. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text;
}

/** Read up to (not including) the first newline. */
async function readLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  const end = buffer.indexOf("\n");
  return end === -1 ? buffer : buffer.slice(0, end);
}

/** Keep reading until the stream ends, discarding everything (so the pipe never fills). */
async function swallow(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  while (true) {
    const { done } = await reader.read();
    if (done) return;
  }
}

/**
 * Spawn `deno run -A cli.ts ui <dir> --no-open --json --port 0` and parse its first stdout line.
 *
 * @param dir The project to manage.
 * @param extra Extra flags (e.g. `--read-only`).
 * @param env Extra environment for the child (merged over this process's).
 * @returns The running child and what it announced.
 */
async function spawnUi(
  dir: string,
  extra: string[] = [],
  env?: Record<string, string>,
): Promise<Launch> {
  const args = ["run", "-A", CLI, "ui", dir, "--no-open", "--json", "--port", "0", ...extra];
  const proc = new Deno.Command(Deno.execPath(), {
    args,
    env,
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const errors = drain(proc.stderr);
  const reader = proc.stdout.getReader();
  let line: string;
  try {
    line = await withTimeout(readLine(reader), SPAWN_TIMEOUT_MS, "the `denext ui --json` line");
    if (!line.startsWith("{")) throw new Error(`the first stdout line was not JSON: ${line}`);
  } catch (error) {
    await reader.cancel().catch(() => {});
    proc.kill("SIGKILL");
    await proc.status;
    throw new Error(`${(error as Error).message}\n--- stderr ---\n${await errors}`);
  }
  const rest = swallow(reader).catch(() => {});
  const info = JSON.parse(line) as { url: string; port: number; token: string };
  return { proc, errors, rest, ...info };
}

/**
 * Stop a launch and wait for its streams to close.
 *
 * @param launch The running child.
 * @param signal The signal to send (default `SIGKILL`).
 * @returns Its exit status.
 */
async function stopUi(
  launch: Launch,
  signal: Deno.Signal = "SIGKILL",
): Promise<Deno.CommandStatus> {
  try {
    launch.proc.kill(signal);
  } catch { /* already exited */ }
  const status = await launch.proc.status;
  await launch.rest;
  await launch.errors;
  return status;
}

/** The session shell for a launch; `cookie`/`csrf` are filled in by {@linkcode handshake}. */
function session(launch: Launch, dir: string): Ui {
  return {
    base: `http://127.0.0.1:${launch.port}`,
    port: launch.port,
    token: launch.token,
    dir,
    cookie: "",
    csrf: "",
  };
}

/** What one {@linkcode withUi} launch starts from. */
interface Setup {
  /** The project's `denext.config.ts` (default {@linkcode CONFIG}). */
  readonly config?: string;
  /** Extra project files. */
  readonly files?: Readonly<Record<string, string>>;
  /** Extra `denext ui` flags. */
  readonly flags?: string[];
  /** Extra environment for the child. */
  readonly env?: Record<string, string>;
}

/**
 * Make a project, launch `denext ui` over it, run `body`, then stop the child and delete the
 * project — whatever `body` did.
 *
 * @param setup The project and the launch flags.
 * @param body The work, handed the (not yet authenticated) session and the launch.
 */
async function withUi(
  setup: Setup,
  body: (ui: Ui, launch: Launch) => Promise<void>,
): Promise<void> {
  const dir = await project(setup.config, setup.files);
  try {
    const launch = await spawnUi(dir, setup.flags, setup.env);
    try {
      await body(session(launch, dir), launch);
    } finally {
      await stopUi(launch);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ── talking to it ────────────────────────────────────────────────────────────

/** A request carrying the session cookie and a browser's `Sec-Fetch-Site: same-origin`. */
function authed(ui: Ui, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", ui.cookie);
  if (!headers.has("sec-fetch-site")) headers.set("sec-fetch-site", "same-origin");
  return fetch(ui.base + path, { ...init, headers, redirect: "manual" });
}

/** Form fields to post: a value, or several under one name (a checkbox after its hidden twin). */
type Fields = Readonly<Record<string, string | readonly string[]>>;

/** A `POST` with a form body, the same-origin `Origin` and (unless refused) the CSRF field. */
function mutate(
  ui: Ui,
  path: string,
  fields: Fields,
  init: { csrf?: boolean; site?: string } = {},
): Promise<Response> {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of typeof value === "string" ? [value] : value) body.append(name, item);
  }
  if (init.csrf !== false) body.set("_csrf", ui.csrf);
  const headers = new Headers({ origin: ui.base });
  if (init.site) headers.set("sec-fetch-site", init.site);
  return authed(ui, path, { method: "POST", body, headers });
}

/** A mutation's answer, with the body already read. */
interface Sent {
  /** The status. */
  readonly status: number;
  /** The `Location` header, when there is one. */
  readonly location: string | null;
  /** The body. */
  readonly text: string;
}

/** {@linkcode mutate}, answered: the status, the `Location` and the drained body. */
async function send(ui: Ui, path: string, fields: Fields): Promise<Sent> {
  const res = await mutate(ui, path, fields);
  return { status: res.status, location: res.headers.get("location"), text: await res.text() };
}

/** A page's HTML, asserting it answered `200`. */
async function getText(ui: Ui, path: string): Promise<string> {
  const res = await authed(ui, path);
  const text = await res.text();
  assertEquals(res.status, 200, `${path} answered ${res.status}`);
  return text;
}

/** A JSON twin's payload, asserting it answered `200`. */
async function getJson(ui: Ui, path: string) {
  return JSON.parse(await getText(ui, path));
}

/** Decode the entities the UI's renderer writes (`&quot;` `&#39;` `&lt;` `&gt;` `&amp;`). */
function unescapeHtml(text: string): string {
  return text.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** Every `<input>` tag in `html` named `name`, in document order. */
function inputTags(html: string, name: string): string[] {
  return [...html.matchAll(/<input\b[^>]*>/g)].map((match) => match[0])
    .filter((tag) => tag.includes(` name="${name}"`));
}

/** The decoded value of the first `<input>` named `name` — what a browser would post for it. */
function fieldValue(html: string, name: string): string {
  const tag = inputTags(html, name)[0];
  assert(tag, `the page has no <input name="${name}">`);
  return unescapeHtml(/\svalue="([^"]*)"/.exec(tag)?.[1] ?? "");
}

/** The fields a rendered confirm form would re-post, read off the preview page. */
function confirmFields(html: string, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, fieldValue(html, name)]));
}

/** The hex SHA-256 of a text — the `_base` stamp an editor form carries. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The lines of `after` that differ from `before`, as `[index, line]` (line count asserted). */
function changedLines(before: string, after: string): [number, string][] {
  const was = before.split("\n");
  const now = after.split("\n");
  assertEquals(now.length, was.length, "an in-place edit neither adds nor drops a line");
  return now.flatMap((line, index): [number, string][] =>
    line === was[index] ? [] : [[index, line]]
  );
}

/** A loopback listener standing in for an HTTP(S) proxy: it counts every connection, then drops it. */
interface NetTrap {
  /** `http://127.0.0.1:<port>`, for `HTTPS_PROXY` / `HTTP_PROXY`. */
  readonly url: string;
  /** How many connections reached it. */
  hits: number;
  /** Stop listening. */
  close(): Promise<void>;
}

/**
 * Open a {@linkcode NetTrap}. A child started with {@linkcode trapEnv} sends every outbound
 * `fetch` here instead of the internet, so "nothing reached the network" is a count of zero.
 */
function netTrap(): NetTrap {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  let accepting: Promise<void> = Promise.resolve();
  const trap: NetTrap = {
    url: `http://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`,
    hits: 0,
    close: async () => {
      listener.close();
      await accepting;
    },
  };
  accepting = (async () => {
    for await (const conn of listener) {
      trap.hits++;
      conn.close();
    }
  })().catch(() => {});
  return trap;
}

/** The child environment that routes outbound HTTP(S) through `trap` (loopback excepted). */
function trapEnv(trap: NetTrap): Record<string, string> {
  return {
    HTTPS_PROXY: trap.url,
    HTTP_PROXY: trap.url,
    NO_PROXY: "127.0.0.1,localhost",
    DENO_NO_UPDATE_CHECK: "1",
  };
}

/** Drain a response body (the resource sanitizer wants every one consumed) and report the status. */
async function statusOf(res: Response): Promise<number> {
  await res.body?.cancel();
  return res.status;
}

/**
 * A hand-written HTTP/1.1 request over a raw socket, so headers `fetch` owns (`Host`) can be
 * forged — the DNS-rebinding case the UI's host gate exists for.
 *
 * @param port The UI port.
 * @param lines The request headers, `Host` included.
 * @returns The response's status code.
 */
async function rawStatus(port: number, lines: string[]): Promise<number> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const request = ["GET /config HTTP/1.1", ...lines, "Connection: close", "", ""].join("\r\n");
    await conn.write(new TextEncoder().encode(request));
    const buffer = new Uint8Array(512);
    const read = await conn.read(buffer) ?? 0;
    const head = new TextDecoder().decode(buffer.subarray(0, read));
    return Number(head.split(" ")[1]);
  } finally {
    conn.close();
  }
}

/** Whether nothing is listening on `port` any more. */
async function portFree(port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.close();
    return false;
  } catch {
    return true;
  }
}

// ── the steps ────────────────────────────────────────────────────────────────

/** Before the handshake, a page is a `401` — the token is the only way in. */
async function checkUnauthenticated(ui: Ui): Promise<void> {
  const res = await fetch(`${ui.base}/config`, { redirect: "manual" });
  assertEquals(res.status, 401);
  assertEquals((await res.json()).ok, false);
}

/**
 * The `?t=` exchange: a 302 to the same path with the query stripped, and the token parked in an
 * `HttpOnly; SameSite=Strict` cookie. Also picks the CSRF token out of the page's `<meta>`.
 */
async function handshake(ui: Ui): Promise<void> {
  const res = await fetch(`${ui.base}/?t=${ui.token}`, { redirect: "manual" });
  await res.body?.cancel();
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "/", "the token never survives in the address bar");
  const setCookie = res.headers.get("set-cookie") ?? "";
  assertStringIncludes(setCookie, "HttpOnly");
  assertStringIncludes(setCookie, "SameSite=Strict");
  ui.cookie = setCookie.split(";")[0];
  assertStringIncludes(ui.cookie, ui.token);

  const home = await authed(ui, "/");
  assertEquals(home.status, 200);
  const meta = /<meta name="denext-csrf" content="([^"]+)">/.exec(await home.text());
  assert(meta, "the layout publishes the CSRF token as a meta tag");
  ui.csrf = meta[1];
}

/** Every page route renders the panel shell. */
async function checkPages(ui: Ui): Promise<void> {
  for (const path of PAGES) {
    const res = await authed(ui, path);
    const body = await res.text();
    assertEquals(res.status, 200, `${path} answered ${res.status}`);
    assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
    assertStringIncludes(body, '<section id="panel"');
  }
}

/** The two same-origin assets, with the content types the shell references them by. */
async function checkAssets(ui: Ui): Promise<void> {
  const css = await authed(ui, "/_ui/ui.css");
  await css.body?.cancel();
  assertEquals(css.status, 200);
  assertStringIncludes(css.headers.get("content-type") ?? "", "text/css");
  const js = await authed(ui, "/_ui/ui.js");
  await js.body?.cancel();
  assertEquals(js.status, 200);
  assertStringIncludes(js.headers.get("content-type") ?? "", "javascript");
}

/** Every `/api/*` twin answers the same handler's JSON envelope. */
async function checkApiTwins(ui: Ui): Promise<void> {
  for (const path of API_TWINS) {
    const res = await authed(ui, path);
    const payload = await res.json();
    assertEquals(res.status, 200, `${path} answered ${res.status}`);
    assertStringIncludes(res.headers.get("content-type") ?? "", "application/json");
    assertEquals(payload.ok, true, `${path} did not report ok`);
  }
}

/** The hardened header set, on a page and on a refusal alike. */
async function checkHeaders(ui: Ui): Promise<void> {
  for (const path of ["/config", "/nope"]) {
    const res = await authed(ui, path);
    await res.body?.cancel();
    const csp = res.headers.get("content-security-policy") ?? "";
    assertStringIncludes(csp, "default-src 'self'");
    assertStringIncludes(csp, "script-src 'self'");
    assertStringIncludes(csp, "object-src 'none'");
    assertStringIncludes(csp, "frame-ancestors 'none'");
    assertEquals(res.headers.get("referrer-policy"), "same-origin");
    assertEquals(res.headers.get("cross-origin-opener-policy"), "same-origin");
    assertEquals(res.headers.get("cross-origin-resource-policy"), "same-origin");
    assertEquals(res.headers.get("cache-control"), "no-store");
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  }
}

/** The three ways a mutation is refused even when the session cookie is perfect. */
async function checkRefusals(ui: Ui): Promise<void> {
  const fields = { kind: "component", name: "Sneak", op: "apply" };
  const noCsrf = await mutate(ui, "/api/generate", fields, { csrf: false });
  assertEquals(await statusOf(noCsrf), 403, "a mutation with no CSRF token is refused");

  const crossSite = await mutate(ui, "/api/generate", fields, { site: "cross-site" });
  assertEquals(await statusOf(crossSite), 403, "a cross-site caller is refused before anything");

  const rebound = await rawStatus(ui.port, [`Host: evil.test`, `Cookie: ${ui.cookie}`]);
  assertEquals(rebound, 403, "a Host that is not loopback is refused (DNS rebinding)");

  assertEquals(await exists(join(ui.dir, "components", "Sneak.tsx")), false);
}

/** Whether `path` is on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real round trip: read the field name off the rendered form, post a changed scalar with
 * `confirm=1`, and assert the file moved in exactly one place.
 */
async function checkConfigWrite(ui: Ui): Promise<void> {
  const path = join(ui.dir, "denext.config.ts");
  const form = await (await authed(ui, "/config")).text();
  assertMatch(form, /name="basePath"[^>]*value="\/docs"/);

  const preview = await mutate(ui, "/config?section=basePath", { basePath: "/site" });
  assertEquals(await statusOf(preview), 200, "the first POST only previews");
  assertEquals(await Deno.readTextFile(path), CONFIG, "a preview never touches the file");

  const applied = await mutate(ui, "/config?section=basePath", {
    basePath: "/site",
    confirm: "1",
  });
  await applied.body?.cancel();
  assertEquals(applied.status, 303);
  assertEquals(applied.headers.get("location"), "/config#basePath");
  assertEquals(
    await Deno.readTextFile(path),
    CONFIG.replace('"/docs"', '"/site"'),
    "only the edited value moved — comments, the rule thunk and every other key are byte-identical",
  );
}

/** `op=apply` on `/generate` writes the component and redirects to the result. */
async function checkGenerate(ui: Ui): Promise<void> {
  const res = await mutate(ui, "/generate", { kind: "component", name: "Widget", op: "apply" });
  await res.body?.cancel();
  assertEquals(res.status, 303);
  const location = decodeURIComponent(res.headers.get("location") ?? "");
  assertStringIncludes(location, "components/Widget.tsx");
  const written = await Deno.readTextFile(join(ui.dir, "components", "Widget.tsx"));
  assertStringIncludes(written, '"use client"');
}

/** A Docker POST without `confirm=1` shows the diff and writes nothing. */
async function checkDockerPreview(ui: Ui): Promise<void> {
  const res = await mutate(ui, "/docker", { op: "preview", mode: "server", port: "3000" });
  const body = await res.text();
  assertEquals(res.status, 200);
  assertStringIncludes(body, "Dockerfile");
  assertStringIncludes(body, '<pre class="out">');
  assertStringIncludes(body, "+FROM denoland/deno");
  assertEquals(await exists(join(ui.dir, "Dockerfile")), false, "a preview writes nothing");
}

/**
 * The index twin lists the wired plugin, its twin reports the call's options, and its form renders
 * from the catalogue's schema with the `_base` stamp of the file on disk.
 *
 * @returns The form's `_base`.
 */
async function checkOptionsForm(ui: Ui): Promise<string> {
  const index = await getJson(ui, "/api/plugins/options");
  const row = index.plugins.find((plugin: { name: string }) => plugin.name === PLUGIN);
  assertEquals(row, { name: PLUGIN, wired: true, href: OPTIONS_HREF });
  const twin = await getJson(ui, "/api" + OPTIONS_HREF);
  assertEquals(twin.callee, "reactRouter");
  assertEquals(twin.values, { appDirectory: "app" });
  assertEquals(twin.codeKeys, []);
  const html = await getText(ui, OPTIONS_HREF);
  assertEquals(fieldValue(html, "o.appDirectory"), "app");
  assertEquals(fieldValue(html, "o.routesFile"), "");
  const base = fieldValue(html, "_base");
  assertEquals(base, await sha256(PLUGIN_CONFIG), "_base is the SHA-256 of the rendered source");
  return base;
}

/**
 * The widget form's first POST: the diff and a confirm form carrying exactly one option write —
 * and not one byte of the file touched.
 *
 * @returns The confirm form's fields.
 */
async function checkOptionsPreview(ui: Ui, base: string): Promise<Record<string, string>> {
  const form = { "o.appDirectory": "app", "o.routesFile": "app/routes.ts", _base: base };
  const res = await send(ui, OPTIONS_HREF, form);
  assertEquals(res.status, 200);
  const path = join(ui.dir, "denext.config.ts");
  assertEquals(await Deno.readTextFile(path), PLUGIN_CONFIG, "a preview never touches the file");
  const page = unescapeHtml(res.text);
  assertStringIncludes(page, '-    reactRouter({ appDirectory: "app" }), // the router');
  assertStringIncludes(
    page,
    '+    reactRouter({ appDirectory: "app", routesFile: "app/routes.ts" }), // the router',
  );
  const fields = confirmFields(res.text, ["sets", "_base", "confirm"]);
  assertEquals(JSON.parse(fields.sets), [{ path: ["routesFile"], value: "app/routes.ts" }]);
  assertEquals([fields._base, fields.confirm], [base, "1"]);
  return fields;
}

/** The confirm POST adds exactly one key; the leading comment and every other byte stay put. */
async function checkOptionsConfirm(ui: Ui, confirm: Record<string, string>): Promise<void> {
  const res = await send(ui, OPTIONS_HREF, confirm);
  assertEquals([res.status, res.location], [303, OPTIONS_HREF]);
  const written = await Deno.readTextFile(join(ui.dir, "denext.config.ts"));
  assertEquals(written, PLUGIN_CONFIG_AFTER, "one key added — every other byte is unchanged");
  assertEquals(changedLines(PLUGIN_CONFIG, written).length, 1);
  assertEquals(written.split("\n")[0], PLUGIN_CONFIG.split("\n")[0], "the leading comment");
  const twin = await getJson(ui, "/api" + OPTIONS_HREF);
  assertEquals(twin.values, { appDirectory: "app", routesFile: "app/routes.ts" });
}

/** Replaying the confirm form after the file moved on is a `409` that writes nothing. */
async function checkOptionsStale(ui: Ui, confirm: Record<string, string>): Promise<void> {
  assertEquals((await send(ui, OPTIONS_HREF, confirm)).status, 409);
  const res = await send(ui, "/api" + OPTIONS_HREF, confirm);
  assertEquals(res.status, 409);
  const payload = JSON.parse(res.text);
  assertEquals(payload.ok, false);
  assertStringIncludes(payload.reason, "changed on disk");
  const path = join(ui.dir, "denext.config.ts");
  assertEquals(await Deno.readTextFile(path), PLUGIN_CONFIG_AFTER, "a stale form writes nothing");
}

/**
 * The compose editor, the way the page drives it: post one service's whole form with a changed
 * port, re-post the preview's confirm form, and find exactly the port line moved.
 */
async function checkComposeEdit(ui: Ui): Promise<void> {
  const file = join(ui.dir, "docker-compose.yml");
  const base = fieldValue(await getText(ui, "/docker"), "_base");
  assertEquals(base, await sha256(COMPOSE), "the service form carries the file's stamp");
  const preview = await send(ui, "/docker", {
    editor: "compose",
    service: "web",
    _base: base,
    image: "denext-app",
    restart: "",
    "port.0": "8080:3000",
    "port.new": "",
    "env.0": "production",
    "env.new.key": "",
    "env.new.value": "",
    "volume.new": "",
    op: "apply",
  });
  assertEquals(preview.status, 200);
  assertEquals(await Deno.readTextFile(file), COMPOSE, "a preview writes nothing");
  assertStringIncludes(unescapeHtml(preview.text), '+      - "8080:3000" # host:container');
  const confirm = confirmFields(preview.text, ["editor", "_base", "ops", "confirm"]);
  const applied = await send(ui, "/docker", confirm);
  assertEquals([applied.status, applied.location], [303, "/docker?saved=compose"]);
  assertEquals(
    changedLines(COMPOSE, await Deno.readTextFile(file)),
    [[5, '      - "8080:3000" # host:container']],
    "only the port line moved — its comment and every other line are byte-identical",
  );
}

/** An unparseable compose file is `opaque`: shown read-only, and an edit of it is a `400`. */
async function checkOpaqueCompose(ui: Ui): Promise<void> {
  const file = join(ui.dir, "docker-compose.yml");
  await Deno.writeTextFile(file, UNPARSEABLE_COMPOSE);
  const twin = await getJson(ui, "/api/docker");
  const compose = twin.files.find((entry: { path: string }) => entry.path === "docker-compose.yml");
  assertEquals(compose?.state, "opaque");
  assertEquals(twin.model, null);
  const html = await getText(ui, "/docker");
  assertStringIncludes(html, "uses YAML the editor cannot follow line by line");
  assertEquals(inputTags(html, "editor").length, 0, "an opaque file gets no editor form");

  const edit = {
    editor: "compose",
    service: "web",
    _base: await sha256(UNPARSEABLE_COMPOSE),
    "port.0": "8080:3000",
    op: "apply",
  };
  const refused = await send(ui, "/api/docker", edit);
  assertEquals(refused.status, 400);
  assertStringIncludes(JSON.parse(refused.text).reason, "cannot follow");
  assertEquals((await send(ui, "/docker", { ...edit, confirm: "1" })).status, 400);
  assertEquals(await Deno.readTextFile(file), UNPARSEABLE_COMPOSE, "a refused edit writes nothing");
}

/** `--offline`: the search box and its button are disabled with a note; the twin ran no query. */
async function checkOfflineSearch(ui: Ui): Promise<void> {
  const html = await getText(ui, "/plugins?q=denext");
  assertStringIncludes(inputTags(html, "q")[0] ?? "", " disabled", "the search box is disabled");
  assertMatch(html, /<button[^>]*\sdisabled[^>]*>Search<\/button>/);
  assertStringIncludes(html, "JSR search is unavailable — the UI runs --offline");
  assertEquals(html.includes('id="jsr:@'), false, "no results are rendered");
  const twin = await getJson(ui, "/api/plugins?q=denext");
  assertEquals(twin.ok, true);
  assertEquals(twin.jsr, { available: false, query: "denext" }, "no `search` key: no query ran");
}

/** The control: without `--offline` the same search leaves the process — into the trap. */
async function checkOnlineSearch(ui: Ui, trap: NetTrap): Promise<void> {
  const twin = await getJson(ui, "/api/plugins?q=denext");
  assertEquals(twin.jsr.available, true);
  assertEquals(twin.jsr.search?.ok, false, "the trap drops the connection, so the search fails");
  assert(trap.hits > 0, "the trap saw the search — so a zero under --offline means something");
}

/** A verb run from the panel under `--offline` holds no `net` permission (`--deny-net` wins). */
async function checkOfflineChildNet(ui: Ui): Promise<void> {
  const res = await send(ui, "/api/commands", { verb: "net-state" });
  const output: string[] = JSON.parse(res.text).output ?? [];
  const line = output.find((entry) => entry.startsWith("NET "));
  assertMatch(line ?? output.join("\n"), /^NET denied$/);
}

/** `deno task` under `--offline`: a declared task is refused with a `503` and never spawned. */
async function checkOfflineTask(ui: Ui): Promise<void> {
  const res = await send(ui, "/api/tasks/run", { task: "hello" });
  assertEquals(res.status, 503);
  assertStringIncludes(JSON.parse(res.text).reason, "the UI runs --offline");
}

/** The run form is typed from the verb's declared flags. */
async function checkRunForm(ui: Ui): Promise<void> {
  const html = await getText(ui, "/commands");
  assertStringIncludes(html, "denext echo-flags");
  const loud = inputTags(html, "flag:loud");
  assertEquals(loud.length, 2, "a boolean flag is a hidden `false` twin plus a checkbox");
  assertStringIncludes(loud[0], 'type="hidden"');
  assertStringIncludes(loud[1], 'type="checkbox"');
  assertStringIncludes(inputTags(html, "flag:greeting")[0] ?? "", 'type="text"');
}

/** Fields no run may honour: a global flag, undeclared flags, a positional the verb lacks. */
const SMUGGLED: Fields = { "flag:cwd": "/etc", "flag:bogus": "1", "--evil": "1", "pos:0": "x" };

/** Each submitted run form, and the argv (after `<verb> --cwd <dir>`) the verb must receive. */
const RUNS: readonly { readonly fields: Fields; readonly argv: readonly string[] }[] = [
  {
    fields: { "flag:loud": ["false", "true"], "flag:greeting": "hello world" },
    argv: ["--loud", "--greeting", "hello world"],
  },
  { fields: { "flag:loud": "false", "flag:greeting": "" }, argv: [] },
];

/** The argv `echo-flags` printed. */
function verbArgs(output: readonly string[]): string[] {
  const line = output.find((entry) => entry.startsWith("ARGV "));
  assert(line, `the verb printed no argv:\n${output.join("\n")}`);
  return JSON.parse(line.slice("ARGV ".length));
}

/** Each run's argv is built from the declared flags alone; undeclared fields never reach it. */
async function checkFlagRuns(ui: Ui): Promise<void> {
  for (const run of RUNS) {
    const res = await send(ui, "/api/commands", { verb: "echo-flags", ...SMUGGLED, ...run.fields });
    assertEquals(res.status, 200, res.text);
    const payload = JSON.parse(res.text);
    assertEquals([payload.ok, payload.code], [true, 0], payload.output?.join("\n"));
    const args = verbArgs(payload.output);
    assertEquals(args.slice(0, 2), ["echo-flags", "--cwd"]);
    assertEquals(args.slice(3), run.argv, "exactly the declared flags that were submitted");
  }
}

// ── the tests ────────────────────────────────────────────────────────────────

Deno.test("`denext ui` serves, guards and writes over real HTTP", (t) =>
  withUi({}, async (ui, launch) => {
    assertStringIncludes(launch.url, `:${launch.port}/?t=${launch.token}`);
    await t.step("an unauthenticated request is a 401", () => checkUnauthenticated(ui));
    await t.step("the ?t= handshake parks a strict cookie", () => handshake(ui));
    await t.step("every page renders the panel shell", () => checkPages(ui));
    await t.step("the same-origin assets are served", () => checkAssets(ui));
    await t.step("every /api/* twin answers ok", () => checkApiTwins(ui));
    await t.step("every response is hardened", () => checkHeaders(ui));
    await t.step("CSRF, cross-site and rebound Host are refused", () => checkRefusals(ui));
    await t.step("a config write moves exactly one value", () => checkConfigWrite(ui));
    await t.step("generate writes the component", () => checkGenerate(ui));
    await t.step("docker previews a diff without writing", () => checkDockerPreview(ui));
  }));

Deno.test("SIGTERM exits promptly with a browser tab holding /_ui/events open", () =>
  withUi({}, async (ui, launch) => {
    await handshake(ui);
    // A real page keeps this stream open for the life of the tab. Before the SSE controllers
    // were closed on abort, `Deno.serve` never finished draining and one Ctrl+C looked hung.
    const events = await authed(ui, "/_ui/events");
    const reader = events.body!.getReader();
    await reader.read(); // the `retry:` frame — the subscription is live

    const started = performance.now();
    launch.proc.kill("SIGTERM");
    const status = await withTimeout(
      launch.proc.status,
      SHUTDOWN_TIMEOUT_MS,
      "the server to drain after SIGTERM with an open SSE stream",
    );
    assertEquals(status.code, 0, "a signalled `denext ui` exits cleanly");
    assert(
      performance.now() - started < SHUTDOWN_TIMEOUT_MS,
      "one SIGTERM is enough — no second signal needed",
    );
    await reader.cancel().catch(() => {});
    assert(await portFree(launch.port), "the port is released");
  }));

Deno.test("an explicit --port is required exactly, and a short --token is refused", async () => {
  const dir = await project();
  const held = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const taken = (held.addr as Deno.NetAddr).port;
  try {
    const busy = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", CLI, "ui", dir, "--no-open", "--json", "--port", String(taken)],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(busy.code !== 0, "an explicit --port that is taken fails instead of falling forward");
    assertStringIncludes(
      new TextDecoder().decode(busy.stderr),
      `port ${taken} is already in use`,
    );

    const short = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", CLI, "ui", dir, "--no-open", "--json", "--port", "0", "--token", "tiny"],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(short.code !== 0, "a guessable --token is refused at startup");
    assertStringIncludes(new TextDecoder().decode(short.stderr), "--token must be at least");
  } finally {
    held.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("`--read-only` refuses every mutation, and SIGTERM drains the port", () =>
  withUi({ flags: ["--read-only"] }, async (ui, launch) => {
    await handshake(ui);
    const banner = await (await authed(ui, "/")).text();
    assertStringIncludes(banner, "Read-only mode");

    const res = await mutate(ui, "/api/generate", {
      kind: "component",
      name: "Widget",
      op: "apply",
    });
    assertEquals(res.status, 403);
    assertEquals((await res.json()).reason, "read-only");
    assertEquals(await exists(join(ui.dir, "components", "Widget.tsx")), false);

    launch.proc.kill("SIGTERM");
    const status = await withTimeout(
      launch.proc.status,
      SHUTDOWN_TIMEOUT_MS,
      "the server to drain after SIGTERM",
    );
    assertEquals(status.code, 0, "a signalled `denext ui` exits cleanly");
    assert(await portFree(launch.port), "the port is released");
  }));

Deno.test("plugin options and compose edits splice the file in place", (t) =>
  withUi({ config: PLUGIN_CONFIG, files: { "docker-compose.yml": COMPOSE } }, async (ui) => {
    await handshake(ui);
    let base = "";
    let confirm: Record<string, string> = {};
    await t.step("the options form renders from the plugin's schema", async () => {
      base = await checkOptionsForm(ui);
    });
    await t.step("an options preview returns a diff and writes nothing", async () => {
      confirm = await checkOptionsPreview(ui, base);
    });
    await t.step(
      "the confirm adds exactly one key; the leading comment survives",
      () => checkOptionsConfirm(ui, confirm),
    );
    await t.step("a stale _base is a 409", () => checkOptionsStale(ui, confirm));
    await t.step("a compose edit moves only the port line", () => checkComposeEdit(ui));
    await t.step(
      "an unparseable compose file is read-only and refuses edits",
      () => checkOpaqueCompose(ui),
    );
  }));

Deno.test("`--offline` disables JSR search and reaches no network", async (t) => {
  const trap = netTrap();
  const env = trapEnv(trap);
  try {
    await withUi({ config: COMMANDS_CONFIG, flags: ["--offline"], env }, async (ui) => {
      await handshake(ui);
      await t.step(
        "the search box is disabled; the twin reports offline",
        () => checkOfflineSearch(ui),
      );
      await t.step(
        "a UI subprocess under --offline holds no net permission",
        () => checkOfflineChildNet(ui),
      );
      await t.step("deno task is refused with a 503", () => checkOfflineTask(ui));
      await t.step("nothing reached the network", () => assertEquals(trap.hits, 0));
    });
    await withUi({ env }, async (ui) => {
      await handshake(ui);
      await t.step(
        "control: online, the same search reaches the trap",
        () => checkOnlineSearch(ui, trap),
      );
    });
  } finally {
    await trap.close();
  }
});

Deno.test("the Commands panel runs a project verb with exactly its declared flags", (t) =>
  withUi({ config: COMMANDS_CONFIG }, async (ui) => {
    await handshake(ui);
    await t.step("the run form is typed from the declared flags", () => checkRunForm(ui));
    await t.step(
      "argv carries the submitted flags; undeclared fields are ignored",
      () => checkFlagRuns(ui),
    );
  }));
