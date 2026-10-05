/**
 * The `secureStore` capability: store/read/delete a small secret in the OS credential store on
 * Deno Desktop (see `secureGet`/`secureSet`/`secureDelete` in `src/desktop/native.ts`). Keyed by an
 * app-specific service name + the caller's key.
 *
 * Backends are the OS credential CLIs (subprocess, argv — no shell), chosen for safety over raw FFI:
 * - macOS: `security add/find/delete-generic-password` (the login Keychain). A write runs
 *   `security -i` and sends the command line on STDIN, so the secret is never argv.
 * - Linux: `secret-tool store/lookup/clear` (libsecret / the Secret Service). The secret is written
 *   on STDIN, never argv.
 * - Windows: WinRT `PasswordVault` via Windows PowerShell (see WINDOWS_VAULT_SCRIPT). Every value
 *   travels on STDIN as JSON, never argv (PowerShell `-Command` joins trailing argv into the command
 *   text). Verified by the Windows CI (a real PasswordVault set/get/delete round-trip).
 *
 * Values are stored base64-of-UTF-8, so a newline, quote or non-ASCII byte in the value can never
 * corrupt the round-trip or the command. FAIL CLOSED: if the backend is missing (no `security` /
 * `secret-tool`, or no running Secret Service), a write/read is a real error, not a silent success
 * or a plaintext fallback.
 *
 * NOTE (Linux): `secret-tool` is in `libsecret-tools` (Debian/Ubuntu) or `libsecret` (Fedora), which
 * a stock desktop may not ship. Its failures all exit 1, so they are told apart by stderr (checked
 * against secret-tool 0.21 with gnome-keyring): not found is a silent exit 1; no session bus, no
 * Secret Service provider and a locked collection on a write print `secret-tool: …`. A lookup or
 * clear in a LOCKED collection is silent too, so a silent miss is double-checked with
 * `secret-tool search` (which lists a locked item without its secret): an item there means the
 * keyring is locked. Each of those cases is `backend_unavailable` with the reason, never `null`.
 *
 * NOTE (macOS): `security -i` exits 0 even when a command it read fails, so a write is confirmed
 * by reading the value back. Items written through `security` trust `/usr/bin/security` in their
 * ACL, so another process of the SAME USER that runs `security find-generic-password` can read
 * them without a prompt — the same local-process trust boundary the bridge already accepts (see
 * `bridge.ts` and KNOWN-LIMITATIONS.md).
 *
 * Runtime-only (imported by the desktop entry via the caps resolver, never a client bundle).
 *
 * @module
 */

import { base64ToBytes, bytesToBase64 } from "../../mobile/base64.ts";
import { type DesktopCapability, DesktopCapError, type DesktopPermissions } from "../extension.ts";

/** The running OS spelling the command builder branches on. */
type Os = "darwin" | "windows" | "linux";

/** Run a credential CLI (argv, no shell; optional stdin; optional abort signal). Injected so tests
 * never touch the OS store. `stderr` tells a Linux backend failure from a miss (see the module). */
export type SecureRunner = (
  cmd: string,
  args: string[],
  stdin?: string,
  signal?: AbortSignal,
) => Promise<{ code: number; stdout: string; stderr?: string }>;

/** How to install `secret-tool`, for the `backend_unavailable` reason. */
const SECRET_TOOL_INSTALL = "install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora)";
/** The reason when no Secret Service answers. */
const NO_PROVIDER = "no Secret Service provider (gnome-keyring or KWallet)";

/** A credential-CLI invocation: the command, its argv, and optional stdin (the secret, on every OS
 * that writes one). */
export interface SecureCommand {
  readonly cmd: string;
  readonly args: string[];
  readonly stdin?: string;
}

/**
 * The Windows credential script: WinRT `PasswordVault` driven by Windows PowerShell (5.1 projects
 * WinRT types; the cap spawns `powershell.exe`, not `pwsh`). It is a CONSTANT — every value
 * (service, key, secret) arrives on STDIN as JSON and is read with `ConvertFrom-Json`, NEVER
 * interpolated into the command, because PowerShell `-Command` joins trailing argv into the command
 * text (so a page-supplied key/value on argv would be a command-injection). `get` writes the stored
 * password to stdout (exit 1 when absent); `set` upserts; `delete` is idempotent.
 *
 * NOTE (verification): the injection-safe SHAPE (constant script + JSON on stdin) is unit-tested
 * here, but the WinRT round-trip runs only on Windows — it is exercised by the Windows packaging CI,
 * not locally.
 */
