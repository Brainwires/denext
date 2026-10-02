// Deno Desktop custom-scheme sign-in through the OS's own auth session (`Deno.desktop.authSession`,
// macOS `ASWebAuthenticationSession` under runtime 2.9.7-denext.6+), runtime side, with a fake
// `authSession`: the sheet replaces the system browser where the OS has one, `ephemeral` reaches
// it, its callback is still held to the exact redirect + state, its `cancelled` / `busy` / `invalid`
// / `failed` map to the bridge's codes, `not_supported` (Windows, Linux) falls back to the system
// browser + deep-link callback, the owner check guards only that browser path (the sheet catches
// its own scheme whoever handles its links), and a page cancel or the timeout
// while the sheet is up settles the session and drops the sheet's late answer.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createSchemeAuthSessions } from "../src/desktop/scheme-auth-session.ts";
import type { DesktopAppApi, DesktopAuthSessionApi } from "../src/desktop/launch-events.ts";
import { DesktopCapError } from "../src/desktop/extension.ts";

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const AUTH_URL = "https://auth.example.com/authorize?client_id=app&redirect_uri=" +
  encodeURIComponent("myapp://auth/cb") +
  `&response_type=code&state=st-1&code_challenge=${CHALLENGE}&code_challenge_method=S256`;

const ctx = {
  emit: () => {},
  appSupportDir: "",
  os: "darwin" as const,
  signal: new AbortController().signal,
  runOnMainThread: () => Promise.reject(new Error("no UI thread in tests")),
};

/** A controllable fake OS session: each `start` waits until the test settles it. */
function osSession(caps: ReturnType<DesktopAuthSessionApi["capabilities"]> = {
  supported: true,
  ephemeral: true,
}) {
  const starts: Parameters<DesktopAuthSessionApi["start"]>[0][] = [];
  let settle: { resolve(v: { url: string }): void; reject(e: unknown): void } | undefined;
  const api: DesktopAuthSessionApi = {
    capabilities: () => caps,
    start: (options) => {
      starts.push(options);
      return new Promise((resolve, reject) => (settle = { resolve, reject }));
    },
  };
  return {
    api,
    starts,
    resolve: (url: string) => settle!.resolve({ url }),
    reject: (code: string) => {
      const err = new Error(`authSession: ${code}`) as Error & { code: string };
      err.name = "AuthSessionError";
      err.code = code;
      settle!.reject(err);
    },
  };
}

/** The starting page's session key. */
const KEY = "page-key-0123456789abcdef";

/** The sessions over an app API whose scheme is ours, with `authSession` and a browser log. */
function sessions(authSession?: DesktopAuthSessionApi, owner: "self" | "other" = "self") {
  const opened: string[] = [];
  const api: DesktopAppApi = {
    getSchemeOwner: () =>
      Promise.resolve({ owner, ...(owner === "other" ? { handler: "com.other" } : {}) }),
    ...(authSession ? { authSession } : {}),
  };
  const s = createSchemeAuthSessions({
    schemes: ["myapp"],
    api,
    openBrowser: (url) => void opened.push(url),
  });
  const start = (args: Record<string, unknown> = {}) =>
    s.capability.methods.start.handler(
      { callbackScheme: "myapp", url: AUTH_URL, session: KEY, ...args },
      ctx,
    ) as Promise<{ url: string }>;
  const cancel = () =>
    s.capability.methods.cancel.handler({ session: KEY }, ctx) as { cancelled: boolean };
  const capabilities = () =>
    s.capability.methods.capabilities.handler({}, ctx) as Promise<
      { osSession: boolean; ephemeral: boolean }
    >;
  return { s, start, cancel, capabilities, opened };
}

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

/** Wait until the fake OS session was started. */
async function started(starts: unknown[], n = 1): Promise<void> {
  for (let i = 0; i < 50 && starts.length < n; i++) await tick();
  assertEquals(starts.length, n, "the OS session was not started");
}

async function rejectsCode(p: Promise<unknown>, code: string): Promise<DesktopCapError> {
  const err = await assertRejects(() => p, DesktopCapError);
  assertEquals(err.code, code);
  return err;
}

Deno.test("OS auth session: the sheet replaces the browser and its callback resolves", async () => {
  const os = osSession();
  const { start, opened } = sessions(os.api);
  const run = start();
  await started(os.starts);
  assertEquals(os.starts[0], { url: AUTH_URL, callbackScheme: "myapp" });
  os.resolve("myapp://auth/cb?code=abc&state=st-1");
  assertEquals(await run, { url: "myapp://auth/cb?code=abc&state=st-1" });
  assertEquals(opened, []); // no system browser
});

Deno.test("OS auth session: ephemeral reaches the sheet; a non-boolean is invalid", async () => {
  const os = osSession();
  const { start } = sessions(os.api);
  const run = start({ ephemeral: true });
  await started(os.starts);
  assertEquals(os.starts[0].ephemeral, true);
  os.resolve("myapp://auth/cb?state=st-1&code=1");
  await run;
  await rejectsCode(start({ ephemeral: "yes" }), "invalid");
});

Deno.test("OS auth session: a callback off the redirect or with another state is refused", async () => {
  for (
    const bad of [
      "myapp://auth/cb?code=abc&state=forged",
      "myapp://auth/cb?code=abc",
      "myapp://other/cb?code=abc&state=st-1",
    ]
  ) {
    const os = osSession();
    const { start, s } = sessions(os.api);
    const run = start();
    await started(os.starts);
    os.resolve(bad);
    await rejectsCode(run, "invalid");
    assertEquals(s.claim("myapp://auth/cb?code=late&state=st-1"), false); // the session is over
  }
});

