// What a browser posts for a rendered `<form>` — read off the real markup.
//
// Several suites drive `denext ui` panels with the body a browser would submit when nothing has
// been touched. The audit found the old suites posting hand-built bodies, which is how a form
// that could never be saved from a browser shipped: the renderer's presence markers and hidden
// companions made an untouched save write `[]` and `false` for keys the file never set. These
// helpers scrape the successful controls the way a browser reads them, so a test can only pass
// when render, post and decode agree.

import { assert } from "@std/assert";

/** One posted `[name, value]` pair. */
export type Posted = [string, string];

/** Attribute text back to the characters it stands for. */
export function unescapeAttr(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** One attribute of an opening tag (`undefined` when absent). */
function attrOf(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? unescapeAttr(match[1]) : undefined;
}

/**
 * Whether a boolean attribute (`checked`, `disabled`, `selected`) is set on an opening tag —
 * bare or with a value (`disabled=""`, as ReactDOMServer and the renderer write it).
 */
function flagged(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(?=[\\s>/=]|$)`).test(tag);
}

/**
 * The markup of the first `<form>` whose opening tag contains `needle` (an attribute such as
 * `data-dirty-track="1"` or `name="confirm"`), from its opening tag to its `</form>`.
 */
export function formContaining(markup: string, needle: string): string {
  for (const match of markup.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)) {
    if (/^<form[^>]*>/.exec(match[0])![0].includes(needle)) return match[0];
  }
  assert(false, `no <form> carries ${needle}`);
}

/** Every `<form method="post">` that carries `needle` anywhere in its markup. */
export function formsWith(markup: string, needle: string): { action: string; markup: string }[] {
  return [...markup.matchAll(/<form\b[^>]*method="post"[\s\S]*?<\/form>/g)]
    .map((match) => match[0])
    .filter((form) => form.includes(needle))
    .map((form) => ({
      action: attrOf(/^<form[^>]*>/.exec(form)![0], "action") ?? "",
      markup: form,
    }));
}

/** What one `<input>` contributes: nothing for a disabled, unnamed, unchecked or button control. */
function inputPair(tag: string): Posted | undefined {
  const name = attrOf(tag, "name");
  if (name === undefined || flagged(tag, "disabled")) return undefined;
  const type = attrOf(tag, "type") ?? "text";
  if (type === "submit" || type === "button") return undefined;
  const choice = type === "checkbox" || type === "radio";
  if (choice && !flagged(tag, "checked")) return undefined;
  return [name, attrOf(tag, "value") ?? (type === "checkbox" ? "on" : "")];
}

/** What one `<select>` contributes: its selected option, else — as a browser does — its first. */
function selectPair(open: string, inner: string): Posted | undefined {
  const name = attrOf(open, "name");
  if (name === undefined || flagged(open, "disabled")) return undefined;
  const options = [...inner.matchAll(/<option\b[^>]*>/g)].map((match) => match[0]);
  const chosen = options.find((option) => flagged(option, "selected")) ?? options[0];
  return chosen === undefined ? undefined : [name, attrOf(chosen, "value") ?? ""];
}

/** What one `<textarea>` contributes: its text, minus the leading newline the parser drops. */
function textareaPair(open: string, inner: string): Posted | undefined {
  const name = attrOf(open, "name");
  if (name === undefined || flagged(open, "disabled")) return undefined;
  return [name, unescapeAttr(inner.replace(/^\n/, ""))];
}

/**
 * The body a browser submits for `form`'s markup when its unnamed primary submit is pressed:
 * every successful control in document order — hidden and text inputs as rendered, a checkbox
 * or radio only when checked, a select as its selected (else first) option, a textarea's text.
 * Named submit buttons are not the submitter, so they contribute nothing.
 */
export function browserPost(form: string): Posted[] {
  const out: Posted[] = [];
  const controls = form.matchAll(
    /<input\b[^>]*>|<(select|textarea)\b([^>]*)>([\s\S]*?)<\/\1>/g,
  );
  for (const match of controls) {
    const [tag, kind, open, inner] = match;
    const pair = kind === undefined
      ? inputPair(tag)
      : kind === "select"
      ? selectPair(open, inner)
      : textareaPair(open, inner);
    if (pair) out.push(pair);
  }
  return out;
}

/** The same body, grouped by name (a toggle posts its name twice: the companion, then the box). */
export function browserPostByName(form: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, value] of browserPost(form)) (out[name] ??= []).push(value);
  return out;
}
