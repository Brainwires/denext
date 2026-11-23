// `runDesktop`'s result outside the desktop runtime (src/build/desktop.ts): under a plain `deno run`
// there is no window, so the server starts and the runtime's hooks are inert but callable (the Dock,
// notification clicks, before-quit guards, quit), `emit` reaches no page, `sidecar()` names the
// missing declaration, and an app that declares no sidecar still lists and stops the detached
// sidecars an earlier version left in its registry (`<data>/sidecars`). Run in a child process:
// the server `runDesktop` starts has no stop, so the child ends itself once it answered.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { inChild } from "./helpers/isolated.ts";

/** What the child reports. */
interface RuntimeReport {
  readonly window: boolean;
  readonly served: string;
  readonly unsubscribes: string[];
  readonly quit: boolean;
  readonly emitted: boolean;
  readonly sidecarError: string;
  readonly beforeRecord: unknown[];
  readonly listed: { name: string; pid: number; appVersion: string }[];
  readonly stopError: string;
  readonly afterStop: unknown[];
  readonly recordGone: boolean;
}

Deno.test({
  name:
    "runDesktop: outside the desktop runtime its hooks are inert, and the registry is the app's own",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-runtime-api-" });
    try {
      const out = join(dir, "out");
      await Deno.mkdir(out);
      await Deno.writeTextFile(join(out, "index.html"), "<!doctype html><title>t</title><p>hi</p>");
      const data = join(dir, "data");
      const { value } = await inChild<RuntimeReport>({
        imports: [
          'import { runDesktop } from "@repo/src/build/desktop.ts";',
          "import {",
          "  detachedRecordPath,",
          "  detachedRegistryDir,",
          "  newDetachedKey,",
          "  writeDetachedRecord,",
          '} from "@repo/src/desktop/sidecar-detached.ts";',
        ].join("\n"),
        env: {
          DENEXT_DESKTOP_DEV_URL: undefined,
          DENEXT_DESKTOP_HEADLESS: undefined,
          DENEXT_SIDECAR_CHILD: undefined,
        },
        body: `
          const out = ${JSON.stringify(out)};
          const data = ${JSON.stringify(data)};
          // A free port, so the server's address is known.
          const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
          const port = probe.addr.port;
          probe.close();
          const rt = await runDesktop({ outDir: out, port, appDirs: { data } });
          const served = await (await fetch("http://127.0.0.1:" + port + "/")).text();
          const unsubscribes = [
            rt.onDockReopen(() => {}),
            rt.onNotificationClick(() => {}),
            rt.onBeforeQuit(() => true),
          ].map((u) => { u(); return typeof u; });
          const quit = await rt.quit();
          rt.emit("custom", "ping", { n: 1 });
          rt.emit("custom", "ping", { n: 2 }, { retain: false, window: "main" });
          let sidecarError = "";
          try {
            rt.sidecar("server");
          } catch (err) {
            sidecarError = (err as Error).message;
          }
          // No registry folder yet: nothing is listed (the launch's leftover cleanup found none).
          const beforeRecord = await rt.detachedSidecars();
          // A record an earlier version left, whose control endpoint no longer answers.
          const dir = detachedRegistryDir(data);
          const gone = Deno.listen({ hostname: "127.0.0.1", port: 0 });
          const deadPort = gone.addr.port;
          gone.close();
          await writeDetachedRecord(dir, {
            v: 1,
            name: "ptyd",
            pid: 4242,
            startedAt: 1,
            appVersion: "0.9.0",
            control: { host: "127.0.0.1", port: deadPort },
            key: newDetachedKey(),
          });
          const listed = (await rt.detachedSidecars()).map((e) => ({
            name: e.name,
            pid: e.pid,
            appVersion: e.appVersion,
          }));
          let stopError = "";
          try {
            await rt.stopDetachedSidecar("other");
          } catch (err) {
            stopError = (err as Error).message;
          }
          await rt.stopDetachedSidecar("ptyd");
          const afterStop = await rt.detachedSidecars();
          const recordGone = await Deno.stat(detachedRecordPath(dir, "ptyd")).then(() => false, () => true);
          // The server runDesktop started has no stop: end the child once it answered.
          setTimeout(() => Deno.exit(0), 0);
          return {
            window: rt.window !== undefined,
            served,
            unsubscribes,
            quit,
            emitted: true,
            sidecarError,
            beforeRecord,
            listed,
            stopError,
            afterStop,
            recordGone,
          };
        `,
      });
      assertEquals(value.window, false, "no window under a plain deno run");
      assertMatch(value.served, /<p>hi<\/p>/);
      assertEquals(value.unsubscribes, ["function", "function", "function"]);
      // No window lifecycle to ask: a quit request is refused, not carried out.
      assertEquals(value.quit, false);
      assert(value.emitted);
      assertEquals(value.sidecarError, 'desktop: no sidecar named "server" (none declared)');
      assertEquals(value.beforeRecord, []);
      assertEquals(value.listed, [{ name: "ptyd", pid: 4242, appVersion: "0.9.0" }]);
      assertEquals(
        value.stopError,
        "sidecar other: no detached sidecar of that name is recorded",
      );
      // Its endpoint is gone, so the stop only drops the record.
      assertEquals(value.afterStop, []);
      assert(value.recordGone);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

/** What the sidecar's child reports. */
interface ChildRuntimeReport {
  readonly ran: string | null;
  readonly sidecarChild: string | undefined;
  readonly window: boolean;
  readonly markersLeft: (string | null)[];
  readonly unsubscribes: string[];
  readonly notifyError: { code: string; message: string };
  readonly sidecarError: string;
  readonly detached: unknown[];
  readonly stopError: string;
  readonly quit: boolean;
}

Deno.test({
  name: "runDesktop: a module sidecar's child runs only that module and gets an inert runtime",
  fn: async () => {
    const { value } = await inChild<ChildRuntimeReport>({
      imports: 'import { runDesktop } from "@repo/src/build/desktop.ts";',
      env: {
        DENEXT_SIDECAR_CHILD: "server",
        DENEXT_SIDECAR_CHILD_ARGC: "0",
        DENEXT_SIDECAR_DETACHED: undefined,
        DENEXT_DESKTOP_DEV_URL: undefined,
      },
      body: `
        // The sidecar's module, beside this entry: it records the global it was started with.
        await Deno.writeTextFile(
          new URL("./server.ts", import.meta.url),
          "globalThis.__ran = globalThis.denextSidecar.name + ':' + globalThis.denextSidecar.child;",
        );
        const rt = await runDesktop({
          importMetaUrl: import.meta.url,
          sidecars: [{ name: "server", run: { module: "./server.ts" } }],
        });
        const markersLeft = ["DENEXT_SIDECAR_CHILD", "DENEXT_SIDECAR_CHILD_ARGC"].map((k) =>
          Deno.env.get(k) ?? null
        );
        const unsubscribes = [rt.onNotificationClick(() => {}), rt.onBeforeQuit(() => true)].map(
          (u) => { u(); return typeof u; },
        );
        let notifyError = { code: "", message: "" };
        try {
          await rt.notify({ title: "t" });
        } catch (err) {
          notifyError = { code: (err as { code: string }).code, message: (err as Error).message };
        }
        rt.emit("custom", "ping", {});
        let sidecarError = "";
        try {
          rt.sidecar("server");
        } catch (err) {
          sidecarError = (err as Error).message;
        }
        const detached = await rt.detachedSidecars();
        let stopError = "";
        try {
          await rt.stopDetachedSidecar("server");
        } catch (err) {
          stopError = (err as Error).message;
        }
        const quit = await rt.quit();
        setTimeout(() => Deno.exit(0), 0);
        return {
          ran: globalThis.__ran ?? null,
          sidecarChild: rt.sidecarChild,
          window: rt.window !== undefined,
          markersLeft,
          unsubscribes,
          notifyError,
          sidecarError,
          detached,
          stopError,
          quit,
        };
      `,
    });
    assertEquals(value.ran, "server:true", "the sidecar's module ran with its global");
    assertEquals(value.sidecarChild, "server");
    assertEquals(value.window, false);
    // The markers are removed, so nothing the child starts inherits them.
    assertEquals(value.markersLeft, [null, null]);
    assertEquals(value.unsubscribes, ["function", "function"]);
    assertEquals(value.notifyError.code, "unsupported");
    assertEquals(value.notifyError.message, "a sidecar's child posts no notifications");
    assertEquals(
      value.sidecarError,
      `desktop: no sidecar named "server" (a sidecar's child runs none)`,
    );
    assertEquals(value.detached, []);
    assertEquals(
      value.stopError,
      `desktop: no sidecar named "server" (a sidecar's child runs none)`,
    );
    assertEquals(value.quit, false);
  },
});
