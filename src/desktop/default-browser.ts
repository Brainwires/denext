/**
 * The system's default web browser, from the desktop app's own Deno process (`denext/desktop`'s
 * {@linkcode createDefaultBrowser}, and the `defaultBrowser` capability behind
 * `setDefaultBrowser` / `getSchemeOwner` / `isDefaultBrowser` in `denext/desktop/app`):
 *
 * - macOS: LaunchServices through FFI (`Deno.dlopen` of CoreServices and CoreFoundation):
 *   `LSCopyDefaultHandlerForURLScheme` reads a scheme's handler (a bundle id), and
 *   `LSSetDefaultHandlerForURLScheme` asks to become the `http` / `https` handler, which macOS
 *   confirms with its own dialog ("Do you want to change your default web browser?"). The call
 *   returns before the user answers, so a change the user has not confirmed yet reads `prompted`.
 *   Baked as `--allow-ffi` of the two framework paths.
 * - Linux: `xdg-settings get | set default-web-browser <identifier>.desktop` (the desktop's own
 *   setting, every MIME association a browser has) and `xdg-mime query default
 *   x-scheme-handler/<scheme>` for one scheme's handler (a `.desktop` file id). Baked as
 *   `--allow-run=xdg-settings,xdg-mime`; no prompt.
 * - Windows: not supported yet (a browser registers `StartMenuInternet` / `Capabilities` keys, and
 *   only the user can pick the default in Settings): `setDefaultBrowser` resolves `unsupported`,
 *   `getSchemeOwner` rejects `unsupported`, `isDefaultBrowser` resolves `false`.
 *
 * The OS lists the app as a browser only when it declares itself one: `desktop.app.browser: true`
 * (packaging writes the Info.plist URL and document types, the Linux `MimeType`s).
 *
 * Runtime-only (the desktop app's own process; never a client bundle). The FFI and the commands are
 * injected so tests run without either.
 *
 * @module
 */

import { DesktopCapError } from "./extension.ts";
import {
  BROWSER_SCHEMES,
  CORE_FOUNDATION_PATH,
  CORE_SERVICES_PATH,
  DEFAULT_BROWSER_LINUX_PROGRAMS,
} from "./browser-config.ts";

export { CORE_FOUNDATION_PATH, CORE_SERVICES_PATH, DEFAULT_BROWSER_LINUX_PROGRAMS };

/** The OS spelling the implementation branches on (`Deno.build.os`). */
export type DefaultBrowserOs = "darwin" | "windows" | "linux";

/**
 * What {@linkcode DefaultBrowserApi.setDefaultBrowser} reports:
 *
 * - `set`: the app is the default browser now (it already was, or the OS changed it at once).
 * - `prompted`: the OS asked the user (macOS); read {@linkcode DefaultBrowserApi.isDefaultBrowser}
 *   later (an app activation, a settings view) for the answer.
 * - `unsupported`: this OS (Windows) or session cannot set it from the app (Linux without
 *   `xdg-settings`).
 * - `failed`: the OS refused (macOS: the app does not declare `http` / `https`, as an unpackaged or
 *   unregistered build; Linux: `xdg-settings` failed, or the desktop kept another browser).
 */
export type SetDefaultBrowserResult = "set" | "prompted" | "unsupported" | "failed";

/** `kCFStringEncodingUTF8`. */
const UTF8 = 0x08000100;
/** The longest handler id read back (bundle ids are at most 155 bytes; `.desktop` ids are short). */
const MAX_ID_BYTES = 1024;

/** The symbols of `Deno.dlopen` the macOS side uses (a fake in tests). */
export type DlopenFn = (
  path: string,
  symbols: Record<string, { parameters: string[]; result: string }>,
) => { symbols: Record<string, (...args: unknown[]) => unknown>; close(): void };

/** A command's outcome. */
export interface CommandOutput {
  /** The exit code. */
  readonly code: number;
  /** Its standard output, decoded. */
  readonly stdout: string;
}

/**
 * Runs `program` with `args` (no shell). Rejects `Deno.errors.NotFound` when it is not installed,
 * `Deno.errors.NotCapable` / `PermissionDenied` when the app may not run it.
 */
export type RunCommandFn = (program: string, args: string[]) => Promise<CommandOutput>;

/** LaunchServices' two calls, over CFString (the FFI layer {@linkcode macLaunchServices} builds). */
interface LaunchServices {
  /** The bundle id of the scheme's handler, or `null` when none. */
  copyDefaultHandler(scheme: string): string | null;
  /** Ask to make `bundleId` the scheme's handler; the `OSStatus` (`0`: accepted). */
  setDefaultHandler(scheme: string, bundleId: string): number;
  /** Close the libraries. */
  close(): void;
}

/** Options for {@linkcode createDefaultBrowser}. */
export interface DefaultBrowserOptions {
  /**
   * The app's identifier (`desktop.app.identifier`): its macOS bundle id, and its Linux `.desktop`
   * file id without the extension.
   */
  readonly identifier: string;
  /** The OS (default `Deno.build.os`). */
  readonly os?: DefaultBrowserOs;
  /** `Deno.dlopen` (tests pass a fake). */
  readonly dlopen?: DlopenFn;
  /** Runs a program (default `Deno.Command`; tests pass a fake). */
  readonly run?: RunCommandFn;
}

