import { createEffectRuntime } from "@denext/effect";
import { AppLayer } from "./services.ts";

// A typed runtime bound to AppLayer: `runEffect`/`runEffectExit` accept only Effects
// whose requirements are satisfied by AppLayer (`Users`), `DenextRequest`, or `Scope` —
// a missing service is a compile error. The layer is built once and reused.
export const { runEffect, runEffectExit } = createEffectRuntime(AppLayer);
