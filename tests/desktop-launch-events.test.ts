// The Deno Desktop launch router (runtime side): cold-start links and files are queued once,
// `openurl` / `openfile` / `secondinstance` feed the same queues, only declared schemes pass, a
// pending auth session takes its callback before anything is queued, every take empties the queue
// (no replay), opened files become READ-ONLY picked handles, and the scheme owner / claim methods
// only touch declared schemes.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
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

Deno.test("launch router: the default resolver accepts only real, existing regular files", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_launch_" }));
  try {
    const file = join(dir, "notes.txt");
    await Deno.writeTextFile(file, "hi");
    await Deno.mkdir(`${dir}/folder`);
    const posix = Deno.build.os !== "windows";
    if (posix) await Deno.symlink(file, `${dir}/link.txt`);
    // No resolveFile and no picked set: the router's own defaults.
    const emitted: string[] = [];
    const router = createLaunchRouter({
      schemes: [],
      api: fakeApi(),
      emit: (cap, event) => emitted.push(`${cap}.${event}`),
    });
    for (const path of [file, `${dir}/folder`, `${dir}/missing.txt`, "", 42, null]) {
      await router.acceptFile(path, false);
    }
    if (posix) await router.acceptFile(`${dir}/link.txt`, true);
    const files = await call(router, "openFiles", "take") as { path: string; name: string }[];
    // A symlink is reported as the file it points at; a directory or a missing path is dropped.
    assertEquals(
      files.map((f) => [f.name, f.path]),
      posix ? [["notes.txt", file], ["notes.txt", file]] : [["notes.txt", file]],
    );
    assertEquals(emitted.length, files.length);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("launch router: malformed launch lists and event details queue nothing", async () => {
  const api = fakeApi({
    launchUrls: "myapp://not-a-list" as unknown as string[],
    launchFiles: [42, "/ok/real.txt"] as unknown as string[],
  });
  const { router, emitted } = setup({}, api);
  router.install();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(emitted, ["openFiles.available"], "only the string entry of a list counts");
  for (const detail of [null, "myapp://x", 7]) {
    api.fire("openurl", detail);
    api.fire("openfile", detail);
    api.fire("secondinstance", detail);
  }
  api.fire("secondinstance", { urls: "myapp://x", files: { 0: "/ok/x" } });
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(await call(router, "deepLinks", "take"), []);
  assertEquals((await call(router, "openFiles", "take") as unknown[]).length, 1);
});

Deno.test("launch router: a runtime without addEventListener still queues the cold-start items", async () => {
  const api: DesktopAppApi = { launchUrls: ["myapp://cold"], launchFiles: ["/ok/cold.txt"] };
  const { router } = setup({}, api as ReturnType<typeof fakeApi>);
  router.install();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(await call(router, "deepLinks", "take"), [{ url: "myapp://cold", launch: true }]);
  assertEquals((await call(router, "openFiles", "take") as unknown[]).length, 1);
});

Deno.test("launch router: owner / claim report only the fields the runtime gave", async () => {
  const api = fakeApi({
    getSchemeOwner: () => Promise.resolve({ owner: "none" }),
    registerScheme: () =>
      Promise.resolve({
        registered: "yes" as unknown as boolean, // anything but `true` is not registered
        owner: "other",
        handler: "com.other.app",
        reason: "UserChoice is set",
      }),
  });
  const { router } = setup({}, api);
  assertEquals(await call(router, "deepLinks", "owner", { scheme: "myapp" }), { owner: "none" });
  assertEquals(await call(router, "deepLinks", "claim", { scheme: "myapp" }), {
    registered: false,
    owner: "other",
    handler: "com.other.app",
    reason: "UserChoice is set",
  });
});

Deno.test("launch router: without an api option it uses Deno.desktop when that is an object", async () => {
  const had = Object.getOwnPropertyDescriptor(Deno, "desktop");
  const define = (value: unknown) =>
    Object.defineProperty(Deno, "desktop", { value, configurable: true });
  try {
    define(fakeApi({ launchUrls: ["myapp://from-runtime"] }));
    const live = createLaunchRouter({ schemes: ["myapp"], emit: () => {} });
    live.install();
    assertEquals(await call(live, "deepLinks", "take"), [
      { url: "myapp://from-runtime", launch: true },
    ]);
    define(true); // not an app API: the stock runtime path
    const stock = createLaunchRouter({ schemes: ["myapp"], emit: () => {} });
    stock.install();
    const err = await assertRejects(
      () => call(stock, "deepLinks", "owner", { scheme: "myapp" }) as Promise<unknown>,
      DesktopCapError,
    );
    assertEquals(err.code, "unsupported");
  } finally {
    if (had) Object.defineProperty(Deno, "desktop", had);
    else delete (Deno as unknown as Record<string, unknown>).desktop;
  }
});
