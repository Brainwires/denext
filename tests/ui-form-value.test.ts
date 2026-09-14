// The form codec and the renderer: `decode(spec, encode(spec, value))` deep-equals `value` for
// every widget kind, list buttons move rows without JavaScript, out-of-range numbers are
// reported rather than clamped, and nothing a config file contains can escape into markup.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  loadConfigSchema,
  MAP_SEGMENT,
  resolveAt,
  type SchemaNode,
} from "../src/ui/form/schema.ts";
import { widgetFor, type WidgetSpec } from "../src/ui/form/widget.ts";
import {
  applyListOp,
  decode,
  encode,
  fieldName,
  type FormEntry,
  FormValueError,
  parseFieldName,
  parseOp,
} from "../src/ui/form/value.ts";
import { readWidget, renderWidget } from "../src/ui/form/render.ts";
import { control, field, opButton } from "../src/ui/form/control.ts";
import { toHtml } from "../src/ui/html.ts";

const SCHEMA = loadConfigSchema();

/** The widget for a real config path. */
function specAt(...path: string[]): WidgetSpec {
  return widgetFor(resolveAt(SCHEMA, path), path, false);
}

/** Assert that a value survives a trip through the form and back. */
function assertRoundTrip(spec: WidgetSpec, value: unknown, label: string): void {
  assertEquals(decode(spec, encode(spec, value)), value, label);
}

/** Render a widget with a fixed CSRF token. */
function render(spec: WidgetSpec, value: unknown, readOnly = false): string {
  return toHtml(renderWidget(spec, value, { csrf: "tok", readOnly }));
}

Deno.test("every widget kind round-trips its value through a flat form body", () => {
  assertRoundTrip(specAt("basePath"), "/app", "text");
  assertRoundTrip(specAt("apiMaxBodyBytes"), 2048, "number");
  assertRoundTrip(specAt("trailingSlash"), true, "toggle (true)");
  assertRoundTrip(specAt("trailingSlash"), false, "toggle (false)");
  assertRoundTrip(specAt("mode"), "spa", "segmented");
  assertRoundTrip(specAt("images", "formats"), ["image/webp", "image/avif"], "multi-select");
  assertRoundTrip(specAt("publicEnv"), ["API_URL", "SENTRY_DSN"], "chips");
  assertRoundTrip(specAt("images", "deviceSizes"), [640, 1080], "chips of numbers");
  assertRoundTrip(specAt("tailwind"), { input: "a.css", output: "b.css" }, "group");
  assertRoundTrip(specAt("spa", "env"), { API: "1", FLAG: "2" }, "map");
  assertRoundTrip(specAt("mdx", "remarkPlugins"), ["remark-gfm"], "code");
  assertRoundTrip(
    specAt("redirects"),
    [
      { source: "/a", destination: "/b", permanent: true },
      { source: "/c", destination: "/d", permanent: false },
    ],
    "list-of-forms",
  );
  assertRoundTrip(
    specAt("headers"),
    [{ source: "/(.*)", headers: [{ key: "x-a", value: "1" }] }],
    "nested list-of-forms",
  );
  const textarea: SchemaNode = { type: "string", "x-denext": { widget: "textarea" } };
  assertRoundTrip(widgetFor(textarea, ["spa", "head"], false), "<meta>", "textarea");
  const select: SchemaNode = { type: "string", enum: ["a", "b", "c", "d", "e"] };
  assertRoundTrip(widgetFor(select, ["pick"], true), "d", "select");
});

Deno.test("a union round-trips through whichever branch holds the value", () => {
  assertRoundTrip(specAt("csp"), "strict", "enum branch");
  assertRoundTrip(specAt("csp"), { scriptSrc: ["'self'"], imgSrc: ["data:"] }, "object branch");
  assertRoundTrip(specAt("hsts"), false, "a non-string enum branch stays a boolean");
  assertRoundTrip(specAt("hsts"), { maxAge: 63072000, preload: true }, "object branch");
  assertRoundTrip(specAt("compatibilityMode"), true, "boolean branch");
  assertRoundTrip(specAt("compatibilityMode"), "auto", "enum branch");
  assertRoundTrip(specAt("cache", "store"), "sqlite", "enum branch");
  assertRoundTrip(specAt("scheduledTasks"), { "0 3 * * *": ["cleanup", "digest"] }, "map of union");
  assertRoundTrip(specAt("scheduledTasks"), { "0 3 * * *": "cleanup" }, "map of union (scalar)");
});

