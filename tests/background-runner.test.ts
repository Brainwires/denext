// Background tasks' build side (src/build/background-runner.ts): the task modules found in
// background/, the generated runner entry, the dispatcher's due-task logic (evaluated with fake
// runner globals), and compileBackgroundRunner / writeMobileExportExtras with a fake bundler.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  BACKGROUND_DISPATCHER,
  BACKGROUND_RUNNER_EVENT,
  BACKGROUND_RUNNER_FILE,
  backgroundRunnerEntry,
  compileBackgroundRunner,
  listBackgroundTaskFiles,
} from "../src/build/background-runner.ts";
import { writeMobileExportExtras } from "../src/build/mobile-export-extras.ts";
import { defineBackgroundTask } from "../src/mobile/background.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Handler = (
  resolve: (v?: unknown) => void,
  reject: (e: unknown) => void,
  args: unknown,
) => void;

/** Evaluate the dispatcher with `tasks`, returning the events it registered and the KV. */
function runner(tasks: unknown[], kvSeed: Record<string, string> = {}) {
  const events = new Map<string, Handler>();
  const kv = new Map(Object.entries(kvSeed));
  const errors: string[] = [];
  const CapacitorKV = {
    get: (k: string) => ({ value: kv.get(k) }),
    set: (k: string, v: string) => void kv.set(k, v),
    remove: (k: string) => void kv.delete(k),
  };
  const saved = (globalThis as Any).CapacitorKV;
  (globalThis as Any).CapacitorKV = CapacitorKV;
  new Function("__denextTasks", "addEventListener", "console", BACKGROUND_DISPATCHER)(
    tasks,
    (name: string, fn: Handler) => events.set(name, fn),
    { error: (m: string) => errors.push(m) },
  );
  const fire = (event: string, args: unknown = {}) =>
    new Promise((resolve, reject) => events.get(event)!(resolve, reject, args));
  const restore = () => {
    if (saved === undefined) delete (globalThis as Any).CapacitorKV;
    else (globalThis as Any).CapacitorKV = saved;
  };
  return { events, kv, errors, fire, restore };
}

