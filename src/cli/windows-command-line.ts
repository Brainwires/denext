// This process's command line on Windows, where no `/proc/self/cmdline` or `ps` exists: kernel32's
// `GetCommandLineW` (one FFI call, so only with `--allow-ffi`, which `-A` grants), split into
// arguments by the rules every MSVC-built program, Deno included, parses its own with.
//
// The toolchain re-exec reads its parent's `--config` and resolution flags from here
// (`toolchainConfigArgs` in ./self-exec.ts). Without them a child started from a local checkout
// with an explicit `--config <app>/deno.json` discovered the checkout's own config instead, and
// the app's import map (an npm alias its `denext.config.ts` imports) was gone.

/**
 * Split a Windows command line into its arguments: whitespace separates them outside double
 * quotes; `2n` backslashes before a quote are `n` backslashes and the quote toggles quoting;
 * `2n+1` backslashes before a quote are `n` backslashes and a literal quote; other backslashes
 * are literal; `""` inside quotes is a literal quote. The first argument (the program) takes no
 * escapes: quotes only group.
 *
 * @param line The whole command line, as `GetCommandLineW` returns it.
 * @returns The arguments, the program first.
 */
export function splitWindowsCommandLine(line: string): string[] {
  const args: string[] = [];
  let at = skipBlanks(line, 0);
  if (at < line.length) {
    const program = readProgram(line, at);
    args.push(program.value);
    at = program.end;
  }
  for (at = skipBlanks(line, at); at < line.length; at = skipBlanks(line, at)) {
    const arg = readArgument(line, at);
    args.push(arg.value);
    at = arg.end;
  }
  return args;
}

/** One parsed token: its value and the index just past it. */
interface Token {
  value: string;
  end: number;
}

/** Whether `ch` separates arguments (outside quotes). */
function isBlank(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

/** The index of the first non-blank character at or after `at`. */
function skipBlanks(line: string, at: number): number {
  while (at < line.length && isBlank(line[at])) at++;
  return at;
}

/** The program name at `at`: quotes group, backslashes are literal. */
function readProgram(line: string, at: number): Token {
  let value = "";
  let quoted = false;
  for (; at < line.length && (quoted || !isBlank(line[at])); at++) {
    if (line[at] === '"') quoted = !quoted;
    else value += line[at];
  }
  return { value, end: at };
}

/** A run of backslashes at `at`, and what it means given the character after it. */
function readBackslashes(line: string, at: number): Token {
  const start = at;
  while (line[at] === "\\") at++;
  const n = at - start;
  if (line[at] !== '"') return { value: "\\".repeat(n), end: at };
  // Before a quote: n / 2 backslashes; an odd one escapes the quote into a literal, an even
  // count leaves the quote to toggle quoting.
  return n % 2 === 1
    ? { value: "\\".repeat(n >> 1) + '"', end: at + 1 }
    : { value: "\\".repeat(n >> 1), end: at };
}

/** One argument at `at` (after the program), with MSVC's quote and backslash rules. */
function readArgument(line: string, at: number): Token {
  let value = "";
  let quoted = false;
  while (at < line.length && (quoted || !isBlank(line[at]))) {
    if (line[at] === "\\") {
      const run = readBackslashes(line, at);
      value += run.value;
      at = run.end;
    } else if (line[at] !== '"') value += line[at++];
    else if (quoted && line[at + 1] === '"') {
      value += '"'; // "" inside quotes
      at += 2;
    } else {
      quoted = !quoted;
      at++;
    }
  }
  return { value, end: at };
}

/**
 * This process's command line on Windows, from `GetCommandLineW`.
 *
 * @returns The arguments (the program first), or `null` off Windows, without `--allow-ffi`, or
 *   when the call fails.
 */
export function windowsCommandLine(): string[] | null {
  if (Deno.build.os !== "windows") return null;
  try {
    if (Deno.permissions.querySync({ name: "ffi" }).state !== "granted") return null;
    const lib = Deno.dlopen("kernel32.dll", {
      GetCommandLineW: { parameters: [], result: "pointer" },
    });
    try {
      const ptr = lib.symbols.GetCommandLineW();
      if (ptr === null) return null;
      const view = new Deno.UnsafePointerView(ptr);
      let line = "";
      for (let at = 0;; at += 2) {
        const unit = view.getUint16(at);
        if (unit === 0) break;
        line += String.fromCharCode(unit);
      }
      return splitWindowsCommandLine(line);
    } finally {
      lib.close();
    }
  } catch {
    return null;
  }
}
