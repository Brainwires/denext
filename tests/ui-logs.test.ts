// The Database section's Logs page and where its lines come from: `docker compose logs` on a
// machine with Docker (argv only; the runner scripted), and inside the stack the
// `dashboard-logs` relay — the only container with the Docker socket — answering two GETs behind
// a bearer token derived from the dashboard password (the Engine faked). Covers: the relay
// refuses without the token, while locked, for another method, and for a service not in its own
// project, and never forwards an inspect; a multiplexed logs stream is demultiplexed; every line
// is redacted (a connection-string password, every secret-looking variable) BEFORE the text
// filter runs, so a search cannot find a secret; the level filter; the page's fixed choices; a
// project with no compose file says so.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Harness, stopUi, uiOn } from "./helpers/ui-panel.ts";
import {
  composeSource,
  type DockerRunner,
  filterLines,
  type LogLine,
  redact,
  relaySource,
  relayToken,
  secretValues,
  setDockerRunner,
} from "../src/ui/logs/source.ts";
import { relayHandler, startLogsRelay } from "../src/ui/logs/relay.ts";
import { demux, type EngineGet, projectServices, timestamped } from "../src/ui/logs/engine.ts";

const PASSWORD = "dashboard password 1234";

/** One Engine frame: stream, three zeros, a big-endian length, the payload. */
function frame(stream: number, text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const out = new Uint8Array(8 + payload.length);
  out[0] = stream;
  new DataView(out.buffer).setUint32(4, payload.length);
  out.set(payload, 8);
  return out;
}

/** Concatenate byte arrays. */
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A fake Engine: this container in project `shop`, two services, a stranger's container. */
function fakeEngine(): { get: EngineGet; paths: string[] } {
  const paths: string[] = [];
  const label = (project: string, service: string) => ({
    "com.docker.compose.project": project,
    "com.docker.compose.service": service,
  });
  const get: EngineGet = (path) => {
    paths.push(path);
    if (path === "/containers/self123/json") {
      return Promise.resolve(Response.json({
        Config: { Env: ["SECRET=never"], Labels: label("shop", "dashboard-logs") },
      }));
    }
    if (path.startsWith("/containers/json?")) {
      return Promise.resolve(Response.json([
        {
          Id: "web-old",
          Created: 1,
          State: "exited",
          Status: "Exited (1)",
          Labels: label("shop", "web"),
        },
        {
          Id: "web-new",
          Created: 2,
          State: "running",
          Status: "Up 2 minutes (healthy)",
          Labels: label("shop", "web"),
        },
        {
          Id: "db-1",
          Created: 1,
          State: "running",
          Status: "Up 1 minute (unhealthy)",
          Labels: label("shop", "db"),
        },
        {
          Id: "mig-1",
          Created: 1,
          State: "exited",
          Status: "Exited (0) 1 minute ago",
          Labels: label("shop", "migrate"),
        },
        {
          Id: "other",
          Created: 3,
          State: "running",
          Status: "Up",
          Labels: label("elsewhere", "web"),
        },
      ]));
    }
    const logs = /^\/containers\/([\w-]+)\/logs\?/.exec(path);
    if (logs) {
      const body = concat(
        frame(1, `2026-10-14T09:00:00.000000001Z ${logs[1]} started\n`),
        frame(2, `2026-10-14T09:00:01.000000001Z ERROR: ${logs[1]} broke\n`),
      );
      return Promise.resolve(new Response(body as BodyInit));
    }
    return Promise.resolve(new Response("no", { status: 404 }));
  };
  return { get, paths };
}

Deno.test("demux: Engine frames become text; a TTY's raw stream passes through", () => {
  const framed = concat(frame(1, "a\n"), frame(2, "b é\n"));
  assertEquals(demux(framed), "a\nb é\n");
  assertEquals(demux(new TextEncoder().encode("2026 raw tty\n")), "2026 raw tty\n");
  assertEquals(timestamped("web", "2026-10-14T09:00:00.5Z hi"), {
    service: "web",
    time: "2026-10-14T09:00:00.5Z",
    text: "hi",
  });
  assertEquals(timestamped("web", "no stamp"), { service: "web", text: "no stamp" });
});

Deno.test("the Engine reader keeps to its own project and the newest container per service", async () => {
  const { get } = fakeEngine();
  const services = await projectServices(get, "shop");
  assertEquals([...services.entries()], [["db", "db-1"], ["migrate", "mig-1"], ["web", "web-new"]]);
});

