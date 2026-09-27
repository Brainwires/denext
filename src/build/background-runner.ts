// Background tasks (`defineBackgroundTask` in denext/mobile): compile the project's
// `background/*.ts` modules into the one script `@capacitor/background-runner` runs in its
// headless JavaScript engine. `denext export` calls it when the folder exists, writing
// `denext-background.js` into the export (the Capacitor webDir), which is the `src` that
// `denext mobile add background` puts in capacitor.config's `plugins.BackgroundRunner`.
//
// The runner fires ONE configured event (`denextBackground`) on the OS's schedule; the
// generated dispatcher runs every task whose interval has passed (tracked in CapacitorKV) and
// resolves within the iOS budget. Each task is also its own event, so the page can run one on
// demand (`runBackgroundTask(name)` → `dispatchEvent`).

import { join, toFileUrl } from "@std/path";

/** The project folder holding the task modules. */
const BACKGROUND_DIR = "background";
/** The runner script's file name in the export (the plugin's `src`). */
export const BACKGROUND_RUNNER_FILE = "denext-background.js";
/** The event the runner's schedule fires (the plugin's `event`). */
export const BACKGROUND_RUNNER_EVENT = "denextBackground";

/** Whether `name` is a task module: `.ts`/`.js`, not a test, not `_`-prefixed. */
function isTaskModule(name: string): boolean {
  return /\.(ts|js|mts|mjs)$/.test(name) && !/\.test\.[mc]?[jt]s$/.test(name) &&
    !name.startsWith("_") && !name.startsWith(".") && !name.endsWith(".d.ts");
}

/**
 * The task modules in `<projectDir>/background/`, sorted, as absolute paths; `[]` when the
 * folder does not exist.
 *
 * @param projectDir The denext project.
 * @returns The module paths.
 */
export async function listBackgroundTaskFiles(projectDir: string): Promise<string[]> {
  const dir = join(projectDir, BACKGROUND_DIR);
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && isTaskModule(entry.name)) out.push(join(dir, entry.name));
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  return out.sort();
}

/**
 * The dispatcher that runs inside the runner. It reads `__denextTasks` (the task modules'
 * default exports) and the runner globals `addEventListener`, `CapacitorKV` and `console`.
 * Plain ES2017 on purpose: it runs as-is in the runner's engine, and tests evaluate it.
 */
export const BACKGROUND_DISPATCHER = `
const __denextBudgetMs = 25000;
const __denextSeen = new Set();
const __denextValid = __denextTasks.filter(function (task) {
  if (!task || typeof task.name !== "string" || typeof task.handler !== "function") {
    console.error("denext background: a background/ module's default export is not a defineBackgroundTask()");
    return false;
  }
  if (__denextSeen.has(task.name)) {
    console.error("denext background: two tasks are named " + task.name + "; the second is skipped");
    return false;
  }
  __denextSeen.add(task.name);
  return true;
});
function __denextKv() {
  const kv = globalThis.CapacitorKV;
  return {
    get: function (key) {
      const got = kv ? kv.get(key) : null;
      if (got && typeof got === "object") return got.value == null ? null : String(got.value);
      return got == null ? null : String(got);
    },
    set: function (key, value) { if (kv) kv.set(key, String(value)); },
    remove: function (key) { if (kv) kv.remove(key); },
  };
}
async function __denextRun(task, trigger, details, kv, deadline) {
  await task.handler({
    name: task.name,
    trigger: trigger,
    details: details && typeof details === "object" ? details : {},
    kv: kv,
    deadline: deadline,
  });
}
addEventListener("${BACKGROUND_RUNNER_EVENT}", async function (resolve, reject, args) {
  const ran = [];
  const failed = [];
  try {
    const kv = __denextKv();
    const start = Date.now();
    const deadline = start + __denextBudgetMs;
    for (const task of __denextValid) {
      if (Date.now() >= deadline) break;
      const key = "denext:bg:last:" + task.name;
      const last = Number(kv.get(key) || 0);
      // The OS rarely wakes the runner exactly on time: a task is due at 90% of its interval.
      if (start - last < task.interval * 60000 * 0.9) continue;
      try {
        await __denextRun(task, "schedule", {}, kv, deadline);
        kv.set(key, String(Date.now()));
        ran.push(task.name);
      } catch (err) {
        failed.push(task.name);
        console.error("denext background: " + task.name + " failed: " + (err && err.message ? err.message : err));
      }
    }
  } finally {
    resolve({ ran: ran, failed: failed });
  }
});
__denextValid.forEach(function (task) {
  addEventListener(task.name, async function (resolve, reject, args) {
    try {
      await __denextRun(task, "dispatch", args, __denextKv(), Date.now() + __denextBudgetMs);
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});
`;

