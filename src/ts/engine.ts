// Native type checking on denext's Deno toolchain. From the runtime whose CLI archive ships the
// native TypeScript 7 compiler in `typescript-check/` beside `deno` (the pin's `tsgo` entry), `deno check`,
// `deno test`, `run --check` & co. — and so `denext check` and the dev type-check overlay — type-
// check with it by default; `DENO_CHECK_ENGINE=tsc` (or `--check-engine=tsc`) selects the runtime's
// in-process TypeScript 6.0.3 instead. That runtime refuses to type-check when its compiler is
// missing, so before a verb runs project code denext picks the in-process engine itself when:
//
//   - `DENEXT_NATIVE_CHECK=0` (or `false` / `off`) asks for it, or
//   - the toolchain supports native checking but its `typescript-check/` is not installed and verified
//     (refused at install, or changed since): one warning, and the in-process checker runs.
//
// A `DENO_CHECK_ENGINE` the user set always wins, and a runtime without native checking (every
// pin before it, stock Deno, a `DENEXT_DENO=<path>` binary) is left alone.

import {
  activeToolchainPin,
  type DenoToolchainPin,
  denoToolchainTarget,
  toolchainTsgo,
  type ToolchainTsgoStatus,
} from "../build/deno-toolchain.ts";
import {
  currentDenoIdentity,
  type DenoIdentity,
  isPinnedDenextDeno,
} from "../build/deno-version.ts";

/** The runtime's engine switch: `native` (its default) or `tsc` (the in-process TypeScript). */
export const CHECK_ENGINE_ENV = "DENO_CHECK_ENGINE";
/** denext's opt-out: `0` / `false` / `off` type-checks with the in-process TypeScript. */
const NATIVE_CHECK_ENV = "DENEXT_NATIVE_CHECK";

/** Seams for {@linkcode nativeCheckDecision}; all default to the process. */
export interface NativeCheckOptions {
  readonly env?: (name: string) => string | undefined;
  /** This process's Deno (default {@linkcode currentDenoIdentity}). */
  readonly running?: DenoIdentity;
  readonly pin?: DenoToolchainPin;
  readonly target?: string;
  /** The toolchain's compiler (default {@linkcode toolchainTsgo}). */
  readonly tsgo?: () => Promise<ToolchainTsgoStatus>;
}

/** What {@linkcode nativeCheckDecision} decided. */
export interface NativeCheckDecision {
  /** `tsc` when the in-process engine must run; `null` to leave the runtime's default. */
  readonly engine: "tsc" | null;
  /** Whether the running Deno type-checks natively by default. */
  readonly supported: boolean;
  /** A warning to print once (the compiler was refused), if any. */
  readonly warning?: string;
}

/**
 * Whether the Deno running as `running` is the pinned toolchain (denext's Deno of the pin's
 * version, never upstream Deno of that number) and that release ships the native TypeScript
 * compiler (so it type-checks natively by default).
 */
export function runtimeSupportsNativeCheck(
  pin: DenoToolchainPin,
  target: string,
  running: DenoIdentity,
): boolean {
  return isPinnedDenextDeno(running, pin.version) && pin.targets[target]?.tsgo !== undefined;
}

/**
 * Decide the type-check engine for the commands this process runs (see the module header).
 *
 * @param options Seams; all default to the process.
 * @returns The decision.
 */
export async function nativeCheckDecision(
  options: NativeCheckOptions = {},
): Promise<NativeCheckDecision> {
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  let supported = false;
  try {
    supported = runtimeSupportsNativeCheck(
      options.pin ?? activeToolchainPin(),
      options.target ?? denoToolchainTarget(),
      options.running ?? currentDenoIdentity(),
    );
  } catch {
    // an unreadable DENEXT_TOOLCHAIN_PIN_FILE: resolving the toolchain reports it
  }
  if (env(CHECK_ENGINE_ENV)) return { engine: null, supported };
  const optOut = env(NATIVE_CHECK_ENV)?.trim().toLowerCase();
  if (optOut === "0" || optOut === "false" || optOut === "off") return { engine: "tsc", supported };
  if (!supported) return { engine: null, supported };
  const tsgo = await (options.tsgo ?? (() => toolchainTsgo()))();
  if (tsgo.state === "ok") return { engine: null, supported };
  return {
    engine: "tsc",
    supported,
    warning: tsgo.state === "refused"
      ? `denext: ${tsgo.detail}; type-checking with the in-process TypeScript instead ` +
        `(\`denext toolchain install\` re-downloads it).`
      : undefined,
  };
}

/**
 * Apply {@linkcode nativeCheckDecision} to this process's environment, so the verb and every
 * Deno it starts (`deno check`, `deno test`, the dev overlay's checks) inherit it; prints its
 * warning once.
 *
 * @param options Seams; all default to the process.
 * @returns The decision.
 */
export async function applyNativeCheckEngine(
  options: NativeCheckOptions & {
    readonly setEnv?: (name: string, value: string) => void;
    readonly warn?: (message: string) => void;
  } = {},
): Promise<NativeCheckDecision> {
  const decision = await nativeCheckDecision(options);
  if (decision.engine) {
    (options.setEnv ?? ((name, value) => Deno.env.set(name, value)))(
      CHECK_ENGINE_ENV,
      decision.engine,
    );
  }
  if (decision.warning) (options.warn ?? ((m) => console.error(m)))(decision.warning);
  return decision;
}