Deno.test("relay: the bearer token, nothing while locked, GET only, its own services only", async () => {
  const { get, paths } = fakeEngine();
  const token = await relayToken(PASSWORD);
  assertEquals(token, await relayToken(PASSWORD), "both containers derive the same token");
  assert(token !== (await relayToken(PASSWORD + "x")));
  const handle = relayHandler({ token, engine: get, self: "self123" });
  const call = (path: string, init: RequestInit = {}) =>
    handle(new Request(`http://relay${path}`, init));
  assertEquals((await call("/v1/services")).status, 401);
  assertEquals(
    (await call("/v1/services", { headers: { authorization: "Bearer wrong" } })).status,
    401,
  );
  const auth = { authorization: `Bearer ${token}` };
  assertEquals((await call("/v1/services", { method: "POST", headers: auth })).status, 405);
  const services = await (await call("/v1/services", { headers: auth })).json();
  assertEquals(services, { ok: true, services: ["db", "migrate", "web"] });
  // /v1/health: each service's verdict, as `denext stack health` reads `docker compose ps`.
  const health = await (await call("/v1/health", { headers: auth })).json();
  assertEquals(health.services, [
    { name: "db", state: "running", health: "unhealthy", ok: false },
    { name: "migrate", state: "exited", health: "completed", ok: true },
    { name: "web", state: "running", health: "healthy", ok: true },
  ]);
  assertEquals((await call("/v1/health")).status, 401);
  const stranger = await (await call("/v1/logs?service=other", { headers: auth })).json();
  assertEquals(stranger.ok, false);
  const logs = await (await call("/v1/logs?service=web&tail=50&since=600", { headers: auth }))
    .json();
  assertEquals(logs.lines.map((l: LogLine) => l.text), ["web-new started", "ERROR: web-new broke"]);
  assert(
    paths.some((p) =>
      /^\/containers\/web-new\/logs\?stdout=1&stderr=1&timestamps=1&tail=50&since=\d+$/.test(p)
    ),
  );
  assertEquals((await call("/v1/exec", { headers: auth })).status, 404);
  // The only inspect it ever reads is its own (for its project label); it never forwards one.
  assertEquals(paths.filter((p) => /\/json$/.test(p)), ["/containers/self123/json"]);
  assert(!JSON.stringify(services).includes("never"));
  const locked = relayHandler({ token: null, engine: get, self: "self123" });
  assertEquals(
    (await locked(new Request("http://relay/v1/services", { headers: auth }))).status,
    503,
  );
});

Deno.test("relay over HTTP, read by the dashboard's relay source", async () => {
  const { get } = fakeEngine();
  const token = await relayToken(PASSWORD);
  const controller = new AbortController();
  const relay = startLogsRelay({
    port: 0,
    token,
    engine: get,
    self: "self123",
    signal: controller.signal,
  });
  try {
    const source = relaySource(`http://127.0.0.1:${relay.port}/`, token);
    assertEquals(await source.services(), ["db", "migrate", "web"]);
    assertEquals((await source.health()).map((s) => [s.name, s.ok]), [
      ["db", false],
      ["migrate", true],
      ["web", true],
    ]);
    const lines = await source.read({ service: "", tail: 3 });
    assertEquals(lines.map((l) => `${l.service}: ${l.text}`), [
      "db: ERROR: db-1 broke",
      "migrate: ERROR: mig-1 broke",
      "web: ERROR: web-new broke",
    ], "the newest three, oldest first");
    let refused = "";
    try {
      await relaySource(`http://127.0.0.1:${relay.port}`, "wrong").services();
    } catch (error) {
      refused = (error as Error).message;
    }
    assertStringIncludes(refused, "401");
  } finally {
    controller.abort();
    await relay.finished;
  }
});

Deno.test("compose source: argv only — services, then each service's logs, merged by time", async () => {
  const calls: string[][] = [];
  const runner: DockerRunner = (args) => {
    calls.push(args);
    if (args.includes("config")) {
      return Promise.resolve({ code: 0, stdout: "web\ndb\n", stderr: "" });
    }
    const service = args.at(-1);
    const t = service === "db" ? "09:00:02" : "09:00:01";
    return Promise.resolve({ code: 0, stdout: `2026-10-14T${t}Z ${service} line\n`, stderr: "" });
  };
  const previous = setDockerRunner(runner);
  try {
    const source = composeSource("/project", "docker-compose.yml");
    const lines = await source.read({ service: "", tail: 100, sinceSeconds: 3600 });
    assertEquals(lines.map((l) => l.text), ["web line", "db line"]);
    assertEquals(calls[0], ["compose", "-f", "docker-compose.yml", "config", "--services"]);
    assertEquals(calls[1], [
      "compose",
      "-f",
      "docker-compose.yml",
      "logs",
      "--no-color",
      "--timestamps",
      "--no-log-prefix",
      "--tail=100",
      "--since=60m",
      "db",
    ]);
  } finally {
    setDockerRunner(previous);
  }
});

