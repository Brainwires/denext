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
 * never touch the OS store. */
export type SecureRunner = (
  cmd: string,
  args: string[],
  stdin?: string,
  signal?: AbortSignal,
) => Promise<{ code: number; stdout: string }>;

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

/** The default runner (exported for the real-Keychain test): spawn the CLI, feed `stdin` if given, capture stdout; map a missing binary to
 * a fail-closed error. */
export async function runSecureCli(
  cmd: string,
  args: string[],
  stdin?: string,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string }> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(cmd, {
      args,
      // The bridge's per-method timeout aborts this signal; Deno then kills the child, so a hung
      // credential CLI does not outlive the deadline.
      signal,
      stdin: stdin !== undefined ? "piped" : "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch {
    throw new DesktopCapError(
      "backend_unavailable",
      `the secure-store backend "${cmd}" is not available`,
    );
  }
  if (stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const { code, stdout } = await child.output();
  return { code, stdout: new TextDecoder().decode(stdout) };
}

/** Options for {@linkcode secureStoreCapability}. */
export interface SecureStoreDeps {
  /** The app-specific service name (the keychain "service" / secret-tool `service` attribute). */
  readonly service: string;
  /** The OS (defaults to the running one). */
  readonly os?: Os;
  /** The CLI runner (defaults to a real subprocess); tests inject a fake store. */
  readonly run?: SecureRunner;
}

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

  // One permission descriptor + one Windows-refuse-and-read-key preamble, shared by all methods.
  // Windows has no backend (fails closed, spawns nothing) so it declares NO `--allow-run`.
  const permissions: DesktopPermissions = os === "darwin"
    ? { run: ["security"] }
    : os === "linux"
    ? { run: ["secret-tool"] }
    : { run: ["powershell.exe"] };
  const keyArg = (args: unknown): string => safeKey(str((args as { key?: unknown })?.key, "key"));
  const exec = (
    op: "get" | "set" | "delete",
    key: string,
    b64: string | undefined,
    signal: AbortSignal,
  ) => {
    const c = secureStoreCommand(os, op, service, key, b64);
    return run(c.cmd, c.args, c.stdin, signal);
  };

  return {
    name: "secureStore",
    methods: {
      get: {
        permissions,
        handler: async (args, ctx) => {
          const { code, stdout } = await exec("get", keyArg(args), undefined, ctx.signal);
          if (code !== 0) return null; // not found (a missing backend already threw)
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
          const { code } = await exec("set", key, b64, ctx.signal);
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
          // a non-zero (not found) is fine — delete is idempotent
          await exec("delete", keyArg(args), undefined, ctx.signal);
          return { ok: true };
        },
      },
    },
  };
}