/** The default browser, as the app sees it. */
export interface DefaultBrowserApi {
  /**
   * Ask to become the default web browser (`http` and `https`). Call it from the user's action (a
   * "Make default" button): macOS shows its confirmation.
   *
   * @returns See {@linkcode SetDefaultBrowserResult}.
   */
  setDefaultBrowser(): Promise<SetDefaultBrowserResult>;
  /**
   * Which app handles `scheme`: a bundle id on macOS (LaunchServices may report it in lower
   * case), a `.desktop` file id on Linux.
   *
   * @param scheme A URL scheme (`"http"`, `"https"`, `"mailto"`, …), without `:`.
   * @returns The handler's id, or `null` when no app handles it. Rejects `validation` for a
   * malformed scheme and `unsupported` on Windows (or on Linux without `xdg-mime`).
   */
  getSchemeOwner(scheme: string): Promise<string | null>;
  /**
   * Whether the app is the default web browser: macOS, it handles both `http` and `https`; Linux,
   * `xdg-settings` names its `.desktop` file. `false` on Windows.
   *
   * @returns Whether it is.
   */
  isDefaultBrowser(): Promise<boolean>;
}

/** A NUL-terminated UTF-8 copy of `s`. */
function cString(s: string): Uint8Array {
  return new TextEncoder().encode(`${s}\0`);
}

/**
 * LaunchServices over FFI: opens CoreFoundation and CoreServices with `dlopen`.
 *
 * @param dlopen `Deno.dlopen` (tests pass a fake).
 * @returns The two calls; {@linkcode LaunchServices.close} closes the libraries.
 */
function macLaunchServices(dlopen: DlopenFn): LaunchServices {
  const cf = dlopen(CORE_FOUNDATION_PATH, {
    CFStringCreateWithCString: { parameters: ["pointer", "buffer", "u32"], result: "pointer" },
    CFStringGetCString: { parameters: ["pointer", "buffer", "i64", "u32"], result: "u8" },
    CFRelease: { parameters: ["pointer"], result: "void" },
  });
  let ls: ReturnType<DlopenFn>;
  try {
    ls = dlopen(CORE_SERVICES_PATH, {
      LSCopyDefaultHandlerForURLScheme: { parameters: ["pointer"], result: "pointer" },
      LSSetDefaultHandlerForURLScheme: { parameters: ["pointer", "pointer"], result: "i32" },
    });
  } catch (err) {
    cf.close();
    throw err;
  }
  const cfString = (s: string): unknown => {
    const ref = cf.symbols.CFStringCreateWithCString(null, cString(s), UTF8);
    if (!ref) throw new Error("CFStringCreateWithCString failed");
    return ref;
  };
  const withCfString = <T>(s: string, fn: (ref: unknown) => T): T => {
    const ref = cfString(s);
    try {
      return fn(ref);
    } finally {
      cf.symbols.CFRelease(ref);
    }
  };
  const readCfString = (ref: unknown): string | null => {
    const buf = new Uint8Array(MAX_ID_BYTES);
    if (!cf.symbols.CFStringGetCString(ref, buf, MAX_ID_BYTES, UTF8)) return null;
    const end = buf.indexOf(0);
    return new TextDecoder().decode(buf.subarray(0, end < 0 ? buf.length : end));
  };
  return {
    copyDefaultHandler: (scheme) =>
      withCfString(scheme, (s) => {
        const out = ls.symbols.LSCopyDefaultHandlerForURLScheme(s);
        if (!out) return null;
        try {
          return readCfString(out) || null;
        } finally {
          cf.symbols.CFRelease(out);
        }
      }),
    setDefaultHandler: (scheme, bundleId) =>
      withCfString(
        scheme,
        (s) => withCfString(bundleId, (id) => ls.symbols.LSSetDefaultHandlerForURLScheme(s, id)),
      ) as number,
    close: () => {
      ls.close();
      cf.close();
    },
  };
}

