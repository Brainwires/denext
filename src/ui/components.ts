// The shared pieces of the `denext ui` component views — the markup more than one panel repeats
// (the panel frame, a note, an output block, a coloured diff, a one-operation form, a table, a
// result list, …), built with `h()` so a feature view composes them instead of re-spelling them.
//
// Every piece renders its elements, attributes and classes in a fixed order, so a panel that
// swaps a local copy for the shared one keeps its markup byte for byte. No script, no inline
// style: the page CSP is unchanged. The form renderer (`form/*`) keeps its own primitives.

import { Fragment, h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeChildren } from "../jsx/types.ts";
import { UI_CSRF_FIELD } from "./security.ts";

/**
 * The `<section id="panel">` every panel is — the piece `ui.js` swaps — with its heading.
 *
 * @param props `name`: the `data-panel` marker (omitted when absent); `title`: the `<h1>`;
 *   `children`: the panel body after the heading.
 * @returns The section.
 */
export function Panel(
  { name, title, children }: {
    readonly name?: string;
    readonly title: string;
    readonly children?: VNodeChildren;
  },
): VNode {
  return h("section", { id: "panel", "data-panel": name }, h("h1", null, title), children);
}

/**
 * A `<p class="note">` — the panels' one-line remark (a refusal, a mode, a result). With
 * `role="alert"` it is a message the page announces: a validation failure, a warning.
 *
 * @param props `role`: `"alert"` to announce it; `children`: the note's content.
 * @returns The paragraph.
 */
export function Note(
  { role, children }: { readonly role?: "alert"; readonly children?: VNodeChildren },
): VNode {
  return h("p", { class: "note", role }, children);
}

/**
 * How a {@linkcode Badge} reads. The CSS colours each one; a badge with no tone stays grey.
 */
export type BadgeTone = "ok" | "todo" | "warn" | "fail" | "info";

/**
 * A `<span class="badge">` — the pill a panel puts beside a name to say what state it is in.
 *
 * `tone` is what colours it. Without one the badge renders exactly the markup every call site
 * emitted before this component existed, so adopting it is never a visual change on its own —
 * the colour arrives only when the caller has something to say.
 *
 * @param props `tone`: `ok` (done/set), `todo` (pending), `warn` (caution), `fail` (broken) or
 *   `info` (neutral but deliberate); `children`: the label.
 * @returns The span.
 */
export function Badge(
  { tone, children }: { readonly tone?: BadgeTone; readonly children?: VNodeChildren },
): VNode {
  return h("span", { class: tone === undefined ? "badge" : `badge ${tone}` }, children);
}

/** One entry of a {@linkcode Tabs} strip. */
export interface TabItem {
  /** Where the tab goes — a real URL, so it works with JavaScript disabled. */
  readonly href: string;
  /** The tab's label. */
  readonly label: string;
}

/**
 * A tab strip: ordinary links, marked `aria-current="page"` on the active one, exactly as the
 * top navigation is. Nothing here is a widget — a tab is a URL the server renders a panel for,
 * so the strip works with scripting off and each tab is linkable, bookmarkable and reloadable.
 *
 * Two shapes use it: a strip of distinct routes (`/config` beside `/config/next`), and a strip
 * of one route's views (`/docker?tab=services`). Both are just hrefs; the caller decides which
 * one is `active` rather than the component guessing from a URL it cannot see.
 *
 * @param props `items`: the tabs in order; `active`: the href to mark current; `label`: the
 *   accessible name of the strip (several panels can carry one).
 * @returns The navigation element.
 */
export function Tabs(
  { items, active, label }: {
    readonly items: readonly TabItem[];
    readonly active: string;
    readonly label: string;
  },
): VNode {
  return h(
    "nav",
    { class: "tabs", "aria-label": label },
    items.map((item) =>
      h("a", {
        key: item.href,
        href: item.href,
        "aria-current": item.href === active ? "page" : undefined,
      }, item.label)
    ),
  );
}

/**
 * A panel's filter box: a plain `GET` form that narrows what the page renders.
 *
 * Nothing here is a widget either — submitting navigates to the same panel with `?q=`, so the
 * filter works with scripting off, the query is in the URL (linkable, reloadable, in history),
 * and the server does the matching it already has the data for. The same shape the docs site
 * uses, and the same one the plugins panel's JSR search box already uses here.
 *
 * @param props `action`: the panel's own path; `query`: the current `?q=`; `label`: the
 *   accessible name and placeholder (e.g. "Filter config keys").
 * @returns The form.
 */
