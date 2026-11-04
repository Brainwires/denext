// The Go template subset `/auth/v1`'s mail templates run on: control structures, variables,
// pipes, the builtin functions and Go's value printing, and the errors that make the sender fall
// back to the built-in template.

import { assertEquals, assertThrows } from "@std/assert";
import { executeGoTemplate, GoTemplateError } from "../packages/auth/src/gotrue/go-template.ts";

const DATA = {
  Name: "Ada",
  N: 3,
  List: ["a", "b", "c"],
  Map: { b: 2, a: 1 },
  Empty: [],
  Nested: { inner: { deep: "x" } },
  Yes: true,
};

const run = (t: string, data: Record<string, unknown> = DATA) =>
  executeGoTemplate(t, data, (s) => s.replace(/</g, "&lt;"));

const fails = (t: string) => assertThrows(() => run(t), GoTemplateError);

Deno.test("go template: text, fields, trim markers and comments", () => {
  assertEquals(run("plain"), "plain");
  assertEquals(run("{{ .Name }}-{{.Nested.inner.deep}}"), "Ada-x");
  assertEquals(run("a  {{- .Name -}}  b"), "aAdab");
  assertEquals(run("a {{- /* gone */ -}} b"), "ab");
  assertEquals(run("{{ .Missing }}|{{ .Missing.deeper }}"), "|");
  assertEquals(run("{{ . }}", { x: 1 } as Record<string, unknown>), "map[x:1]");
  assertEquals(run('{{ "a}}b" }}'), "a}}b");
  assertEquals(run("{{ `raw\\n` }}"), "raw\\n");
  assertEquals(run('{{ "q\\"<" }}'), 'q"&lt;');
});

Deno.test("go template: Go's value printing", () => {
  assertEquals(run("{{ .List }} {{ .Map }} {{ .Yes }} {{ nil }}"), "[a b c] map[a:1 b:2] true ");
  const nums = { a: 1000000, b: 123456, c: 0.00001, d: 1.5, e: -0, f: 0, g: 1e21 };
  assertEquals(
    run("{{ .a }} {{ .b }} {{ .c }} {{ .d }} {{ .e }} {{ .f }} {{ .g }}", nums),
    "1e+06 123456 1e-05 1.5 -0 0 1e+21",
  );
  assertEquals(
    run("{{ .x }} {{ .y }} {{ .z }}", { x: NaN, y: Infinity, z: -Infinity }),
    "NaN +Inf -Inf",
  );
  assertEquals(run("{{ 0x1F }} {{ -2 }} {{ 1.25 }}"), "31 -2 1.25");
});

Deno.test("go template: if / else if / else, with / else with", () => {
  assertEquals(run("{{ if .Empty }}x{{ else if .Missing }}y{{ else }}z{{ end }}"), "z");
  assertEquals(run("{{ if .Map }}m{{ end }}{{ if 0 }}0{{ end }}{{ if .Name }}n{{ end }}"), "mn");
  assertEquals(run("{{ with .Missing }}a{{ else with .Nested }}{{ .inner.deep }}{{ end }}"), "x");
  assertEquals(run("{{ with $x := .Name }}{{ $x }}{{ . }}{{ end }}"), "AdaAda");
});

Deno.test("go template: range over lists and maps, else, break and continue", () => {
  assertEquals(run("{{ range .List }}{{ . }}{{ end }}"), "abc");
  assertEquals(run("{{ range $k, $v := .Map }}{{ $k }}{{ $v }}{{ end }}"), "a1b2");
  assertEquals(run("{{ range $v := .List }}{{ $v }}{{ end }}"), "abc");
  assertEquals(run("{{ range .Missing }}x{{ else }}none{{ end }}"), "none");
  assertEquals(
    run(
      '{{ range .List }}{{ if eq . "b" }}{{ continue }}{{ end }}{{ if eq . "c" }}{{ break }}{{ end }}{{ . }}{{ end }}',
    ),
    "a",
  );
  fails("{{ range .Name }}x{{ end }}");
  fails("{{ range $a, $b, $c := .List }}{{ end }}");
  fails("{{ break }}");
  fails("{{ if .Name }}{{ continue }}{{ end }}");
});

