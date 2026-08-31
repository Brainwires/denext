import { Effect, Exit } from "effect";
import { DenextRequest } from "@denext/effect";
import { runEffectExit } from "../effect-runtime.ts";
import { Users } from "../services.ts";

// A Server Component that awaits an Effect combining the request-scoped `DenextRequest`
// service (read the `?id=` query) with the app-wide `Users` service, and branches on a
// typed failure (`UserNotFound`) — no thrown exceptions.
export default async function Page() {
  const program = Effect.gen(function* () {
    const { request } = yield* DenextRequest; // request-scoped DI
    const users = yield* Users; //               app-wide DI (from AppLayer)
    const id = new URL(request.url).searchParams.get("id") ?? "1";
    const name = yield* users.nameOf(id); //     may fail with UserNotFound
    return { id, name };
  });

  const exit = await runEffectExit(program);

  return (
    <main>
      <h1>denext + Effect</h1>
      <p>
        Try <code>?id=1</code>, <code>?id=2</code>, <code>?id=3</code> — or <code>?id=9</code>{" "}
        for the typed-error branch.
      </p>
      {Exit.isSuccess(exit)
        ? (
          <p>
            User <strong>{exit.value.id}</strong> is <strong>{exit.value.name}</strong>.
          </p>
        )
        : (
          <p style={{ color: "crimson" }}>
            No such user (the Effect failed with a typed error).
          </p>
        )}
    </main>
  );
}
