// `denext profile --android` end to end against a recorded device session
// (tests/fixtures/profile-android/session.json): a fake adb answers with the recorded output, a
// local server stands in for the forwarded DevTools socket (`/json/list` + the page's WebSocket)
// and replays the recorded CDP transcript, asserting every command arrives in the recorded order
// with the recorded params. The profile, heap and leak results then come out of the same pipeline
// a local run uses. No device is needed; a real one is still the final check.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type AdbRunner,
  adbRunner,
  CdpConnection,
  devtoolsSockets,
  type DevtoolsTarget,
  pickPage,
  profileAndroid,
  remotePage,
} from "../src/profile/android.ts";
import { profileReportLines } from "../src/profile/report.ts";
import { capacitorAppId } from "../src/cli/commands/profile.ts";

interface Step {
  method: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
  events?: Array<{ method: string; params: unknown }>;
}

interface Fixture {
  adb: { devices: string; procNetUnix: string; pidof: Record<string, string> };
  targets: DevtoolsTarget[];
  interact: string;
  sessions: Record<string, Step[]>;
}

const FIXTURE = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/profile-android/session.json", import.meta.url)),
) as Fixture;

/** The frames answering `msg` from its recorded `step`; a mismatch is noted in `problems`. */
function replay(
  step: Step | undefined,
  n: number,
  msg: { id: number; method: string; params?: unknown },
  problems: string[],
): unknown[] {
  if (step?.method !== msg.method) {
    problems.push(`#${n}: got ${msg.method}, recorded ${step?.method ?? "(end)"}`);
    return [{ id: msg.id, error: { code: -32601, message: "unexpected" } }];
  }
  if (step.params && JSON.stringify(step.params) !== JSON.stringify(msg.params)) {
    problems.push(`#${n} ${msg.method}: params ${JSON.stringify(msg.params)}`);
  }
  const answer = step.error
    ? { id: msg.id, error: step.error }
    : { id: msg.id, result: step.result };
  return [answer, ...(step.events ?? [])];
}

/** A stand-in for the forwarded DevTools port that replays one recorded CDP session. */
function fakeDevtools(steps: Step[], targets = FIXTURE.targets) {
  let at = 0;
  const problems: string[] = [];
  let closed!: () => void;
  const socketClosed = new Promise<void>((r) => (closed = r));
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/json/list") return Response.json(targets);
    if (!url.pathname.startsWith("/devtools/page/")) return new Response("no", { status: 404 });
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onclose = () => closed();
    socket.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as { id: number; method: string; params?: unknown };
      for (const frame of replay(steps[at++], at, msg, problems)) {
        socket.send(JSON.stringify(frame));
      }
    };
    return response;
  });
  return {
    port: server.addr.port,
    problems,
    remaining: () => steps.length - at,
    socketClosed,
    close: () => server.shutdown(),
  };
}

/** A fake adb answering with the recorded output; `forward tcp:0` names the fake port. */
function fakeAdb(port: number, overrides: Partial<Fixture["adb"]> = {}) {
  const adb = { ...FIXTURE.adb, ...overrides };
  const calls: string[] = [];
  const ok = (stdout: string) => ({ code: 0, stdout });
  const answers: Record<string, (a: readonly string[]) => { code: number; stdout: string }> = {
    "devices": () => ok(adb.devices),
    "shell cat": () => ok(adb.procNetUnix),
    "shell pidof": (a) => adb.pidof[a[2]] ? ok(adb.pidof[a[2]]) : { code: 1, stdout: "" },
    "forward tcp:0": () => ok(`${port}\n`),
    "forward --remove": () => ok(""),
  };
  const run: AdbRunner = (args) => {
    calls.push(args.join(" "));
    const a = args[0] === "-s" ? args.slice(2) : args;
    const answer = answers[a.slice(0, 2).join(" ")] ?? answers[a[0]];
    return Promise.resolve(
      answer?.(a) ?? { code: 1, stdout: "", stderr: `unknown: ${args.join(" ")}` },
    );
  };
  return { run, calls };
}

