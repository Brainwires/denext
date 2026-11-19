// The browser sender: a camera or a canvas test pattern, offered to every viewer in the room.

import { Sender } from "./sender.tsx";

export const metadata = { title: "RTC viewer: sender" };

export default function SendPage() {
  return <Sender />;
}