export function FilterForm(
  { action, query, label }: {
    readonly action: string;
    readonly query: string;
    readonly label: string;
  },
): VNode {
  return h(
    "form",
    { method: "get", action, class: "filter", role: "search" },
    h(Input, { type: "search", name: "q", value: query, placeholder: label, ariaLabel: label }),
    h("button", { type: "submit" }, "Filter"),
    // Only offered once there is something to clear, and it is a link, not a reset: it has to
    // drop `?q=` from the URL, which a form reset would leave in place.
    query === "" ? null : h("a", { class: "lead", href: action }, "Clear"),
  );
}

/**
 * The lead every two-step write's preview page opens with.
 *
 * @returns The paragraph.
 */
export function PreviewLead(): VNode {
  return h(
    "p",
    { class: "lead" },
    "Nothing has been written yet — review the change, then apply it.",
  );
}

/**
 * The note a write that would change nothing gets instead of a confirm button.
 *
 * @returns The note.
 */
export function NoChange(): VNode {
  return h(Note, null, "No change — the file already says this.");
}

/**
 * A key, a value, a file name or a path in the panels' monospace (`<code class="mono">`).
 *
 * @param props `children`: the text.
 * @returns The code element.
 */
export function Mono({ children }: { readonly children?: VNodeChildren }): VNode {
  return h("code", { class: "mono" }, children);
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
 * The common leading whitespace of every non-blank line, or `""` when they do not share one.
 *
 * @param lines The lines to compare.
 * @returns The shared prefix.
 */
function commonIndent(lines: readonly string[]): string {
  let common: string | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (common === null) {
      common = indent;
      continue;
    }
    let i = 0;
    while (i < common.length && i < indent.length && common[i] === indent[i]) i++;
    common = common.slice(0, i);
  }
  return common ?? "";
}

/**
 * A sliced value's source, with its continuation lines brought back to its first line's column.
 *
 * @param source The value's source text.
 * @returns The same text, re-indented.
 */
function dedentSource(source: string): string {
  const lines = source.split("\n");
  if (lines.length < 2) return source;
  const indent = commonIndent(lines.slice(1));
  if (indent === "") return source;
  const rest = lines.slice(1).map((line) =>
    line.startsWith(indent) ? line.slice(indent.length) : line
  );
  return [lines[0], ...rest].join("\n");
}

/**
 * A `<pre class="out">` holding source text that was sliced out of a file.
 *
 * The config reader hands a value's bytes back verbatim, and the span starts at the value itself
 * — so the first line carries no indentation while every line under it keeps the indentation it
 * had in the file. Rendered as-is that reads as a misaligned block: `[` at column 0, its entries
 * at 4, its closing bracket at 2. The writer must keep those bytes exact, because splicing an
 * edit back in uses the same spans, so the re-indent belongs here at the render instead.
 *
 * Only the leading whitespace shared by every continuation line is removed, so the value's own
 * internal shape survives. A block whose lines do not share one prefix — tabs mixed with spaces
 * — is left exactly as it arrived: showing it plainly beats guessing at it.
 *
 * @param props `source`: the value's source text.
 * @returns The block.
 */
export function SourceBlock({ source }: { readonly source: string }): VNode {
  return h("pre", { class: "out" }, dedentSource(source));
}

/**
 * One flex row of cells (`<div class="row">`).
 *
 * @param props `children`: the cells.
 * @returns The row.
 */
export function Row({ children }: { readonly children?: VNodeChildren }): VNode {
  return h("div", { class: "row" }, children);
}

/**
 * A `<table class="table">` with one header row.
 *
 * @param props `head`: the header cells; `rows`: the body rows.
 * @returns The table.
 */
export function Table(
  { head, rows }: { readonly head: readonly string[]; readonly rows: VNode[] },
): VNode {
  return h(
    "table",
    { class: "table" },
    h("thead", null, h("tr", null, head.map((cell, index) => h("th", { key: index }, cell)))),
    h("tbody", null, rows),
  );
}