Deno.test("profileAndroid: a recorded startup session through the whole pipeline", async () => {
  const devtools = fakeDevtools(FIXTURE.sessions.startup);
  const adb = fakeAdb(devtools.port);
  try {
    const result = await profileAndroid(
      { route: "/settings", package: "dev.example.app", timeoutMs: 5_000 },
      { run: adb.run },
    );
    await devtools.socketClosed;
    assertEquals(devtools.problems, []);
    assertEquals(devtools.remaining(), 0);
    assertEquals(result.origin, "https://localhost");
    assertEquals(result.route, "/settings");
    assertEquals(result.device, {
      serial: "R58N12ABCDE",
      socket: "webview_devtools_remote_12345",
      package: "dev.example.app",
    });
    // 12 samples of 1 ms: renderSettings 6, commitRoot 2, (program) 3, GC 1.
    assertEquals(result.cpu.sampleCount, 12);
    assertEquals(result.cpu.topSelfTime[0].name, "renderSettings");
    assertEquals(result.cpu.topSelfTime[0].line, 1204);
    assertEquals(result.heap, {
      beforeBytes: 3145728,
      afterBytes: 6291456,
      afterGcBytes: 5242880,
      leaked: false, // startup mode never calls a leak
    });
    assertEquals(adb.calls, [
      "devices",
      "-s R58N12ABCDE shell cat /proc/net/unix",
      "-s R58N12ABCDE shell pidof dev.example.app",
      "-s R58N12ABCDE forward tcp:0 localabstract:webview_devtools_remote_12345",
      `-s R58N12ABCDE forward --remove tcp:${devtools.port}`,
    ]);
    const header = profileReportLines(result)[0];
    assertStringIncludes(header, "Android R58N12ABCDE dev.example.app, the installed build");
  } finally {
    await devtools.close();
  }
});

Deno.test("profileAndroid: a recorded interaction session reports the warm baseline", async () => {
  const devtools = fakeDevtools(FIXTURE.sessions.interaction);
  const adb = fakeAdb(devtools.port);
  try {
    const result = await profileAndroid(
      {
        route: "/settings",
        package: "dev.example.app",
        interact: FIXTURE.interact,
        iterations: 2,
        budget: { maxHeapGrowthBytes: 1_000_000 },
        filter: "settings",
        timeoutMs: 5_000,
      },
      { run: adb.run },
    );
    await devtools.socketClosed;
    assertEquals(devtools.problems, []);
    assertEquals(devtools.remaining(), 0);
    assertEquals(result.heap.warmBytes, 5767168);
    assertEquals(result.heap.leaked, false); // 64 KB over the warm heap
    assertEquals(result.cpu.topSelfTime.map((f) => f.name), ["toggleSettings"]);
    assertEquals(result.budget?.passed, false); // 2 MB peak growth > 1 MB
  } finally {
    await devtools.close();
  }
});

Deno.test("profileAndroid: the only debuggable WebView needs no package", async () => {
  const devtools = fakeDevtools(FIXTURE.sessions.startup);
  const procNetUnix = FIXTURE.adb.procNetUnix.split("\n").filter((l) => !l.includes("20811"))
    .join("\n");
  const adb = fakeAdb(devtools.port, { procNetUnix });
  try {
    const result = await profileAndroid({ route: "/settings", timeoutMs: 5_000 }, {
      run: adb.run,
    });
    await devtools.socketClosed;
    assertEquals(result.device, { serial: "R58N12ABCDE", socket: "webview_devtools_remote_12345" });
  } finally {
    await devtools.close();
  }
});

Deno.test("profileAndroid: device and WebView selection errors say what to do", async () => {
  const run = (o: Partial<Fixture["adb"]>, opts = {}) =>
    profileAndroid({ timeoutMs: 1_000, ...opts }, { run: fakeAdb(1, o).run });
  await assertRejects(
    () => run({ devices: "List of devices attached\nX1\tunauthorized\n" }),
    Error,
    'X1 unauthorized: accept the "Allow USB debugging" prompt',
  );
  await assertRejects(() => run({ devices: "List of devices attached\n" }), Error, "no device");
  await assertRejects(
    () => run({ devices: "List of devices attached\nA\tdevice\nB\tdevice\n" }),
    Error,
    "--device <serial>",
  );
  await assertRejects(() => run({}, { serial: "nope" }), Error, "device nope is not attached");
  await assertRejects(() => run({}), Error, "2 debuggable WebViews");
  await assertRejects(() => run({}, { package: "other.app" }), Error, "is not running");
  await assertRejects(
    () => run({ pidof: { "dev.example.app": "999\n" } }, { package: "dev.example.app" }),
    Error,
    "has no debuggable WebView",
  );
  await assertRejects(() => run({ procNetUnix: "" }), Error, "no debuggable WebView is running");
});

