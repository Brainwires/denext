// The `lustre` starter template of `denext create --template lustre`: one Lustre counter, written
// in Gleam, used three ways on the home page — an island (`lustreIsland`), a custom element
// (`lustreElement`) and a server component over Live (`defineLustreView`). The `gleam()` plugin
// compiles `gleam/` with denext's pinned Gleam (downloaded and verified on first use) and writes
// the `.denext/lustre*.ts` kits the app imports, so the first `dev` / `build` needs the network
// (the compiler, then Lustre from Hex).

import type { ScaffoldFile } from "./scaffold.ts";

/** The Gleam project's directory, and its package name (what `@gleam/<name>/…` imports use). */
const GLEAM_DIR = "gleam";
const GLEAM_PACKAGE = "app";

/** The import-map entry that maps `@gleam/` onto the Gleam project's JavaScript build. */
export const LUSTRE_IMPORTS: Readonly<Record<string, string>> = {
  "@gleam/": `./${GLEAM_DIR}/build/dev/javascript/`,
};

/** What the template adds to `.gitignore`: Gleam's build output. */
export const LUSTRE_GITIGNORE: readonly string[] = [`${GLEAM_DIR}/build/`];

/** The `denext.config.ts` import line the template needs. */
export const LUSTRE_CONFIG_IMPORT = `import { gleam } from "denext/gleam";`;

/** The `denext.config.ts` lines the template adds. */
export const LUSTRE_CONFIG_LINES: readonly string[] = [
  "  // Compiles gleam/ to JavaScript at dev startup, on every .gleam change and at build, and",
  "  // writes .denext/lustre*.ts, the Lustre kits the app imports.",
  "  plugins: [gleam()],",
];

/** The Gleam project: JavaScript target, TypeScript declarations, Lustre. */
const GLEAM_TOML = `name = "${GLEAM_PACKAGE}"
version = "1.0.0"
target = "javascript"

[dependencies]
lustre = ">= 5.7.1 and < 6.0.0"
gleam_stdlib = ">= 1.0.5 and < 2.0.0"

[javascript]
typescript_declarations = true
`;

/** The Lustre counter, as an app (flags: the start) and as a component (a `start` attribute). */
const COUNTER_GLEAM =
  `//// A counter written once in Lustre and used three ways by the app: as an island (\`app\`, its
//// start as flags), as the custom element <lustre-counter> (\`component\`, its start from the
//// \`start\` attribute) and as a server component (\`app\` again, run on the server).

import gleam/int
import gleam/result
import lustre
import lustre/attribute
import lustre/component
import lustre/effect
import lustre/element.{type Element}
import lustre/element/html
import lustre/event

pub type Msg {
  Incr
  Decr
  SetCount(Int)
}

fn update(count: Int, msg: Msg) -> Int {
  case msg {
    Incr -> count + 1
    Decr -> count - 1
    SetCount(count) -> count
  }
}

fn view(count: Int) -> Element(Msg) {
  html.div([attribute.class("counter")], [
    html.button([attribute.class("dec"), event.on_click(Decr)], [html.text("-")]),
    html.span([attribute.class("count")], [html.text(int.to_string(count))]),
    html.button([attribute.class("inc"), event.on_click(Incr)], [html.text("+")]),
  ])
}

/// The counter as an app: its flags are the starting count.
pub fn app() -> lustre.App(Int, Int, Msg) {
  lustre.simple(fn(start) { start }, update, view)
}

/// The counter as a custom element: the \`start\` attribute sets the count.
pub fn component() -> lustre.App(Nil, Int, Msg) {
  lustre.component(
    fn(_) { #(0, effect.none()) },
    fn(count, msg) { #(update(count, msg), effect.none()) },
    view,
    [
      component.open_shadow_root(True),
      component.on_attribute_change("start", fn(value) {
        int.parse(value) |> result.map(SetCount)
      }),
    ],
  )
}
`;

