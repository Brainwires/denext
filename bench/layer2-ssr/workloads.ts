// Framework-agnostic component trees, built through an injected element factory.
//
// Both denext's `h` and React's `createElement` share the signature
// `(type, props | null, ...children)`, so ONE builder produces a structurally
// identical tree on either framework. That is what makes the SSR throughput
// comparison fair: the two frameworks render the same shape, differing only in
// their own rendering machinery — not in the workload.
//
// The workloads are pure (no hooks, no state): SSR throughput should measure the
// renderer, not hook plumbing. Function components ARE used (passed as the
// element `type`) so component invocation overhead is included on both sides.

// deno-lint-ignore no-explicit-any
export type Create = (type: any, props: any, ...children: any[]) => any;

export interface Workload {
  readonly name: string;
  readonly description: string;
  /** Build the tree for a given framework's element factory. */
  build(create: Create): unknown;
}

/** A wide, static list — stresses raw element + text markup throughput. */
function markupHeavy(rows: number): Workload {
  return {
    name: `markup-${rows}`,
    description: `${rows}-row static list (raw markup throughput)`,
    build(create) {
      const items = [];
      for (let i = 0; i < rows; i++) {
        items.push(
          create(
            "li",
            { class: "row", key: i },
            create(
              "span",
              { class: "k" },
              `item ${i}`,
            ),
            create("code", { class: "v" }, `value-${i * 7}`),
          ),
        );
      }
      return create("ul", { class: "list" }, items);
    },
  };
}

/** Deeply nested function components — stresses component invocation + prop flow. */
function componentTree(depth: number, fanout: number): Workload {
  return {
    name: `components-d${depth}-f${fanout}`,
    description: `nested function components (depth ${depth}, fanout ${fanout})`,
    build(create) {
      // deno-lint-ignore no-explicit-any
      const Node = (props: any) => {
        if (props.depth === 0) {
          return create("span", { class: "leaf" }, `leaf@${props.path}`);
        }
        const kids = [];
        for (let i = 0; i < fanout; i++) {
          kids.push(
            create(Node, {
              key: i,
              depth: props.depth - 1,
              path: `${props.path}.${i}`,
            }),
          );
        }
        return create("div", { class: `n d${props.depth}` }, kids);
      };
      return create(Node, { depth, path: "0" });
    },
  };
}

/**
 * A structural mirror of examples/hello's home page (minus the hooks): layout
 * chrome + a card + a paragraph list. Represents a realistic page render rather
 * than a synthetic stress tree.
 */
function helloPage(): Workload {
  return {
    name: "hello-page",
    description: "structural mirror of examples/hello home + layout chrome",
    build(create) {
      return create(
        "div",
        { class: "app" },
        helloHeader(create),
        create("main", { class: "content" }, helloSection(create)),
        create(
          "footer",
          { class: "foot" },
          "Built on Deno · no npm dependencies",
        ),
      );
    },
  };
}

function helloHeader(create: Create): unknown {
  const nav = create(
    "nav",
    null,
    create("a", { href: "/" }, "Home"),
    create("a", { href: "/about" }, "About"),
    create("a", { href: "/blog/hello-world" }, "Blog"),
  );
  return create(
    "header",
    { class: "topbar" },
    create("a", { class: "brand", href: "/" }, "denext"),
    nav,
  );
}

function helloSection(create: Create): unknown {
  const card = create(
    "div",
    { class: "card" },
    create(
      "p",
      null,
      "Interactivity status: ",
      create("span", { class: "off" }, "server-rendered (not yet hydrated)"),
    ),
    create("button", { type: "button" }, "Clicked 0 times"),
  );
  return create(
    "section",
    null,
    create("h1", null, "Hello from denext"),
    create(
      "p",
      null,
      "A Next.js-style framework rebuilt on Deno with ",
      create("strong", null, "zero runtime npm dependencies"),
      " — its own JSX runtime, SSR, router, and client reconciler.",
    ),
    card,
    create("p", { class: "hint" }, "View source for details."),
  );
}

/** The workload set both frameworks run, in report order. */
export const WORKLOADS: readonly Workload[] = [
  helloPage(),
  markupHeavy(100),
  markupHeavy(1000),
  componentTree(6, 3), // 3^6 ≈ 729 leaf components
];
