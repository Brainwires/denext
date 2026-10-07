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
 * macOS: the runtime's own store when it has one (`Deno.desktop.secureStore` `supported`, denext's
 * pinned runtime from denext.13): the Keychain, written by the app's own process through
 * Security.framework, so the item is the app's: the data-protection keychain when the app is signed
 * with a keychain access group (a provisioning profile), else the login keychain with an access
 * list naming only the app. Another program of the same user gets macOS's prompt, never the secret.
 * Items an older denext wrote through `security` (which trust `/usr/bin/security`, so any program
 * of the user could read them through it) move over on their first read (see
 * `migratingBackend`), so a signed-in user keeps their tokens.
 *
 * Otherwise (macOS under an older or the stock runtime, and Windows) the backends are the OS
 * credential CLIs (subprocess, argv — no shell), chosen for safety over raw FFI:
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
 * NOTE (macOS, the `security` path): `security -i` exits 0 even when a command it read fails, so a
 * write is confirmed by reading the value back. Items written through `security` trust
 * `/usr/bin/security` in their ACL, so another process of the SAME USER that runs `security
 * find-generic-password` can read them without a prompt: the reason the runtime's store replaces
 * this path wherever the runtime has one.
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
   * The runtime's store (Linux, macOS): how long it may take to answer (default 20 s, under the
   * bridge's 30 s deadline) before the call fails `backend_unavailable` — a locked keyring whose
   * unlock prompt nobody answers otherwise just hangs. The runtime's store gets it as its timeout.
   */
  readonly answerTimeoutMs?: number;
  /**
   * The runtime's app API (default `Deno.desktop`): its `secureStore`, when `supported`, is the
   * Linux and macOS backend; tests pass a fake, or `null` for a runtime without one.
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

/** One backend's three operations, on base64 values (see `decodeStored`). */
interface SecureBackend {
  get(key: string, signal: AbortSignal): Promise<string | null>;
  set(key: string, b64: string, signal: AbortSignal): Promise<void>;
  delete(key: string, signal: AbortSignal): Promise<void>;
}

/**
 * The runtime's own store as a backend: every rejection is a capability error
 * (`runtimeSecureStoreError`).
 *
 * @param store The runtime's store.
 * @param service The app-specific service name.
 * @param timeout The answer timeout in milliseconds.
 * @returns The backend.
 */
function runtimeBackend(
  store: RuntimeSecureStore,
  service: string,
  timeout: number,
): SecureBackend {
  const guard = async <T>(p: () => Promise<T>): Promise<T> => {
    try {
      return await p();
    } catch (err) {
      throw runtimeSecureStoreError(err);
    }
  };
  return {
    get: (key) => guard(() => store.get(service, key, { timeout })),
    set: (key, b64) => guard(() => store.set(service, key, b64, { label: service, timeout })),
    delete: (key) => guard(() => store.delete(service, key, { timeout })),
  };
}

/**
 * The OS credential CLI as a backend (macOS `security`, Windows PowerShell + PasswordVault).
 *
 * @param os The OS.
 * @param service The app-specific service name.
 * @param run The CLI runner.
 * @returns The backend.
 */
function cliBackend(os: Exclude<Os, "linux">, service: string, run: SecureRunner): SecureBackend {
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
    get: async (key, signal) => {
      const { code, stdout } = await exec("get", key, undefined, signal);
      // Not found (a missing backend already threw).
      return code === 0 ? stdout.trim() : null;
    },
    set: async (key, b64, signal) => {
      const { code } = await exec("set", key, b64, signal);
      // `security -i` exits 0 whatever its commands did, so on macOS read the value back.
      const stored = os === "darwin" && code === 0
        ? (await exec("get", key, undefined, signal)).stdout.trim() === b64
        : code === 0;
      if (!stored) {
        throw new DesktopCapError("store_failed", "the secure store rejected the write");
      }
    },
    delete: async (key, signal) => {
      // A non-zero exit (not found) is fine: delete is idempotent.
      await exec("delete", key, undefined, signal);
    },
  };
}

/**
 * How long putting a legacy item back may take (`security -i add` plus the read-back): its own
 * deadline, well inside the bridge's 30 s per-method budget, since the caller's signal may already
 * be aborted by then.
 */
const RESTORE_TIMEOUT_MS = 10_000;

/** `kSecAttrCreator` of the items the runtime's macOS store writes, as `security` prints it. */
const RUNTIME_ITEM_CREATOR = '"crtr"<uint32>="Lfy1"';