const WINDOWS_VAULT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$p=[Console]::In.ReadToEnd()|ConvertFrom-Json",
  "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]",
  "$v=New-Object Windows.Security.Credentials.PasswordVault",
  "switch($p.op){",
  "'get'{try{$c=$v.Retrieve($p.service,$p.key);$c.RetrievePassword();[Console]::Out.Write($c.Password)}catch{exit 1}}",
  "'set'{try{$old=$v.Retrieve($p.service,$p.key);$v.Remove($old)}catch{};$v.Add((New-Object Windows.Security.Credentials.PasswordCredential($p.service,$p.key,$p.value)))}",
  "'delete'{try{$c=$v.Retrieve($p.service,$p.key);$v.Remove($c)}catch{}}",
  "}",
].join("\n");

/**
 * Quote one argument for the `security -i` command-line parser: double quotes, with `\` and `"`
 * backslash-escaped. Keys reaching here have no control characters (see `safeKey`).
 *
 * @param value The argument.
 * @returns The quoted argument.
 */
function securityQuote(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * The credential-CLI invocation for `op`. Pure + exported so every OS's argv and stdin are
 * unit-tested. The value (already base64) is never argv: it travels on STDIN to macOS
 * (`security -i`), Linux (`secret-tool`) and Windows (`powershell.exe` + WinRT PasswordVault).
 *
 * @param os The target OS.
 * @param op `get` / `set` / `delete`.
 * @param service The app-specific service name.
 * @param key The account/key.
 * @param b64 The base64 value (for `set`).
 * @returns The invocation.
 */
export function secureStoreCommand(
  os: Os,
  op: "get" | "set" | "delete",
  service: string,
  key: string,
  b64?: string,
): SecureCommand {
  if (os === "windows") {
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_VAULT_SCRIPT],
      stdin: JSON.stringify({ op, service, key, value: b64 ?? null }),
    };
  }
  if (os === "darwin") {
    if (op === "get") {
      return { cmd: "security", args: ["find-generic-password", "-a", key, "-s", service, "-w"] };
    }
    if (op === "delete") {
      return { cmd: "security", args: ["delete-generic-password", "-a", key, "-s", service] };
    }
    // `security -i` reads commands from stdin, so the secret never appears in `ps`.
    const line = ["add-generic-password", "-U", "-a", securityQuote(key), "-s"]
      .concat(securityQuote(service), "-w", securityQuote(b64 ?? ""))
      .join(" ");
    return { cmd: "security", args: ["-i"], stdin: `${line}\n` };
  }
  // linux (secret-tool): the secret travels on stdin, never argv.
  if (op === "get") {
    return { cmd: "secret-tool", args: ["lookup", "service", service, "account", key] };
  }
  if (op === "delete") {
    return { cmd: "secret-tool", args: ["clear", "service", service, "account", key] };
  }
  return {
    cmd: "secret-tool",
    args: ["store", "--label", service, "service", service, "account", key],
    stdin: b64 ?? "",
  };
}

/**
 * The `backend_unavailable` error for a credential CLI that could not be started.
 *
 * @param cmd The command.
 * @param err Why the spawn failed.
 * @returns The error.
 */
export function missingBackendError(cmd: string, err: unknown): DesktopCapError {
  const notFound = err instanceof Deno.errors.NotFound;
  const message = cmd === "secret-tool" && notFound
    ? `the secure store needs secret-tool, which is not installed: ${SECRET_TOOL_INSTALL}`
    : `the secure-store backend "${cmd}" is not available`;
  return new DesktopCapError("backend_unavailable", message, { status: 503 });
}

/** The default runner (exported for the real-Keychain test): spawn the CLI, feed `stdin` if given,
 * capture stdout and stderr; map a missing binary to a fail-closed error. */
