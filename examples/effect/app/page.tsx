import { Effect } from "effect";
import { AppLayer, Users } from "@/services";

// A Next Server Component that runs a plain Effect program — combining the app-wide `Users`
// service (provided by `AppLayer`) — with `Effect.runPromise`. This is ordinary Effect usage
// that is valid on Next.js AND on denext after `denext migrate` (which aliases react/next to
// denext and wires the `effect()` plugin because the app depends on `effect`).
export default async function Page() {
  const name = await Effect.runPromise(
    Effect.gen(function* () {
      const users = yield* Users;
      return yield* users.nameOf("1");
    }).pipe(Effect.provide(AppLayer)),
  );

  return (
    <main>
      <h1>denext + Effect (migrated Next app)</h1>
      <p>
        User 1 is <strong>{name}</strong>.
      </p>
    </main>
  );
}