/** One `<input>`'s attributes — every one optional but the type, name and value. */
export interface InputProps {
  /** The input type. */
  readonly type?: "text" | "number" | "checkbox" | "hidden" | "search";
  /** The form field name. */
  readonly name: string;
  /** The value (a checkbox's posted value). */
  readonly value: string;
  /** The longest value the field takes. */
  readonly maxLength?: number;
  /** A number field's step. */
  readonly step?: string;
  /** The browser's autofill hint. */
  readonly autocomplete?: string;
  /** The element id (so a `<label for>` can point at it). */
  readonly id?: string;
  /** Placeholder text (an empty one is left out). */
  readonly placeholder?: string;
  /** An accessible name, when no visible `<label>` points at the input. */
  readonly ariaLabel?: string;
  /** Whether a checkbox is checked. */
  readonly checked?: boolean;
  /** Whether the field must be filled in. */
  readonly required?: boolean;
  /** Render disabled. */
  readonly disabled?: boolean;
}

/**
 * One `<input>`. The prop order below is the attribute order; a `true` attribute renders bare,
 * `false`/`undefined` drops it.
 *
 * @param props The input's attributes.
 * @returns The input.
 */
export function Input(props: InputProps): VNode {
  return h("input", {
    type: props.type,
    name: props.name,
    value: props.value,
    maxlength: props.maxLength === undefined ? undefined : String(props.maxLength),
    step: props.step,
    autocomplete: props.autocomplete,
    id: props.id,
    placeholder: props.placeholder || undefined,
    "aria-label": props.ariaLabel,
    checked: props.checked,
    required: props.required,
    disabled: props.disabled,
  });
}

/**
 * One hidden field.
 *
 * @param props `name` and `value`; `disabled` keeps it out of the submit.
 * @returns The hidden input.
 */
export function Hidden(
  { name, value, disabled }: {
    readonly name: string;
    readonly value: string;
    readonly disabled?: boolean;
  },
): VNode {
  return h(Input, { type: "hidden", name, value, disabled });
}

/**
 * The session CSRF token as the hidden field every mutating form carries.
 *
 * @param props `csrf`: the session token.
 * @returns The hidden input.
 */
export function CsrfField({ csrf }: { readonly csrf: string }): VNode {
  return h(Hidden, { name: UI_CSRF_FIELD, value: csrf });
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

/**
 * One file as a collapsible block: its path and a badge in the summary, then its body (a diff,
 * the file's contents, or a note).
 *
 * @param props `path`, `badge`, whether it starts `open`, and the body as `children`.
 * @returns The details element.
 */
export function FileDetails(
  { path, badge, tone, open, children }: {
    readonly path: string;
    readonly badge: string;
    readonly tone?: BadgeTone;
    readonly open: boolean;
    readonly children?: VNodeChildren;
  },
): VNode {
  return h(
    "details",
    { open },
    h("summary", null, h("code", null, path), " ", h(Badge, { tone }, badge)),
    children,
  );
}

/** One group of a {@linkcode ResultList}: the marker every line starts with, and its paths. */
export interface ResultGroup {
  /** The text before each path (`"+ "`, `"• exists, skipped: "`). */
  readonly marker: string;
  /** The project-relative paths. */
  readonly paths: readonly string[];
}

/**
 * What a completed write did: a "Result" heading, then one line per path — each group's marker
 * and the path in code.
 *
 * @param props `groups`: the groups, in order.
 * @returns The heading and the list.
 */
export function ResultList({ groups }: { readonly groups: readonly ResultGroup[] }): VNode {
  const lines = groups.flatMap(({ marker, paths }) =>
    paths.map((path) => h("li", { key: marker + path }, marker, h("code", null, path)))
  );
  return h(Fragment, null, h("h2", null, "Result"), h("ul", null, lines));
}

/** Props of {@linkcode OpForm}. */
interface OpFormProps {
  /** The session CSRF token. */
  readonly csrf: string;
  /** The form action (the panel's own path unless the operation posts elsewhere). */
  readonly action: string;
  /** The submit button's label. */
  readonly label: string;
  /** Hidden fields carried with the operation (`op`, a row name, `confirm`, …). */
  readonly fields?: Readonly<Record<string, string>>;
  /** Extra fields inside the form, after the hidden ones. */
  readonly extra?: VNodeChildren;
  /** A class on the `<form>` itself. */
  readonly className?: string;
  /** Disable the button (what `--read-only` does to every write). */
  readonly disabled?: boolean;
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
    h(Hidden, { key: name, name, value })
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
