"use server";
import { defineSubscription } from "denext/server";
import { object, oneOf } from "../lib/schema.ts";
import { stats } from "../lib/store.ts";

// A typed, VALIDATED live query: the client's input is checked by the schema on every
// subscribe (a bad input is refused with field errors and the resolver never runs), the tags
// are derived on the server, and the value is re-pushed whenever "todos" is invalidated.
// Registering the definition is the live opt-in — no `liveReadable`, no `canSubscribe`.
export const todoStats = defineSubscription({
  input: object({ filter: oneOf("all", "open") }),
  tags: ["todos"],
  resolve: ({ filter }) => stats(filter),
});
