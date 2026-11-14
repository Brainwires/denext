// The edges of src/desktop/window-config.ts the feature tests leave out: a size that is not an
// object, the default `console.warn` sink of every `apply*` helper, a non-window argument, a
// runtime method that throws (an Error or anything else), the private level op skipped for an
// unknown level, a level the runtime can't put on top, and the best-effort display placement
// (no `getBounds`, a throwing `getBounds` / `getScreen`).

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  applyDesktopWindowSettings,
  applySizeLimits,
  applyTitleBarStyle,
  applyTitleOptions,
  applyWindowButtonPosition,
  applyWindowLevel,
  applyWindowOverlaySettings,
  resolveDesktopWindowSettings,
} from "../src/desktop/window-config.ts";

/** Collect what `console.warn` gets while `fn` runs. */
function capturingWarn(fn: () => void): string[] {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return seen;
}

Deno.test("window-config: a size that is not an object is refused", () => {
  assertThrows(() => resolveDesktopWindowSettings({ minSize: 5 }), Error, "minSize");
  assertThrows(() => resolveDesktopWindowSettings({ maxSize: null }), Error, "maxSize");
});

Deno.test("window-config: every apply helper warns on console.warn by default", () => {
  const win = {}; // a runtime with none of the methods
  const seen = capturingWarn(() => {
    applyDesktopWindowSettings(win, { title: "T" });
    applySizeLimits(win, { minSize: { width: 10, height: 10 } });
    applyTitleBarStyle(win, "hidden");
    applyTitleOptions(win, { titleVisibility: "hidden" });
    applyWindowButtonPosition(win, { x: 1, y: 2 });
    applyWindowOverlaySettings(win, { opacity: 0.5 });
  });
  assertEquals(seen.length, 6);
  for (const line of seen) assertStringIncludes(line, "desktop: desktop.");
});

Deno.test("window-config: a non-window argument is a no-op", () => {
  const warn = (m: string) => {
    throw new Error(`unexpected warning: ${m}`);
  };
  for (const win of [undefined, null, 1, "w"]) {
    applyDesktopWindowSettings(win, { title: "T" }, warn);
    applySizeLimits(win, { minSize: { width: 1, height: 1 } }, warn);
    applyTitleBarStyle(win, "hidden", warn);
    applyTitleOptions(win, { titleVisibility: "hidden" }, warn);
    applyWindowButtonPosition(win, { x: 1, y: 1 }, warn);
    applyWindowOverlaySettings(win, { opacity: 1 }, warn);
    applyWindowLevel(win, "screen-saver");
  }
  applyDesktopWindowSettings({}, undefined, warn);
});

Deno.test("window-config: a throwing runtime method is a warning, its message or value kept", () => {
  const warnings: string[] = [];
  const win = {
    setTitle() {
      throw new Error("no title today");
    },
    setOpacity() {
      throw "opacity refused";
    },
  };
  applyDesktopWindowSettings(win, { title: "T", opacity: 0.4 }, (m) => warnings.push(m));
  assertEquals(warnings, [
    "desktop.window.title could not be applied: no title today",
    "desktop.window.opacity could not be applied: opacity refused",
  ]);
});

Deno.test("window-config: applyWindowLevel calls the private op only for a known level", () => {
  const codes: number[] = [];
  const win = {
    [Symbol.for("Deno_privateDesktopWindowLevel")](code: number) {
      codes.push(code);
    },
  };
  applyWindowLevel(win, "floating"); // at or below floating: left alone
  applyWindowLevel(win, "no-such-level");
  applyWindowLevel(win, "screen-saver");
  applyWindowLevel({}, "status"); // a runtime without the op
  assertEquals(codes, [4]);
});

Deno.test("window-config: a level the runtime can't put on top skips the level op", () => {
  const warnings: string[] = [];
  const codes: number[] = [];
  const win = {
    [Symbol.for("Deno_privateDesktopWindowLevel")](code: number) {
      codes.push(code);
    },
  };
  applyWindowOverlaySettings(win, { alwaysOnTop: "screen-saver" }, (m) => warnings.push(m));
  assertEquals(codes, []);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "desktop.window.alwaysOnTop");
});

Deno.test("window-config: placement on the display is best effort", () => {
  const area = { x: 0, y: 0, width: 1000, height: 800 };
  const noWarn = (m: string) => {
    throw new Error(`unexpected warning: ${m}`);
  };

  // No getBounds / setPosition: sized, not moved.
  const sized: Array<[number, number]> = [];
  applyDesktopWindowSettings(
    {
      getScreen: () => ({ workArea: area }),
      setSize: (w: number, h: number) => void sized.push([w, h]),
    },
    { width: 2000, height: 600 },
    noWarn,
  );
  assertEquals(sized, [[1000, 600]]);

  // A throwing getBounds: sized, the move skipped.
  const sized2: Array<[number, number]> = [];
  let moved = false;
  applyDesktopWindowSettings(
    {
      getScreen: () => ({ workArea: area }),
      setSize: (w: number, h: number) => void sized2.push([w, h]),
      getBounds: () => {
        throw new Error("gone");
      },
      setPosition: () => void (moved = true),
    },
    { width: 500 },
    noWarn,
  );
  assertEquals(sized2, [[500, 600]]);
  assertEquals(moved, false);

  // A throwing getScreen: no work area, the size uncapped.
  const sized3: Array<[number, number]> = [];
  applyDesktopWindowSettings(
    {
      getScreen: () => {
        throw new Error("no display");
      },
      getSize: () => [640, 480],
      setSize: (w: number, h: number) => void sized3.push([w, h]),
    },
    { height: 5000 },
    noWarn,
  );
  assertEquals(sized3, [[640, 5000]]);
});
