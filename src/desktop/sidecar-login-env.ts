/**
 * The user's login-shell environment for sidecars that opt in (`loginShellEnv`). An app started
 * from the Dock, Finder or Launchpad on macOS (and from some Linux desktop launchers) inherits a
 * minimal environment: `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`, so a backend cannot find what the
 * user installed with Homebrew, nvm, asdf, mise or Volta (`git`, `node`, `codex`, `claude`). As an
 * Electron app does, the host runs the user's `$SHELL` once per launch of the app as a login and
 * interactive shell (`-l -i -c`), which reads the same profile and rc files a terminal does, and
 * reads the variables it asked for back between sentinels (whatever the rc files print around
 * them is ignored).
 *
 * Bounded and never in the window's way: it runs when the first opted-in sidecar starts (after the
 * window's server is up), with a time budget (default 3 s) across every shell it tries, and a shell
 * that takes longer is killed. On a failure or a timeout a warning is logged and the sidecar starts
 * with the inherited environment. Only the variables asked for (`PATH`, merged with the inherited
 * one, plus `keys`) reach the sidecars that opt in: never the page, never the app's own
 * environment, and never a `DENO_*` / `DENEXT_*` variable. Windows has no such split (a GUI app
 * there gets the user's full environment): it is a no-op.
 *
 * Runtime-safe at import (no Deno APIs until called): the packaging code reads
 * {@linkcode LOGIN_SHELL_PATHS} to bake the shells' `--allow-run`.
 *
 * @module
 */

/** How long the login shell may take, across every shell tried, by default. */
export const LOGIN_SHELL_TIMEOUT_MS = 3_000;

/**
 * The shells a packaged app may run to read the login environment (its baked `--allow-run`), per
 * OS. A `$SHELL` outside the list is refused by Deno, and the next candidate (the OS's default
 * shell) is tried; add it to the sidecar's `permissions.run` to allow it.
 */
export const LOGIN_SHELL_PATHS: Readonly<Record<"darwin" | "linux", readonly string[]>> = {
  darwin: [
    "/bin/zsh",
    "/bin/bash",
    "/bin/sh",
    "/bin/ksh",
    "/opt/homebrew/bin/bash",
    "/opt/homebrew/bin/fish",
    "/opt/homebrew/bin/nu",
    "/opt/homebrew/bin/zsh",
    "/usr/local/bin/bash",
    "/usr/local/bin/fish",
    "/usr/local/bin/zsh",
  ],
  linux: [
    "/bin/bash",
    "/bin/sh",
    "/bin/zsh",
    "/usr/bin/bash",
    "/usr/bin/fish",
    "/usr/bin/sh",
    "/usr/bin/zsh",
    "/usr/local/bin/fish",
    "/usr/local/bin/zsh",
    "/home/linuxbrew/.linuxbrew/bin/bash",
    "/home/linuxbrew/.linuxbrew/bin/fish",
    "/home/linuxbrew/.linuxbrew/bin/zsh",
  ],
};

/** The OS's default shells, tried after `$SHELL`. */
const DEFAULT_SHELLS: Readonly<Record<"darwin" | "linux", readonly string[]>> = {
  darwin: ["/bin/zsh", "/bin/bash"],
  linux: ["/bin/bash", "/bin/sh"],
};

/**
 * Whether the login environment never hands `name` over: the runtime's and denext's own variables
 * (`DENO_*`, `DENEXT_*`).
 *
 * @param name A variable name.
 * @returns `true` for a reserved name.
 */
export function isReservedLoginVariable(name: string): boolean {
  return /^(DENO|DENEXT)_/i.test(name);
}