Deno.test("an absent field stays absent, and an empty list stays empty", () => {
  assertEquals(encode(specAt("basePath"), undefined), []);
  assertEquals(decode(specAt("basePath"), []), undefined);
  assertEquals(decode(specAt("redirects"), []), undefined, "no marker ⇒ leave the key alone");
  assertRoundTrip(specAt("redirects"), [], "a list the user cleared");
  assertRoundTrip(specAt("spa", "env"), {}, "a map the user cleared");
  assertRoundTrip(specAt("images", "formats"), [], "nothing checked");
});

Deno.test("the field names are the bracket paths the renderer posts", () => {
  assertEquals(fieldName(["redirects", "2", "permanent"]), "redirects[2].permanent");
  assertEquals(fieldName(["headers", "0", "headers", "1", "key"]), "headers[0].headers[1].key");
  assertEquals(fieldName(["spa", "env", MAP_SEGMENT]), "spa.env[*]");
  assertEquals(fieldName(["basePath"], "cfg."), "cfg.basePath");
  assertEquals(parseFieldName("redirects[2].permanent"), ["redirects", "2", "permanent"]);
  assertEquals(parseFieldName("headers[0].headers[1].key"), [
    "headers",
    "0",
    "headers",
    "1",
    "key",
  ]);
  assertEquals(parseFieldName("spa.env[0]~key"), ["spa", "env", "0"]);
  const entries = encode(specAt("redirects"), [{ source: "/a", destination: "/b" }]);
  assertEquals(entries.map((entry) => entry.name), [
    "redirects~n",
    "redirects[0].source",
    "redirects[0].destination",
  ]);
});

Deno.test("a name prefix carries through encode, decode and render", () => {
  const spec = specAt("basePath");
  const entries = encode(spec, "/app", "cfg.");
  assertEquals(entries, [{ name: "cfg.basePath", value: "/app" }]);
  assertEquals(decode(spec, entries, "cfg."), "/app");
  assertStringIncludes(
    toHtml(renderWidget(spec, "/app", { csrf: "tok", namePrefix: "cfg." })),
    'name="cfg.basePath"',
  );
});

Deno.test("numbers are parsed, and an out-of-range value is reported, never clamped", () => {
  const spec = specAt("apiBatch", "maxItems");
  const post = (value: string): FormEntry[] => [{ name: "apiBatch.maxItems", value }];
  assertEquals(decode(spec, post("50")), 50);
  assertEquals(decode(spec, post("")), undefined);
  const low = assertThrows(() => decode(spec, post("0")), FormValueError, "must be at least 1");
  assertEquals((low as FormValueError).field, "apiBatch.maxItems");
  assertThrows(() => decode(spec, post("101")), FormValueError, "must be at most 100");
  assertThrows(() => decode(spec, post("lots")), FormValueError, "is not a number");
  // The bound is inclusive on both ends.
  assertEquals(decode(spec, post("1")), 1);
  assertEquals(decode(spec, post("100")), 100);
});

Deno.test("a checkbox posts a real false through its hidden companion", () => {
  const spec = specAt("trailingSlash");
  assertEquals(decode(spec, [{ name: "trailingSlash", value: "off" }]), false);
  assertEquals(
    decode(spec, [{ name: "trailingSlash", value: "off" }, {
      name: "trailingSlash",
      value: "on",
    }]),
    true,
  );
  assertEquals(decode(spec, []), undefined, "a form that did not carry the field changes nothing");
  const markup = render(spec, false);
  assertStringIncludes(markup, 'type="hidden" value="off"');
  assertStringIncludes(markup, 'type="checkbox"');
  assert(!markup.includes("checked"), "an unchecked box must not render `checked`");
});

Deno.test("a read-only cell renders disabled and leaves the config untouched", () => {
  const spec = specAt("plugins");
  const markup = render(spec, [{ name: "@denext/openapi" }]);
  assertStringIncludes(markup, "<textarea");
  assertStringIncludes(markup, "disabled");
  assertStringIncludes(markup, "read-only");
  assertEquals(decode(spec, []), undefined, "a disabled control posts nothing ⇒ no change");
});