export async function runSecureCli(
  cmd: string,
  args: string[],
  stdin?: string,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(cmd, {
      args,
      // The bridge's per-method timeout aborts this signal; Deno then kills the child, so a hung
      // credential CLI does not outlive the deadline.
      signal,
      stdin: stdin !== undefined ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (err) {
    throw missingBackendError(cmd, err);
  }
  if (stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const { code, stdout, stderr } = await child.output();
  const text = new TextDecoder();
  return { code, stdout: text.decode(stdout), stderr: text.decode(stderr) };
}

/**
 * The `backend_unavailable` error for a failing `secret-tool` run (its stderr, non-empty): no
 * session bus, no Secret Service provider, a locked collection, or another Secret Service error.
 *
 * @param stderr What secret-tool printed.
 * @returns The error.
 */
export function secretToolError(stderr: string): DesktopCapError {
  const line = stderr.trim().split("\n")[0].replace(/^secret-tool:\s*/, "").slice(0, 200);
  let reason: string;
  if (/not provided by any \.service files|ServiceUnknown|org\.freedesktop\.secrets/i.test(line)) {
    reason = `${NO_PROVIDER} is running on the session bus`;
  } else if (/could not connect|autolaunch|DBUS_SESSION_BUS_ADDRESS|session bus/i.test(line)) {
    reason = `no D-Bus session bus, so ${NO_PROVIDER} can answer`;
  } else if (/locked/i.test(line)) {
    reason = "the keyring is locked (unlock it, or sign in to the desktop session)";
  } else {
    // The message crosses to the page: no paths (a socket or object path) in it.
    reason = `the Secret Service failed (${line.replace(/\/[^\s'"]*/g, "…")})`;
  }
  return new DesktopCapError("backend_unavailable", `the secure store is unavailable: ${reason}`, {
    status: 503,
  });
}

/** The error for an item that exists but whose collection is locked (a silent lookup / clear). */
function lockedError(): DesktopCapError {
  return secretToolError("secret-tool: the collection is locked");
}

/** The error for a Secret Service that did not answer in time (an unanswered unlock prompt). */
function noAnswerError(ms: number): DesktopCapError {
  return new DesktopCapError(
    "backend_unavailable",
    `the secure store is unavailable: the Secret Service did not answer within ${ms / 1000} s ` +
      "(the keyring is probably locked, waiting for an unlock prompt nobody answered)",
    { status: 503 },
  );
}

/** Options for {@linkcode secureStoreCapability}. */
export interface SecureStoreDeps {
  /** The app-specific service name (the keychain "service" / secret-tool `service` attribute). */
  readonly service: string;
  /** The OS (defaults to the running one). */
  readonly os?: Os;
  /** The CLI runner (defaults to a real subprocess); tests inject a fake store. */
  readonly run?: SecureRunner;
  /**
   * Linux: how long `secret-tool` may wait for the Secret Service (default 20 s, under the
   * bridge's 30 s deadline) before the call fails `backend_unavailable` — a locked keyring whose
   * unlock prompt nobody can answer otherwise just hangs.
   */
  readonly answerTimeoutMs?: number;
}

/** The default {@linkcode SecureStoreDeps.answerTimeoutMs}. */
const LINUX_ANSWER_TIMEOUT_MS = 20_000;

/** Require a string arg. */
function str(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new DesktopCapError("validation", `${name} must be a string`);
  }
  return value;
}

/**
 * Reject a page-supplied key an OS credential CLI could misread: `secret-tool` takes the key as a
 * positional attribute VALUE, where a leading `-` is parsed as an option (getopt), and a control
 * character or NUL would corrupt the argv. (macOS `security -a <key>` is safe — the value follows an
 * option flag — but this is validated uniformly for every backend.) Tool-agnostic, so it does not
 * depend on any one CLI's `--` handling.
 *
 * @param key The account/key from the page.
 * @returns The key, when safe.
 */
function safeKey(key: string): string {
  // deno-lint-ignore no-control-regex
  if (key.startsWith("-") || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new DesktopCapError(
      "validation",
      "key must not start with '-' or contain control characters",
    );
  }
  return key;
}

/**
 * Build the `secureStore` capability.
 *
 * @param deps The service name, and (for tests) the OS and runner.
 * @returns The `secureStore` {@link DesktopCapability}.
 */
export function secureStoreCapability(deps: SecureStoreDeps): DesktopCapability {
  const os = deps.os ?? (Deno.build.os as Os);
  const run = deps.run ?? runSecureCli;
  const service = deps.service;

  // One permission descriptor + one read-key preamble, shared by all methods.
  const permissions: DesktopPermissions = os === "darwin"
    ? { run: ["security"] }
    : os === "linux"
    ? { run: ["secret-tool"] }
    : { run: ["powershell.exe"] };
  const keyArg = (args: unknown): string => safeKey(str((args as { key?: unknown })?.key, "key"));
  const answerMs = deps.answerTimeoutMs ?? LINUX_ANSWER_TIMEOUT_MS;
  /** Linux: `run`, killed and `backend_unavailable` when the Secret Service does not answer. */
  const runLinux = async (args: string[], stdin: string | undefined, signal: AbortSignal) => {
    const late = new AbortController();
    const timer = setTimeout(() => late.abort(), answerMs);
    const both = AbortSignal.any([signal, late.signal]);
    try {
      const result = await Promise.race([
        run("secret-tool", args, stdin, both),
        new Promise<never>((_, reject) =>
          late.signal.addEventListener("abort", () => reject(noAnswerError(answerMs)))
        ),
      ]);
      return result;
    } catch (err) {
      throw late.signal.aborted && !signal.aborted ? noAnswerError(answerMs) : err;
    } finally {
      clearTimeout(timer);
    }
  };
  const exec = (
    op: "get" | "set" | "delete",
    key: string,
    b64: string | undefined,
    signal: AbortSignal,
  ) => {
    const c = secureStoreCommand(os, op, service, key, b64);
    if (os === "linux") return runLinux(c.args, c.stdin, signal);
    return run(c.cmd, c.args, c.stdin, signal);
  };
  /**
   * Linux: a non-zero `secret-tool` exit as a miss (`false`), or a thrown `backend_unavailable`.
   * A failure prints to stderr; a silent one is a miss unless `search` still lists the item (its
   * collection is locked: lookup and clear exit 1 silently there).
   */
  const linuxMiss = async (
    result: { stderr?: string },
    key: string,
    signal: AbortSignal,
  ): Promise<false> => {
    if (result.stderr?.trim()) throw secretToolError(result.stderr);
    const probe = await runLinux(["search", "service", service, "account", key], undefined, signal);
    if (probe.stderr?.trim() && probe.code !== 0) throw secretToolError(probe.stderr);
    if (probe.stdout.trim() !== "") throw lockedError();
    return false;
  };

  return {
    name: "secureStore",
    methods: {
      get: {
        permissions,
        handler: async (args, ctx) => {
          const key = keyArg(args);
          const result = await exec("get", key, undefined, ctx.signal);
          const { code, stdout } = result;
          if (code !== 0) {
            // Linux: a backend failure throws; else not found (a missing backend already threw).
            if (os === "linux") await linuxMiss(result, key, ctx.signal);
            return null;
          }
          const b64 = stdout.trim();
          if (!b64) return null;
          try {
            return new TextDecoder().decode(base64ToBytes(b64));
          } catch {
            return null; // a value not written by this cap (not our base64) — treat as absent
          }
        },
      },
      set: {
        permissions,
        handler: async (args, ctx) => {
          const key = keyArg(args);
          const value = str((args as { value?: unknown })?.value, "value");
          const b64 = bytesToBase64(new TextEncoder().encode(value));
          const result = await exec("set", key, b64, ctx.signal);
          const { code } = result;
          if (os === "linux" && code !== 0 && result.stderr?.trim()) {
            throw secretToolError(result.stderr);
          }
          // `security -i` exits 0 whatever its commands did, so on macOS read the value back.
          const stored = os === "darwin" && code === 0
            ? (await exec("get", key, undefined, ctx.signal)).stdout.trim() === b64
            : code === 0;
          if (!stored) {
            throw new DesktopCapError("store_failed", "the secure store rejected the write");
          }
          return { ok: true };
        },
      },
      delete: {
        permissions,
        handler: async (args, ctx) => {
          // a non-zero (not found) is fine — delete is idempotent — unless the backend failed
          const key = keyArg(args);
          const result = await exec("delete", key, undefined, ctx.signal);
          if (os === "linux" && result.code !== 0) await linuxMiss(result, key, ctx.signal);
          return { ok: true };
        },
      },
    },
  };
}
