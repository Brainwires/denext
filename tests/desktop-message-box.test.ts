// An extension host's `confirm` (src/desktop/message-box.ts) over a fake
// `Deno.desktop.dialog.showMessageBox`: the options it hands the runtime (Electron's names), the
// answer it resolves (the button index, `cancelId` or `null` for a dismissed box), the checks it
// makes first, and the `unsupported` refusal on a runtime without native message boxes — whether
// the runtime predates FIRST_MESSAGE_DIALOG_RUNTIME or simply has no `showMessageBox`.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { desktopConfirm } from "../src/desktop/message-box.ts";
import { DesktopCapError } from "../src/desktop/extension.ts";
import { FIRST_MESSAGE_DIALOG_RUNTIME, supportsMessageDialog } from "../src/build/deno-version.ts";

/** A runtime whose message box answers `result`, recording what it was asked. */
function fakeDesktop(result: { response: number; cancelled: boolean } | Error) {
  const asked: Record<string, unknown>[] = [];
  const desktop = {
    dialog: {
      showMessageBox(options: Record<string, unknown>) {
        asked.push(options);
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
    },
  };
  return { desktop, asked };
}

/** A runtime new enough for message boxes. */
const NEW = FIRST_MESSAGE_DIALOG_RUNTIME;

async function refused(p: Promise<unknown>, code: string): Promise<DesktopCapError> {
  const err = await assertRejects(() => p, DesktopCapError);
  assertEquals(err.code, code);
  return err;
}

Deno.test("confirm: the pressed button's index, with Electron's options handed to the runtime", async () => {
  const { desktop, asked } = fakeDesktop({ response: 1, cancelled: false });
  const buttons = ["Quit", "Cancel"];
  const answer = await desktopConfirm({
    message: "Quit with a job running?",
    detail: "The job stops.",
    title: "Jobs",
    buttons,
    defaultId: 1,
    cancelId: 1,
    kind: "warning",
  }, { desktop, runtimeVersion: NEW });
  assertEquals(answer, 1);
  assertEquals(asked, [{
    message: "Quit with a job running?",
    detail: "The job stops.",
    title: "Jobs",
    type: "warning",
    buttons: ["Quit", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  }]);
  assert(asked[0].buttons !== buttons, "a copy of the labels");
});

Deno.test("confirm: the defaults are one info box with no ids", async () => {
  const { desktop, asked } = fakeDesktop({ response: 0, cancelled: false });
  assertEquals(await desktopConfirm({ message: "Saved." }, { desktop, runtimeVersion: NEW }), 0);
  assertEquals(asked, [{ message: "Saved.", type: "info", buttons: [] }]);
});

Deno.test("confirm: a box dismissed without a button resolves cancelId, or null without one", async () => {
  const dismissed = { response: -1, cancelled: true };
  const a = fakeDesktop(dismissed);
  assertEquals(
    await desktopConfirm({ message: "m", buttons: ["OK", "Cancel"], cancelId: 1 }, {
      desktop: a.desktop,
      runtimeVersion: NEW,
    }),
    1,
  );
  const b = fakeDesktop(dismissed);
  assertEquals(
    await desktopConfirm({ message: "m", buttons: ["OK", "Cancel"] }, {
      desktop: b.desktop,
      runtimeVersion: NEW,
    }),
    null,
  );
});

Deno.test("confirm: unsupported without native message boxes (no runtime, no showMessageBox, an older runtime)", async () => {
  // Deno.desktop.dialog.showMessageBox ships in 3.0.0-denext.16 (denext.14 and .15 were never published).
  assertEquals(FIRST_MESSAGE_DIALOG_RUNTIME, "3.0.0-denext.16");
  assert(!supportsMessageDialog("3.0.0-denext.13"), "3.0.0-denext.13 predates message boxes");
  assert(supportsMessageDialog(FIRST_MESSAGE_DIALOG_RUNTIME));
  assert(!supportsMessageDialog("not a version"));
  const err = await refused(
    desktopConfirm({ message: "m" }, { desktop: {}, runtimeVersion: NEW }),
    "unsupported",
  );
  assertEquals(err.status, 501);
  await refused(
    desktopConfirm({ message: "m" }, { desktop: { dialog: {} }, runtimeVersion: NEW }),
    "unsupported",
  );
  // showMessageBox present, but the runtime predates the release that ships it.
  const { desktop, asked } = fakeDesktop({ response: 0, cancelled: false });
  await refused(
    desktopConfirm({ message: "m" }, { desktop, runtimeVersion: "3.0.0-denext.13" }),
    "unsupported",
  );
  assertEquals(asked, [], "never asked");
  // The defaults: this process's Deno, which has no Deno.desktop.
  await refused(desktopConfirm({ message: "m" }), "unsupported");
});

Deno.test("confirm: bad options are a validation error before the runtime is asked", async () => {
  const { desktop, asked } = fakeDesktop({ response: 0, cancelled: false });
  const deps = { desktop, runtimeVersion: NEW };
  const bad = [
    null,
    {},
    { message: "" },
    { message: 1 },
    { message: "m", detail: 2 },
    { message: "m", title: false },
    { message: "m", kind: "question" },
    { message: "m", buttons: "OK" },
    { message: "m", buttons: ["OK", 2] },
    { message: "m", buttons: Array(17).fill("b") },
    { message: "m", buttons: ["A", "B"], defaultId: 2 },
    { message: "m", cancelId: 1 },
    { message: "m", buttons: ["A"], defaultId: 0.5 },
    { message: "m", buttons: ["A"], cancelId: -1 },
  ];
  for (const options of bad) {
    // deno-lint-ignore no-explicit-any
    await refused(desktopConfirm(options as any, deps), "validation");
  }
  assertEquals(asked, []);
  // Sixteen buttons and an index into them are fine.
  const ok = await desktopConfirm(
    { message: "m", buttons: Array(16).fill("b"), defaultId: 15, cancelId: 0 },
    deps,
  );
  assertEquals(ok, 0);
});

Deno.test("confirm: the runtime's own refusals map to validation and dialog_failed", async () => {
  const typeError = fakeDesktop(new TypeError("options.message must not contain a NUL character"));
  const err = await refused(
    desktopConfirm({ message: "m" }, { desktop: typeError.desktop, runtimeVersion: NEW }),
    "validation",
  );
  assert(err.message.includes("NUL"));
  const failed = fakeDesktop(new Error("The message box could not be shown"));
  const failure = await refused(
    desktopConfirm({ message: "m" }, { desktop: failed.desktop, runtimeVersion: NEW }),
    "dialog_failed",
  );
  assertEquals(failure.status, 500);
});