Deno.test("listBackgroundTaskFiles: task modules only, sorted; none without the folder", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await listBackgroundTaskFiles(dir), []);
    await Deno.mkdir(join(dir, "background"));
    for (const f of ["b.ts", "a.js", "_shared.ts", "x.test.ts", "types.d.ts", "notes.md"]) {
      await Deno.writeTextFile(join(dir, "background", f), "");
    }
    assertEquals(await listBackgroundTaskFiles(dir), [
      join(dir, "background", "a.js"),
      join(dir, "background", "b.ts"),
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("backgroundRunnerEntry: imports each module and registers the dispatcher", () => {
  const entry = backgroundRunnerEntry(["/p/background/a.ts", "/p/background/b.ts"]);
  assertStringIncludes(
    entry,
    `import __denextTask0 from "${toFileUrl("/p/background/a.ts").href}";`,
  );
  assertStringIncludes(entry, "const __denextTasks = [__denextTask0, __denextTask1];");
  assertStringIncludes(entry, `addEventListener("${BACKGROUND_RUNNER_EVENT}"`);
});

Deno.test("dispatcher: runs due tasks, records the run, skips not-due ones, survives a failure", async () => {
  const ran: Array<[string, Any]> = [];
  const hourly = defineBackgroundTask({
    name: "hourly",
    interval: 60,
    handler: (ctx) => void ran.push(["hourly", ctx]),
  });
  const quarter = defineBackgroundTask({
    name: "quarter",
    handler: () => {
      throw new Error("boom");
    },
  });
  const now = Date.now();
  // hourly ran 20 minutes ago: not due; quarter never ran: due (and fails).
  const r = runner([hourly, quarter], { "denext:bg:last:hourly": String(now - 20 * 60_000) });
  try {
    assertEquals(await r.fire(BACKGROUND_RUNNER_EVENT), { ran: [], failed: ["quarter"] });
    assertEquals(ran, []);
    assert(!r.kv.has("denext:bg:last:quarter"), "a failed run is retried next wake");
    assertStringIncludes(r.errors.join("\n"), "quarter failed: boom");
    // 55 minutes later (90% of 60): hourly is due.
    r.kv.set("denext:bg:last:hourly", String(now - 55 * 60_000));
    assertEquals(await r.fire(BACKGROUND_RUNNER_EVENT), { ran: ["hourly"], failed: ["quarter"] });
    const [, ctx] = ran[0];
    assertEquals([ctx.name, ctx.trigger, ctx.details], ["hourly", "schedule", {}]);
    assert(ctx.deadline > now && ctx.deadline <= Date.now() + 25_000);
    ctx.kv.set("k", 1);
    assertEquals(ctx.kv.get("k"), "1");
    assert(Number(r.kv.get("denext:bg:last:hourly")) >= now);
  } finally {
    r.restore();
  }
});

Deno.test("dispatcher: each task is its own event; bad and duplicate exports are skipped", async () => {
  const seen: Any[] = [];
  const task = defineBackgroundTask({ name: "sync", handler: (ctx) => void seen.push(ctx) });
  const failing = defineBackgroundTask({
    name: "fails",
    handler: () => Promise.reject(new Error("nope")),
  });
  const r = runner([task, { name: "sync", handler: () => {} }, null, failing]);
  try {
    assertEquals([...r.events.keys()].sort(), [BACKGROUND_RUNNER_EVENT, "fails", "sync"].sort());
    assertEquals(r.errors.length, 2, "the duplicate and the null export");
    await r.fire("sync", { reason: "login" });
    assertEquals([seen[0].trigger, seen[0].details], ["dispatch", { reason: "login" }]);
    let rejected: unknown;
    await r.fire("fails").catch((e) => (rejected = e));
    assertEquals((rejected as Error).message, "nope");
  } finally {
    r.restore();
  }
});

Deno.test("compileBackgroundRunner + writeMobileExportExtras: the script and the association files", async () => {
  const project = await Deno.makeTempDir();
  const out = await Deno.makeTempDir();
  try {
    const bundled: Array<[string, string]> = [];
    const bundle = async (entry: string, outFile: string) => {
      bundled.push([await Deno.readTextFile(entry), outFile]);
      await Deno.writeTextFile(outFile, "/* bundled */");
    };
    assertEquals(await compileBackgroundRunner({ projectDir: project, outDir: out, bundle }), null);
    await Deno.mkdir(join(project, "background"));
    await Deno.writeTextFile(join(project, "background", "sync.ts"), "export default {};");
    const extras = await writeMobileExportExtras(
      project,
      {
        appLinks: {
          apple: { appIds: ["ABCDE12345.com.example.app"] },
          android: { packageName: "com.example.app", sha256CertFingerprints: ["ab".repeat(32)] },
        },
      },
      out,
      bundle,
    );
    assertEquals(extras, {
      appLinks: [".well-known/apple-app-site-association", ".well-known/assetlinks.json"],
      background: { file: BACKGROUND_RUNNER_FILE, tasks: 1 },
    });
    assertEquals(bundled.length, 1);
    assertStringIncludes(bundled[0][0], "background/sync.ts");
    assertEquals(bundled[0][1], join(out, BACKGROUND_RUNNER_FILE));
    const aasa = JSON.parse(
      await Deno.readTextFile(join(out, ".well-known", "apple-app-site-association")),
    );
    assertEquals(aasa.applinks.details[0].appIDs, ["ABCDE12345.com.example.app"]);
    const links = JSON.parse(await Deno.readTextFile(join(out, ".well-known", "assetlinks.json")));
    assertEquals(links[0].target.sha256_cert_fingerprints[0].split(":").length, 32);
    assertEquals(await writeMobileExportExtras(project, {}, out, async () => {}), {
      appLinks: [],
      background: { file: BACKGROUND_RUNNER_FILE, tasks: 1 },
    });
  } finally {
    await Deno.remove(project, { recursive: true });
    await Deno.remove(out, { recursive: true });
  }
});
