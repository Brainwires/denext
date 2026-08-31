import { Effect } from "effect";
import { DenextRequest, effectHandler } from "@denext/effect";
import { type UserNotFound, Users } from "../../../services.ts";

// A JSON route handler on the AMBIENT runtime (provided by the `effect()` plugin in
// denext.config.ts). It combines request-scoped DI (`DenextRequest` → the `?id=` query)
// with the app-wide `Users` service, and maps the typed `UserNotFound` failure to a 404.
//
// The ambient `runEffect`/`effectHandler` erase app-layer services from the *type* (the
// documented tradeoff vs. `createEffectRuntime`), so the program — which requires `Users`
// at run time — is cast to erase that requirement at the handler boundary. `onError`'s
// argument is then the typed `UserNotFound`.
export const GET = effectHandler(
  () =>
    Effect.gen(function* () {
      const { request } = yield* DenextRequest;
      const users = yield* Users;
      const id = new URL(request.url).searchParams.get("id") ?? "1";
      const name = yield* users.nameOf(id);
      return Response.json({ id, name });
    }) as unknown as Effect.Effect<Response, UserNotFound, DenextRequest>,
  {
    onError: (e) => Response.json({ error: e._tag, id: e.id }, { status: 404 }),
  },
);
