// Full-app update auto-confirmation (`desktop.update.autoConfirm`, default on): a trial launch is
// confirmed once the window has loaded (the token-gated boot beacon), so an app that never calls
// `confirmAppUpdate()` does not roll every update back; off, or not a trial, means no hook (and no
// beacon). The runtime is faked: the swap/rollback itself is covered by the runtime's Rust tests and
// the packaged e2e.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createDesktopHandler } from "../src/build/desktop.ts";
import {
  appUpdateAutoConfirm,
  type AppUpdateConfirmDeps,
  combineBootHooks,
} from "../src/desktop/app-update-confirm.ts";
import { resolveDesktopCapabilities } from "../src/desktop/caps/mod.ts";

interface Fake extends AppUpdateConfirmDeps {
  confirms: number;
  logs: string[];
}

function fake(
  status: () => { trial: boolean } | null,
  confirm: () => boolean = () => true,
): Fake {
  const f: Fake = {
    confirms: 0,
    logs: [],
    status,
    confirm: () => {
      f.confirms++;
      return confirm();
    },
    log: (m) => f.logs.push(m),
  };
  return f;
}

Deno.test("autoConfirm: a trial launch gets a hook that confirms exactly once", () => {
  const f = fake(() => ({ trial: true }));
  const hook = appUpdateAutoConfirm(undefined, f);
  assert(hook, "default (undefined) is on");
  hook();
  hook(); // a reload beacons again: already confirmed, no second runtime call
  assertEquals(f.confirms, 1);
  assertStringIncludes(f.logs.join("\n"), "confirmed the updated app version");
  assert(appUpdateAutoConfirm(true, fake(() => ({ trial: true }))));
});

Deno.test("autoConfirm: off, no runtime, or not a trial → no hook", () => {
  const trial = fake(() => ({ trial: true }));
  assertEquals(appUpdateAutoConfirm(false, trial), undefined);
  assertEquals(appUpdateAutoConfirm(true, fake(() => null)), undefined); // stock runtime
  assertEquals(appUpdateAutoConfirm(true, fake(() => ({ trial: false }))), undefined);
  assertEquals(trial.confirms, 0);
});

Deno.test("autoConfirm: an unreadable status is logged and yields no hook", () => {
  const f = fake(() => {
    throw new Error("state file unreadable");
  });
  assertEquals(appUpdateAutoConfirm(true, f), undefined);
  assertStringIncludes(f.logs[0], "state file unreadable");
});

Deno.test("autoConfirm: a failed confirm is logged and retried on the next beacon", () => {
  let fail = true;
  const f = fake(() => ({ trial: true }), () => {
    if (fail) throw new Error("io: disk full");
    return true;
  });
  const hook = appUpdateAutoConfirm(true, f)!;
  hook();
  assertStringIncludes(f.logs[0], "stays on trial");
  fail = false;
  hook();
  hook();
  assertEquals(f.confirms, 2);
});

Deno.test("autoConfirm: confirm() answering false (nothing pending) retries later", () => {
  let pending = false;
  const f = fake(() => ({ trial: true }), () => pending);
  const hook = appUpdateAutoConfirm(true, f)!;
  hook();
  pending = true;
  hook();
  hook();
  assertEquals(f.confirms, 2);
});

Deno.test("combineBootHooks: none → undefined; every hook runs in order", async () => {
  assertEquals(combineBootHooks(undefined, undefined), undefined);
  const order: string[] = [];
  const both = combineBootHooks(
    () => void order.push("app"),
    undefined,
    async () => {
      await Promise.resolve();
      order.push("ui");
    },
  );
  await both!();
  assertEquals(order, ["app", "ui"]);
});

Deno.test("autoConfirm: the beacon is injected on a trial launch and its POST confirms", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "index.html"), "<!doctype html><div id=root></div>");
    const token = "trial-token-1";
    const f = fake(() => ({ trial: true }));
    const handle = createDesktopHandler(
      {},
      dir,
      undefined,
      token,
      combineBootHooks(appUpdateAutoConfirm(true, f)),
    );
    const at = (path: string) => `http://127.0.0.1${path}`;
    const html = await (await handle(
      new Request(at("/"), { headers: { accept: "text/html" } }),
      new URL(at("/")),
    )).text();
    assertStringIncludes(html, "/_denext/desktop/booted");
    const res = await handle(
      new Request(at("/_denext/desktop/booted"), {
        method: "POST",
        headers: { "x-denext-desktop-token": token },
      }),
      new URL(at("/_denext/desktop/booted")),
    );
    assertEquals(res.status, 204);
    assertEquals(f.confirms, 1);

    // Not a trial (and no UI updater): no beacon at all.
    const plain = createDesktopHandler(
      {},
      dir,
      undefined,
      token,
      combineBootHooks(appUpdateAutoConfirm(true, fake(() => ({ trial: false })))),
    );
    const plainHtml = await (await plain(
      new Request(at("/"), { headers: { accept: "text/html" } }),
      new URL(at("/")),
    )).text();
    assert(!plainHtml.includes("/_denext/desktop/booted"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveDesktopCapabilities: desktop.update.autoConfirm (default on)", async () => {
  assertEquals((await resolveDesktopCapabilities(undefined)).autoConfirmAppUpdate, true);
  assertEquals(
    (await resolveDesktopCapabilities({ desktop: { update: {} } })).autoConfirmAppUpdate,
    true,
  );
  assertEquals(
    (await resolveDesktopCapabilities({ desktop: { update: { autoConfirm: false } } }))
      .autoConfirmAppUpdate,
    false,
  );
});

Deno.test("autoConfirm: the default deps read Deno.desktop.updater and log to stderr", () => {
  const desktop = Object.getOwnPropertyDescriptor(Deno, "desktop");
  const errors: unknown[] = [];
  const consoleError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  let confirms = 0;
  const install = (updater: Record<string, () => unknown>) =>
    Object.defineProperty(Deno, "desktop", { value: { updater }, configurable: true });
  try {
    // A status read that throws a non-Error is described by its string form.
    install({
      status: () => {
        throw "state.json: permission denied";
      },
    });
    assertEquals(appUpdateAutoConfirm(undefined), undefined);
    assertEquals(errors, [
      "desktop: cannot read the app update status: state.json: permission denied",
    ]);

    // A trial launch confirms through the runtime and says so.
    install({ status: () => ({ trial: true }), confirm: () => ++confirms > 0 });
    const hook = appUpdateAutoConfirm(undefined);
    assert(hook);
    hook();
    assertEquals(confirms, 1);
    assertStringIncludes(String(errors[1]), "desktop: the window loaded; confirmed");
  } finally {
    console.error = consoleError;
    if (desktop) Object.defineProperty(Deno, "desktop", desktop);
    else delete (Deno as unknown as Record<string, unknown>).desktop;
  }
});