/**
 * Whether the login keychain holds an item for (`service`, `key`) that the runtime's store did
 * not write: one an older denext wrote through `security`. Attributes only (`find-generic-password`
 * without `-w`), which macOS hands out without a prompt.
 *
 * @param run The CLI runner.
 * @param service The app-specific service name.
 * @param key The account/key.
 * @param signal Aborts the CLI.
 * @returns Whether such an item is there.
 */
async function legacyItemPresent(
  run: SecureRunner,
  service: string,
  key: string,
  signal: AbortSignal,
): Promise<boolean> {
  const { code, stdout } = await run(
    "security",
    ["find-generic-password", "-a", key, "-s", service],
    undefined,
    signal,
  );
  return code === 0 && !stdout.includes(RUNTIME_ITEM_CREATOR);
}

/**
 * Run each key's operations one at a time, in call order: a move (read legacy, delete it, store,
 * maybe put it back) is several steps, and a concurrent write or delete of the same key between
 * them could be undone by it, or leave two items.
 *
 * @returns `serial(key, op)`: `op` runs once every earlier operation on `key` has settled.
 */
function keyQueue(): <T>(key: string, op: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return (key, op) => {
    const result = (tails.get(key) ?? Promise.resolve()).then(op);
    const tail = result.then(() => {}, () => {});
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

/**
 * macOS under a runtime with its own store (the Keychain, written by the app's own process, so
 * only the app may read the item), with the items an older denext wrote through `/usr/bin/security`
 * moved over: those trust `security`, so any program of the user could read them. On a read miss
 * the legacy item is read with `security`, stored in the runtime's store, then deleted, so a
 * signed-in user keeps their tokens. A write or delete removes a legacy item too, so it can never
 * come back on a later read.
 *
 * In the login keychain the two can't coexist (one item per service + account): the runtime
 * refuses to store over an item it didn't write, so the legacy item is deleted first and, when the
 * store still fails, put back with the value it held (read with `security -w` before the delete),
 * on a write as on a read: a failed write leaves the old value, never nothing. A write first asks
 * the runtime's store for the key (no prompt): a store that can't answer (the keychain locked)
 * fails the write before the legacy item is touched. `security` is pointed at a (service, key)
 * only while the runtime's own item isn't there (`security delete-generic-password` would match it
 * too). Each key's operations run one at a time (see {@linkcode keyQueue}).
 *
 * @param runtime The runtime's store.
 * @param legacy The `security` CLI.
 * @param present Whether a legacy item is there (see {@linkcode legacyItemPresent}).
 * @returns The backend.
 */
function migratingBackend(
  runtime: SecureBackend,
  legacy: SecureBackend,
  present: (key: string, signal: AbortSignal) => Promise<boolean>,
): SecureBackend {
  // Keys with no legacy item left, as far as this process knows: no `security` call for them.
  const settled = new Set<string>();
  const serial = keyQueue();
  /**
   * Store `b64` in the runtime's store over a legacy item known to be there, holding `kept`
   * (`null`: it could not be read). When the store fails after the legacy item was deleted to make
   * room, the item is put back with `kept` and the store's error is thrown.
   */
  const replaceLegacy = async (
    key: string,
    b64: string,
    kept: string | null,
    signal: AbortSignal,
  ) => {
    try {
      // The data-protection keychain: no clash; the legacy copy goes after.
      await runtime.set(key, b64, signal);
      await legacy.delete(key, signal);
    } catch {
      // The login keychain: the legacy item is in the way.
      await legacy.delete(key, signal);
      await storeOrRestore(key, b64, kept, signal);
    }
    settled.add(key);
  };
  /**
   * Store `b64` where the legacy item was; on a failure put `kept` back, then throw the store's
   * error. The put-back runs under its own deadline ({@linkcode RESTORE_TIMEOUT_MS}), not the
   * caller's `signal`: when the store failed because that signal aborted (the bridge's per-method
   * timeout), it is already aborted, and `security` would be killed before it put the value back.
   */
  const storeOrRestore = async (
    key: string,
    b64: string,
    kept: string | null,
    signal: AbortSignal,
  ) => {
    try {
      await runtime.set(key, b64, signal);
    } catch (err) {
      if (kept !== null) {
        await legacy.set(key, kept, AbortSignal.timeout(RESTORE_TIMEOUT_MS)).catch(() => {});
      }
      throw err;
    }
  };
  /** A read miss: move a legacy item this cap wrote over, returning its value. */
  const migrateOnRead = async (key: string, signal: AbortSignal) => {
    const old = (await present(key, signal)) ? await legacy.get(key, signal) : null;
    // Not there, or not a value this cap wrote (not our base64): leave it alone.
    if (old === null || decodeStored(old) === null) {
      settled.add(key);
      return null;
    }
    // On a failure the user's value stays where it was (the next read retries the move).
    await replaceLegacy(key, old, old, signal).catch(() => {});
    return old;
  };
  /** A write while a legacy item may be there. */
  const migrateOnWrite = async (key: string, b64: string, signal: AbortSignal) => {
    if (!(await present(key, signal))) {
      await runtime.set(key, b64, signal);
      settled.add(key);
      return;
    }
    // Can the runtime's store answer at all (no prompt)? If not, nothing is touched.
    await runtime.get(key, signal);
    await replaceLegacy(key, b64, await legacy.get(key, signal), signal);
  };
  return {
    get: (key, signal) =>
      serial(key, async () => {
        const stored = await runtime.get(key, signal);
        if (stored !== null || settled.has(key)) return stored;
        return migrateOnRead(key, signal);
      }),
    set: (key, b64, signal) =>
      serial(
        key,
        () => settled.has(key) ? runtime.set(key, b64, signal) : migrateOnWrite(key, b64, signal),
      ),
    delete: (key, signal) =>
      serial(key, async () => {
        await runtime.delete(key, signal);
        // The runtime's item is gone, so `security` can only match a legacy one.
        if (!settled.has(key)) await legacy.delete(key, signal);
        settled.add(key);
      }),
  };
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

  // One permission descriptor + one read-key preamble, shared by all methods. The runtime's store
  // (Linux; macOS under a runtime that has it) needs an unscoped --allow-sys (the user's keyring
  // is shared by every app); macOS keeps `security` for runtimes without it and for moving older
  // items over.
  const permissions: DesktopPermissions = os === "darwin"
    ? { run: ["security"], sys: ["*"] }
    : os === "linux"
    ? { sys: ["*"] }
    : { run: ["powershell.exe"] };
  const answerMs = deps.answerTimeoutMs ?? LINUX_ANSWER_TIMEOUT_MS;
  /** The runtime's own secure store when it has one (`supported`), else `undefined`. */
  const runtimeStore = (): RuntimeSecureStore | undefined => {
    if (os === "windows") return undefined;
    try {
      const candidate = deps.api === null ? undefined : (deps.api ?? desktopAppApi())?.secureStore;
      return candidate?.supported === true ? candidate : undefined;
    } catch {
      return undefined;
    }
  };
  let migrating: { store: RuntimeSecureStore; backend: SecureBackend } | undefined;
  /**
   * The backend for this call: Linux, the runtime's store (`backend_unavailable` when the runtime
   * has none); macOS, the runtime's store with the legacy items moved over, else `security`;
   * Windows, PowerShell + PasswordVault.
   */
  const backend = (): SecureBackend => {
    const store = runtimeStore();
    if (os === "linux") {
      if (!store) throw noLinuxStoreError();
      return runtimeBackend(store, service, answerMs);
    }
    const cli = cliBackend(os, service, run);
    if (!store) return cli;
    if (migrating?.store !== store) {
      migrating = {
        store,
        backend: migratingBackend(
          runtimeBackend(store, service, answerMs),
          cli,
          (key, signal) => legacyItemPresent(run, service, key, signal),
        ),
      };
    }
    return migrating.backend;
  };
  const keyArg = (args: unknown): string => safeKey(str((args as { key?: unknown })?.key, "key"));

  return {
    name: "secureStore",
    methods: {
      get: {
        permissions,
        handler: async (args, ctx) => {
          const key = keyArg(args);
          return decodeStored(await backend().get(key, ctx.signal));
        },
      },
      set: {
        permissions,
        handler: async (args, ctx) => {
          const key = keyArg(args);
          const value = str((args as { value?: unknown })?.value, "value");
          await backend().set(key, bytesToBase64(new TextEncoder().encode(value)), ctx.signal);
          return { ok: true };
        },
      },
      delete: {
        permissions,
        handler: async (args, ctx) => {
          const key = keyArg(args);
          await backend().delete(key, ctx.signal);
          return { ok: true };
        },
      },
    },
  };
}
