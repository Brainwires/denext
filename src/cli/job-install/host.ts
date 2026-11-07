// What `denext job install` does to the machine, behind one interface: the files it writes and
// removes, and the scheduler commands it runs (`launchctl`, `systemctl`, `crontab`, `schtasks`).
// The real host does them; `--dry-run` wraps it in a recorder that still reads (so the plan sees
// what is installed) but only prints each write and each command that changes something; tests
// pass a fake one, so nothing is ever installed by a test.

import { dirname } from "@std/path";
import { systemToolPath } from "../../utils/system-programs.ts";

/** The scheduler programs the backends run. */
export type SchedulerTool = "launchctl" | "systemctl" | "crontab" | "schtasks";

/** How a tool run went. `code` 127 means the tool isn't installed. */
export interface ToolResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Options for one {@linkcode SchedulerHost.run}. */
export interface RunOptions {
  /** Text written to the tool's standard input. */
  readonly stdin?: string;
  /** The command changes the scheduler (a dry run prints it instead of running it). */
  readonly mutates?: boolean;
}

/** The machine `denext job install` works on. */
export interface SchedulerHost {
  /** `darwin`, `linux` or `windows`. */
  readonly os: string;
  /** The user's home directory. */
  readonly home: string;
  /** The user's numeric id (POSIX), else `null`. */
  readonly uid: number | null;
  /** Reads an environment variable. */
  env(name: string): string | undefined;
  /** A file's text, or `null` when it does not exist. */
  readTextFile(path: string): Promise<string | null>;
  /** The names in a directory (none when it does not exist). */
  readDir(path: string): Promise<string[]>;
  /** Writes a file, creating its directory. */
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  /** Creates a directory and its parents. */
  ensureDir(path: string): Promise<void>;
  /** Removes a file (no error when it is already gone). */
  remove(path: string): Promise<void>;
  /** Runs a scheduler tool. */
  run(tool: SchedulerTool, args: readonly string[], options?: RunOptions): Promise<ToolResult>;
}

/** Where each tool is run from: launchd's own, else the OS's system directories. */
export function schedulerToolPath(tool: SchedulerTool): string | null {
  if (tool === "launchctl") return "/bin/launchctl";
  return systemToolPath(tool);
}

/** Runs a tool by its absolute path; `127` when it isn't installed. */
async function runTool(
  pathOf: (tool: SchedulerTool) => string | null,
  tool: SchedulerTool,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ToolResult> {
  const path = pathOf(tool);
  if (!path) return { code: 127, stdout: "", stderr: `${tool}: not found` };
  try {
    const child = new Deno.Command(path, {
      args: [...args],
      stdin: options.stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    if (options.stdin !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(options.stdin));
      await writer.close();
    }
    const out = await child.output();
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    return { code: out.code, stdout: decode(out.stdout), stderr: decode(out.stderr) };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { code: 127, stdout: "", stderr: `${tool}: not found` };
    }
    throw err;
  }
}

/** Options for {@linkcode realSchedulerHost}. */
export interface RealHostOptions {
  /** Where each tool is run from (default: {@linkcode schedulerToolPath}); tests point it away. */
  readonly toolPath?: (tool: SchedulerTool) => string | null;
}

/**
 * This machine, for real.
 *
 * @param options Where the tools are run from.
 */
export function realSchedulerHost(options: RealHostOptions = {}): SchedulerHost {
  const pathOf = options.toolPath ?? schedulerToolPath;
  const env = (name: string) => {
    try {
      return Deno.env.get(name);
    } catch {
      return undefined;
    }
  };
  const home = env("HOME") ?? env("USERPROFILE");
  if (!home) throw new Error("denext: neither HOME nor USERPROFILE is set");
  return {
    os: Deno.build.os,
    home,
    uid: Deno.uid(),
    env,
    readTextFile: async (path) => {
      try {
        return await Deno.readTextFile(path);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return null;
        throw err;
      }
    },
    readDir: async (path) => {
      const names: string[] = [];
      try {
        for await (const entry of Deno.readDir(path)) names.push(entry.name);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
      return names.sort();
    },
    writeFile: async (path, data) => {
      await Deno.mkdir(dirname(path), { recursive: true });
      if (typeof data === "string") await Deno.writeTextFile(path, data);
      else await Deno.writeFile(path, data);
    },
    ensureDir: (path) => Deno.mkdir(path, { recursive: true }),
    remove: async (path) => {
      try {
        await Deno.remove(path);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    },
    run: (tool, args, runOptions) => runTool(pathOf, tool, args, runOptions),
  };
}

/** One change a dry run would have made. */
export type DryRunStep =
  | { readonly kind: "write"; readonly path: string; readonly content: string }
  | { readonly kind: "mkdir"; readonly path: string }
  | { readonly kind: "remove"; readonly path: string }
  | {
    readonly kind: "run";
    readonly tool: SchedulerTool;
    readonly args: readonly string[];
    readonly stdin?: string;
  };

/** Text for a written file's bytes (Task Scheduler's XML is UTF-16). */
function textOf(data: string | Uint8Array): string {
  if (typeof data === "string") return data;
  const utf16 = data.length >= 2 && data[0] === 0xff && data[1] === 0xfe;
  return new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(data);
}

/**
 * `host`, with every change recorded into `steps` instead of made. Reads and read-only tool runs
 * still reach the host, so the plan is the one a real run would carry out.
 *
 * @param host The host to read from.
 * @param steps Receives each change, in order.
 */
export function dryRunHost(host: SchedulerHost, steps: DryRunStep[]): SchedulerHost {
  return {
    ...host,
    env: (name) => host.env(name),
    readTextFile: (path) => host.readTextFile(path),
    readDir: (path) => host.readDir(path),
    writeFile: (path, data) => {
      steps.push({ kind: "write", path, content: textOf(data) });
      return Promise.resolve();
    },
    ensureDir: (path) => {
      steps.push({ kind: "mkdir", path });
      return Promise.resolve();
    },
    remove: (path) => {
      steps.push({ kind: "remove", path });
      return Promise.resolve();
    },
    run: (tool, args, options = {}) => {
      if (!options.mutates) return host.run(tool, args, options);
      steps.push({
        kind: "run",
        tool,
        args,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
}
