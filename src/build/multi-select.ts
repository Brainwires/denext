// A minimal terminal multi-select (checkbox list) for `denext create`/`init`.
// Kept dependency-free and small; the terminal I/O is injectable so the
// key-handling logic is unit-testable without a real TTY.

/** Terminal I/O used by {@linkcode multiSelect}; injectable for tests. */
export interface TermIO {
  /** Read available bytes into `buf`; return the count, or `null` at EOF. */
  read(buf: Uint8Array): number | null;
  /** Write a string to the terminal. */
  write(s: string): void;
  /** Enter/leave raw mode (no-op in tests). */
  setRaw(raw: boolean): void;
}

/** The default {@linkcode TermIO} backed by `Deno.stdin`/`Deno.stdout`. */
export const denoTerm: TermIO = {
  read: (buf) => Deno.stdin.readSync(buf),
  write: (s) => {
    Deno.stdout.writeSync(new TextEncoder().encode(s));
  },
  setRaw: (raw) => Deno.stdin.setRaw(raw),
};

/** A selectable row: `key` is returned; `label` is displayed. */
export interface MultiSelectItem {
  /** Stable identifier returned when the row is selected. */
  key: string;
  /** Human-readable text shown in the list. */
  label: string;
}

/**
 * A minimal terminal multi-select: ↑/↓ (or j/k) move, space toggles, enter
 * confirms, Ctrl-C aborts (`Deno.exit(130)`). Puts stdin in raw mode via `io`
 * (restored in a `finally`), so call it only on a TTY. EOF (`read` → `null`)
 * confirms the current selection.
 *
 * @param title Heading shown above the list.
 * @param items The selectable rows.
 * @param preselected Keys checked initially (e.g. from CLI flags).
 * @param io Terminal I/O (defaults to {@linkcode denoTerm}; inject for tests).
 * @returns The set of selected `key`s.
 */
export function multiSelect(
  title: string,
  items: MultiSelectItem[],
  preselected: Set<string>,
  io: TermIO = denoTerm,
): Set<string> {
  const selected = new Set(preselected);
  let cursor = 0;

  const draw = (redraw: boolean) => {
    if (redraw) io.write(`\x1b[${items.length + 1}A`); // back up over the previous frame
    io.write("\x1b[0J"); // clear to end of screen
    io.write(title + "\n");
    items.forEach((it, i) => {
      const mark = selected.has(it.key) ? "◉" : "◯";
      const row = `${i === cursor ? "›" : " "} ${mark} ${it.label}`;
      io.write((i === cursor ? `\x1b[36m${row}\x1b[0m` : row) + "\n");
    });
  };

  io.setRaw(true);
  try {
    io.write("\x1b[?25l"); // hide cursor
    draw(false);
    const buf = new Uint8Array(8);
    while (true) {
      const n = io.read(buf);
      if (n === null) break; // EOF → confirm
      const b = buf.subarray(0, n);
      if (b[0] === 0x03) { // Ctrl-C
        io.write("\x1b[?25h\n");
        io.setRaw(false);
        Deno.exit(130);
      }
      if (b[0] === 0x0d || b[0] === 0x0a) break; // enter → confirm
      if (b[0] === 0x20) { // space: toggle the row under the cursor
        const k = items[cursor].key;
        if (selected.has(k)) selected.delete(k);
        else selected.add(k);
      } else if (b[0] === 0x1b && b[1] === 0x5b) { // arrows: ESC [ A/B
        if (b[2] === 0x41) cursor = (cursor - 1 + items.length) % items.length;
        else if (b[2] === 0x42) cursor = (cursor + 1) % items.length;
      } else if (b[0] === 0x6b) { // k → up
        cursor = (cursor - 1 + items.length) % items.length;
      } else if (b[0] === 0x6a) { // j → down
        cursor = (cursor + 1) % items.length;
      }
      draw(true);
    }
  } finally {
    io.write("\x1b[?25h"); // show cursor
    io.setRaw(false);
  }
  io.write("\n");
  return selected;
}
