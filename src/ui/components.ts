// The shared pieces of the `denext ui` component views — the markup every panel repeats (a
// note, an output block, a coloured diff, a one-operation form), built with `h()` so a feature
// view composes them instead of re-spelling the string helpers in `html.ts`.
//
// Each one renders the same elements, attributes and classes as its `html.ts` string twin
// (`opForm`, `diffHtml`), modulo entity spelling and the whitespace between tags — the view
// substrate test holds them to that. No script, no inline style: the page CSP is unchanged.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeChildren } from "../jsx/types.ts";
import type { OpFormOptions } from "./html.ts";
import { UI_CSRF_FIELD } from "./security.ts";

/**
 * A `<p class="note">` — the panels' one-line remark (a refusal, a mode, a result).
 *
 * @param props `children`: the note's content.
 * @returns The paragraph.
 */
export function Note({ children }: { readonly children?: VNodeChildren }): VNode {
  return h("p", { class: "note" }, children);
}

/**
 * A `<pre class="out">` output block. With no children it is the empty sink `ui.js` streams a
 * task's output into (the first `pre.out` of the panel).
 *
 * @param props `children`: the text to show (escaped by the renderer).
 * @returns The block.
 */
export function Out({ children }: { readonly children?: VNodeChildren }): VNode {
  return h("pre", { class: "out" }, children);
}

/**
 * The session CSRF token as the hidden field every mutating form carries.
 *
 * @param props `csrf`: the session token.
 * @returns The hidden input.
 */
export function CsrfField({ csrf }: { readonly csrf: string }): VNode {
  return h("input", { type: "hidden", name: UI_CSRF_FIELD, value: csrf });
}

/** The class each kind of diff line gets, by prefix — the first match wins. */
const DIFF_LINE_CLASSES: readonly (readonly [prefix: string, kind: string])[] = [
  ["+++", "meta"],
  ["---", "meta"],
  ["@@", "meta"],
  ["+", "add"],
  ["-", "del"],
];

/** One diff line: wrapped in its class's `<span>`, or plain text for a context line. */
function diffLine(line: string, index: number): VNodeChild {
  const kind = DIFF_LINE_CLASSES.find(([prefix]) => line.startsWith(prefix))?.[1];
  return kind === undefined ? line : h("span", { key: index, class: kind }, line);
}

/**
 * A unified diff as the panels' ordinary `<pre class="out">` block, with each added, removed
 * and hunk-header line wrapped in a class the stylesheet colours. The newlines between lines
 * are emitted as explicit text children — the renderer writes no whitespace of its own.
 *
 * @param props `diff`: the unified diff text.
 * @returns The block.
 */
export function DiffBlock({ diff }: { readonly diff: string }): VNode {
  const lines = diff.split("\n").flatMap((line, index) =>
    index === 0 ? [diffLine(line, index)] : ["\n", diffLine(line, index)]
  );
  return h("pre", { class: "out" }, h("code", { class: "diff" }, lines));
}

/** Props of {@linkcode OpForm}: `opForm`'s options, the token, and component-tree extras. */
interface OpFormProps extends Omit<OpFormOptions, "extra"> {
  /** The session CSRF token. */
  readonly csrf: string;
  /** Extra fields inside the form, after the hidden ones. */
  readonly extra?: VNodeChildren;
}

/**
 * One operation as a real `<form method="post">` — the CSRF token, the operation's hidden
 * fields and a submit button. Works with JavaScript disabled; `ui.js` upgrades the same form to
 * fetch + panel swap.
 *
 * @param props Action, label, hidden fields, extra fields and whether the button is disabled.
 * @returns The form.
 */
export function OpForm(props: OpFormProps): VNode {
  const hidden = Object.entries(props.fields ?? {}).map(([name, value]) =>
    h("input", { key: name, type: "hidden", name, value })
  );
  return h(
    "form",
    { method: "post", action: props.action, class: props.className },
    h(CsrfField, { csrf: props.csrf }),
    hidden,
    props.extra,
    h("button", { type: "submit", disabled: props.disabled === true }, props.label),
  );
}
