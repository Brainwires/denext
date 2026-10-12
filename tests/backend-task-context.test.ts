// A scheduled task must never run inside a request that happened to come before it. Deno hands
// the async context of the code that first `import()`s a module to the next task the runtime
// starts on its own, so a request that first loaded the image codec (an image transform on
// download) used to leave its request visible to the next test here — and a task calling the
// storage server API would then run the bucket's `authorize` with that old request's session
// instead of the out-of-request path (which refuses anything but a service handle). This file is its own isolate on purpose: the codec
// must be loaded for the first time by the request below.

import { assertEquals } from "@std/assert";
import { backendApp } from "./_backend-app.ts";
import { storage } from "../packages/backend/server.ts";
import { currentContext } from "../src/server/request-context.ts";
import { clearTasks, defineTask, registerTask, scheduleTasks } from "../src/server/tasks.ts";
import { samplePng } from "./fixtures/sample-image.ts";

const authorizeCalls: unknown[] = [];
let app: Awaited<ReturnType<typeof backendApp>> | undefined;

Deno.test("backend task context: a request loads the image codec for the first time", async () => {
  app = await backendApp({
    buckets: {
      img: { public: true, mime: ["image/png"], authorize: () => true },
      vault: {
        authorize: ({ session, op }) => {
          authorizeCalls.push({ session, op });
          return false; // a request may never read the vault
        },
      },
    },
  });
  await storage.bucket("img", { service: true }).upload("logo.png", samplePng());
  await storage.bucket("vault", { service: true }).upload("secret.txt", "s3cret", {
    contentType: "text/plain",
  });
  const sized = await app.call(
    await storage.bucket("img", { service: true }).createSignedUrl("logo.png", {
      transform: { width: 32 },
    }),
  );
  assertEquals([sized.status, sized.headers.get("content-type")], [200, "image/webp"]);
  await sized.body?.cancel();
});

Deno.test("backend task context: a scheduled task afterwards runs with no request", async () => {
  try {
    assertEquals(currentContext(), undefined, "no request context leaked into this test");
    clearTasks();
    let sawContext: unknown = "unset";
    registerTask(
      "vault-report",
      defineTask({
        handler: async () => {
          sawContext = currentContext();
          // A plain handle has no session to authorize out of a request: refused — never
          // checked against a leaked request's session.
          const refused = await storage.bucket("vault").list().then(() => "", (e) => e.message);
          if (!refused.includes("{ service: true }")) throw new Error(`not refused: ${refused}`);
          return (await storage.bucket("vault", { service: true }).list()).objects.map((o) =>
            o.key
          );
        },
      }),
    );
    const fired: Array<() => unknown> = [];
    const denoAny = Deno as { cron?: unknown };
    const had = "cron" in denoAny;
    const prev = denoAny.cron;
    denoAny.cron = (_name: string, _schedule: string, handler: () => unknown) => {
      fired.push(handler);
    };
    try {
      scheduleTasks([{ cron: "0 3 * * *", task: "vault-report" }]);
    } finally {
      if (had) denoAny.cron = prev;
      else delete denoAny.cron;
    }
    assertEquals(fired.length, 1);
    // Out of a request `authorize` is never consulted: a plain handle is refused and a service
    // handle reads the vault — nothing is checked with the old request's session.
    assertEquals(await fired[0](), ["secret.txt"]);
    assertEquals(sawContext, undefined);
    assertEquals(authorizeCalls, []);
  } finally {
    clearTasks();
    await app?.close();
  }
});