Deno.test("list rows carry real submit buttons with their index and their list", () => {
  const spec = specAt("redirects");
  const markup = render(spec, [
    { source: "/a", destination: "/b", permanent: true },
    { source: "/c", destination: "/d" },
  ]);
  assertStringIncludes(markup, 'name="op" value="up:1:redirects"');
  assertStringIncludes(markup, 'name="op" value="down:0:redirects"');
  assertStringIncludes(markup, 'name="op" value="remove:1:redirects"');
  assertStringIncludes(markup, 'name="op" value="add:2:redirects"');
  assertStringIncludes(markup, 'name="redirects[1].source"');
  assertStringIncludes(markup, 'name="redirects~n" type="hidden" value="2"');
  assertStringIncludes(markup, "<fieldset");
  assertStringIncludes(markup, `name="_csrf" type="hidden" value="tok"`);
  // The first row cannot move up and the last cannot move down.
  assertStringIncludes(
    markup,
    'value="up:0:redirects" title="Move up" aria-label="Move up" formnovalidate disabled',
  );
  assertStringIncludes(
    markup,
    'value="down:1:redirects" title="Move down" aria-label="Move down" formnovalidate disabled',
  );
});

Deno.test("a row button's packed value parses back into an operation", () => {
  assertEquals(parseOp("up:1:redirects"), { op: "up", at: 1, list: "redirects" });
  assertEquals(parseOp("add:0:headers[0].headers"), {
    op: "add",
    at: 0,
    list: "headers[0].headers",
  });
  assertEquals(parseOp("nope:1:redirects"), undefined);
  assertEquals(parseOp("up:-1:redirects"), undefined);
  assertEquals(parseOp("up:1:"), undefined);
  assertEquals(parseOp("up"), undefined);
});

Deno.test("applyListOp moves, removes and inserts rows", () => {
  const list = [{ source: "/a" }, { source: "/b" }, { source: "/c" }];
  const sources = (rows: { source?: string }[]) => rows.map((row) => row.source);
  assertEquals(sources(applyListOp(list, "up", 2)), ["/a", "/c", "/b"]);
  assertEquals(sources(applyListOp(list, "down", 0)), ["/b", "/a", "/c"]);
  assertEquals(sources(applyListOp(list, "remove", 1)), ["/a", "/c"]);
  assertEquals(sources(applyListOp(list, "add", 3, { source: "" })), ["/a", "/b", "/c", ""]);
  assertEquals(sources(applyListOp(list, "add", 1, { source: "/new" })), [
    "/a",
    "/new",
    "/b",
    "/c",
  ]);
  // Edges and stale indices are no-ops, never corruption.
  assertEquals(sources(applyListOp(list, "up", 0)), ["/a", "/b", "/c"]);
  assertEquals(sources(applyListOp(list, "down", 2)), ["/a", "/b", "/c"]);
  assertEquals(sources(applyListOp(list, "remove", 9)), ["/a", "/b", "/c"]);
  assertEquals(applyListOp(list, "add", 99, { source: "/z" }).length, 4);
  assertEquals(applyListOp([], "add", 0), [null]);
  assertEquals(list.length, 3, "the input list is never mutated");
});

Deno.test("a submitted list survives its own button: decode, apply, re-render", () => {
  const spec = specAt("redirects");
  const value = [{ source: "/a", destination: "/b" }, { source: "/c", destination: "/d" }];
  const posted = encode(spec, value);
  const decoded = decode(spec, posted) as Record<string, unknown>[];
  const request = parseOp("up:1:redirects");
  assert(request);
  const moved = applyListOp(decoded, request.op, request.at);
  assertEquals(moved.map((row) => row.source), ["/c", "/a"]);
  assertEquals(decode(spec, encode(spec, moved)), moved);
});

Deno.test("a map row keeps its key beside its value", () => {
  const spec = specAt("spa", "env");
  const markup = render(spec, { API_URL: "https://x" });
  assertStringIncludes(markup, 'name="spa.env[0]~key" aria-label="env key 1" type="text"');
  assertStringIncludes(markup, 'value="API_URL"');
  assertStringIncludes(markup, 'name="spa.env[0]" id="f-spa-env-0-" type="text" value="https://x"');
  assertStringIncludes(markup, 'name="op" value="add:1:spa.env"');
  // A row whose key was blanked out is dropped rather than written as "".
  assertEquals(
    decode(spec, [
      { name: "spa.env~n", value: "2" },
      { name: "spa.env[0]~key", value: "" },
      { name: "spa.env[0]", value: "orphan" },
      { name: "spa.env[1]~key", value: "OK" },
      { name: "spa.env[1]", value: "1" },
    ]),
    { OK: "1" },
  );
});

