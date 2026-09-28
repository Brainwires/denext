/**
 * Deno Desktop native extensions, authoring side (`denext/desktop`): the types and the
 * {@linkcode defineDesktopExtension} helper for a capability that runs in the desktop app's Deno
 * process. A capability is plain TypeScript there — it uses Deno/Node APIs, an existing `Deno.*`
 * desktop API, a CLI tool, FFI, or a sidecar — and the page reaches it only through the runtime's
 * gated bridge (see {@link ./bridge.ts}): a per-launch token, the exact window origin, a JSON
 * content type, then the capability allowlist and the method's input schema.
 *
 * This module is RUNTIME-ONLY (it is imported by the desktop entry via `runDesktop`, never by a
 * client bundle — the same convention as {@link ./auth-session-runtime.ts} and {@link ./updater.ts}).
 * The page-side counterpart is `denext/desktop/client` ({@link ./client.ts}).
 *
 * @module
 */

import type { StandardResult, StandardSchemaV1 } from "../runtime/define-action.ts";

export type { StandardSchemaV1 };

/**
 * The Deno permissions a capability method needs, as `--allow-*` scopes. The union of every
 * enabled capability's descriptor is what the package scripts bake into the desktop binary
 * instead of `-A` (least-privilege packaging), and what `denext doctor` reports. An `ffi` or
 * `run` entry means full-trust native code: least-privilege is moot for that surface once it is on.
 */
export interface DesktopPermissions {
  /** `--allow-read` paths (a bundle-relative or absolute path, or a token like `$APPDATA`). */
  readonly read?: readonly string[];
  /** `--allow-write` paths. */
  readonly write?: readonly string[];
  /** `--allow-net` hosts. */
  readonly net?: readonly string[];
  /** `--allow-run` programs (a sidecar or CLI tool). Full trust. */
  readonly run?: readonly string[];
  /** `--allow-ffi` libraries. Full trust. */
  readonly ffi?: readonly string[];
  /** `--allow-env` variable names. */
  readonly env?: readonly string[];
  /** `--allow-sys` kinds. */
  readonly sys?: readonly string[];
}

/**
 * The context a capability handler runs with: a scoped {@linkcode DesktopCapCtx.emit} for its
 * declared events, the OS app-support directory (which survives relaunch, unlike browser storage —
 * see the desktop storage note), the running OS, the app window (Deno's `BrowserWindow` when the
 * runtime exposes it), and an {@linkcode AbortSignal} that fires when the handler's timeout elapses.
 */
export interface DesktopCapCtx {
  /**
   * Push an event to the page's event stream. `event` must be one the capability declared in
   * {@linkcode DesktopCapability.events}; emitting an undeclared event throws.
   */
  emit(event: string, data: unknown): void;
  /** The OS per-app support directory (create-on-first-use); durable across launches. */
  readonly appSupportDir: string;
  /** The running OS. */
  readonly os: "darwin" | "windows" | "linux";
  /**
   * The app's `Deno.BrowserWindow` when the runtime exposes one (menu/tray/context-menu/navigate
   * capabilities use it), else `undefined`. Typed loosely because it is a Deno Desktop API not in
   * the ambient lib; a window capability narrows it.
   */
  readonly window?: unknown;
  /** Aborts when the handler exceeds its timeout, so a long native call can cooperate. */
  readonly signal: AbortSignal;
}

/**
 * One capability method: an optional input schema (validated before the handler), an optional
 * output schema (strips the result before it reaches the page, in production too), the Deno
 * permissions it needs, an optional per-method timeout, and the handler that runs in the Deno
 * process.
 *
 * Input inference for the PAGE flows from `input`/`output` (read by `denext/desktop/client`'s
 * typed proxy). Annotate `handler`'s `args` with the schema's output type for typed handler code.
 */
export interface DesktopCapabilityMethod<I = unknown, O = unknown> {
  /** Validates the page's arguments; a mismatch is a `validation` error before the handler runs. */
  readonly input?: StandardSchemaV1<unknown>;
  /** Strips the handler's result to the declared shape before it reaches the page. */
  readonly output?: StandardSchemaV1<O>;
  /** The Deno permissions this method needs (drives least-privilege packaging + `doctor`). */
  readonly permissions?: DesktopPermissions;
  /**
   * How long the handler may run before the bridge answers `timeout` and aborts `ctx.signal`.
   * A number of ms, or `false` to wait as long as it takes (a native dialog the user is reading).
   * Defaults to the bridge's default (30 s).
   */
  readonly timeoutMs?: number | false;
  /** Runs in the Deno process with the validated `args` and a {@linkcode DesktopCapCtx}. */
  readonly handler: (args: I, ctx: DesktopCapCtx) => O | Promise<O>;
}

