// The DevTools → MCP bridge, agent side: render the component tree a running dev page
// pushed to `/_denext/dev-inspect` as text an agent can read.
//
// The data arrives by PUSH (`src/client/devtools-inspect-sink.ts` posts after each settled
// commit), so every answer is a snapshot of a moment, and every answer says how old that
// moment is — an agent that acts on a 40-second-old tree is acting on a page it has since
// changed. Past 5 s the header also says how to refresh it.
//
// Three things can be missing, and they need three DIFFERENT answers: there is no dev
// server; there is one but no page has pushed a tree; there is a tree but no component by
// that name. The first is fixed by `deno task dev`, the second by opening the app in a
// browser, the third by naming a component that exists — so the failure strings below are
// deliberately distinct, and the third lists what IS there.

import type { RenderReason } from "../client/devtools-inspect.ts";
import type {
  InspectSnapshot,
  InspectSnapshotNode,
  SnapshotHook,
} from "../client/devtools-inspect-sink.ts";
import type { DevInspect, DevInspectMiss } from "./dev-client.ts";
import type { Tool } from "./tools.ts";
import { fetchDevInspect } from "./dev-client.ts";

/** Past this age the header tells the agent how to get a fresher tree. */
const STALE_MS = 5000;

/** Default tree depth rendered (the snapshot itself may go to 50). */
const DEFAULT_DEPTH = 12;

/** Default number of components rendered (the snapshot itself may hold 2000). */
const DEFAULT_MAX_NODES = 200;

/** How many distinct component names a "no such component" answer lists. */
const MAX_NAMES = 40;

/** What to render in a component tree. */
export interface TreeOptions {
  /** Only components whose name contains this (case-insensitive), plus their ancestors. */
  filter?: string;
  /** How deep to render (default 12). */
  depth?: number;
  /** How many components to render before stopping (default 200). */
  maxNodes?: number;
  /** The project directory, so source paths render relative to it. */
  dir?: string;
}

/** The two "nothing to show" answers, each naming the ONE thing that fixes it. */
export function missText(reason: DevInspectMiss, dir: string): string {
  if (reason === "no-dev-server") {
    return `no dev server running (\`deno task dev\`) for ${dir} — the DevTools bridge reads ` +
      "the component tree from a RUNNING dev server (it looked for .denext/dev.json).";
  }
  return "open the app in a browser, then CALL THIS AGAIN — the DevTools sink has posted " +
    "nothing yet. The dev server is running, but the tree is pushed from the page, and the " +
    "page only starts pushing once a read like this one has happened (it arms on the first " +
    "call). So: load a route in a browser, interact with it (or reload), and ask again. " +
    "`DENEXT_DEV_INSPECT=1 deno task dev` arms it from the start.";
}

/** `snapshot N.Ns old · <url>`, plus a refresh hint once the tree is stale. */
function header(inspect: DevInspect): string {
  const age = `snapshot ${(num(inspect.ageMs) / 1000).toFixed(1)}s old · ${
    text(inspect.snapshot.url)
  }`;
  return inspect.ageMs > STALE_MS ? `${age} — interact with the page or reload to refresh` : age;
}

/**
 * A field that should be a string, however the snapshot arrived. The dev server rebuilds
 * every stored node from coerced fields, so this is belt-and-braces — but these
 * formatters run on BROWSER-supplied data and their output goes straight into an agent's
 * context, so not one of them may throw on a field that is missing or mis-typed.
 */
function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** A field that should be an array, however the snapshot arrived (see {@link text}). */
function arr<T>(v: T[] | undefined): T[] {
  return Array.isArray(v) ? v : [];
}

