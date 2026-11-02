// The real `Host`: Deno's process, file and socket APIs. Used only by the desktop extension, in the
// app's Deno process; the tests never load it.

import {
  type DirEntry,
  homeFolder,
  type Host,
  type ProcessInfo,
  type QmpSession,
  type RunResult,
} from "./host.ts";
import { parsePs, PS_ARGS, psProgram } from "./processes.ts";
import { openQmpSession } from "./qmp.ts";

const decoder = new TextDecoder();

async function run(
  program: string,
  args: readonly string[],
  options: { cwd?: string } = {},
): Promise<RunResult> {
  const out = await new Deno.Command(program, {
    args: [...args],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: out.code, stdout: decoder.decode(out.stdout), stderr: decoder.decode(out.stderr) };
}

async function processCwd(pid: number): Promise<string | null> {
  try {
    if (Deno.build.os === "linux") return await Deno.readLink(`/proc/${pid}/cwd`);
    // macOS: lsof's `n` field of the process's cwd descriptor.
    const out = await run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const line = out.stdout.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

async function qmp(socketPath: string, timeoutMs: number): Promise<QmpSession> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  return await openQmpSession(conn, timeoutMs);
}

/** The machine Hangar runs on. */
export function denoHost(): Host {
  return {
    home: homeFolder(Deno.build.os, (name) => Deno.env.get(name)),
    os: Deno.build.os,
    run,
    spawnDetached(program, args, options) {
      // Output appended to the VM's log through a shell redirection; `exec` keeps the pid QEMU's
      // (or start.sh's, which execs QEMU in turn).
      const child = new Deno.Command("/bin/sh", {
        args: ["-c", 'exec "$0" "$@" >>"$HANGAR_LOG" 2>&1', program, ...args],
        cwd: options.cwd,
        env: { ...options.env, HANGAR_LOG: options.logFile },
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      child.unref();
      // A daemonizing start exits at once; nobody reads its status.
      child.status.catch(() => {});
      return Promise.resolve(child.pid);
    },
    async processes(): Promise<ProcessInfo[]> {
      const ps = psProgram(Deno.build.os);
      return ps ? parsePs((await run(ps, PS_ARGS)).stdout) : [];
    },
    processCwd,
    kill(pid, signal) {
      Deno.kill(pid, signal);
    },
    qmp,
    readTextFile: (path) => Deno.readTextFile(path),
    writeTextFile: (path, text) => Deno.writeTextFile(path, text),
    copyFile: (from, to) => Deno.copyFile(from, to),
    async readDir(path): Promise<DirEntry[]> {
      const out: DirEntry[] = [];
      for await (const e of Deno.readDir(path)) {
        out.push({ name: e.name, isDirectory: e.isDirectory, isFile: e.isFile });
      }
      return out;
    },
    async exists(path) {
      try {
        await Deno.lstat(path);
        return true;
      } catch {
        return false;
      }
    },
    async realPath(path) {
      try {
        return await Deno.realPath(path);
      } catch {
        return null;
      }
    },
    async fileSize(path) {
      try {
        return (await Deno.stat(path)).size;
      } catch {
        return null;
      }
    },
    mkdir: (path) => Deno.mkdir(path, { recursive: true }),
    removeFile: (path) => Deno.remove(path),
    totalMemoryBytes: () => Deno.systemMemoryInfo().total,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
