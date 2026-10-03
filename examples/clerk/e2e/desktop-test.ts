// The desktop leg of the Clerk e2e: the app in a real Deno Desktop window (packaged with
// `denext desktop package` on denext's pinned runtime, launched directly as the kitchen sink's
// window test does), signing in through `@clerk/nextjs`'s `<ClerkProvider>` switched to
// native mode by the bridge the preload installs, against a real Clerk development instance.
//
//   1. build + start the web server (the protected API the window's /api/* is proxied to);
//   2. create a `+clerk_test` user and a testing token through the Backend API;
//   3. launch 1 ("sign-in"): the page signs in with the code 424242, calls /api/me with the
//      session token, and reports (the e2e extension, enabled only by DENEXT_CLERK_E2E=1);
//   4. launch 2 ("relaunch"): clerk-js restores the session from the client JWT the keychain kept,
//      calls /api/me again, signs out, and reports;
//   5. delete the user.
//
//   deno task test:desktop        # from examples/clerk (needs the keys, a logged-in macOS session
//                                 # or a display; Linux: xvfb-run -a deno task test:desktop)
//
// Without keys it prints why and exits 0. It never prints a key.

import { join } from "@std/path";
import { desktopAppDirs } from "../../../src/desktop/app-dirs.ts";
import { clerkTestKeys } from "../../../tests/e2e/clerk-keys.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLI = new URL("../../../cli.ts", import.meta.url).pathname;
const APP_ID = "dev.denext.clerk-example";
const BAPI = "https://api.clerk.com/v1";
const PHASE_TIMEOUT_MS = Number(Deno.env.get("CLERK_DESKTOP_TIMEOUT_MS") ?? 300_000);

const keys = await clerkTestKeys(ROOT);
if (!keys) {
  console.log(
    "desktop e2e SKIPPED: set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY (or " +
      "CLERK_TEST_*), or put them in examples/clerk/.env.local.",
  );
  Deno.exit(0);
}

/** A free loopback port. */
function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

const port = freePort();
const childEnv = {
  DENEXT_APP_NAME: "ClerkExample",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: keys.publishableKey,
  CLERK_SECRET_KEY: keys.secretKey,
  DENEXT_CLERK_E2E: "1",
  DENEXT_CLERK_API_ORIGIN: `http://127.0.0.1:${port}`,
};

/** Run the CLI in the example; fail with its output (keys redacted) on a non-zero exit. */
async function cli(args: string[]): Promise<void> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--node-modules-dir=none", CLI, ...args],
    cwd: ROOT,
    env: childEnv,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    throw new Error(
      `denext ${args.join(" ")} failed:\n${text.replaceAll(keys!.secretKey, "sk_***")}`,
    );
  }
}

/** A Backend API call that must succeed. */
async function bapi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BAPI + path, {
    method,
    headers: {
      authorization: `Bearer ${keys!.secretKey}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Clerk ${method} ${path}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Create the test user (email + whatever else the instance requires). */
async function createUser(tag: string, email: string): Promise<string> {
  const body: Record<string, unknown> = { email_address: [email], skip_password_requirement: true };
  for (let i = 0; i < 3; i++) {
    const res = await fetch(BAPI + "/users", {
      method: "POST",
      headers: { authorization: `Bearer ${keys!.secretKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (res.ok) return json.id;
    const missing: string[] = (json.errors ?? []).flatMap((
      e: { meta?: { param_names?: string[] } },
    ) => e.meta?.param_names ?? []);
    if (missing.includes("username") && !body.username) body.username = `denext_desk_${tag}`;
    else if (missing.includes("password") && !body.password) {
      body.password = `Dnx-${crypto.randomUUID()}`;
      body.skip_password_checks = true;
    } else throw new Error(`Clerk POST /users: ${res.status} ${JSON.stringify(json)}`);
  }
  throw new Error("Clerk POST /users: the instance keeps asking for more fields");
}

/** The packaged app's name (DENEXT_APP_NAME: a predictable dist/ path without spaces). */
const APP_NAME = "ClerkExample";

/** The packaged executable `denext desktop package` wrote into dist/ (as the kitchen sink finds it). */
async function packagedExecutable(): Promise<string> {
  const dist = join(ROOT, "dist");
  if (Deno.build.os === "darwin") {
    const app = join(dist, `${APP_NAME}.app`);
    const plist = await Deno.readTextFile(join(app, "Contents", "Info.plist"));
    const exe = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
    if (!exe) throw new Error(`no CFBundleExecutable in ${app}`);
    return join(app, "Contents", "MacOS", exe);
  }
  const arch = Deno.build.arch === "aarch64" ? "arm64" : "x64";
  const dir = join(dist, `${APP_NAME}-${arch}`);
  if (Deno.build.os === "windows") return join(dir, `${APP_NAME}-${arch}.exe`);
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile || /\.so(\.|$)/.test(e.name)) continue;
    if (((await Deno.stat(join(dir, e.name))).mode ?? 0) & 0o111) return join(dir, e.name);
  }
  throw new Error(`no executable in ${dir}`);
}