/** A field that should be a number, however the snapshot arrived (see {@link text}). */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** A source location as `app/page.tsx:12`, made relative to `dir` when it is under it. */
function shortSource(node: InspectSnapshotNode, dir?: string): string {
  const src = node.source;
  if (!src) return "";
  const raw = text(src.file);
  if (!raw) return "";
  let file = raw.startsWith("file://") ? decodeURIComponent(raw.slice(7)) : raw;
  if (dir && file.startsWith(dir)) file = file.slice(dir.length).replace(/^\//, "");
  const line = num(src.line);
  return `  ${file}${line ? `:${line}` : ""}`;
}

/** One tree line: `Counter key="a" [memo]  app/counter.tsx:5  ×3`. */
function nodeLine(node: InspectSnapshotNode, depth: number, dir?: string): string {
  const key = typeof node.key === "string" ? ` key=${JSON.stringify(node.key)}` : "";
  const badgeList = arr(node.badges).map(text).filter((b) => b !== "");
  const badges = badgeList.length > 0 ? ` [${badgeList.join(", ")}]` : "";
  const count = num(node.reason?.count);
  const renders = count > 0 ? `  ×${count}` : "";
  return `${"  ".repeat(depth)}${text(node.name)}${key}${badges}${
    shortSource(node, dir)
  }${renders}`;
}

/** Whether `node` or any descendant matches the lower-cased `filter`. */
function subtreeMatches(node: InspectSnapshotNode, filter: string): boolean {
  return text(node.name).toLowerCase().includes(filter) ||
    arr(node.children).some((c) => subtreeMatches(c, filter));
}

/** The walk's remaining line budget. */
interface LineBudget {
  left: number;
  cut: boolean;
}

/** Append the rendered lines for `nodes` (depth-first) into `out`, honouring the budget. */
function treeLines(
  nodes: InspectSnapshotNode[],
  out: string[],
  depth: number,
  opts: TreeOptions & { filter?: string },
  budget: LineBudget,
): void {
  const maxDepth = opts.depth ?? DEFAULT_DEPTH;
  for (const node of nodes) {
    if (opts.filter && !subtreeMatches(node, opts.filter)) continue;
    if (budget.left <= 0 || depth >= maxDepth) {
      budget.cut = true;
      return;
    }
    budget.left--;
    out.push(nodeLine(node, depth, opts.dir));
    treeLines(arr(node.children), out, depth + 1, opts, budget);
  }
}

/** Every distinct component name in the snapshot, in tree order. */
function componentNames(snapshot: InspectSnapshot): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const visit = (nodes: InspectSnapshotNode[]): void => {
    for (const n of nodes) {
      const name = text(n.name);
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
      visit(arr(n.children));
    }
  };
  visit(arr(snapshot.nodes));
  return names;
}

/** The third failure string: a real tree, but nothing by that name. */
function noSuchComponent(snapshot: InspectSnapshot, component: string): string {
  const names = componentNames(snapshot);
  const shown = names.slice(0, MAX_NAMES).join(", ");
  const more = names.length > MAX_NAMES ? `, … (${names.length} in all)` : "";
  return `no component named "${component}" in this snapshot. Components present: ` +
    `${shown || "(none)"}${more}`;
}

/** Every component whose name matches `component` (exact first, else substring). */
function findComponents(
  snapshot: InspectSnapshot,
  component: string,
): InspectSnapshotNode[] {
  const want = component.toLowerCase();
  const exact: InspectSnapshotNode[] = [];
  const partial: InspectSnapshotNode[] = [];
  const visit = (nodes: InspectSnapshotNode[]): void => {
    for (const n of nodes) {
      const name = text(n.name).toLowerCase();
      if (name === want) exact.push(n);
      else if (name.includes(want)) partial.push(n);
      visit(arr(n.children));
    }
  };
  visit(arr(snapshot.nodes));
  return exact.length > 0 ? exact : partial;
}

/**
 * Render the pushed component tree as an indented list.
 *
 * @param inspect The snapshot and its age.
 * @param opts Filter / depth / node cap / project dir.
 * @returns The header line followed by the tree (or why it is empty).
 */
export function componentTreeText(inspect: DevInspect, opts: TreeOptions = {}): string {
  const { snapshot } = inspect;
  const filter = opts.filter?.trim().toLowerCase() || undefined;
  const budget: LineBudget = { left: opts.maxNodes ?? DEFAULT_MAX_NODES, cut: false };
  const lines: string[] = [];
  treeLines(arr(snapshot.nodes), lines, 0, { ...opts, filter }, budget);
  if (lines.length === 0) {
    return `${header(inspect)}\n${
      filter ? noSuchComponent(snapshot, opts.filter ?? "") : "the page rendered no components"
    }`;
  }
  const notes: string[] = [];
  if (budget.cut) notes.push("…more components not shown (raise `depth` / `maxNodes`)");
  if (snapshot.truncated) notes.push("…the page capped this tree when it posted it");
  return [header(inspect), ...lines, ...notes].join("\n");
}

/** One changed-inputs line per dimension that actually changed. */
function reasonLines(reason: RenderReason, node: InspectSnapshotNode): string[] {
  const lines: string[] = [];
  const props = arr(reason.props).map(text).filter((p) => p !== "");
  if (props.length > 0) lines.push(`  props changed: ${props.join(", ")}`);
  for (const raw of arr(reason.hooks)) {
    const i = num(raw);
    const hook = arr(node.hooks)[i];
    const label = hook ? hookLabel(hook) : `hook ${i}`;
    lines.push(`  hook changed: [${i}] ${label}`);
  }
  const contexts = arr(reason.contexts).map(text).filter((c) => c !== "");
  if (contexts.length > 0) lines.push(`  contexts changed: ${contexts.join(", ")}`);
  if (lines.length === 0) lines.push("  no input changed on the last commit (parent re-render)");
  return lines;
}

