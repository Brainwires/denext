// Loopy's voice backend in the browser (`denext task dev`): the key is the dev server's
// OPENAI_API_KEY, never sent to the page. In the desktop app the same backend is the `loopyVoice`
// capability over the OS keychain (desktop.ts). See voice/dev-route.ts for what it accepts.
import { createVoiceRoute } from "../../../voice/dev-route.ts";
import { envKeyStore } from "../../../voice/keys.ts";
import { createVoiceService } from "../../../voice/service.ts";

export const POST = createVoiceRoute(createVoiceService({ keys: envKeyStore() }));