/**
 * The runner's entry module: every task module imported, then the dispatcher.
 *
 * @param files The task modules (absolute paths).
 * @returns The entry source.
 */
export function backgroundRunnerEntry(files: readonly string[]): string {
  const imports = files.map((f, i) =>
    `import __denextTask${i} from ${JSON.stringify(toFileUrl(f).href)};`
  );
  const list = files.map((_, i) => `__denextTask${i}`).join(", ");
  return `// @generated by denext: the Background Runner script (background/*.ts).\n` +
    `${imports.join("\n")}\nconst __denextTasks = [${list}];\n${BACKGROUND_DISPATCHER}`;
}

/** Bundles `entry` into the single script at `outFile` (the default runs `deno bundle`). */
export type BackgroundBundler = (entry: string, outFile: string, cwd: string) => Promise<void>;

/** The project's deno config file, if it has one. */
async function projectConfig(projectDir: string): Promise<string | undefined> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      if ((await Deno.stat(join(projectDir, name))).isFile) return join(projectDir, name);
    } catch { /* not this one */ }
  }
  return undefined;
}

/** `deno bundle` the entry as one browser-platform IIFE script (the runner loads no modules). */
const denoBundle: BackgroundBundler = async (entry, outFile, cwd) => {
  const config = await projectConfig(cwd);
  const args = [
    "bundle",
    "--unstable-sloppy-imports",
    "--platform=browser",
    "--format=iife",
    "--minify",
    ...(config ? ["--config", config] : []),
    "--output",
    outFile,
    entry,
  ];
  // Loaded here, not at the top: `mobile add` imports this module's constants, and the
  // bundler module drags the whole client build in.
  const { denoExecutable } = await import("./bundle.ts");
  const { code, stderr } = await new Deno.Command(denoExecutable(), {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `bundling background/ for the Background Runner failed:\n${new TextDecoder().decode(stderr)}`,
    );
  }
};

/** Options for {@linkcode compileBackgroundRunner}. */
export interface CompileBackgroundOptions {
  /** The denext project (holding `background/`). */
  readonly projectDir: string;
  /** Where the script goes (the export's root; `denext-background.js` is written in it). */
  readonly outDir: string;
  /** The bundler (tests); default `deno bundle`. */
  readonly bundle?: BackgroundBundler;
}

/**
 * Compile `background/*.ts` into `<outDir>/denext-background.js`.
 *
 * @param options The project, the output folder and the bundler.
 * @returns The task module count and the script path, or null when there is no `background/`
 * folder (or it holds no task module).
 */
export async function compileBackgroundRunner(
  options: CompileBackgroundOptions,
): Promise<{ tasks: number; file: string } | null> {
  const files = await listBackgroundTaskFiles(options.projectDir);
  if (files.length === 0) return null;
  const tmp = await Deno.makeTempDir({ prefix: "denext_background_" });
  const file = join(options.outDir, BACKGROUND_RUNNER_FILE);
  try {
    const entry = join(tmp, "entry.ts");
    await Deno.writeTextFile(entry, backgroundRunnerEntry(files));
    await Deno.mkdir(options.outDir, { recursive: true });
    await (options.bundle ?? denoBundle)(entry, file, options.projectDir);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
  return { tasks: files.length, file };
}