/**
 * The shared shape of the two per-component answers: the header, then one block per
 * matching instance — or the "no such component" answer when nothing matched.
 *
 * @param inspect The snapshot and its age.
 * @param component The component name to match.
 * @param dir The project directory, so source paths render relative to it.
 * @param block Render one instance, given the node and its already-formatted head line.
 * @returns The complete answer text.
 */
function perMatch(
  inspect: DevInspect,
  component: string,
  dir: string | undefined,
  block: (node: InspectSnapshotNode, head: string) => string,
): string {
  const matches = findComponents(inspect.snapshot, component);
  if (matches.length === 0) {
    return `${header(inspect)}\n${noSuchComponent(inspect.snapshot, component)}`;
  }
  const blocks = matches.map((node) =>
    block(node, `${node.name} #${node.id}${shortSource(node, dir)}`)
  );
  return [header(inspect), ...blocks].join("\n");
}

/**
 * Explain why a component last rendered: which props, hooks and contexts changed, and how
 * many times it has rendered while the page has been tracking.
 *
 * @param inspect The snapshot and its age.
 * @param component The component name (exact match preferred, else substring).
 * @param dir The project directory, so source paths render relative to it.
 * @returns The header line followed by one block per matching instance.
 */
export function whyRenderText(inspect: DevInspect, component: string, dir?: string): string {
  return perMatch(inspect, component, dir, (node, head) => {
    if (!node.reason) {
      return `${head}\n  no render reason recorded yet — it has not re-rendered since the ` +
        "page started tracking";
    }
    return [
      `${head} · rendered ${num(node.reason.count)}× while tracking`,
      ...reasonLines(
        node.reason,
        node,
      ),
    ].join("\n");
  });
}

/** `count · useState` when the dev metadata named the cell, else the kind label. */
function hookLabel(cell: SnapshotHook): string {
  const hook = cell ?? {} as SnapshotHook;
  const name = text(hook.name);
  const from = text(hook.hook);
  if (name && from) return `${name} · ${from}`;
  return name || from || text(hook.kind) || "hook";
}

/** The `useDebugValue` suffix: `  debug=Online`, `  debug=[a, b]` for several, or `""`. */
function debugSuffix(hook: SnapshotHook): string {
  const debug = hook.debug;
  if (debug === null || typeof debug !== "object") return "";
  const shown = Array.isArray(debug.entries)
    ? `[${debug.entries.map((e) => text(e?.value?.preview)).join(", ")}]`
    : text(debug.preview);
  return `  debug=${shown}`;
}

/** One hook cell as a line: `[0] count · useState = 0  deps [a, b]  debug=…`. */
function hookLine(cell: SnapshotHook): string {
  const hook = cell ?? {} as SnapshotHook; // a posted `hooks: [null]` must not throw
  const deps = Array.isArray(hook.deps)
    ? `  deps [${hook.deps.map((d) => text(d?.preview)).join(", ")}]`
    : "";
  const cleanup = hook.hasCleanup ? "  (has cleanup)" : "";
  const value = text(hook.value?.preview);
  return `  [${num(hook.index)}] ${hookLabel(hook)} = ${value}${deps}${cleanup}${
    debugSuffix(hook)
  }`;
}

/**
 * Show a component's hook cells — every cell, or just one by index.
 *
 * @param inspect The snapshot and its age.
 * @param component The component name (exact match preferred, else substring).
 * @param index Optional hook index to show on its own.
 * @param dir The project directory, so source paths render relative to it.
 * @returns The header line followed by one block per matching instance.
 */
export function hookStateText(
  inspect: DevInspect,
  component: string,
  index?: number,
  dir?: string,
): string {
  return perMatch(inspect, component, dir, (node, head) => {
    const hooks = arr(node.hooks);
    const cells = index === undefined ? hooks : hooks.filter((h) => num(h?.index) === index);
    if (cells.length === 0) {
      const what = index === undefined
        ? "no hooks"
        : `no hook at index ${index} (it has ${hooks.length})`;
      return `${head}\n  ${what}`;
    }
    const note = node.hooksNamed === false
      ? "\n  names unavailable (conditional hooks?) — showing kind labels"
      : "";
    return `${head}${note}\n${cells.map(hookLine).join("\n")}`;
  });
}

/** Read the running dev server's snapshot, or the failure string explaining why not. */
async function readInspect(
  dir: string,
  url: unknown,
): Promise<{ inspect: DevInspect } | { text: string }> {
  const res = await fetchDevInspect(dir, typeof url === "string" && url ? url : undefined);
  return res.ok ? { inspect: res.inspect } : { text: missText(res.reason, dir) };
}

