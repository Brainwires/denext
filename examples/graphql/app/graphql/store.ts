// The demo's data: the last few messages per room, in memory (a stand-in for a database).
import type { Message } from "./channels.ts";

const rooms = new Map<string, Message[]>();

export function history(room: string): Message[] {
  return rooms.get(room) ?? [];
}

export function remember(message: Message): void {
  const list = rooms.get(message.room) ?? [];
  list.push(message);
  rooms.set(message.room, list.slice(-20));
}
