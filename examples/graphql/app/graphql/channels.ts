// The push primitive the GraphQL subscription rides. Exported from a "use server" module so
// it gets its stable id; a public room, so `authorize` says yes to every same-origin viewer.
"use server";
import { createChannel } from "denext/server";

export interface Message {
  room: string;
  text: string;
  at: Date;
}

export const messages = createChannel<Message>({
  authorize: () => true,
});
