// The `effect()` plugin path — this is what `denext migrate` generates when an app
// depends on `effect` (there with an empty `effect()`; here we provide the real layer).
// It builds the AppLayer once (a memoized runtime), makes its services ambient for
// `runEffect`/`effectHandler`, and disposes it on shutdown. The `createEffectRuntime`
// page (app/page.tsx) does NOT need this — it carries its own typed runtime — so this
// config exercises the *ambient* path used by app/api/user/route.ts.
import { effect } from "@denext/effect";
import { AppLayer } from "./services.ts";

export default { plugins: [effect({ layer: AppLayer })] };
