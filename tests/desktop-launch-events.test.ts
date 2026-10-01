// The Deno Desktop launch router (runtime side): cold-start links and files are queued once,
// `openurl` / `openfile` / `secondinstance` feed the same queues, only declared schemes pass, a
// pending auth session takes its callback before anything is queued, every take empties the queue
// (no replay), opened files become READ-ONLY picked handles, and the scheme owner / claim methods
// only touch declared schemes.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createLaunchRouter,
  type DesktopAppApi,
  type LaunchRouter,
} from "../src/desktop/launch-events.ts";
import { PickedPaths } from "../src/desktop/picked-paths.ts";
import { DesktopCapError } from "../src/desktop/extension.ts";

/** A fake `Deno.desktop`: an EventTarget with launch lists and scheme functions. */
function fakeApi(
  over: Partial<DesktopAppApi> = {},
): DesktopAppApi & { fire(t: string, d: unknown): void } {
  const target = new EventTarget();
  return {
    launchUrls: [],
    launchFiles: [],
    addEventListener: (type, fn) => target.addEventListener(type, fn),
    fire: (type, detail) => target.dispatchEvent(new CustomEvent(type, { detail })),
    ...over,
  };
}

/** Call a capability method of the router by name. */
async function call(router: LaunchRouter, cap: string, method: string, args: unknown = {}) {
  const c = router.capabilities.find((x) => x.name === cap)!;
  return await c.methods[method].handler(args, {
    emit: () => {},
    appSupportDir: "",
    os: "darwin",
    signal: new AbortController().signal,
  });
}

function setup(over: Partial<Parameters<typeof createLaunchRouter>[0]> = {}, api = fakeApi()) {
  const emitted: string[] = [];
  const picked = new PickedPaths();
  const router = createLaunchRouter({
    schemes: ["myapp"],
    api,
    picked,
    emit: (cap, event) => emitted.push(`${cap}.${event}`),
    resolveFile: (p) => Promise.resolve(p.startsWith("/ok/") ? p : undefined),
    ...over,
  });
  return { router, emitted, picked, api };
}

Deno.test("launch router: cold-start links are queued once; a take empties the queue", async () => {
  const api = fakeApi({ launchUrls: ["myapp://threads/1", "other://x", "MyApp://threads/2"] });
  const { router, emitted } = setup({}, api);
  router.install();
  router.install(); // idempotent
  assertEquals(await call(router, "deepLinks", "take"), [
    { url: "myapp://threads/1", launch: true },
    { url: "MyApp://threads/2", launch: true },
  ]);
  assertEquals(await call(router, "deepLinks", "take"), []);
  assertEquals(emitted, ["deepLinks.available", "deepLinks.available"]);
});

Deno.test("launch router: openurl and secondinstance feed the queue (warm)", async () => {
  const { router, api } = setup();
  router.install();
  api.fire("openurl", { url: "myapp://a" });
  api.fire("openurl", { url: "https://evil.example/" }); // undeclared scheme
  api.fire("openurl", { url: 42 });
  api.fire("secondinstance", { args: [], cwd: "/", urls: ["myapp://b", "nope://c"], files: [] });
  assertEquals(await call(router, "deepLinks", "take"), [
    { url: "myapp://a", launch: false },
    { url: "myapp://b", launch: false },
  ]);
});

Deno.test("launch router: an over-long or unparseable URL is dropped", async () => {
  const { router } = setup();
  router.acceptUrl(`myapp://x/${"a".repeat(9000)}`, false);
  router.acceptUrl("myapp", false);
  router.acceptUrl("", false);
  assertEquals(await call(router, "deepLinks", "take"), []);
});

Deno.test("launch router: a pending auth session's callback is consumed before the queue", async () => {
  const offered: string[] = [];
  const { router, emitted } = setup({
    claimAuthCallback: (url) => {
      offered.push(url);
      return url.startsWith("myapp://auth");
    },
  });
  router.acceptUrl("myapp://auth/cb?code=c&state=s", false);
  router.acceptUrl("myapp://threads/9", false);
  router.acceptUrl("nope://auth/cb", false); // undeclared: never offered either
  assertEquals(offered, ["myapp://auth/cb?code=c&state=s", "myapp://threads/9"]);
  assertEquals(await call(router, "deepLinks", "take"), [{
    url: "myapp://threads/9",
    launch: false,
  }]);
  assertEquals(emitted, ["deepLinks.available"]);
});

Deno.test("launch router: the queue is bounded (oldest dropped)", async () => {
  const { router } = setup();
  for (let i = 0; i < 70; i++) router.acceptUrl(`myapp://n/${i}`, false);
  const taken = await call(router, "deepLinks", "take") as { url: string }[];
  assertEquals(taken.length, 64);
  assertEquals(taken[0].url, "myapp://n/6");
});

Deno.test("launch router: opened files become read-only picked handles", async () => {
  const api = fakeApi({ launchFiles: ["/ok/a.txt", "/missing.txt"] });
  const { router, picked } = setup({}, api);
  router.install();
  await new Promise((r) => setTimeout(r, 0));
  api.fire("openfile", { path: "/ok/b.txt" });
  api.fire("secondinstance", { args: [], cwd: "/", urls: [], files: ["/ok/c.txt", "/nope"] });
  await new Promise((r) => setTimeout(r, 0));
  const files = await call(router, "openFiles", "take") as {
    handle: string;
    name: string;
    path: string;
    launch: boolean;
  }[];
  assertEquals(files.map((f) => [f.name, f.launch]), [["a.txt", true], ["b.txt", false], [
    "c.txt",
    false,
  ]]);
  // Read access resolves; a write is refused (read-only), whatever the page asks.
  assertEquals((await picked.resolve(files[0].handle, "", false)).target, "/ok/a.txt");
  await assertRejects(
    () => picked.resolve(files[0].handle, "", true),
    DesktopCapError,
    "read-only",
  );
  assertEquals(await call(router, "openFiles", "take"), []);
});

Deno.test("launch router: owner / claim only for declared schemes; claim forces", async () => {
  const registered: unknown[] = [];
  const api = fakeApi({
    getSchemeOwner: (s) =>
      Promise.resolve({ owner: s === "myapp" ? "other" : "none", handler: "com.x" }),
    registerScheme: (s, o) => {
      registered.push([s, o]);
      return Promise.resolve({ registered: true, owner: "self" });
    },
  });
  const { router } = setup({}, api);
  assertEquals(await call(router, "deepLinks", "owner", { scheme: "MyApp" }), {
    owner: "other",
    handler: "com.x",
  });
  assertEquals(await call(router, "deepLinks", "claim", { scheme: "myapp:" }), {
    registered: true,
    owner: "self",
  });
  assertEquals(registered, [["myapp", { force: true }]]);
  for (const scheme of ["https", "other", 1]) {
    await assertRejects(
      () => call(router, "deepLinks", "claim", { scheme }) as Promise<unknown>,
      DesktopCapError,
      "not declared",
    );
  }
  assertEquals(registered.length, 1);
});

Deno.test("launch router: owner / claim on a runtime without scheme registration → unsupported", async () => {
  const { router } = setup({}, fakeApi());
  const err = await assertRejects(
    () => call(router, "deepLinks", "owner", { scheme: "myapp" }) as Promise<unknown>,
    DesktopCapError,
  );
  assertEquals(err.code, "unsupported");
});

Deno.test("launch router: no Deno.desktop (stock runtime) → install is a no-op", () => {
  const { router } = setup({ api: undefined }, undefined as unknown as ReturnType<typeof fakeApi>);
  router.install();
  assert(router.capabilities.length === 2);
});
