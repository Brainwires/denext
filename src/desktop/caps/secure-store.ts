/**
 * The `secureStore` capability: store/read/delete a small secret in the OS credential store on
 * Deno Desktop (see `secureGet`/`secureSet`/`secureDelete` in `src/desktop/native.ts`). Keyed by an
 * app-specific service name + the caller's key.
 *
 * Backends are the OS credential CLIs (subprocess, argv — no shell), chosen for safety over raw FFI:
 * - macOS: `security add/find/delete-generic-password` (the login Keychain).
 * - Linux: `secret-tool store/lookup/clear` (libsecret / the Secret Service). The secret is written
 *   on STDIN, never argv.
 * - Windows: not yet supported — the cap FAILS CLOSED with a real error (never the web fallback,
 *   which is not secret), so an app never silently downgrades to plaintext.
 *
 * Values are stored base64-of-UTF-8, so a newline, quote or non-ASCII byte in the value can never
 * corrupt the round-trip or the command. FAIL CLOSED: if the backend is missing (no `security` /
 * `secret-tool`, or no running Secret Service), a write/read is a real error, not a silent success
 * or a plaintext fallback.
 *
 * NOTE (macOS argv exposure): `security add-generic-password -w <b64>` passes the (base64) secret as
 * an argv element, briefly visible in `ps` to OTHER processes of the SAME USER — the same
 * local-process trust boundary the bridge already accepts (see `bridge.ts`). `secret-tool` avoids
 * this via stdin; a future macOS FFI backend (SecItemAdd) would too.
 *
 * Runtime-only (imported by the desktop entry via the caps resolver, never a client bundle).
 *
 * @module
 */

import { base64ToBytes, bytesToBase64 } from "../../mobile/base64.ts";
import { type DesktopCapability, DesktopCapError } from "../extension.ts";

/** The running OS spelling the command builder branches on. */
type Os = "darwin" | "windows" | "linux";

/** Run a credential CLI (argv, no shell; optional stdin). Injected so tests never touch the OS store. */
export type SecureRunner = (
  cmd: string,
  args: string[],
  stdin?: string,
) => Promise<{ code: number; stdout: string }>;

/** A credential-CLI invocation: the command, its argv, and optional stdin (the secret, on Linux). */
export interface SecureCommand {
  readonly cmd: string;
  readonly args: string[];
  readonly stdin?: string;
}

/**
 * The credential-CLI invocation for `op` on macOS/Linux. Pure + exported so every OS's argv is
 * unit-tested. The value (already base64) is argv on macOS (`security`) and STDIN on Linux
 * (`secret-tool`). Windows has no builder — the cap fails closed before reaching here.
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
  if (os === "darwin") {
    if (op === "get") {
      return { cmd: "security", args: ["find-generic-password", "-a", key, "-s", service, "-w"] };
    }
    if (op === "delete") {
      return { cmd: "security", args: ["delete-generic-password", "-a", key, "-s", service] };
    }
    return {
      cmd: "security",
      args: ["add-generic-password", "-U", "-a", key, "-s", service, "-w", b64 ?? ""],
    };
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

/** The default runner: spawn the CLI, feed `stdin` if given, capture stdout; map a missing binary to
 * a fail-closed error. */
async function defaultRun(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<{ code: number; stdout: string }> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(cmd, {
      args,
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

/** Refuse on Windows (no backend yet) — fail closed, never a plaintext web fallback. */
function refuseWindows(os: Os): void {
  if (os === "windows") {
    throw new DesktopCapError(
      "unsupported_platform",
      "secure-store is not yet supported on Windows; it fails closed rather than storing plaintext",
    );
  }
}

/** Require a string arg. */
function str(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new DesktopCapError("validation", `${name} must be a string`);
  }
  return value;
}

/**
 * Build the `secureStore` capability.
 *
 * @param deps The service name, and (for tests) the OS and runner.
 * @returns The `secureStore` {@link DesktopCapability}.
 */
export function secureStoreCapability(deps: SecureStoreDeps): DesktopCapability {
  const os = deps.os ?? (Deno.build.os as Os);
  const run = deps.run ?? defaultRun;
  const service = deps.service;

  // One permission descriptor + one Windows-refuse-and-read-key preamble, shared by all methods.
  const permissions = os === "darwin" ? { run: ["security"] } : { run: ["secret-tool"] };
  const keyArg = (args: unknown): string => {
    refuseWindows(os);
    return str((args as { key?: unknown })?.key, "key");
  };
  const exec = (op: "get" | "set" | "delete", key: string, b64?: string) => {
    const c = secureStoreCommand(os, op, service, key, b64);
    return run(c.cmd, c.args, c.stdin);
  };

  return {
    name: "secureStore",
    methods: {
      get: {
        permissions,
        handler: async (args) => {
          const { code, stdout } = await exec("get", keyArg(args));
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
        handler: async (args) => {
          const key = keyArg(args);
          const value = str((args as { value?: unknown })?.value, "value");
          const b64 = bytesToBase64(new TextEncoder().encode(value));
          const { code } = await exec("set", key, b64);
          if (code !== 0) {
            throw new DesktopCapError("store_failed", "the secure store rejected the write");
          }
          return { ok: true };
        },
      },
      delete: {
        permissions,
        handler: async (args) => {
          await exec("delete", keyArg(args)); // a non-zero (not found) is fine — delete is idempotent
          return { ok: true };
        },
      },
    },
  };
}
