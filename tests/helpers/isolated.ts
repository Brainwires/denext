// A test body in its own process. `deno test --parallel` runs every test file in ONE process, so
// `Deno.env.set` / `Deno.env.delete` / `Deno.chdir` in one test reaches every other test running
// at that moment (a `finally` that restores the value does not help the test that read it in
// between). A test whose subject reads the environment or the working directory runs it here
// instead, with its own env and cwd, and gets the result back as JSON.

import { fromFileUrl, join, resolve } from "@std/path";

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
}

/** What the child returned, and what it wrote to stderr (its `console.warn` / `console.error`). */
export interface ChildResult<T> {
  readonly value: T;
  readonly stderr: string;
}

const MARK = "\u0000denext-child-result:";

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
    await Deno.writeTextFile(
      main,
      `${imports}\nconst __value = await (async () => {\n${run.body}\n})();\n` +
        `console.log(${JSON.stringify(MARK)} + JSON.stringify(__value ?? null));\n`,
    );
    const env = Deno.env.toObject();
    for (const [key, value] of Object.entries(run.env ?? {})) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    // Under the coverage tasks the child's coverage joins the run's (`DENEXT_CHILD_COVERAGE` names
    // the profile directory they collect into).
    const coverage = Deno.env.get("DENEXT_CHILD_COVERAGE");
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--unstable-kv",
        ...(coverage ? [`--coverage=${resolve(coverage)}`] : []),
        "--config",
        fromFileUrl(new URL("deno.json", REPO)),
        main,
      ],
      cwd: run.cwd,
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);
    const line = stdout.split("\n").find((l) => l.startsWith(MARK));
    if (!out.success || line === undefined) {
      throw new Error(`child failed (${out.code}):\n${stdout}\n${stderr}`);
    }
    return { value: JSON.parse(line.slice(MARK.length)) as T, stderr };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
