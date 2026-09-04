// The domain model is the SAME as the sibling fixture `examples/effect` (the `Users`
// service, its typed `UserNotFound` error, and the live `AppLayer`): this example only
// changes HOW effects run — through a typed `ManagedRuntime` from `@denext/effect` —
// so it imports the services instead of re-declaring them.
export { AppLayer, UserNotFound, Users } from "../effect/services.ts";
