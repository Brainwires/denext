// Stop a server the way a Windows console (or a service wrapper) does: Ctrl-C / Ctrl-Break.
//
// Windows has no SIGTERM: Deno's `kill("SIGTERM")` there is `TerminateProcess`, which no handler
// sees, and a console control event can't be addressed to one process — it reaches every process
// on a console. So on Windows the server runs under this module as a script: it moves itself to a
// console of its own (hidden), spawns the server there with Ctrl-C enabled, relays the server's
// output, and on a line from its stdin (`c` / `break`) raises that event on its own console, which
// only it and the server share. On POSIX, `spawnStoppable` spawns the server directly and stops it
// with SIGTERM.

/** A server under test that can be stopped as its platform stops one. */
export interface Stoppable {
  /** The process: the server itself on POSIX, this module's relay on Windows. */
  child: Deno.ChildProcess;
  /**
   * Ask for a graceful stop: SIGTERM on POSIX, the console event `kind` on Windows (once; a second
   * call does nothing there).
   */
  stop(kind?: "c" | "break"): Promise<void>;
}

/**
 * Spawn `cmd args` with piped stdout / stderr, stoppable gracefully on every platform.
 *
 * @param cmd The executable.
 * @param args Its arguments.
 * @param options The working directory and environment.
 * @returns The process and its stop function.
 */
export function spawnStoppable(
  cmd: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): Stoppable {
  if (Deno.build.os !== "windows") {
    const child = new Deno.Command(cmd, {
      args,
      ...options,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    return {
      child,
      stop: () => {
        child.kill("SIGTERM");
        return Promise.resolve();
      },
    };
  }
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--unstable-ffi", new URL(import.meta.url).href, cmd, ...args],
    ...options,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  // The relay's stdin is closed once it has the stop line (the relay reads to its end), or when
  // the relay exits unstopped: the resource sanitizer fails a test that leaves it open.
  let closing: Promise<void> | undefined;
  const close = () => closing ??= writer.close().catch(() => {});
  child.status.then(close, close);
  return {
    child,
    stop: async (kind = "c") => {
      if (closing) return; // one stop: the event reached the server's console already
      await writer.write(new TextEncoder().encode(`${kind}\n`));
      await close();
    },
  };
}

/** The relay: run on Windows only (see the module comment). */
async function relay(cmd: string, args: string[]): Promise<never> {
  const k32 = Deno.dlopen("kernel32.dll", {
    FreeConsole: { parameters: [], result: "i32" },
    AllocConsole: { parameters: [], result: "i32" },
    GetConsoleWindow: { parameters: [], result: "pointer" },
    SetConsoleCtrlHandler: { parameters: ["pointer", "i32"], result: "i32" },
    GenerateConsoleCtrlEvent: { parameters: ["u32", "u32"], result: "i32" },
  });
  const user32 = Deno.dlopen("user32.dll", {
    ShowWindow: { parameters: ["pointer", "i32"], result: "i32" },
  });
  k32.symbols.FreeConsole();
  if (!k32.symbols.AllocConsole()) throw new Error("AllocConsole failed");
  const hwnd = k32.symbols.GetConsoleWindow();
  if (hwnd) user32.symbols.ShowWindow(hwnd, 0); // SW_HIDE
  // Ctrl-C on for this process and, inherited, the server (a parent may have started us with it off).
  k32.symbols.SetConsoleCtrlHandler(null, 0);
  // Survive the events this relay raises on its own console.
  Deno.addSignalListener("SIGINT", () => {});
  Deno.addSignalListener("SIGBREAK", () => {});
  const server = new Deno.Command(cmd, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const pipe = async (
    from: ReadableStream<Uint8Array>,
    to: { write(p: Uint8Array): Promise<number> },
  ) => {
    for await (const chunk of from) {
      for (let off = 0; off < chunk.length;) off += await to.write(chunk.subarray(off));
    }
  };
  const piped = Promise.all([pipe(server.stdout, Deno.stdout), pipe(server.stderr, Deno.stderr)]);
  (async () => {
    const lines = Deno.stdin.readable.pipeThrough(new TextDecoderStream());
    for await (const text of lines) {
      for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
        k32.symbols.GenerateConsoleCtrlEvent(line === "break" ? 1 : 0, 0);
      }
    }
  })();
  const { code } = await server.status;
  await piped;
  Deno.exit(code);
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  await relay(cmd, args);
}