Deno.test("a union renders its picker and only the selected branch", () => {
  const spec = specAt("csp");
  const strict = render(spec, "strict");
  assertStringIncludes(strict, 'name="csp~branch" type="radio" value="0" checked');
  assert(!strict.includes('name="csp.scriptSrc'), "the object branch is not rendered");
  const object = render(spec, { scriptSrc: ["'self'"] });
  assertStringIncludes(object, 'name="csp.scriptSrc[0]"');
  assertStringIncludes(object, 'name="csp~branch" type="radio" value="2" checked');
});

Deno.test("read-only mode disables every control and every row button", () => {
  const markup = render(specAt("redirects"), [{ source: "/a" }], true);
  assertEquals(markup.match(/<input(?![^>]*disabled)/g), null, "no input escapes --read-only");
  assertEquals(markup.match(/<button(?![^>]*disabled)/g), null, "no button escapes --read-only");
});

Deno.test("nothing in a config value can escape into markup", () => {
  const attack = '"><script>alert(1)</script>';
  const markup = render(specAt("redirects"), [{ source: attack, destination: attack }]);
  assert(!markup.includes("<script"), markup.slice(0, 400));
  // The quote that would have closed the `value` attribute is escaped along with the tag.
  assertStringIncludes(markup, "&quot;&gt;&lt;script&gt;");
  const mapMarkup = render(specAt("spa", "env"), { [attack]: attack });
  assert(!mapMarkup.includes("<script"));
  const codeMarkup = render(specAt("mdx", "remarkPlugins"), [attack]);
  assert(!codeMarkup.includes("<script"));
});

Deno.test("the control primitive is the only place markup is built", () => {
  assertEquals(
    toHtml(control({ tag: "input", name: "a&b", value: '<"x">' })),
    '<input name="a&amp;b" type="text" value="&lt;&quot;x&quot;&gt;">',
  );
  assertEquals(
    toHtml(
      control({ tag: "select", name: "s", value: "b", options: [{ value: "b", label: "B" }] }),
    ),
    '<select name="s"><option value="b" selected>B</option></select>',
  );
  assertStringIncludes(
    toHtml(control({ tag: "textarea", name: "t", value: "<x>", rows: 2 })),
    ">\n&lt;x&gt;</textarea>",
  );
  assertStringIncludes(
    toHtml(
      field({
        id: "f-x",
        label: "x",
        help: "h",
        error: "e",
        body: control({ tag: "input", name: "x" }),
      }),
    ),
    'role="alert"',
  );
  assertStringIncludes(
    toHtml(opButton({ op: "remove", at: 0, list: "l", label: "✕", title: "Remove" })),
    'value="remove:0:l"',
  );
});

/** The references the renderer emits, back to characters. */
const ENTITY: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/**
 * A `<textarea>`'s value as a browser parses and posts it: the content between its start and
 * end tags, minus the ONE newline the HTML parser drops right after the start tag, decoded.
 */
function parsedTextarea(markup: string, name: string): string {
  const start = markup.indexOf(`<textarea name="${name}"`);
  assert(start >= 0, `no textarea named ${name}`);
  const open = markup.indexOf(">", start) + 1;
  const content = markup.slice(open, markup.indexOf("</textarea>", open));
  return content.replace(/^\n/, "").replace(/&(?:amp|lt|gt|quot|#39);/g, (ref) => ENTITY[ref]);
}

Deno.test("a textarea keeps a value's leading newlines through render and parse", () => {
  const value = '\n\n<meta name="x">\n';
  const markup = toHtml(control({ tag: "textarea", name: "t", value }));
  // The one newline the parser eats, then the value's own two.
  assertStringIncludes(markup, 'style="width:100%">\n\n\n&lt;meta');
  assertEquals(parsedTextarea(markup, "t"), value);
  // The same through a schema-driven textarea widget, and back through the form codec.
  const spec = specAt("spa", "head");
  assertEquals(spec.kind, "textarea");
  const posted = parsedTextarea(render(spec, value), "spa.head");
  assertEquals(posted, value);
  assertEquals(decode(spec, [{ name: "spa.head", value: posted }]), value);
});

Deno.test("readWidget decodes one posted field on its own", () => {
  assertEquals(readWidget(SCHEMA, "redirects[0].permanent", "on"), true);
  assertEquals(readWidget(SCHEMA, "basePath", "/app"), "/app");
  assertEquals(readWidget(SCHEMA, "apiBatch.maxItems", "10"), 10);
  assertThrows(() => readWidget(SCHEMA, "nope", "x"), Error, "no schema at `nope`");
});
