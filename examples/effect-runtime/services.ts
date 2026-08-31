import { Context, Effect, Layer } from "effect";

/** A trivial "user directory" service, provided app-wide by {@link AppLayer}. */
export class Users extends Context.Tag("app/Users")<Users, {
  readonly nameOf: (id: string) => Effect.Effect<string, UserNotFound>;
}>() {}

/** A typed error — flows through the Effect error channel, not a thrown exception. */
export class UserNotFound {
  readonly _tag = "UserNotFound";
  constructor(readonly id: string) {}
}

const DIRECTORY: Record<string, string> = {
  "1": "Ada",
  "2": "Grace",
  "3": "Katherine",
};

/** The live implementation. In a real app this would open a DB pool once, here. */
export const AppLayer = Layer.succeed(Users, {
  nameOf: (id) =>
    id in DIRECTORY ? Effect.succeed(DIRECTORY[id]) : Effect.fail(new UserNotFound(id)),
});