Deno.test("OS auth session: the sheet's errors map to the bridge's codes", async () => {
  const cases: Array<[string, string]> = [
    ["cancelled", "cancelled"],
    ["busy", "session_in_progress"],
    ["invalid", "invalid"],
    ["failed", "unsupported"],
  ];
  for (const [osCode, code] of cases) {
    const os = osSession();
    const { start, opened } = sessions(os.api);
    const run = start();
    await started(os.starts);
    os.reject(osCode);
    await rejectsCode(run, code);
    assertEquals(opened, [], `${osCode}: no browser fallback`);
  }
});

Deno.test("OS auth session: not_supported falls back to the browser + deep-link callback", async () => {
  const os = osSession();
  const { start, s, opened } = sessions(os.api);
  const run = start();
  await started(os.starts);
  os.reject("not_supported");
  for (let i = 0; i < 50 && opened.length === 0; i++) await tick();
  assertEquals(opened, [AUTH_URL]);
  // The deep-link rules hold: a forged state is swallowed, the real callback resolves.
  assert(s.claim("myapp://auth/cb?code=forged&state=nope"));
  assert(s.claim("myapp://auth/cb?code=real&state=st-1"));
  assertEquals(await run, { url: "myapp://auth/cb?code=real&state=st-1" });
});

Deno.test("OS auth session: no OS session (Windows, Linux, older runtimes) → the browser", async () => {
  const throwing: DesktopAuthSessionApi = {
    capabilities: () => {
      throw new Error("boom");
    },
    start: () => Promise.reject(new Error("must not start")),
  };
  const unsupported = osSession({ supported: false, ephemeral: false });
  for (const api of [undefined, unsupported.api, throwing]) {
    const { start, s, opened, capabilities } = sessions(api);
    assertEquals(await capabilities(), { osSession: false, ephemeral: false });
    const run = start();
    for (let i = 0; i < 50 && opened.length === 0; i++) await tick();
    assertEquals(opened, [AUTH_URL]);
    s.claim("myapp://auth/cb?code=1&state=st-1");
    await run;
  }
  assertEquals(unsupported.starts, []);
});

Deno.test("OS auth session: capabilities reports the sheet and its ephemeral support", async () => {
  assertEquals(await sessions(osSession().api).capabilities(), {
    osSession: true,
    ephemeral: true,
  });
  const noEphemeral = osSession({ supported: true, ephemeral: false });
  assertEquals(await sessions(noEphemeral.api).capabilities(), {
    osSession: true,
    ephemeral: false,
  });
});

Deno.test("OS auth session: the sheet runs even when another app handles the scheme", async () => {
  // The sheet catches its own callback scheme, so who handles the scheme's links does not matter.
  const os = osSession();
  const { start, s, opened } = sessions(os.api, "other");
  const run = start({ osSessionOnly: true });
  await started(os.starts);
  // A deep link (which would go to the other app anyway) never completes it.
  assertEquals(s.claim("myapp://auth/cb?code=evil&state=st-1"), true);
  os.resolve("myapp://auth/cb?code=good&state=st-1");
  assertEquals((await run).url, "myapp://auth/cb?code=good&state=st-1");
  assertEquals(opened, []);
});

Deno.test("OS auth session: not_supported with another app on the scheme → refused, no browser", async () => {
  const os = osSession();
  const { start, opened } = sessions(os.api, "other");
  const run = start();
  await started(os.starts);
  os.reject("not_supported");
  const err = await rejectsCode(run, "scheme_owned_by_other_app");
  assertEquals(err.data, { handler: "com.other" });
  assertEquals(opened, []); // the callback would have gone to the other app
});

Deno.test("OS auth session: no sheet and another app on the scheme → refused before anything opens", async () => {
  const { start, opened } = sessions(undefined, "other");
  await rejectsCode(start(), "scheme_owned_by_other_app");
  assertEquals(opened, []);
});

Deno.test("OS auth session: a page cancel while the sheet is up ends it; its late answer is dropped", async () => {
  const os = osSession();
  const { start, cancel } = sessions(os.api);
  const run = start();
  await started(os.starts);
  assertEquals(cancel(), { cancelled: true });
  await rejectsCode(run, "cancelled");
  // A second session while the first sheet is still up: the OS says busy.
  const second = start();
  await started(os.starts, 2);
  os.reject("busy");
  await rejectsCode(second, "session_in_progress");
});

Deno.test("OS auth session: the timeout settles the session; the sheet's late callback is dropped", async () => {
  const os = osSession();
  const first = sessions(os.api);
  const run = first.start({ timeoutMs: 5 });
  await started(os.starts);
  await rejectsCode(run, "timeout");
  os.resolve("myapp://auth/cb?code=late&state=st-1"); // ignored: nothing is pending
  await tick();
});

Deno.test("OS auth session: a matching deep link during the sheet is swallowed, never resolving", async () => {
  const os = osSession();
  const { s, start } = sessions(os.api);
  const run = start();
  await started(os.starts);
  let settled = false;
  run.then(() => (settled = true), () => (settled = true));
  // The OS delivers the same callback as a deep link (another app sent it): not routed, not used.
  assertEquals(s.claim("myapp://auth/cb?code=evil&state=st-1"), true);
  await tick(5);
  assertEquals(settled, false);
  // Only the sheet completes the session.
  os.resolve("myapp://auth/cb?code=good&state=st-1");
  assertEquals((await run).url, "myapp://auth/cb?code=good&state=st-1");
});

Deno.test("OS auth session: osSessionOnly runs in the sheet; a runtime saying not_supported refuses", async () => {
  const os = osSession();
  const { start, opened } = sessions(os.api);
  const run = start({ osSessionOnly: true });
  await started(os.starts);
  os.reject("not_supported");
  await rejectsCode(run, "unsupported");
  assertEquals(opened, []); // never the system browser
});
