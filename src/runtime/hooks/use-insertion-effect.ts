// The public `useInsertionEffect`: the installed dispatcher's own (the server's), else the client fiber
// dispatcher's, which lives in src/client/fiber/hooks/use-insertion-effect.ts so a bundle carries it only when
// the app calls `useInsertionEffect` (see src/client/fiber/hooks-dispatcher.ts).

import type { DependencyList } from "../../compat/react-types.ts";
import type { ClientHookHost } from "../../client/fiber/hooks-dispatcher.ts";
import { activeDispatcher, type EffectCleanup } from "../hooks.ts";
import { clientUseInsertionEffect } from "../../client/fiber/hooks/use-insertion-effect.ts";

/**
 * Run `effect` synchronously at commit in its own pre-mutation phase — before any
 * DOM mutation and before layout effects — intended for CSS-in-JS libraries (emotion,
 * styled-components) and animation libraries (motion) to inject styles before the DOM
 * is read. It must NOT read layout or use refs. A no-op during server rendering.
 *
 * @param effect The insertion effect; may return a cleanup.
 * @param deps Dependency array controlling when it re-runs.
 */
export function useInsertionEffect(
  effect: () => EffectCleanup,
  deps?: DependencyList,
): void {
  const d = activeDispatcher();
  if (d.useInsertionEffect) d.useInsertionEffect(effect, deps);
  else clientUseInsertionEffect(d as ClientHookHost, effect, deps);
}