/** A tool's answer: the rendered text, or an `isError` failure string. */
type ToolText = { text: string; isError?: boolean };

/**
 * The shared body of the two component-scoped tools: require `component`, read the
 * snapshot (or report which of the two empty cases applies), then render.
 *
 * @param args The raw tool arguments.
 * @param projectDir Resolve `args.dir` to an absolute project directory.
 * @param render Render the answer for the resolved snapshot and component.
 * @returns The tool result.
 */
async function componentAnswer(
  args: Record<string, unknown>,
  projectDir: (raw: unknown) => string,
  render: (inspect: DevInspect, component: string, dir: string) => string,
): Promise<ToolText> {
  const component = typeof args.component === "string" ? args.component : "";
  if (!component) return { text: "Pass a `component` name.", isError: true };
  const dir = projectDir(args.dir);
  const got = await readInspect(dir, args.url);
  if ("text" in got) return { text: got.text, isError: true };
  return { text: render(got.inspect, component, dir) };
}

/** The shared `url`/`dir` arguments every bridge tool takes. */
const PAGE_ARGS = {
  url: {
    type: "string",
    description: "Which page's tree to read, e.g. `/blog/hello` (default: the most recent).",
  },
  dir: { type: "string", description: "Project directory (default: .)" },
} as const;

/** How every bridge tool's description ends — every precondition, stated every time. */
const NEEDS = "Requires `deno task dev` to be running AND the app open in a browser (the tree is " +
  "pushed from the page, so it is a snapshot, and the answer says how old it is). The page " +
  "starts pushing only once one of these tools has been called, so the FIRST call on a page may " +
  "answer 'posted nothing yet' — call it again after the page's next commit.";

/**
 * The three DevTools bridge tools, registered in the MCP tool table. Each resolves the
 * project directory through the caller-supplied `projectDir`, so they inherit the server's
 * root confinement instead of re-implementing it.
 *
 * @param projectDir Resolve a tool's `dir` argument to an absolute project directory.
 * @returns The tool definitions, in registration order.
 */
export function devtoolsTools(projectDir: (raw: unknown) => string): readonly Tool[] {
  return [
    {
      name: "denext_component_tree",
      description:
        "Show the LIVE component tree of a running dev page — every component with its " +
        "source location, badges and render count, as the in-page DevTools last pushed it. " +
        `Use it to see what actually mounted. ${NEEDS}`,
      inputSchema: {
        type: "object",
        properties: {
          ...PAGE_ARGS,
          filter: {
            type: "string",
            description: "Only components whose name contains this (and their ancestors).",
          },
          depth: { type: "number", description: "How deep to render (default 12)." },
          maxNodes: { type: "number", description: "How many components to render (default 200)." },
        },
      },
      run: async (args: Record<string, unknown>): Promise<ToolText> => {
        const dir = projectDir(args.dir);
        const got = await readInspect(dir, args.url);
        if ("text" in got) return { text: got.text, isError: true };
        return {
          text: componentTreeText(got.inspect, {
            dir,
            filter: typeof args.filter === "string" ? args.filter : undefined,
            depth: typeof args.depth === "number" ? args.depth : undefined,
            maxNodes: typeof args.maxNodes === "number" ? args.maxNodes : undefined,
          }),
        };
      },
    },
    {
      name: "denext_why_render",
      description:
        "Explain why a component in a running dev page last re-rendered — which props, " +
        "hooks and contexts changed, and how many renders it has done. Use it to chase a " +
        `re-render loop or a missing memo. ${NEEDS}`,
      inputSchema: {
        type: "object",
        properties: {
          component: { type: "string", description: "Component name, e.g. `Counter`." },
          ...PAGE_ARGS,
        },
        required: ["component"],
      },
      run: (args: Record<string, unknown>): Promise<ToolText> =>
        componentAnswer(args, projectDir, whyRenderText),
    },
    {
      name: "denext_hook_state",
      description:
        "Read a component's live hook cells in a running dev page — each cell's name, the " +
        "hook that produced it, its current value and its deps. Use it to see the state a " +
        `component actually holds. ${NEEDS}`,
      inputSchema: {
        type: "object",
        properties: {
          component: { type: "string", description: "Component name, e.g. `Counter`." },
          index: { type: "number", description: "Show only this hook index (default: all)." },
          ...PAGE_ARGS,
        },
        required: ["component"],
      },
      run: (args: Record<string, unknown>): Promise<ToolText> =>
        componentAnswer(
          args,
          projectDir,
          (inspect, component, dir) =>
            hookStateText(
              inspect,
              component,
              typeof args.index === "number" ? args.index : undefined,
              dir,
            ),
        ),
    },
  ];
}
