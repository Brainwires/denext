/**
 * Alert and prompt dialogs for `denext/mobile`: the system dialog through `@capacitor/dialog`
 * inside the native shell (`denext mobile add dialog`) when the dialog fits it, else an
 * accessible in-page modal (`role="alertdialog"`, focus kept inside, Escape to cancel, focus
 * returned on close). React Native mode's `Alert.alert` / `Alert.prompt` run on this. Internal:
 * not re-exported from `denext/mobile`.
 *
 * Dialogs queue: one opened while another is up waits for it, as iOS alerts do.
 *
 * @module
 */

import { nativePlugin } from "./plugin.ts";

/** A dialog button's role, as React Native's `Alert` names it. */
export type DialogButtonStyle = "default" | "cancel" | "destructive";

/** One button. */
export interface DialogButton {
  readonly text: string;
  readonly style?: DialogButtonStyle;
  /** Focused first in the in-page modal (React Native's `isPreferred`). */
  readonly preferred?: boolean;
}

/** The text field(s) of a prompt. */
export type DialogInput = "plain-text" | "secure-text" | "login-password";

/** What {@linkcode showDialog} shows. */
export interface DialogRequest {
  readonly title: string;
  readonly message?: string;
  /** At least one; the caller supplies React Native's default `OK`. */
  readonly buttons: readonly DialogButton[];
  /**
   * Whether a tap outside the in-page modal dismisses it (React Native's Android
   * `cancelable`). Escape always picks the `cancel`-style button when there is one, and
   * otherwise dismisses only when this is set.
   */
  readonly cancelable?: boolean;
  /** Show text field(s): a prompt. */
  readonly input?: DialogInput;
  /** The first field's initial text. */
  readonly defaultValue?: string;
  /** The first field's `inputmode` (from React Native's `keyboardType`). */
  readonly inputMode?: string;
}

/** How a dialog closed. */
export interface DialogResult {
  /** The index of the button pressed, or `null` when dismissed without one. */
  readonly index: number | null;
  /** The text entered (a prompt's first field). */
  readonly value?: string;
  /** The password entered (a `login-password` prompt's second field). */
  readonly password?: string;
}

/** The JS side of `@capacitor/dialog`. */
interface DialogPlugin {
  alert(options: { title?: string; message: string; buttonTitle?: string }): Promise<void>;
  confirm(options: {
    title?: string;
    message: string;
    okButtonTitle?: string;
    cancelButtonTitle?: string;
  }): Promise<{ value?: boolean }>;
  prompt(options: {
    title?: string;
    message: string;
    okButtonTitle?: string;
    cancelButtonTitle?: string;
    inputPlaceholder?: string;
    inputText?: string;
  }): Promise<{ value?: string; cancelled?: boolean }>;
}

/** The slice of a DOM element the modal uses (a real element and the test DOM satisfy it). */
interface DialogEl {
  setAttribute(name: string, value: string): void;
  readonly style: { setProperty(name: string, value: string): void };
  addEventListener(type: string, fn: (e: DialogEvent) => void): void;
  removeEventListener(type: string, fn: (e: DialogEvent) => void): void;
  appendChild(node: unknown): unknown;
  remove(): void;
  focus?(): void;
  textContent: string;
  value?: string;
  readonly parentNode: DialogEl | null;
}

/** The slice of `document` the modal uses. */
interface DialogDocument {
  createElement(tag: string): DialogEl;
  body?: { appendChild(node: unknown): unknown } | null;
  activeElement?: { focus?(): void } | null;
}

/** A DOM event as the modal reads it. */
interface DialogEvent {
  key?: string;
  shiftKey?: boolean;
  target?: unknown;
  preventDefault?(): void;
}

/** The tail of the dialog queue: each dialog waits for the one before it. */
let queue: Promise<unknown> = Promise.resolve();

/** A process-wide counter so each modal's ids are unique. */
let dialogSeq = 0;

/** The index of the `cancel`-style button, or -1. */
function cancelIndex(buttons: readonly DialogButton[]): number {
  return buttons.findIndex((b) => b.style === "cancel");
}

/**
 * Whether `request` fits `@capacitor/dialog`: at most two buttons, and a prompt only with a
 * plain text field (the plugin has no secure or two-field prompt).
 */
function fitsNative(request: DialogRequest): boolean {
  if (request.buttons.length > 2) return false;
  if (request.input === undefined) return true;
  return request.input === "plain-text" && request.buttons.length === 2;
}

/** For two buttons: which is the cancel one (the `cancel`-style, else the first) and which OK. */
function pair(buttons: readonly DialogButton[]): { cancel: number; ok: number } {
  const cancel = Math.max(0, cancelIndex(buttons));
  return { cancel, ok: cancel === 0 ? 1 : 0 };
}

