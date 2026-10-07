/**
 * The `secureStore` capability: store/read/delete a small secret in the OS credential store on
 * Deno Desktop (see `secureGet`/`secureSet`/`secureDelete` in `src/desktop/native.ts`). Keyed by an
 * app-specific service name + the caller's key.
 *
 * Linux: the runtime's own secure store (`Deno.desktop.secureStore` in denext's pinned runtime: the
 * Secret Service through libsecret, which the runtime loads at run time, `libsecret-1.so.0`). It
 * refuses with the reason (no provider: "install gnome-keyring" / "enable KWallet's Secret
 * Service"; a locked keyring no one here can unlock, at once; an unlock nobody answers, after the
 * timeout), which this cap passes on as `backend_unavailable`. Items carry the attributes `service`
 * and `account`, as `secret-tool` writes them. A runtime without that store (the stock runtime) has
 * no Linux secure store: every call is `backend_unavailable`, never a plain file.
 *
 * On macOS and Windows the backends are the OS credential CLIs (subprocess, argv — no shell), chosen
 * for safety over raw FFI:
 * - macOS: `security add/find/delete-generic-password` (the login Keychain). A write runs
 *   `security -i` and sends the command line on STDIN, so the secret is never argv.
 * - Windows: WinRT `PasswordVault` via Windows PowerShell (see WINDOWS_VAULT_SCRIPT). Every value
 *   travels on STDIN as JSON, never argv (PowerShell `-Command` joins trailing argv into the command
 *   text). Verified by the Windows CI (a real PasswordVault set/get/delete round-trip).
 *
 * Values are stored base64-of-UTF-8, so a newline, quote or non-ASCII byte in the value can never
 * corrupt the round-trip or the command. FAIL CLOSED: if the backend is missing (no `security`, no
 * runtime store, or no running Secret Service), a write/read is a real error, not a silent success
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
import { type DesktopAppApi, desktopAppApi } from "../launch-events.ts";

/** The running OS spelling the capability branches on. */
type Os = "darwin" | "windows" | "linux";

/** Run a credential CLI (argv, no shell; optional stdin; optional abort signal). Injected so tests
 * never touch the OS store. */
export type SecureRunner = (
  cmd: string,
  args: string[],
  stdin?: string,
  signal?: AbortSignal,
) => Promise<{ code: number; stdout: string; stderr?: string }>;

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
 * (`security -i`) and Windows (`powershell.exe` + WinRT PasswordVault). Linux has no CLI backend:
 * the runtime's own store serves it.
 *
 * @param os The target OS (macOS or Windows).
 * @param op `get` / `set` / `delete`.
 * @param service The app-specific service name.
 * @param key The account/key.
 * @param b64 The base64 value (for `set`).
 * @returns The invocation.
 */