Deno.test("redaction: connection passwords and every secret-looking variable, before the search", () => {
  const secrets = secretValues(
    { DASHBOARD_PASSWORD: PASSWORD, DENEXT_SECRET_KEY: "sb_secret_abcdef", HOME: "/home/someone" },
    { DENEXT_PUBLISHABLE_KEY: "sb_publishable_1,sb_publishable_2", SHORT_TOKEN: "abc" },
  );
  assert(secrets.includes(PASSWORD) && secrets.includes("sb_secret_abcdef"));
  assert(secrets.includes("sb_publishable_1") && secrets.includes("sb_publishable_2"));
  assert(!secrets.includes("/home/someone") && !secrets.includes("abc"));
  assertEquals(
    redact(`connect postgres://app:hunter2@db/x with ${PASSWORD}`, secrets),
    "connect postgres://app:•••@db/x with •••",
  );
  const lines: LogLine[] = [
    { service: "web", text: `debug: key=sb_secret_abcdef` },
    { service: "web", text: `info: hello` },
    { service: "db", text: `ERROR: password ${PASSWORD} rejected` },
  ];
  assertEquals(filterLines(lines, { level: "debug", text: "sb_secret" }, secrets), [], "no oracle");
  assertEquals(
    filterLines(lines, { level: "warn", text: "" }, secrets).map((l) => l.text),
    ["ERROR: password ••• rejected"],
  );
  assertEquals(filterLines(lines, { level: "debug", text: "HELLO" }, secrets).length, 1);
});

/** A UI on a project with a compose file and a `.env` holding a secret. */
async function withLogs(fn: (h: Harness) => Promise<void>, compose = true): Promise<void> {
  const files: Record<string, string> = {
    ".env":
      `DATABASE_URL=postgres://app:pw@127.0.0.1:5432/app\nDENEXT_SECRET_KEY=sb_secret_from_env\n`,
  };
  if (compose) files["docker-compose.yml"] = "services:\n  web:\n    image: x\n";
  const previous = setDockerRunner((args) => {
    if (args.includes("config")) return Promise.resolve({ code: 0, stdout: "web\n", stderr: "" });
    return Promise.resolve({
      code: 0,
      stdout: "2026-10-14T09:00:00Z info: <b>key sb_secret_from_env</b>\n" +
        "2026-10-14T09:00:01Z ERROR: db postgres://app:pw@db/x down\n",
      stderr: "",
    });
  });
  const h = await uiOn(files, {}, "denext_ui_logs_");
  try {
    await fn(h);
  } finally {
    setDockerRunner(previous);
    await stopUi(h);
  }
}

Deno.test("Logs page: fixed choices, lines redacted and escaped, the level filter, the JSON twin", async () => {
  await withLogs(async (h) => {
    const page = await (await fetch(`${h.base}/database/logs`, { headers: h.headers })).text();
    assertStringIncludes(page, '<select name="service" aria-label="Service">');
    assertStringIncludes(page, '<option value="web">web</option>');
    assertStringIncludes(page, '<select name="level" aria-label="Level">');
    assertStringIncludes(page, "info: &lt;b&gt;key •••&lt;/b&gt;");
    assertStringIncludes(page, "postgres://app:•••@db/x");
    assert(!page.includes("sb_secret_from_env"), "a secret from .env is never shown");
    const errors = await (await fetch(`${h.base}/database/logs?level=error&since=bogus`, {
      headers: h.headers,
    })).text();
    assert(!errors.includes("info: "));
    assertStringIncludes(
      errors,
      '<option value="3600" selected="">',
      "an unknown window falls back",
    );
    const api = await (await fetch(`${h.base}/api/database/logs?q=down`, { headers: h.headers }))
      .json();
    assertEquals(api.lines.map((l: LogLine) => l.text), ["ERROR: db postgres://app:•••@db/x down"]);
  });
});

Deno.test("Logs page: no compose file and no relay says so", async () => {
  await withLogs(async (h) => {
    const page = await (await fetch(`${h.base}/database/logs`, { headers: h.headers })).text();
    assertStringIncludes(page, "No log source");
    const api = await fetch(`${h.base}/api/database/logs`, { headers: h.headers });
    assertEquals(api.status, 404);
    await api.body?.cancel();
  }, false);
});

Deno.test("the real docker runner: a machine without docker gets the hint, not a spawn error", async () => {
  // `Command.output()` throws a missing binary synchronously; a child with an empty PATH has no
  // docker on any OS.
  const empty = await Deno.makeTempDir({ prefix: "dnx-no-docker-" });
  try {
    const source = new URL("../src/ui/logs/source.ts", import.meta.url).href;
    const code = `const { setDockerRunner } = await import(${JSON.stringify(source)});
const real = setDockerRunner(() => Promise.reject(new Error("unused")));
try { await real(["--version"], ".", undefined); console.log("ran"); }
catch (error) { console.log(error.message); }`;
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["eval", "--no-check", code],
      env: { PATH: empty, Path: empty },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    assertStringIncludes(text, "docker is not on PATH");
  } finally {
    await Deno.remove(empty, { recursive: true });
  }
});