Deno.test("go template: variables, assignment and scope", () => {
  assertEquals(run("{{ $x := 1 }}{{ $x = 2 }}{{ $x }}"), "2");
  assertEquals(run("{{ $x := 1 }}{{ if .Yes }}{{ $x := 5 }}{{ $x }}{{ end }}{{ $x }}"), "51");
  assertEquals(run("{{ $.Name }}{{ $a, $b := 1 }}"), "Ada");
  fails("{{ $nope }}");
  fails("{{ $nope = 1 }}");
});

Deno.test("go template: the builtin functions", () => {
  assertEquals(run('{{ and 1 0 2 }}|{{ or 0 "" }}|{{ or 0 7 }}|{{ and 1 2 }}'), "0||7|2");
  assertEquals(run('{{ not .Empty }}{{ len .Name }}{{ len .Map }}{{ len "é" }}'), "true322");
  assertEquals(run('{{ index .Nested "inner" "deep" }}{{ index .List 2 }}'), "xc");
  assertEquals(
    run('{{ eq .N 1 2 3 }} {{ ne .Name "Ada" }} {{ eq nil .Missing }}'),
    "true false true",
  );
  assertEquals(
    run('{{ lt 1 2 }} {{ le 2 2 }} {{ gt "b" "a" }} {{ ge 1 2 }}'),
    "true true true false",
  );
  assertEquals(run('{{ print 1 2 "x" 3 }}|{{ println 1 "a" }}'), "1 2x3|1 a\n");
  assertEquals(
    run('{{ printf "%v %s %d %q %t %% %d %t" 1 "s" 2 "q" true 1.5 1 }}'),
    '1 s 2 "q" true % %!d(1.5) %!t(1)',
  );
  assertEquals(run('{{ printf "%s %s" 1 }}|{{ printf "x" 2 }}'), "1 %!s(MISSING)|x%!(EXTRA 2)");
  assertEquals(
    run('{{ html "<b>" }}|{{ urlquery "a b&c!" }}|{{ "x" | printf "%s-%s" "y" }}'),
    "&lt;b>|a+b%26c%21|y-x",
  );
  assertEquals(run('{{ (index .List 0) }}{{ (index .Nested "inner").deep }}'), "ax");
  for (
    const t of [
      "{{ and }}",
      "{{ not 1 2 }}",
      "{{ len 1 }}",
      "{{ len nil }}",
      "{{ index .List 9 }}",
      "{{ index .Missing 1 }}",
      "{{ index .Name 1 }}",
      "{{ eq 1 }}",
      "{{ eq .List .List }}",
      '{{ lt 1 "a" }}',
      "{{ ne 1 }}",
      '{{ printf "%x" 1 }}',
      "{{ printf 1 }}",
      "{{ nope }}",
      "{{ .Name 1 }}",
      "{{ 1 | .Name }}",
      "{{ .Name.x }}",
    ]
  ) fails(t);
});

Deno.test("go template: parse errors", () => {
  for (
    const t of [
      "{{ if .Name }}x",
      "{{ end }}",
      "{{ else }}",
      "{{ .Name",
      '{{ "open }}',
      "{{ `open }}",
      '{{ "\\q" }}',
      '{{ define "x" }}{{ end }}',
      '{{ template "x" }}',
      "{{ (.Name }}",
      "{{ ) }}",
      "{{ | .Name }}",
      "{{ .Name | }}",
      "{{ }}",
      "{{ # }}",
      "{{ .Name ) }}",
      "{{/* open }}",
      "{{ if .Name }}{{ else nope }}{{ end }}",
      "{{ if .Name }}{{ else }}{{ else }}{{ end }}",
      "{{ range .List }}{{ else if .N }}{{ end }}",
      "{{ break 1 }}",
    ]
  ) fails(t);
});