/** The home page: a Server Component rendering the counter three ways. */
function lustrePage(tailwind: boolean): string {
  const sectionCls = tailwind ? ' class="mx-auto max-w-xl p-8"' : "";
  const h1Cls = tailwind ? ' class="text-3xl font-bold"' : "";
  return `// Home page — a Server Component. It renders one Lustre counter (gleam/src/counter.gleam) three
// ways: an island the browser runs, a custom element, and a server component over Live.

import type { PageProps } from "denext/server";
import { CounterElement } from "./counter-element.tsx";
import { CounterIsland } from "./counter-island.tsx";
import { CounterView } from "./counter-view.ts";

export const metadata = { title: "denext + Lustre" };

export default function Home(_props: PageProps) {
  return (
    <section${sectionCls}>
      <h1${h1Cls}>Hello from denext and Lustre 👋</h1>
      <h2>An island</h2>
      <CounterIsland start={1} />
      <h2>A custom element</h2>
      <CounterElement start="2" />
      <h2>A server component over Live</h2>
      <CounterView start={3} />
    </section>
  );
}
`;
}

/** The island module; `kits` is the app dir's path to `.denext`. */
const counterIsland = (kits: string) =>
  `"use client";
// The Lustre counter as an island: the server renders its first view, the browser's Lustre adopts
// that markup and runs it. Props become its flags.
import { lustreIsland } from "denext/gleam";
import { lustre } from "${kits}/lustre.ts"; // written by the gleam() plugin
import * as counter from "@gleam/${GLEAM_PACKAGE}/counter.mjs";

export const CounterIsland = lustreIsland(lustre, counter.app(), {
  flags: (props: { start: number }) => props.start,
});
`;

/** The custom-element module. */
const counterElement = (kits: string) =>
  `"use client";
// The Lustre counter as the custom element <lustre-counter>: the server prerenders its shadow
// root as Declarative Shadow DOM and Lustre adopts it once the element registers. Props are
// attributes.
import { lustreElement } from "denext/gleam";
import { lustre } from "${kits}/lustre.ts"; // written by the gleam() plugin
import * as counter from "@gleam/${GLEAM_PACKAGE}/counter.mjs";

export const CounterElement = lustreElement<{ start: \`\${number}\` }>(
  lustre,
  "lustre-counter",
  counter.component(),
);
`;

/** The server-component module. */
const counterView = (kits: string) =>
  `// The Lustre counter as a server component: its model lives on the server, one runtime per
// visitor, and its DOM patches travel over denext's Live socket.
import { defineLustreView } from "denext/gleam";
import { lustreServer } from "${kits}/lustre-server.ts"; // written by the gleam() plugin
import * as counter from "@gleam/${GLEAM_PACKAGE}/counter.mjs";

export const CounterView = defineLustreView({
  id: "counter",
  kit: lustreServer,
  app: counter.app(),
  flags: (props: { start: number }) => props.start,
  // Runs when the page renders, when the browser mounts or resumes the view, and on a timer while
  // it runs: check the session here.
  authorize: () => true,
});
`;

/**
 * The template's own files: the Gleam project and the page with its three counters.
 *
 * @param appBase The app directory (`app` or `src/app`).
 * @param tailwind Whether the page uses Tailwind classes.
 * @returns The files, with project-relative paths.
 */
export function lustreTemplateFiles(appBase: string, tailwind: boolean): ScaffoldFile[] {
  const kits = [...appBase.split("/").map(() => ".."), ".denext"].join("/");
  return [
    { path: `${GLEAM_DIR}/gleam.toml`, content: GLEAM_TOML },
    { path: `${GLEAM_DIR}/src/counter.gleam`, content: COUNTER_GLEAM },
    { path: `${appBase}/page.tsx`, content: lustrePage(tailwind) },
    { path: `${appBase}/counter-island.tsx`, content: counterIsland(kits) },
    { path: `${appBase}/counter-element.tsx`, content: counterElement(kits) },
    { path: `${appBase}/counter-view.ts`, content: counterView(kits) },
  ];
}