/** The default command runner: `Deno.Command`, no shell, stdin and stderr closed. */
const denoRun: RunCommandFn = async (program, args) => {
  const out = await new Deno.Command(program, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
};

/** Whether `err` is Deno's refusal of a permission the app was not packaged with. */
function isPermissionError(err: unknown): boolean {
  const errors = Deno.errors as unknown as Record<string, unknown>;
  return [errors.NotCapable, errors.PermissionDenied].some(
    (E) => typeof E === "function" && err instanceof (E as new () => Error),
  );
}

/** The `forbidden` error for a call Deno refused (the capability's grant was not baked). */
function forbidden(what: string): DesktopCapError {
  return new DesktopCapError(
    "forbidden",
    `the app may not ${what}: enable desktop.capabilities.defaultBrowser (\`denext desktop add ` +
      "default-browser`) and package the app again",
    { status: 403 },
  );
}

/** The `unsupported` error. */
function unsupported(message: string): DesktopCapError {
  return new DesktopCapError("unsupported", message, { status: 501 });
}

/** A URL scheme from the caller, lower-cased, or a `validation` error. */
export function browserSchemeArg(raw: unknown): string {
  const scheme = typeof raw === "string" ? raw.trim().replace(/:$/, "").toLowerCase() : "";
  if (!/^[a-z][a-z0-9+.-]{0,63}$/.test(scheme)) {
    throw new DesktopCapError("validation", 'scheme must be a URL scheme such as "https"');
  }
  return scheme;
}

/**
 * The default-browser calls for the app `options.identifier` on `options.os`.
 *
 * @example
 * ```ts
 * import { createDefaultBrowser } from "denext/desktop";
 *
 * const browser = createDefaultBrowser({ identifier: "com.example.browser" });
 * if (!(await browser.isDefaultBrowser())) await browser.setDefaultBrowser();
 * ```
 *
 * @param options The identifier, and the OS / FFI / command runner (tests).
 * @returns The API.
 */
export function createDefaultBrowser(options: DefaultBrowserOptions): DefaultBrowserApi {
  const os = options.os ?? (Deno.build.os as DefaultBrowserOs);
  if (os === "darwin") return macDefaultBrowser(options);
  if (os === "linux") return linuxDefaultBrowser(options);
  return {
    setDefaultBrowser: () => Promise.resolve("unsupported"),
    // deno-lint-ignore require-await
    getSchemeOwner: async (scheme) => {
      browserSchemeArg(scheme);
      throw unsupported("reading a scheme's handler is not supported on this OS yet");
    },
    isDefaultBrowser: () => Promise.resolve(false),
  };
}

/** macOS: LaunchServices, opened for each call (the calls are rare). */
function macDefaultBrowser(options: DefaultBrowserOptions): DefaultBrowserApi {
  const id = options.identifier.toLowerCase();
  const withLs = <T>(fn: (ls: LaunchServices) => T): T => {
    let ls: LaunchServices;
    try {
      ls = macLaunchServices(options.dlopen ?? (Deno.dlopen as unknown as DlopenFn));
    } catch (err) {
      if (isPermissionError(err)) throw forbidden("load LaunchServices");
      throw new DesktopCapError("failed", "could not load LaunchServices", { status: 500 });
    }
    try {
      return fn(ls);
    } finally {
      ls.close();
    }
  };
  const ownsAll = (ls: LaunchServices) =>
    BROWSER_SCHEMES.every((s) => ls.copyDefaultHandler(s)?.toLowerCase() === id);
  return {
    // deno-lint-ignore require-await
    setDefaultBrowser: async () =>
      withLs((ls): SetDefaultBrowserResult => {
        if (ownsAll(ls)) return "set";
        for (const scheme of BROWSER_SCHEMES) {
          if (ls.setDefaultHandler(scheme, options.identifier) !== 0) return "failed";
        }
        // macOS confirms with its own dialog and returns before the user answers.
        return ownsAll(ls) ? "set" : "prompted";
      }),
    // deno-lint-ignore require-await
    getSchemeOwner: async (scheme) => {
      const s = browserSchemeArg(scheme);
      return withLs((ls) => ls.copyDefaultHandler(s));
    },
    // deno-lint-ignore require-await
    isDefaultBrowser: async () => withLs(ownsAll),
  };
}

/** Linux: `xdg-settings` / `xdg-mime`. */
function linuxDefaultBrowser(options: DefaultBrowserOptions): DefaultBrowserApi {
  const desktopId = `${options.identifier}.desktop`;
  const run = options.run ?? denoRun;
  /** `program args…`, or `undefined` when the program is not installed. */
  const tryRun = async (program: string, args: string[]): Promise<CommandOutput | undefined> => {
    try {
      return await run(program, args);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return undefined;
      if (isPermissionError(err)) throw forbidden(`run ${program}`);
      throw new DesktopCapError("failed", `${program} could not run`, { status: 500 });
    }
  };
  const currentBrowser = async (): Promise<string | null> => {
    const out = await tryRun("xdg-settings", ["get", "default-web-browser"]);
    const id = out?.code === 0 ? out.stdout.trim() : "";
    return id === "" ? null : id;
  };
  return {
    setDefaultBrowser: async () => {
      const out = await tryRun("xdg-settings", ["set", "default-web-browser", desktopId]);
      if (out === undefined) return "unsupported";
      if (out.code !== 0) return "failed";
      return (await currentBrowser()) === desktopId ? "set" : "failed";
    },
    getSchemeOwner: async (scheme) => {
      const s = browserSchemeArg(scheme);
      const out = await tryRun("xdg-mime", ["query", "default", `x-scheme-handler/${s}`]);
      if (out === undefined) throw unsupported("xdg-mime is not installed");
      const id = out.code === 0 ? out.stdout.trim() : "";
      return id === "" ? null : id;
    },
    isDefaultBrowser: async () => (await currentBrowser()) === desktopId,
  };
}