Deno.test("profileAndroid: a failed adb forward names the command", async () => {
  const base = fakeAdb(1);
  const run: AdbRunner = (args) =>
    args.includes("forward")
      ? Promise.resolve({ code: 1, stdout: "", stderr: "error: cannot bind" })
      : base.run(args);
  await assertRejects(
    () => profileAndroid({ package: "dev.example.app" }, { run }),
    Error,
    "forward tcp:0 localabstract:webview_devtools_remote_12345` failed: error: cannot bind",
  );
  const junk: AdbRunner = (args) =>
    args.includes("forward") ? Promise.resolve({ code: 0, stdout: "?" }) : base.run(args);
  await assertRejects(
    () => profileAndroid({ package: "dev.example.app" }, { run: junk }),
    Error,
    "did not print a port",
  );
});

Deno.test("profileAndroid: a page already held by DevTools is refused and the forward removed", async () => {
  const targets = FIXTURE.targets.map(({ webSocketDebuggerUrl: _, ...t }) => t);
  const devtools = fakeDevtools([], targets);
  const adb = fakeAdb(devtools.port);
  try {
    await assertRejects(
      () => profileAndroid({ package: "dev.example.app" }, { run: adb.run }),
      Error,
      "another DevTools client is attached",
    );
    assert(adb.calls.at(-1)?.includes("forward --remove"));
  } finally {
    await devtools.close();
  }
});

Deno.test("devtoolsSockets: the abstract DevTools sockets, deduplicated", () => {
  assertEquals(devtoolsSockets(FIXTURE.adb.procNetUnix), [
    "webview_devtools_remote_12345",
    "chrome_devtools_remote",
    "webview_devtools_remote_20811",
  ]);
});

Deno.test("pickPage: the attached, visible page; errors without one", () => {
  assertEquals(pickPage(FIXTURE.targets).url, "https://localhost/");
  const blank = FIXTURE.targets[0];
  assertEquals(pickPage([{ ...blank, description: "not json" }]).id, blank.id);
  assertThrows(() => pickPage([FIXTURE.targets[2]]), Error, "lists no page");
});

Deno.test("CdpConnection: CDP errors, script exceptions and timeouts reject", async () => {
  const devtools = fakeDevtools([
    { method: "Page.navigate", result: { frameId: "F", errorText: "net::ERR_NAME_NOT_RESOLVED" } },
    {
      method: "Runtime.evaluate",
      result: {
        result: { type: "object", subtype: "error" },
        exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom" } },
      },
    },
    { method: "Profiler.start", error: { code: -32000, message: "Profiler is not enabled" } },
    { method: "Runtime.getHeapUsage", result: {} },
  ]);
  const conn = await CdpConnection.open(
    `ws://127.0.0.1:${devtools.port}/devtools/page/X`,
    200,
  );
  try {
    const { page, cdp } = remotePage(conn);
    await assertRejects(() => page.goto("https://x.invalid/"), Error, "ERR_NAME_NOT_RESOLVED");
    await assertRejects(() => page.evaluate("boom()"), Error, "TypeError: boom");
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => (cdp.Profiler as any).start(),
      Error,
      "Profiler is not enabled",
    );
    assertEquals(await page.heapBytes(), 0);
    await assertRejects(() => conn.once("Page.loadEventFired"), Error, "no Page.loadEventFired");
  } finally {
    conn.close();
    await devtools.socketClosed;
    await devtools.close();
  }
  await assertRejects(
    () => CdpConnection.open(`ws://127.0.0.1:${devtools.port}/devtools/page/X`),
    Error,
    "could not connect",
  );
});

Deno.test("capacitorAppId: the Capacitor config's appId is the default package", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await capacitorAppId(dir), undefined);
    await Deno.writeTextFile(
      `${dir}/capacitor.config.json`,
      JSON.stringify({ appId: "dev.example.app", appName: "Example", webDir: "out" }),
    );
    assertEquals(await capacitorAppId(dir), "dev.example.app");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("adbRunner: runs the binary; a missing one says how to get adb", async () => {
  const out = await adbRunner(Deno.execPath())(["--version"]);
  assertEquals(out.code, 0);
  assertStringIncludes(out.stdout, "deno");
  await assertRejects(
    () => adbRunner("/nonexistent/denext-adb")(["devices"]),
    Error,
    "platform-tools",
  );
});
