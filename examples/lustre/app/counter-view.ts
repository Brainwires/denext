// The Lustre counter as a server component: its model lives on the server, one runtime per
// visitor, and its DOM patches travel over denext's Live socket.
import { defineLustreView } from "denext/gleam";
import { lustreServer } from "../.denext/lustre-server.ts";
import * as counter from "@gleam/app/counter.mjs";

export const CounterView = defineLustreView({
  id: "counter",
  kit: lustreServer,
  app: counter.app(),
  flags: (props: { start: number }) => props.start,
  // Runs when the page renders, when the browser mounts or resumes the view, and every
  // live.limits.channelAuthTtlSeconds while it runs. A real app checks the session here.
  authorize: () => true,
});
