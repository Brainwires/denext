// Loopy's voice backend in the browser (`denext task dev`): the key is the dev server's
// OPENAI_API_KEY, never sent to the page. In the desktop app the same backend is the `loopyVoice`
// capability over the OS keychain (desktop.ts). See voice/dev-route.ts for what it accepts.
//
// The tools' files (the memory database, the browser profile) go in `.loopy/` under the example.
// The toolset is made on the first request and kept for the process (voice/lifecycle.ts), so a hot
// reload of this route doesn't start a second Chrome, and Ctrl-C kills Chrome with the server.
import { createVoiceRoute } from "../../../voice/dev-route.ts";
import { envKeyStore } from "../../../voice/keys.ts";
import { sharedToolset } from "../../../voice/lifecycle.ts";
import { createVoiceService } from "../../../voice/service.ts";
import { createToolset } from "../../../voice/toolset.ts";

let route: ((request: Request) => Promise<Response>) | undefined;

export function POST(request: Request): Promise<Response> {
  route ??= createVoiceRoute(createVoiceService({
    keys: envKeyStore(),
    toolset: sharedToolset(() => createToolset({ dataDir: `${Deno.cwd()}/.loopy` })),
  }));
  return route(request);
}