/**
 * A desktop capability: a name (its address on the bridge — an extension's name is its cap name),
 * a set of methods, and the event names it may {@linkcode DesktopCapCtx.emit}. Built-ins live in
 * {@link ./caps}; user extensions are authored with {@linkcode defineDesktopExtension}.
 */
export interface DesktopCapability {
  /** The capability name the page calls (`"secureStore"`, or an extension's own name). */
  readonly name: string;
  /** The methods, keyed by method name. */
  readonly methods: Readonly<Record<string, DesktopCapabilityMethod>>;
  /** The event names this capability may emit (empty when it emits none). */
  readonly events?: readonly string[];
}

/**
 * Define a native desktop extension: a capability that runs in the desktop app's Deno process and
 * that the page calls through `denext/desktop/client`'s {@link desktopExtension}. Enable it in
 * `desktop.capabilities.extensions` (a module path). This is an identity helper — it returns its
 * argument unchanged so a `typeof import("./ext.ts")` keeps the exact method types the client's
 * typed proxy reads — and it is not a place for side effects (nothing should run at import).
 *
 * @example
 * ```ts
 * // desktop/extensions/scanner.ts  (runs in the Deno process only)
 * import { defineDesktopExtension } from "denext/desktop";
 * import { z } from "zod";
 * export default defineDesktopExtension({
 *   name: "scanner",
 *   methods: {
 *     listDevices: {
 *       input: z.object({}),
 *       output: z.array(z.string()),
 *       permissions: { ffi: ["./native/libscanner.dylib"] },
 *       handler: () => listDevicesFromFfi(),
 *     },
 *   },
 * });
 * ```
 *
 * @typeParam C The capability's exact shape (preserved for the page's typed client).
 * @param capability The capability definition.
 * @returns The same object, typed as given.
 */
export function defineDesktopExtension<const C extends DesktopCapability>(capability: C): C {
  return capability;
}

/**
 * Throw this from a capability handler to answer the page with a specific error code and a SAFE
 * message. The bridge puts `code`, the message and any `data` into the `{ ok: false, error }`
 * envelope at `status` (default 400). Never encode an absolute path, environment value or stack
 * into the message — it crosses to the page. The code `"unavailable"` is RESERVED (it means the
 * capability/method is not enabled, which makes the page fall back to its web path); use another
 * code for a real failure.
 */
export class DesktopCapError extends Error {
  /** The machine-readable error code the page narrows on. */
  override readonly name = "DesktopCapError";
  /** The error code (not `"unavailable"`, which the bridge reserves). */
  readonly code: string;
  /** The HTTP status for the envelope (the client reads the envelope at any status). */
  readonly status: number;
  /** Structured detail for the page, if any (must be JSON-serialisable and non-sensitive). */
  readonly data?: unknown;

  constructor(code: string, message: string, options: { status?: number; data?: unknown } = {}) {
    super(message);
    this.code = code;
    this.status = options.status ?? 400;
    if (options.data !== undefined) this.data = options.data;
  }
}

/**
 * Validate `value` against a Standard Schema, returning the parsed value or the issue messages.
 * A thin wrapper over the schema's own `~standard.validate` (async-aware), matching how
 * `defineApi` validates. Used by the bridge to check a method's `input` and strip its `output`.
 *
 * @param schema The Standard Schema.
 * @param value The value to validate.
 * @returns `{ ok: true, value }` on success, else `{ ok: false, messages }`.
 */
export async function validateStandard<O>(
  schema: StandardSchemaV1<O>,
  value: unknown,
): Promise<{ ok: true; value: O } | { ok: false; messages: string[] }> {
  const result: StandardResult<O> = await schema["~standard"].validate(value);
  if (result.issues === undefined) return { ok: true, value: result.value };
  return { ok: false, messages: result.issues.map((issue) => issue.message) };
}
