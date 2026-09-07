// A code-first schema with Pothos (typed, no decorators). The mutation publishes to a denext
// channel; the subscription is that channel's key as an AsyncIterable via `fromChannel`.
import SchemaBuilder from "@pothos/core";
import { fromChannel } from "@denext/graphql";
import { type Message, messages } from "./channels.ts";
import { history, remember } from "./store.ts";

const builder = new SchemaBuilder<{
  Context: { signal: AbortSignal };
  Scalars: { Date: { Input: Date; Output: Date } };
}>({});

builder.scalarType("Date", {
  serialize: (d) => d.toISOString(),
  parseValue: (v) => new Date(String(v)),
});

const MessageRef = builder.objectRef<Message>("Message").implement({
  description: "A message posted to a room.",
  fields: (t) => ({
    room: t.exposeString("room"),
    text: t.exposeString("text"),
    at: t.expose("at", { type: "Date" }),
  }),
});

builder.queryType({
  fields: (t) => ({
    history: t.field({
      type: [MessageRef],
      description: "The last messages of a room (newest last).",
      args: { room: t.arg.string({ required: true }) },
      resolve: (_root, { room }) => history(room),
    }),
  }),
});

builder.mutationType({
  fields: (t) => ({
    post: t.field({
      type: MessageRef,
      description: "Post a message; every GraphQL subscriber and every useChannel gets it.",
      args: { room: t.arg.string({ required: true }), text: t.arg.string({ required: true }) },
      resolve: async (_root, { room, text }) => {
        const message: Message = { room, text: text.trim().slice(0, 280), at: new Date() };
        remember(message);
        await messages.publish(room, message);
        return message;
      },
    }),
  }),
});

builder.subscriptionType({
  fields: (t) => ({
    messages: t.field({
      type: MessageRef,
      description: "Messages posted to a room, live (GraphQL over SSE, fed by a denext channel).",
      args: { room: t.arg.string({ required: true }) },
      subscribe: (_root, { room }, ctx) => fromChannel(messages, room, { signal: ctx.signal }),
      resolve: (message) => message,
    }),
  }),
});

export const schema = builder.toSchema();
