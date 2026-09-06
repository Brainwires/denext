"use server";
import { createChannel } from "denext/server";
import { object, oneOf, string } from "../lib/schema.ts";

// A server-push channel: any server code (the route handler, the action) publishes an event;
// every subscribed tab receives it — no recompute, no polling. `authorize` is REQUIRED; this
// demo's events are public, so it returns true. `schema` validates every payload at the
// PUBLISHER (a bad payload is a server bug thrown there, never sent). Exported from a
// "use server" module, the channel reaches the browser as an opaque id.
export const todoEvents = createChannel({
  schema: object({
    kind: oneOf("added", "toggled", "removed"),
    title: string(),
  }),
  key: (key) => key === "all",
  authorize: () => true,
});