export function secureStoreCommand(
  os: Exclude<Os, "linux">,
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

/**
 * The `backend_unavailable` error for a credential CLI that could not be started.
 *
 * @param cmd The command.
 * @param err Why the spawn failed.
 * @returns The error.
 */
export function missingBackendError(cmd: string, _err: unknown): DesktopCapError {
  return new DesktopCapError(
    "backend_unavailable",
    `the secure-store backend "${cmd}" is not available`,
    { status: 503 },
  );
}

/**
 * The `backend_unavailable` error on Linux when the runtime has no secure store of its own (the
 * stock runtime): there is no other Linux backend.
 *
 * @returns The error.
 */
function noLinuxStoreError(): DesktopCapError {
  return new DesktopCapError(
    "backend_unavailable",
    "the secure store on Linux is the Deno Desktop runtime's own (the Secret Service through " +
      "libsecret), which this runtime does not have: run under denext's pinned runtime",
    { status: 503 },
  );
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
 * A stored value (base64 of UTF-8) as the page's string; `null` for none, or for a value this cap
 * didn't write (not our base64).
 */
function decodeStored(stored: string | null): string | null {
  const b64 = stored?.trim() ?? "";
  if (!b64) return null;
  try {
    return new TextDecoder().decode(base64ToBytes(b64));
  } catch {
    return null;
  }
}

/** Options for {@linkcode secureStoreCapability}. */
export interface SecureStoreDeps {
  /** The app-specific service name (the keychain "service" / the Secret Service `service` attribute). */
  readonly service: string;
  /** The OS (defaults to the running one). */
  readonly os?: Os;
  /** The CLI runner (defaults to a real subprocess); tests inject a fake store. */
  readonly run?: SecureRunner;
  /**
   * Linux: how long the Secret Service may take to answer (default 20 s, under the bridge's 30 s
   * deadline) before the call fails `backend_unavailable` — a locked keyring whose unlock prompt
   * nobody answers otherwise just hangs. The runtime's store gets it as its timeout.
   */
  readonly answerTimeoutMs?: number;
  /**
   * The runtime's app API (default `Deno.desktop`): its `secureStore`, when `supported`, is the
   * Linux backend; tests pass a fake, or `null` for a runtime without one.
   */
  readonly api?: DesktopAppApi | null;
}

/** The runtime's secure store (`Deno.desktop.secureStore`). */
type RuntimeSecureStore = NonNullable<DesktopAppApi["secureStore"]>;

/**
 * A rejection of the runtime's store as a capability error: `"SecureStoreUnavailable"` (no
 * provider, a locked keyring, no answer) is `backend_unavailable` with the runtime's reason; bad
 * arguments are `validation`.
 *
 * @param err What the runtime threw.
 * @returns The error.
 */
function runtimeSecureStoreError(err: unknown): DesktopCapError {
  const e = err as { name?: unknown; message?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message.slice(0, 400) : "";
  if (err instanceof TypeError) {
    return new DesktopCapError("validation", message || "invalid secure-store arguments");
  }
  return new DesktopCapError(
    "backend_unavailable",
    `the secure store is unavailable: ${message || "the Secret Service failed"}`,
    { status: 503 },
  );
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
 * Reject a page-supplied key an OS credential CLI could misread: a leading `-` could be parsed as
 * an option (getopt), and a control character or NUL would corrupt the argv. (macOS `security -a
 * <key>` is safe — the value follows an option flag — but this is validated uniformly for every
 * backend, the runtime's store included.) Tool-agnostic, so it does not depend on any one CLI's
 * `--` handling.
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

  // One permission descriptor + one read-key preamble, shared by all methods. Linux: the runtime's
  // store needs an unscoped --allow-sys (the user's keyring is shared by every app).
  const permissions: DesktopPermissions = os === "darwin"
    ? { run: ["security"] }
    : os === "linux"
    ? { sys: ["*"] }
    : { run: ["powershell.exe"] };
  /**
   * Linux: the runtime's own secure store (denext's pinned runtime); `backend_unavailable` when the
   * runtime has none. `undefined` on macOS and Windows (their CLIs).
   */
  const runtimeStore = (): RuntimeSecureStore | undefined => {
    if (os !== "linux") return undefined;
    let store: RuntimeSecureStore | undefined;
    try {
      const candidate = deps.api === null ? undefined : (deps.api ?? desktopAppApi())?.secureStore;
      store = candidate?.supported === true ? candidate : undefined;
    } catch {
      store = undefined;
    }
    if (!store) throw noLinuxStoreError();
    return store;
  };
  const keyArg = (args: unknown): string => safeKey(str((args as { key?: unknown })?.key, "key"));
  const answerMs = deps.answerTimeoutMs ?? LINUX_ANSWER_TIMEOUT_MS;
  const exec = (
    op: "get" | "set" | "delete",
    key: string,
    b64: string | undefined,
    signal: AbortSignal,
  ) => {
    const c = secureStoreCommand(os as Exclude<Os, "linux">, op, service, key, b64);
    return run(c.cmd, c.args, c.stdin, signal);
  };

  return {
    name: "secureStore",
    methods: {
      get: {
        permissions,
        handler: async (args, ctx) => {
          const key = keyArg(args);
          const store = runtimeStore();
          if (store) {
            let b64: string | null;
            try {
              b64 = await store.get(service, key, { timeout: answerMs });
            } catch (err) {
              throw runtimeSecureStoreError(err);
            }
            return decodeStored(b64);
          }
          const { code, stdout } = await exec("get", key, undefined, ctx.signal);
          // Not found (a missing backend already threw).
          if (code !== 0) return null;
          return decodeStored(stdout);
        },
      },
      set: {
        permissions,
        handler: async (args, ctx) => {
          const key = keyArg(args);
          const value = str((args as { value?: unknown })?.value, "value");
          const b64 = bytesToBase64(new TextEncoder().encode(value));
          const store = runtimeStore();
          if (store) {
            try {
              await store.set(service, key, b64, { label: service, timeout: answerMs });
            } catch (err) {
              throw runtimeSecureStoreError(err);
            }
            return { ok: true };
          }
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
          // a non-zero exit (not found) is fine: delete is idempotent
          const key = keyArg(args);
          const store = runtimeStore();
          if (store) {
            try {
              await store.delete(service, key, { timeout: answerMs });
            } catch (err) {
              throw runtimeSecureStoreError(err);
            }
            return { ok: true };
          }
          await exec("delete", key, undefined, ctx.signal);
          return { ok: true };
        },
      },
    },
  };
}