/** Launch the window for one phase and wait for the page's report. */
async function phase(name: "sign-in" | "relaunch", plan: object): Promise<Record<string, unknown>> {
  const dir = desktopAppDirs(APP_ID).data;
  await Deno.mkdir(dir, { recursive: true });
  const report = join(dir, `clerk-e2e-report-${name.replace(/\W/g, "")}.json`);
  await Deno.remove(report).catch(() => {});
  await Deno.remove(join(dir, "clerk-e2e.log")).catch(() => {});
  await Deno.writeTextFile(
    join(dir, "clerk-e2e-plan.json"),
    JSON.stringify({ phase: name, ...plan }),
  );
  const child = new Deno.Command(await packagedExecutable(), {
    cwd: ROOT,
    env: childEnv,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  // The window's output (the runtime, the page's console), kept for a failed run.
  await Deno.mkdir(join(ROOT, "e2e", ".run"), { recursive: true });
  const log = await Deno.open(join(ROOT, "e2e", ".run", `desktop-${name}.log`), {
    write: true,
    create: true,
    truncate: true,
  });
  const writer = log.writable.getWriter();
  const pump = (s: ReadableStream<Uint8Array>) =>
    s.pipeTo(new WritableStream({ write: (c) => writer.write(c) })).catch(() => {});
  void Promise.all([pump(child.stdout), pump(child.stderr)]).finally(() =>
    writer.close().catch(() => {})
  );
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      try {
        return JSON.parse(await Deno.readTextFile(report));
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const progress = await Deno.readTextFile(join(dir, "clerk-e2e.log")).catch(() => "(none)");
    throw new Error(`${name}: no report within ${PHASE_TIMEOUT_MS} ms; page log:\n${progress}`);
  } finally {
    // The page quits the app after reporting; make sure it is gone before the next launch.
    const exited = await Promise.race([
      child.status.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 20_000)),
    ]);
    if (!exited) {
      try {
        child.kill("SIGTERM");
      } catch { /* gone */ }
      await child.status;
    }
    await Deno.remove(join(dir, "clerk-e2e-plan.json")).catch(() => {});
  }
}

/** Throw unless `cond`. */
function check(cond: unknown, what: string, detail?: unknown): void {
  if (!cond) {
    throw new Error(
      `desktop e2e: ${what}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
    );
  }
  console.log(`  ok  ${what}`);
}

// The window's page origin must be on the instance's allowed origins: in native mode clerk-js
// sends the client JWT as `Authorization`, the WebView adds `Origin`, and the Frontend API
// refuses a request with both from an origin it does not allow ("Setting both the 'Origin' and
// 'Authorization' headers is forbidden"). README → Clerk dashboard, step 3.
const ORIGIN = "denextclerk://app";
const instance = await bapi<{ allowed_origins?: string[] | null }>("GET", "/instance");
if (!(instance.allowed_origins ?? []).includes(ORIGIN)) {
  console.log(
    `desktop e2e SKIPPED: the Clerk instance does not allow the origin ${ORIGIN} yet ` +
      "(README → Clerk dashboard, step 3: PATCH /v1/instance allowed_origins).",
  );
  Deno.exit(0);
}

let userId: string | undefined;
let server: Deno.ChildProcess | undefined;
try {
  console.log("desktop e2e: build + start the API server, package the app …");
  // The packaging scripts embed the e2e extension (DENEXT_CLERK_E2E=1 lists it) and bake the
  // least-privilege flags; the runner then launches the bundle's executable directly. Package
  // first: its export rewrites .denext/, which the production build below must own.
  await cli(["desktop", "package", "--regenerate-scripts", "."]);
  await cli(["desktop", "package", "."]);
  await cli(["build", "."]);
  server = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--node-modules-dir=none",
      CLI,
      "start",
      ".",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    cwd: ROOT,
    env: childEnv,
    stdout: "null",
    stderr: "null",
  }).spawn();
  let up = false;
  for (let i = 0; i < 180 && !up; i++) {
    try {
      const res = await fetch(`${childEnv.DENEXT_CLERK_API_ORIGIN}/api/me`);
      await res.body?.cancel();
      up = res.status === 401; // the protected API answers, signed out
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  check(up, "the API server answers /api/me (401 signed out)");
  const tag = crypto.randomUUID().slice(0, 8);
  const email = `denext-desktop-${tag}+clerk_test@example.com`;
  userId = await createUser(tag, email);
  const { token: testingToken } = await bapi<{ token: string }>("POST", "/testing_tokens");

  console.log("desktop e2e: launch 1 — sign in with the email code …");
  const first = await phase("sign-in", { email, testingToken });
  if (first.error) throw new Error(`sign-in: ${first.error}`);
  check(first.origin === ORIGIN, "the page runs at the stable custom origin");
  check(first.userId === userId, "clerk-js signed in as the test user (native mode)");
  check(first.savedClientJwt === true, "the client JWT is in the keychain token cache");
  const api1 = first.api as { status: number; body: string };
  check(
    api1.status === 200 && JSON.parse(api1.body).userId === userId,
    "/api/me verified the bearer",
    api1,
  );

  console.log("desktop e2e: launch 2 — the session survives a relaunch …");
  const second = await phase("relaunch", { email, testingToken });
  if (second.error) throw new Error(`relaunch: ${second.error}`);
  check(second.userId === userId, "the relaunched app is still signed in");
  const api2 = second.api as { status: number; body: string };
  check(
    api2.status === 200 && JSON.parse(api2.body).userId === userId,
    "/api/me after relaunch",
    api2,
  );
  check(second.signedOut === true, "sign-out");
  console.log("desktop e2e: passed");
} finally {
  if (userId) await bapi("DELETE", `/users/${userId}`).catch(() => {});
  if (server) {
    try {
      server.kill("SIGTERM");
    } catch { /* gone */ }
    await server.status;
  }
}
