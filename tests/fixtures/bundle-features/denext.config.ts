import type { DenextConfig } from "denext/server";

export default {
  live: { canJoinRoom: (_ctx, room) => room === "lobby" },
} satisfies DenextConfig;
