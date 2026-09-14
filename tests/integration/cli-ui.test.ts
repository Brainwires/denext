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
// a too-short `--token` refused at startup.

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
  "/api/generate",
  "/api/docker",
  "/api/wizard",
  "/api/commands",
];

// ── the project ──────────────────────────────────────────────────────────────

/**
 * A throwaway project for the UI to manage: a `deno.json` aliasing `denext` at this checkout,
 * one page, and a `denext.config.ts` with a scalar and a rule thunk.
 *
 * @returns The project directory.
 */
async function project(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_e2e_" });
  const config = { imports: { "denext": MOD, "denext/": ROOT }, tasks: { hello: "eval 1" } };
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(config, null, 2) + "\n");
  await Deno.mkdir(join(dir, "app"));
  await Deno.writeTextFile(
    join(dir, "app", "page.tsx"),
    "export default function Page() {\n  return <h1>hi</h1>;\n}\n",
  );
  await Deno.writeTextFile(join(dir, "denext.config.ts"), CONFIG);
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
 * @returns The running child and what it announced.
 */
async function spawnUi(dir: string, extra: string[] = []): Promise<Launch> {
  const args = ["run", "-A", CLI, "ui", dir, "--no-open", "--json", "--port", "0", ...extra];
  const proc = new Deno.Command(Deno.execPath(), {
    args,
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

// ── talking to it ────────────────────────────────────────────────────────────

/** A request carrying the session cookie and a browser's `Sec-Fetch-Site: same-origin`. */
function authed(ui: Ui, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", ui.cookie);
  if (!headers.has("sec-fetch-site")) headers.set("sec-fetch-site", "same-origin");
  return fetch(ui.base + path, { ...init, headers, redirect: "manual" });
}

/** A `POST` with a form body, the same-origin `Origin` and (unless refused) the CSRF field. */
function mutate(
  ui: Ui,
  path: string,
  fields: Record<string, string>,
  init: { csrf?: boolean; site?: string } = {},
): Promise<Response> {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  if (init.csrf !== false) body.set("_csrf", ui.csrf);
  const headers = new Headers({ origin: ui.base });
  if (init.site) headers.set("sec-fetch-site", init.site);
  return authed(ui, path, { method: "POST", body, headers });
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
    assertEquals(res.headers.get("referrer-policy"), "no-referrer");
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

// ── the tests ────────────────────────────────────────────────────────────────

Deno.test("`denext ui` serves, guards and writes over real HTTP", async (t) => {
  const dir = await project();
  const launch = await spawnUi(dir);
  const ui = session(launch, dir);
  try {
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
  } finally {
    await stopUi(launch);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SIGTERM exits promptly with a browser tab holding /_ui/events open", async () => {
  const dir = await project();
  const launch = await spawnUi(dir);
  const ui = session(launch, dir);
  try {
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
  } finally {
    await stopUi(launch);
    await Deno.remove(dir, { recursive: true });
  }
});

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

Deno.test("`--read-only` refuses every mutation, and SIGTERM drains the port", async () => {
  const dir = await project();
  const launch = await spawnUi(dir, ["--read-only"]);
  const ui = session(launch, dir);
  try {
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
    assertEquals(await exists(join(dir, "components", "Widget.tsx")), false);

    launch.proc.kill("SIGTERM");
    const status = await withTimeout(
      launch.proc.status,
      SHUTDOWN_TIMEOUT_MS,
      "the server to drain after SIGTERM",
    );
    assertEquals(status.code, 0, "a signalled `denext ui` exits cleanly");
    assert(await portFree(launch.port), "the port is released");
  } finally {
    await stopUi(launch);
    await Deno.remove(dir, { recursive: true });
  }
});
