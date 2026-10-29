// A test body in its own process. `deno test --parallel` runs every test file in ONE process, so
// `Deno.env.set` / `Deno.env.delete` / `Deno.chdir` in one test reaches every other test running
// at that moment (a `finally` that restores the value does not help the test that read it in
// between). A test whose subject reads the environment or the working directory runs it here
// instead, with its own env and cwd, and gets the result back as JSON.
//
// The child is bounded (`runBounded`): past its deadline its whole process tree is killed and the
// call throws with what the child printed so far, where an unbounded wait would hold the CI job
// until its own timeout. That also makes this the way to run a full app build or export outside
// the test process (`tests/helpers/bounded-build.ts`).

import { fromFileUrl, join, resolve } from "@std/path";
import { runBounded } from "./bounded-command.ts";

const REPO = new URL("../../", import.meta.url);

/** What {@linkcode inChild} runs, and how. */
export interface ChildRun {
  /**
   * Import statements for the body. `@repo/` stands for this checkout's root
   * (`import { x } from "@repo/src/build/x.ts";`).
   */
  readonly imports?: string;
  /** The body of an async function; what it returns comes back JSON-serialized. */
  readonly body: string;
  /** Variables to set (a string) or unset (`undefined`) on top of this process's environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The child's working directory (default: this process's). */
  readonly cwd?: string;
  /** How long the child may run before its tree is killed (default {@linkcode CHILD_DEADLINE_MS}). */
  readonly timeoutMs?: number;
  /**
   * `false` runs the child with `--no-lock`: a body that imports a module from a throwaway origin
   * (a loopback server on a random port) must not record it in the checkout's `deno.lock`.
   */
  readonly lock?: false;
}

/** The default deadline of {@linkcode inChild}: minutes past the slowest healthy runner's time. */
export const CHILD_DEADLINE_MS = 300_000;

/** What the child returned, and what it wrote to stderr (its `console.warn` / `console.error`). */
export interface ChildResult<T> {
  readonly value: T;
  readonly stderr: string;
}

const MARK = "\u0000denext-child-result:";

/**
 * Prepended to the child's main module: every `Deno.Command` the child makes (`deno info`,
 * `deno bundle`, the esbuild service) is logged to the file `DENEXT_CHILD_TRACE` names when it
 * spawns, exits and, for `output()`, returns, so a child killed at its deadline names the
 * subprocess it was waiting on ({@linkcode pendingSpawns}). Never throws into the child.
 */
const SPAWN_TRACE = `{
  const __file = Deno.env.get("DENEXT_CHILD_TRACE");
  const __Command = Deno.Command;
  if (__file) {
    const log = (line: string) => {
      try {
        Deno.writeTextFileSync(__file, \`\${new Date().toISOString()} \${line}\\n\`, { append: true });
      } catch { /* tracing never fails the child */ }
    };
    const named = new WeakMap<object, string>();
    let n = 0;
    class Traced extends __Command {
      constructor(cmd: string | URL, options?: Deno.CommandOptions) {
        super(cmd, options);
        named.set(this, [String(cmd), ...(options?.args ?? [])].join(" ").slice(0, 400));
      }
      override spawn(): Deno.ChildProcess {
        const id = ++n;
        const child = super.spawn();
        log(\`start #\${id} pid \${child.pid}: \${named.get(this)}\`);
        child.status.then((s) => log(\`exit #\${id} pid \${child.pid} code \${s.code}\`), () => {});
        return child;
      }
      override async output(): Promise<Deno.CommandOutput> {
        const id = ++n;
        log(\`start #\${id} output(): \${named.get(this)}\`);
        try {
          return await super.output();
        } finally {
          log(\`end #\${id}\`);
        }
      }
    }
    Object.defineProperty(Deno, "Command", { value: Traced, configurable: true, writable: true });
  }
}
`;

/**
 * From a {@linkcode SPAWN_TRACE} log, the subprocesses that never finished: a \`spawn()\` with no
 * exit, an \`output()\` that never returned (its child may have exited with another process
 * holding its pipes). `""` when there are none.
 */
export function pendingSpawns(trace: string): string {
  const open = new Map<string, string>();
  for (const line of trace.split("\n")) {
    const start = / start #(\d+) /.exec(line);
    if (start) open.set(start[1], line);
    const done = / (?:exit|end) #(\d+)\b/.exec(line);
    if (done) open.delete(done[1]);
  }
  return [...open.values()].join("\n");
}

/** Read a {@linkcode SPAWN_TRACE} log and say what it shows, for a timeout's error. */
async function traceReport(file: string): Promise<string> {
  let trace = "";
  try {
    trace = await Deno.readTextFile(file);
  } catch { /* nothing spawned */ }
  const lines = trace.split("\n").filter(Boolean);
  const pending = pendingSpawns(trace);
  return `Its subprocesses (${lines.length} trace line(s)); unfinished:\n${pending || "(none)"}\n` +
    `Last of the trace:\n${lines.slice(-12).join("\n")}`;
}

/**
 * Run `run.body` in a child `deno run` and return its result. Throws (with the child's output)
 * when the child fails.
 *
 * @param run The body, its imports, env and cwd.
 */
export async function inChild<T = unknown>(run: ChildRun): Promise<ChildResult<T>> {
  const dir = await Deno.makeTempDir({ prefix: "denext_child_" });
  try {
    const main = join(dir, "main.ts");
    const imports = (run.imports ?? "").replaceAll("@repo/", REPO.href);
    const trace = join(dir, "spawns.log");
    await Deno.writeTextFile(
      main,
      `${SPAWN_TRACE}${imports}\nconst __value = await (async () => {\n${run.body}\n})();\n` +
        `console.log(${JSON.stringify(MARK)} + JSON.stringify(__value ?? null));\n`,
    );
    const env = Deno.env.toObject();
    for (const [key, value] of Object.entries(run.env ?? {})) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    env.DENEXT_CHILD_TRACE = trace;
    // Under the coverage tasks the child's coverage joins the run's (`DENEXT_CHILD_COVERAGE` names
    // the profile directory they collect into).
    const coverage = Deno.env.get("DENEXT_CHILD_COVERAGE");
    const timeoutMs = run.timeoutMs ?? CHILD_DEADLINE_MS;
    const out = await runBounded(Deno.execPath(), [
      "run",
      "-A",
      "--unstable-kv",
      ...(coverage ? [`--coverage=${resolve(coverage)}`] : []),
      ...(run.lock === false ? ["--no-lock"] : []),
      "--config",
      fromFileUrl(new URL("deno.json", REPO)),
      main,
    ], { cwd: run.cwd, env, clearEnv: true, timeoutMs });
    const { stdout, stderr } = out;
    if (out.timedOut) {
      throw new Error(
        `child still running after ${timeoutMs} ms; its tree was killed. It printed:\n` +
          `${stdout}\n${stderr}\n${await traceReport(trace)}\n` +
          `Its process tree at the deadline:\n${out.tree}`,
      );
    }
    const line = stdout.split("\n").find((l) => l.startsWith(MARK));
    if (!out.success || line === undefined) {
      throw new Error(`child failed:\n${stdout}\n${stderr}`);
    }
    return { value: JSON.parse(line.slice(MARK.length)) as T, stderr };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