/** Show `request` through the native plugin. */
async function showNative(plugin: DialogPlugin, request: DialogRequest): Promise<DialogResult> {
  const base = { title: request.title, message: request.message ?? "" };
  const { buttons } = request;
  if (request.input !== undefined) {
    const { cancel, ok } = pair(buttons);
    const result = await plugin.prompt({
      ...base,
      okButtonTitle: buttons[ok].text,
      cancelButtonTitle: buttons[cancel].text,
      ...(request.defaultValue !== undefined ? { inputText: request.defaultValue } : {}),
    });
    const value = result?.value ?? "";
    return result?.cancelled ? { index: cancel, value } : { index: ok, value };
  }
  if (buttons.length <= 1) {
    await plugin.alert({ ...base, buttonTitle: buttons[0]?.text ?? "OK" });
    return { index: 0 };
  }
  const { cancel, ok } = pair(buttons);
  const result = await plugin.confirm({
    ...base,
    okButtonTitle: buttons[ok].text,
    cancelButtonTitle: buttons[cancel].text,
  });
  return { index: result?.value ? ok : cancel };
}

/** Set several style properties on `el`. */
function styled(el: DialogEl, styles: Record<string, string>): DialogEl {
  for (const [name, value] of Object.entries(styles)) el.style.setProperty(name, value);
  return el;
}

/** A text field for the modal. */
function field(doc: DialogDocument, type: "text" | "password", label: string): DialogEl {
  const input = styled(doc.createElement("input"), {
    display: "block",
    width: "100%",
    "box-sizing": "border-box",
    margin: "12px 0 0",
    padding: "8px",
    font: "inherit",
    color: "inherit",
    background: "Field",
    border: "1px solid GrayText",
    "border-radius": "6px",
  });
  input.setAttribute("type", type);
  input.setAttribute("aria-label", label);
  return input;
}

/** The prompt's fields for `request`, appended to `card`. */
function promptFields(doc: DialogDocument, card: DialogEl, request: DialogRequest): DialogEl[] {
  if (request.input === undefined) return [];
  const fields = request.input === "login-password"
    ? [field(doc, "text", "Login"), field(doc, "password", "Password")]
    : [field(doc, request.input === "secure-text" ? "password" : "text", request.title)];
  if (request.defaultValue !== undefined) {
    fields[0].value = request.defaultValue;
    fields[0].setAttribute("value", request.defaultValue);
  }
  if (request.inputMode) fields[0].setAttribute("inputmode", request.inputMode);
  for (const f of fields) card.appendChild(f);
  return fields;
}

/** The modal's buttons, appended to a row in `card`; `choose(i)` runs on a click. */
function buttonRow(
  doc: DialogDocument,
  card: DialogEl,
  buttons: readonly DialogButton[],
  choose: (index: number) => void,
): DialogEl[] {
  const row = styled(doc.createElement("div"), {
    display: "flex",
    "flex-wrap": "wrap",
    "justify-content": "flex-end",
    gap: "8px",
    "margin-top": "16px",
  });
  const els = buttons.map((button, index) => {
    const el = styled(doc.createElement("button"), {
      font: "inherit",
      padding: "8px 14px",
      "border-radius": "8px",
      border: "none",
      cursor: "pointer",
      background: "transparent",
      color: button.style === "destructive" ? "#d70015" : "LinkText",
      "font-weight": button.style === "cancel" || button.preferred ? "600" : "400",
    });
    el.setAttribute("type", "button");
    el.setAttribute("data-style", button.style ?? "default");
    el.textContent = button.text;
    el.addEventListener("click", () => choose(index));
    row.appendChild(el);
    return el;
  });
  card.appendChild(row);
  return els;
}

/** The element to focus first: a field, else the preferred button, else the last button. */
function firstFocus(
  fields: DialogEl[],
  buttons: DialogEl[],
  request: DialogRequest,
): DialogEl | undefined {
  if (fields.length > 0) return fields[0];
  const preferred = request.buttons.findIndex((b) => b.preferred);
  return buttons[preferred >= 0 ? preferred : buttons.length - 1];
}

/** Whether `key` is Escape (either spelling). */
function isEscape(key: string | undefined): boolean {
  return key === "Escape" || key === "Esc";
}

/** The focusable after (or, with Shift, before) the focused one, wrapping around. */
function tabTarget(focusables: DialogEl[], target: unknown, back: boolean): DialogEl {
  const at = focusables.indexOf(target as DialogEl);
  const last = focusables.length - 1;
  if (back) return focusables[at <= 0 ? last : at - 1];
  return focusables[at < 0 || at === last ? 0 : at + 1];
}

/**
 * What a keydown in the modal does: Escape presses the `cancel`-style button (or dismisses a
 * `cancelable` dialog: `null`), Tab keeps focus inside, Enter in a field presses OK. Returns
 * the button index to close with (`null`: dismissed), or undefined to stay open.
 */
