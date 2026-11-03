// The page's voice backend in the desktop app: the `loopyVoice` capability (voice/extension.ts)
// over the runtime's gated bridge. In a browser it is the dev route (lib/voice-backend.ts).

import { desktopExtension } from "denext/desktop/client";
import { backendError, routeBackend, type VoiceBackend } from "./voice-backend.ts";

/** The backend over the desktop bridge. */
function bridgeBackend(): VoiceBackend {
  const ext = desktopExtension("loopyVoice");
  const wrap = <T>(p: Promise<unknown>): Promise<T> =>
    p.then((v) => v as T, (err) => {
      throw backendError(err as { code?: unknown }, "Loopy's voice backend failed.");
    });
  return {
    status: () => wrap(ext.status({})),
    setKey: (key) => wrap(ext.setKey({ key })),
    clearKey: () => wrap(ext.clearKey({})),
    session: () => wrap(ext.session({})),
    tool: (c) => wrap(ext.tool({ name: c.name, arguments: c.arguments })),
  };
}

/** The backend for this page: the bridge in the desktop app, the dev route in a browser. */
export function voiceBackend(desktop: boolean): VoiceBackend {
  return desktop ? bridgeBackend() : routeBackend();
}
