// Terminal multi-select key handling, driven by a scripted TermIO (no real TTY).

import { assertEquals } from "@std/assert";
import { multiSelect, type TermIO } from "../src/build/multi-select.ts";

const DOWN = [0x1b, 0x5b, 0x42];
const UP = [0x1b, 0x5b, 0x41];
const SPACE = [0x20];
const ENTER = [0x0d];

/** A TermIO that replays `keys` (one chunk per read) and captures output. */
function scriptedIO(keys: number[][]): { io: TermIO; frames: () => string } {
  const queue = [...keys];
  const written: string[] = [];
  const io: TermIO = {
    read(buf) {
      const next = queue.shift();
      if (!next) return null; // EOF → confirm
      buf.set(next);
      return next.length;
    },
    write: (s) => void written.push(s),
    setRaw: () => {},
  };
  return { io, frames: () => written.join("") };
}

const ITEMS = [
  { key: "a", label: "Alpha" },
  { key: "b", label: "Beta" },
  { key: "c", label: "Gamma" },
];

Deno.test("multiSelect: space toggles the row under the cursor", () => {
  // toggle a (cursor 0) → down → toggle b → enter
  const { io } = scriptedIO([SPACE, DOWN, SPACE, ENTER]);
  const sel = multiSelect("pick", ITEMS, new Set(), io);
  assertEquals([...sel].sort(), ["a", "b"]);
});

Deno.test("multiSelect: preselected keys start checked and toggle off", () => {
  // a starts checked; space (cursor 0) turns it off → enter
  const { io } = scriptedIO([SPACE, ENTER]);
  const sel = multiSelect("pick", ITEMS, new Set(["a"]), io);
  assertEquals([...sel], []);
});

Deno.test("multiSelect: enter with no toggles keeps the preselected set", () => {
  const { io } = scriptedIO([ENTER]);
  const sel = multiSelect("pick", ITEMS, new Set(["b", "c"]), io);
  assertEquals([...sel].sort(), ["b", "c"]);
});

Deno.test("multiSelect: arrow-up wraps to the last row", () => {
  // up from row 0 wraps to c → toggle c → enter
  const { io } = scriptedIO([UP, SPACE, ENTER]);
  const sel = multiSelect("pick", ITEMS, new Set(), io);
  assertEquals([...sel], ["c"]);
});

Deno.test("multiSelect: j/k move like the arrows", () => {
  // j (down to b) → space → k (up to a) → space → enter
  const { io } = scriptedIO([[0x6a], SPACE, [0x6b], SPACE, ENTER]);
  const sel = multiSelect("pick", ITEMS, new Set(), io);
  assertEquals([...sel].sort(), ["a", "b"]);
});

Deno.test("multiSelect: EOF confirms the current selection", () => {
  // toggle a, then EOF (no ENTER) — should still return {a}
  const { io } = scriptedIO([SPACE]);
  const sel = multiSelect("pick", ITEMS, new Set(), io);
  assertEquals([...sel], ["a"]);
});

Deno.test("multiSelect: renders each item's label", () => {
  const { io, frames } = scriptedIO([ENTER]);
  multiSelect("Select features", ITEMS, new Set(), io);
  const out = frames();
  for (const it of ITEMS) if (!out.includes(it.label)) throw new Error(`missing ${it.label}`);
});
