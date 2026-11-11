// The rules Loopy's browser keeps, as pure functions over what the page reported (unit-tested):
//
// - only http(s) URLs are opened;
// - it never types into a password, payment-card or one-time-code field, and never into a file
//   input (no uploads);
// - a click on anything that submits — a form's submit button, a button in a form that posts, or
//   anything labelled like "Pay", "Send", "Delete", "Place order" — asks the user first;
// - a page's text and its numbered list of links, buttons and inputs go back to the model as
//   untrusted data (voice/untrusted.ts).

import { clip, tidy, wrapUntrusted } from "./untrusted.ts";

/** One link, button or input on the page, as the page script describes it. */
export interface PageElement {
  /** Its number in the list (the `ref` the model clicks or types into). */
  readonly ref: number;
  /** The lower-case tag name. */
  readonly tag: string;
  /** `type` (inputs and buttons), lower-case; "" when absent. */
  readonly type: string;
  readonly role: string;
  /** Its visible text, value, `aria-label`, `alt` or `title`. */
  readonly text: string;
  readonly name: string;
  readonly id: string;
  readonly autocomplete: string;
  readonly placeholder: string;
  /** The text of its `<label>`. */
  readonly label: string;
  /** A link's resolved `href`. */
  readonly href: string;
  /** Inside a `<form>`. */
  readonly inForm: boolean;
  /** The form's method (or the button's `formmethod`), lower-case; "" outside a form. */
  readonly formMethod: string;
  /** `contenteditable`. */
  readonly editable: boolean;
}

/** A page as the page script reports it. */
export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  /** `document.body.innerText`. */
  readonly text: string;
  readonly elements: readonly PageElement[];
}

/** The longest page text passed to the model. */
export const MAX_PAGE_TEXT = 6_000;

/** The most elements listed. */
export const MAX_ELEMENTS = 80;

/**
 * `raw` as an http(s) URL to open, or a reason it isn't one. A bare host (`example.com/x`) is
 * taken as https.
 */
export function checkUrl(raw: unknown): { url: string } | { error: string } {
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > 2_048) {
    return { error: "url must be a web address" };
  }
  const text = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: "that isn't a valid web address" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: "Loopy's browser opens http and https addresses only" };
  }
  return { url: url.href };
}

/** The words of an attribute: separators and camelCase split, lower-case. */
function words(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-.[\]:]+/g, " ").toLowerCase();
}

/** Field names, ids, labels and placeholders that name a secret. */
const SECRET_WORDS =
  /\b(pass ?word|passwd|passphrase|passcode|pwd|pin|cvv2?|cvc2?|csc|cc ?(num|number|exp|csc)|card ?(num|number|no)|credit ?card|security ?code|expiry|expiration|one ?time ?(code|password)|otp|totp|2fa|mfa|verification ?code|auth(entication)? ?code|sms ?code|ssn|social ?security|iban|routing ?number|account ?number)\b/;

/** `autocomplete` tokens that name a secret. */
const SECRET_AUTOCOMPLETE = /\b(current-password|new-password|one-time-code|cc-[a-z-]+)\b/;

/**
 * Why Loopy won't type into `el`, or `null` when it may: a password, payment-card or
 * one-time-code field (by `type`, `autocomplete`, name, id, label or placeholder), a file input,
 * or something that takes no text.
 */
export function typingRefusal(el: PageElement): string | null {
  if (el.type === "file") return "Loopy doesn't upload files.";
  if (el.type === "password") return "Loopy never types into password fields.";
  if (SECRET_AUTOCOMPLETE.test(el.autocomplete.toLowerCase())) {
    return "Loopy never types passwords, card details or one-time codes.";
  }
  const named = [el.name, el.id, el.label, el.placeholder].map(words).join(" ");
  if (SECRET_WORDS.test(named)) {
    return "Loopy never types passwords, card details or one-time codes.";
  }
  const takesText = el.tag === "textarea" || el.tag === "select" || el.editable ||
    (el.tag === "input" && !NON_TEXT_INPUTS.has(el.type));
  return takesText ? null : "That isn't a text field.";
}

/** Input types that take no typed text. */
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Labels of controls that commit something. */
const SUBMIT_WORDS =
  /\b(submit|send|pay|buy|purchase|order|checkout|check out|confirm|sign up|signup|register|subscribe|unsubscribe|delete|remove|post|publish|transfer|donate|book|reserve|apply|save|upload|accept|agree)\b/i;

/**
 * Whether clicking `el` may submit, buy, post or delete something, so the user is asked first: a
 * submit input or button, a button inside a form that posts, or a control labelled that way.
 */
export function submitLike(el: PageElement): boolean {
  if (el.tag === "input" && (el.type === "submit" || el.type === "image")) return true;
  const button = el.tag === "button" || el.role === "button";
  if (el.tag === "button" && el.inForm && (el.type === "" || el.type === "submit")) return true;
  if (button && el.inForm && el.formMethod === "post") return true;
  return SUBMIT_WORDS.test(`${el.text} ${el.label}`);
}

/** Why Loopy won't click `el` at all, or `null`. */
export function clickRefusal(el: PageElement): string | null {
  return el.type === "file" ? "Loopy doesn't upload files." : null;
}

/** What kind of element `el` is, for the list. */
function elementKind(el: PageElement): string {
  if (el.tag === "a") return "link";
  if (el.tag === "input") return `input(${el.type || "text"})`;
  return el.editable ? "editable" : el.role || el.tag;
}

/** Whether `el` is a field (an input that isn't a button) Loopy refuses to type into. */
const refusedField = (el: PageElement) =>
  el.tag === "input" && !BUTTON_INPUTS.has(el.type) && typingRefusal(el) !== null;

/** Inputs that are buttons. */
const BUTTON_INPUTS = new Set(["submit", "button", "reset", "image"]);

/** What the model should know about `el` besides its kind and label. */
function elementNotes(el: PageElement): string[] {
  const notes: string[] = [];
  if (el.tag === "a" && el.href) notes.push(`→ ${clip(el.href, 120)}`);
  if (el.tag !== "a" && typingRefusal(el) === null) notes.push("(can type)");
  if (refusedField(el)) notes.push("(Loopy won't type here)");
  if (submitLike(el)) notes.push("(asks the user first)");
  return notes;
}

/** How one element is listed for the model. */
export function describeElement(el: PageElement): string {
  const label = clip(tidy(el.text || el.label || el.placeholder || el.name), 80);
  return [`[${el.ref}] ${elementKind(el)}`, label ? `"${label}"` : "", ...elementNotes(el)]
    .filter(Boolean).join(" ");
}

/** A page as the model reads it: its title and URL, its text and the numbered list, all wrapped. */
export function pageForModel(page: PageSnapshot): Record<string, unknown> {
  const text = clip(tidy(page.text), MAX_PAGE_TEXT);
  const list = page.elements.slice(0, MAX_ELEMENTS).map(describeElement).join("\n");
  const body = `Title: ${clip(tidy(page.title), 200)}\n\n${text}\n\nLinks, buttons and inputs:\n${
    list || "(none)"
  }`;
  return { url: page.url, page: wrapUntrusted(page.url, body) };
}

/** `value` as an element ref, or `null`. */
export function refOf(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 10_000 ? n : null;
}

/** The host of `url` for a question to the user (the URL itself when it has none). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
