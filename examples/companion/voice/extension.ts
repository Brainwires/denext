// Loopy's voice backend as a desktop capability: the page calls it through the runtime's gated
// bridge (`desktopExtension("loopyVoice")` in lib/voice-backend.ts), and every method runs in the
// app's Deno process. desktop.ts wires it in with {@linkcode voiceCapabilities}: the `secureStore`
// capability becomes the backend's keychain and leaves the page's bridge, so the page can set or
// clear the API key but never read it back.
//
// The tools (web search, the browser, memory; voice/toolset.ts) run here too, with the memory
// file and the browser profile in the app's data folder.
//
// The shapes are `denext/desktop`'s `DesktopCapability`, written structurally, and the bridge's
// error class (`DesktopCapError`) is passed in, so this module imports nothing from the desktop
// runtime and the unit tests load it as it is.

import { dataDir } from "../inbox/paths.ts";
import { envKeyStore, keychainKeyStore, type KeyStore, type StoreCapability } from "./keys.ts";
import { VoiceError } from "./realtime.ts";
import { createVoiceService, type VoiceService } from "./service.ts";
import { createToolset, type Toolset } from "./toolset.ts";

/** The capability's name on the bridge. */
export const VOICE_CAPABILITY = "loopyVoice";

/** The name of the keychain capability the page must not reach. */
const SECURE_STORE = "secureStore";

/** Builds the bridge's error envelope (`new DesktopCapError(code, message, { status })`). */
export type CapErrorClass = new (
  code: string,
  message: string,
  options: { status: number },
) => Error;

/** A bridge capability (a `DesktopCapability`). */
export interface Capability {
  readonly name: string;
  readonly methods: Readonly<
    Record<string, {
      readonly permissions?: { readonly net?: readonly string[] };
      readonly timeoutMs?: number | false;
      readonly handler: (args: unknown, ctx: never) => unknown;
    }>
  >;
}

/** Run `call`, turning a backend refusal into the bridge's error (code, safe message, status). */
function bridged<T>(CapError: CapErrorClass, call: () => Promise<T>): Promise<T> {
  return call().catch((err) => {
    if (err instanceof VoiceError) {
      throw new CapError(err.code, err.message, { status: err.status });
    }
    if (err instanceof CapError) throw err; // the keychain's own (backend_unavailable, …)
    throw new CapError("failed", "Loopy's voice backend failed.", { status: 500 });
  });
}

/** OpenAI, which `session`, the tools and `remember` call. */
const OPENAI = { net: ["api.openai.com"] } as const;

/** How long a tool call may take: a page load in the browser, or a web search. */
const TOOL_TIMEOUT_MS = 60_000;

/**
 * The `loopyVoice` capability over `service`. No method returns the key: `status` says whether one
 * is set, `setKey` / `clearKey` answer with that status, `session` with an ephemeral secret.
 *
 * @param service The voice backend.
 * @param CapError The bridge's error class (`DesktopCapError`).
 */
function voiceCapability(service: VoiceService, CapError: CapErrorClass): Capability {
  const run = <T>(call: () => Promise<T>) => bridged(CapError, call);
  return {
    name: VOICE_CAPABILITY,
    methods: {
      status: { handler: (_args, ctx) => run(() => service.status(ctx)) },
      setKey: { handler: (args, ctx) => run(() => service.setKey(args, ctx)) },
      clearKey: { handler: (_args, ctx) => run(() => service.clearKey(ctx)) },
      session: {
        permissions: OPENAI,
        handler: (args, ctx) => run(() => service.session(args, ctx)),
      },
      configure: { handler: (args) => run(() => service.configure(args)) },
      tool: {
        permissions: OPENAI,
        timeoutMs: TOOL_TIMEOUT_MS,
        handler: (args, ctx) => run(() => service.tool(args, ctx)),
      },
      confirm: { timeoutMs: TOOL_TIMEOUT_MS, handler: (args) => run(() => service.confirm(args)) },
      remember: {
        permissions: OPENAI,
        handler: (args, ctx) => run(() => service.remember(args, ctx)),
      },
      pending: { handler: () => run(() => service.pending()) },
      memories: { handler: () => run(() => service.memories()) },
      forget: { handler: (args) => run(() => service.forget(args)) },
      forgetAll: { handler: () => run(() => service.forgetAll()) },
    },
  };
}

/**
 * The capabilities to serve the page: `resolved` without `secureStore`, plus `loopyVoice` over it
 * (over the `OPENAI_API_KEY` environment variable when no keychain capability is enabled).
 *
 * @param resolved The capabilities `resolveDesktopCapabilities` built from the config.
 * @param CapError The bridge's error class (`DesktopCapError`).
 * @param fetchFn The fetch OpenAI is called with (tests pass a fake).
 * @param toolset The tools (default: Loopy's, keeping memory and the browser profile in the app's
 *   data folder).
 */
export function voiceCapabilities(
  resolved: readonly Capability[],
  CapError: CapErrorClass,
  fetchFn?: typeof fetch,
  toolset: Toolset = createToolset({ dataDir: dataDir(), fetch: fetchFn }),
): Capability[] {
  const store = resolved.find((c) => c.name === SECURE_STORE);
  const keys: KeyStore = store ? keychainKeyStore(store as StoreCapability) : envKeyStore();
  return [
    ...resolved.filter((c) => c !== store),
    voiceCapability(createVoiceService({ keys, fetch: fetchFn, toolset }), CapError),
  ];
}
