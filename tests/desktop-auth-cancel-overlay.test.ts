// The page-side cancel affordance of a system-browser sign-in on Deno Desktop
// (src/desktop/auth-cancel-overlay.ts), on a fake DOM: it mounts one accessible dialog with a
// Cancel button, Cancel and Escape cancel exactly once, the remover is idempotent and does not
// cancel, the text is overridable, a stale overlay is replaced, and with no DOM it is a no-op.

import { assert, assertEquals } from "@std/assert";
import { showAuthCancelOverlay } from "../src/desktop/auth-cancel-overlay.ts";
import { installFakeDocument } from "./helpers/fake-overlay-dom.ts";

Deno.test("cancel overlay: mounts an alertdialog whose Cancel cancels once and unmounts", () => {
  const { doc, restore } = installFakeDocument();
  try {
    let cancels = 0;
    const hide = showAuthCancelOverlay(() => cancels++);
    const root = doc.getElementById("denext-auth-cancel")!;
    assert(root.connected);
    assertEquals(root.style.position, "fixed");
    const dialog = root.children[0];
    assertEquals(dialog.attributes.get("role"), "alertdialog");
    assertEquals(dialog.attributes.get("aria-modal"), "true");
    assertEquals(dialog.children[0].textContent, "Finish signing in in your browser.");
    const button = doc.button()!;
    assertEquals(button.textContent, "Cancel");
    assertEquals(button.attributes.get("type"), "button");
    assert(button.focused, "the Cancel button takes focus");
    button.dispatch("click");
    button.dispatch("click");
    assertEquals(cancels, 1);
    assert(!root.connected);
    hide(); // already gone: a no-op
    assertEquals(cancels, 1);
  } finally {
    restore();
  }
});

Deno.test("cancel overlay: Escape cancels; other keys do not", () => {
  const { doc, restore } = installFakeDocument();
  try {
    let cancels = 0;
    showAuthCancelOverlay(() => cancels++);
    const root = doc.getElementById("denext-auth-cancel")!;
    root.dispatch("keydown", { key: "Enter" });
    assertEquals(cancels, 0);
    root.dispatch("keydown", { key: "Escape" });
    assertEquals(cancels, 1);
    assert(!root.connected);
  } finally {
    restore();
  }
});

Deno.test("cancel overlay: the remover unmounts without cancelling; text is overridable", () => {
  const { doc, restore } = installFakeDocument();
  try {
    let cancels = 0;
    const hide = showAuthCancelOverlay(() => cancels++, {
      message: "Terminez la connexion dans votre navigateur.",
      cancelLabel: "Annuler",
    });
    assertEquals(doc.button()!.textContent, "Annuler");
    hide();
    hide();
    assertEquals(cancels, 0);
    assertEquals(doc.getElementById("denext-auth-cancel"), null);
  } finally {
    restore();
  }
});

Deno.test("cancel overlay: a stale overlay is replaced, not stacked", () => {
  const { doc, restore } = installFakeDocument();
  try {
    showAuthCancelOverlay(() => {});
    showAuthCancelOverlay(() => {});
    assertEquals(doc.body.children.length, 1);
  } finally {
    restore();
  }
});

Deno.test("cancel overlay: without a DOM it does nothing", () => {
  let cancels = 0;
  const hide = showAuthCancelOverlay(() => cancels++);
  hide();
  assertEquals(cancels, 0);
});