function keyAction(
  e: DialogEvent,
  request: DialogRequest,
  fields: DialogEl[],
  focusables: DialogEl[],
): number | null | undefined {
  if (isEscape(e.key)) {
    e.preventDefault?.();
    const cancel = cancelIndex(request.buttons);
    if (cancel >= 0) return cancel;
    return request.cancelable ? null : undefined;
  }
  if (e.key === "Tab" && focusables.length > 0) {
    e.preventDefault?.();
    tabTarget(focusables, e.target, e.shiftKey === true).focus?.();
    return undefined;
  }
  if (e.key === "Enter" && fields.includes(e.target as DialogEl)) {
    e.preventDefault?.();
    return request.buttons.length === 1 ? 0 : pair(request.buttons).ok;
  }
  return undefined;
}

/** Build, mount and drive the in-page modal; resolves how it closed. */
function showWeb(request: DialogRequest): Promise<DialogResult> {
  const doc = (globalThis as { document?: DialogDocument }).document;
  if (typeof doc?.createElement !== "function" || !doc.body) {
    return Promise.resolve({ index: null });
  }
  return new Promise<DialogResult>((resolve) => {
    const seq = ++dialogSeq;
    const opener = doc.activeElement ?? null;
    const backdrop = styled(doc.createElement("div"), {
      position: "fixed",
      inset: "0",
      "z-index": "2147483000",
      display: "flex",
      "align-items": "center",
      "justify-content": "center",
      padding: "16px",
      background: "rgba(0,0,0,0.4)",
    });
    backdrop.setAttribute("data-denext-dialog", "");
    const card = styled(doc.createElement("div"), {
      "max-width": "min(420px, 100%)",
      width: "100%",
      "box-sizing": "border-box",
      padding: "20px",
      "border-radius": "14px",
      background: "Canvas",
      color: "CanvasText",
      "box-shadow": "0 10px 40px rgba(0,0,0,0.3)",
      font: "15px/1.4 system-ui, -apple-system, sans-serif",
    });
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-modal", "true");
    const titleEl = styled(doc.createElement("h2"), { margin: "0", "font-size": "17px" });
    titleEl.setAttribute("id", `denext-dialog-${seq}-title`);
    titleEl.textContent = request.title;
    card.appendChild(titleEl);
    card.setAttribute("aria-labelledby", `denext-dialog-${seq}-title`);
    if (request.message) {
      const messageEl = styled(doc.createElement("p"), { margin: "8px 0 0" });
      messageEl.setAttribute("id", `denext-dialog-${seq}-message`);
      messageEl.textContent = request.message;
      card.appendChild(messageEl);
      card.setAttribute("aria-describedby", `denext-dialog-${seq}-message`);
    }
    const fields = promptFields(doc, card, request);
    let settled = false;
    const finish = (index: number | null) => {
      if (settled) return;
      settled = true;
      card.removeEventListener("keydown", onKey);
      backdrop.removeEventListener("click", onBackdrop);
      backdrop.remove();
      if (typeof opener?.focus === "function") opener.focus();
      resolve({
        index,
        ...(fields.length > 0 ? { value: fields[0].value ?? "" } : {}),
        ...(fields.length > 1 ? { password: fields[1].value ?? "" } : {}),
      });
    };
    const buttons = buttonRow(doc, card, request.buttons, finish);
    const focusables = [...fields, ...buttons];
    function onKey(e: DialogEvent): void {
      const index = keyAction(e, request, fields, focusables);
      if (index !== undefined) finish(index);
    }
    function onBackdrop(e: DialogEvent): void {
      if (e.target === backdrop && request.cancelable) finish(null);
    }
    card.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", onBackdrop);
    backdrop.appendChild(card);
    doc.body!.appendChild(backdrop);
    firstFocus(fields, buttons, request)?.focus?.();
  });
}

/** Show `request` now: natively when the plugin is there and it fits, else in the page. */
async function present(request: DialogRequest): Promise<DialogResult> {
  const plugin = nativePlugin<DialogPlugin>("Dialog", ["alert", "confirm", "prompt"]);
  if (plugin && fitsNative(request)) return await showNative(plugin, request);
  return await showWeb(request);
}

/**
 * Show a dialog and resolve how it closed: the index of the button pressed (and a prompt's
 * text), or `index: null` when it was dismissed without one.
 *
 * - Inside the native shell with `@capacitor/dialog` (`denext mobile add dialog`), the system
 *   dialog when it fits one: an alert with one button, a confirm with two (the `cancel`-style
 *   button, else the first, is the cancel one), a prompt with a plain text field and two
 *   buttons. Button styles have no native equivalent there.
 * - Otherwise an in-page `role="alertdialog"` modal: the title labels it and the message
 *   describes it, focus starts on the first field (else the preferred button, else the last)
 *   and stays inside (Tab wraps), Escape presses the `cancel`-style button (or dismisses when
 *   `cancelable`), Enter in a field presses OK, a destructive button is red, and focus returns
 *   to where it was. Without a document (SSR) it resolves `index: null` at once.
 *
 * @param request What to show.
 * @returns How the dialog closed.
 */
export function showDialog(request: DialogRequest): Promise<DialogResult> {
  const run = queue.then(() => present(request));
  queue = run.catch(() => {});
  return run;
}