/** What one shell run produced. */
export type LoginShellRunResult =
  | { readonly kind: "exit"; readonly code: number; readonly stdout: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Runs one shell: `shell` with `args`, exactly `env` as its environment, stdin closed, stderr
 * discarded; killed once `timeoutMs` passes. Never rejects.
 */
export type LoginShellRunner = (
  shell: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
) => Promise<LoginShellRunResult>;

/** Options for {@linkcode captureLoginShellEnv}. */
export interface LoginShellCaptureOptions {
  /** The variables to read (`PATH` is always read). */
  readonly names?: readonly string[];
  /** The budget across every shell tried (default {@linkcode LOGIN_SHELL_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** The OS (default `Deno.build.os`). */
  readonly os?: string;
  /** The app's environment: `SHELL`, and what the shell starts with (default `Deno.env`). */
  readonly env?: Readonly<Record<string, string>>;
  /** Runs a shell (default: `Deno.Command`; tests pass a fake). */
  readonly run?: LoginShellRunner;
  /** The clock for the budget (default `Date.now`). */
  readonly now?: () => number;
}

/** What {@linkcode captureLoginShellEnv} found. */
export type LoginShellCapture =
  | {
    readonly ok: true;
    /** The shell that answered. */
    readonly shell: string;
    /** The variables it has set (an unset or empty one is left out). */
    readonly env: Readonly<Record<string, string>>;
  }
  | {
    readonly ok: false;
    /** Why nothing was read (`""` on Windows and other OSes, where there is nothing to do). */
    readonly reason: string;
  };

/** The marker around one variable's value; split in the command so its text never matches. */
function marker(nonce: string, name: string, edge: "START" | "END"): string {
  return `__DENEXT_ENV_${nonce}_${name}_${edge}__`;
}

/**
 * The command the shell runs: for each name, a start marker, `printenv NAME`, an end marker. Only
 * `printf` and `printenv` with `;` between them, so it means the same in sh, bash, zsh, ksh, fish
 * and nu. A marker is printed as two `%s` halves, so a shell that echoes its command (`set -v`)
 * cannot fake one.
 *
 * @param names The variable names (already checked: letters, digits, `_`).
 * @param nonce A per-run random tag.
 * @returns The command.
 */
export function loginShellCommand(names: readonly string[], nonce: string): string {
  const half = (m: string) => {
    const at = Math.floor(m.length / 2);
    return `printf '%s%s\\n' '${m.slice(0, at)}' '${m.slice(at)}'`;
  };
  return names.map((name) =>
    [
      half(marker(nonce, name, "START")),
      `printenv ${name}`,
      half(marker(nonce, name, "END")),
    ].join("; ")
  ).join("; ");
}

/**
 * The variables between the markers of `output`: rc-file noise around them is ignored, one newline
 * after the start marker and before the end one is dropped, and an empty value is left out.
 *
 * @param output What the shell printed.
 * @param names The variable names.
 * @param nonce The run's tag.
 * @returns The values, or `null` when the `PATH` markers are missing (the command never ran).
 */
export function parseLoginShellOutput(
  output: string,
  names: readonly string[],
  nonce: string,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  let sawPath = false;
  for (const name of names) {
    const start = marker(nonce, name, "START");
    const at = output.indexOf(start);
    if (at < 0) continue;
    const from = at + start.length;
    const end = output.indexOf(marker(nonce, name, "END"), from);
    if (end < 0) continue;
    if (name === "PATH") sawPath = true;
    const value = output.slice(from, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    if (value !== "") out[name] = value;
  }
  return sawPath ? out : null;
}

/**
 * The shells to try: `$SHELL` (unless it is csh / tcsh, whose `-l` takes no other flag), then the
 * OS's defaults.
 *
 * @param os The OS.
 * @param shell The app's `SHELL`.
 * @returns The absolute shell paths, in order.
 */
export function loginShellCandidates(os: "darwin" | "linux", shell: string | undefined): string[] {
  const out: string[] = [];
  if (shell && shell.startsWith("/") && !/(^|\/)t?csh$/.test(shell)) out.push(shell);
  for (const s of DEFAULT_SHELLS[os]) if (!out.includes(s)) out.push(s);
  return out;
}

/** The environment the probe shell starts with: the app's, without `DENO_*` / `DENEXT_*`. */
function probeEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (!isReservedLoginVariable(k)) out[k] = v;
  return out;
}

/** The real runner: `Deno.Command`, killed (and its output abandoned) at the timeout. */
export const denoLoginShellRunner: LoginShellRunner = async (shell, args, env, timeoutMs) => {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(shell, {
      args: [...args],
      clearEnv: true,
      env: { ...env },
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const read = (async () => {
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += value;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((r) => timer = setTimeout(() => r("timeout"), timeoutMs));
  const done = Promise.all([read, child.status]);
  const first = await Promise.race([done, timedOut]).catch((err: Error) => err);
  clearTimeout(timer);
  if (first === "timeout") {
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
    // A grandchild may hold the pipe open: stop reading rather than wait for it.
    await reader.cancel().catch(() => {});
    await read.catch(() => {});
    await child.status.catch(() => {});
    return { kind: "timeout" };
  }
  if (first instanceof Error) return { kind: "error", message: first.message };
  const [stdout, status] = first;
  return { kind: "exit", code: status.code, stdout };
};

/**
 * Read the user's login-shell environment: `$SHELL -l -i -c <command>`, then the OS's default
 * shells while one fails, all within `timeoutMs`. A shell counts once it exits 0 with the `PATH`
 * markers in its output; a timeout ends the search.
 *
 * @param options The names, budget and (for tests) the runner, OS and environment.
 * @returns The variables, or why there are none.
 */
export async function captureLoginShellEnv(
  options: LoginShellCaptureOptions = {},
): Promise<LoginShellCapture> {
  const os = options.os ?? Deno.build.os;
  if (os !== "darwin" && os !== "linux") return { ok: false, reason: "" };
  const env = options.env ?? Deno.env.toObject();
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS;
  const attempt: Attempt = {
    names: loginNames(options.names),
    env: probeEnv(env),
    run: options.run ?? denoLoginShellRunner,
    timeoutMs,
  };
  const deadline = now() + timeoutMs;
  const failures: string[] = [];
  for (const shell of loginShellCandidates(os, env.SHELL)) {
    const left = deadline - now();
    if (left <= 0) {
      failures.push(`timed out after ${timeoutMs} ms`);
      break;
    }
    const outcome = await tryShell(shell, left, attempt);
    if ("env" in outcome) return { ok: true, shell, env: outcome.env };
    failures.push(outcome.failure);
    if (outcome.stop) break;
  }
  return { ok: false, reason: failures.join("; ") };
}

/** What every shell of one capture is run with. */
interface Attempt {
  readonly names: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly run: LoginShellRunner;
  readonly timeoutMs: number;
}

/** `PATH`, then the valid, unreserved names asked for. */
function loginNames(asked: readonly string[] = []): string[] {
  return [
    "PATH",
    ...asked.filter((n) =>
      n !== "PATH" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !isReservedLoginVariable(n)
    ),
  ];
}

/** One shell's answer: its variables, or why not (and whether to stop looking: a timeout). */
async function tryShell(
  shell: string,
  left: number,
  attempt: Attempt,
): Promise<{ env: Record<string, string> } | { failure: string; stop: boolean }> {
  const nonce = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const args = ["-l", "-i", "-c", loginShellCommand(attempt.names, nonce)];
  const result = await attempt.run(shell, args, attempt.env, left);
  if (result.kind === "timeout") {
    return { failure: `${shell} timed out after ${attempt.timeoutMs} ms`, stop: true };
  }
  if (result.kind === "error") return { failure: `${shell}: ${result.message}`, stop: false };
  if (result.code !== 0) return { failure: `${shell} exited ${result.code}`, stop: false };
  const values = parseLoginShellOutput(result.stdout, attempt.names, nonce);
  return values ? { env: values } : { failure: `${shell} printed no environment`, stop: false };
}

/**
 * The variables one sidecar gets from a captured login environment: `PATH` as the login shell's
 * entries, then the inherited ones it lacks (deduplicated, empty entries dropped), and each of
 * `keys` the login shell has set. Never a `DENO_*` / `DENEXT_*` variable.
 *
 * @param captured The login shell's variables.
 * @param keys The further variables this sidecar asked for.
 * @param inheritedPath The app's own `PATH`.
 * @returns The variables to lay under the sidecar's `env`.
 */
export function loginEnvPatch(
  captured: Readonly<Record<string, string>>,
  keys: readonly string[],
  inheritedPath: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (key !== "PATH" && !isReservedLoginVariable(key) && captured[key] !== undefined) {
      out[key] = captured[key];
    }
  }
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of [...(captured.PATH ?? "").split(":"), ...(inheritedPath ?? "").split(":")]) {
    if (entry === "" || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  if (entries.length > 0) out.PATH = entries.join(":");
  return out;
}
