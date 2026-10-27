// `denext create --monorepo`: a Deno workspace with one denext app and the packages it shares.
//
//   deno.json            the workspace (its members listed one by one), the root-only fields,
//                        the shared compilerOptions / fmt / lint, and tasks that delegate to the app
//   apps/web/            a normal `denext create` app (every create option applies to it), whose
//                        page and island import the packages by name
//   packages/ui/         `@<scope>/ui`: a Card and a Button that render in Server Components and
//                        in `"use client"` islands alike, plus their stylesheet (an export)
//   packages/shared/     `@<scope>/shared`: plain TypeScript, no denext
//
// The members are listed one by one, so the root says exactly what the workspace holds; a glob
// member (`apps/*`) works too (deno-loader-plugins.ts hands the client bundler's loader, which
// can't expand one, the workspace's entries itself).

import { basename, join } from "@std/path";
import {
  DENO_ROOT_FIELDS,
  denoJson,
  SCAFFOLD_COMPILER_OPTIONS,
  SCAFFOLD_DENEXT_CLI,
  SCAFFOLD_DENEXT_DEP,
  SCAFFOLD_EXCLUDE,
  SCAFFOLD_LINT,
  type ScaffoldFile,
  type ScaffoldOptions,
  scaffoldProject,
  writeProjectConfigs,
  writeScaffoldFiles,
} from "./scaffold.ts";
import { FALLOW_GITIGNORE, fallowFiles, fallowTasks } from "./fallow-template.ts";
import { MCP_AGENTS_SECTION, MCP_README_ROWS, mcpTaskCommand } from "./mcp-template.ts";
import { markdownTable, wrapProse } from "./scaffold-markdown.ts";

/** Where the monorepo's app lives, relative to its root. */
export const MONOREPO_APP_DIR = "apps/web";

/** The monorepo's shared packages, relative to its root. */
const PACKAGE_DIRS = ["packages/ui", "packages/shared"] as const;

/** Every `deno.json` a monorepo scaffold writes (the ones whose `@denext/*` pins move together). */
export const MONOREPO_CONFIGS: readonly string[] = [
  "deno.json",
  `${MONOREPO_APP_DIR}/deno.json`,
  ...PACKAGE_DIRS.map((d) => `${d}/deno.json`),
];

/** Build output and local files no member's config should format or lint. */
const BUILD_OUTPUT = ["**/.denext/", "**/out/", "**/dist/", "**/node_modules/"];

/**
 * The packages' scope, from the root directory's name: `my-shop` → `@my-shop`. Lower-cased, with
 * every run of characters a JSR scope can't hold turned into one `-`; `@app` when nothing is left.
 *
 * @param dir The monorepo's root directory.
 */
export function monorepoScope(dir: string): string {
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `@${name || "app"}`;
}

/** The app's scaffold options: the create options, with the root-level features left to the root. */
export function monorepoAppOptions(opts: ScaffoldOptions): ScaffoldOptions {
  return {
    ...opts,
    dir: join(opts.dir, MONOREPO_APP_DIR),
    monorepoScope: monorepoScope(opts.dir),
    // `.vscode`, fallow and the MCP server belong to the repository: written at the root.
    vscode: false,
    fallow: false,
    mcp: false,
    allowExisting: false,
  };
}

/** The root's tasks: the app's verbs delegated to it, the whole-workspace checks, and extras. */
function rootTasks(opts: ScaffoldOptions): Record<string, string> {
  const app = (task: string) => `deno task --cwd ${MONOREPO_APP_DIR} ${task}`;
  const tasks: Record<string, string> = {
    dev: app("dev"),
    build: app("build"),
    start: app("start"),
    // Every member's tests, on denext's Deno toolchain (see the app's own `test` task).
    test: `deno run -A ${SCAFFOLD_DENEXT_CLI} test`,
    check: "deno fmt --check && deno lint && deno task test",
  };
  if (opts.desktop) tasks.desktop = app("desktop");
  if (opts.capacitor || opts.fastlane) tasks["mobile:sync"] = app("mobile:sync");
  if (opts.fallow) Object.assign(tasks, fallowTasks());
  if (opts.mcp) tasks.mcp = mcpTaskCommand(SCAFFOLD_DENEXT_CLI);
  return tasks;
}

/**
 * The root `deno.json`: the workspace, the fields only a root may set, and what every member
 * shares (compiler options, fmt and lint).
 *
 * @param opts The create options (`dir` is the root).
 */
function monorepoRootDenoJson(opts: ScaffoldOptions): string {
  const config = {
    workspace: [MONOREPO_APP_DIR, ...PACKAGE_DIRS].map((d) => `./${d}`),
    tasks: rootTasks(opts),
    ...DENO_ROOT_FIELDS,
    compilerOptions: SCAFFOLD_COMPILER_OPTIONS,
    fmt: { exclude: BUILD_OUTPUT },
    lint: { ...SCAFFOLD_LINT, exclude: BUILD_OUTPUT },
    exclude: [...SCAFFOLD_EXCLUDE],
  };
  return JSON.stringify(config, null, 2) + "\n";
}

/** A member package's `deno.json`: its name, version, exports and its own imports. */
function packageDenoJson(
  name: string,
  exports: string | Record<string, string>,
  imports: Record<string, string>,
): string {
  return JSON.stringify({ name, version: "0.1.0", exports, imports }, null, 2) + "\n";
}

const STD_ASSERT = { "@std/assert": "jsr:@std/assert@^1" };

/** `packages/ui`: the shared components (JSX through denext's runtime), their styles and tests. */
function uiPackage(scope: string): ScaffoldFile[] {
  const dep = SCAFFOLD_DENEXT_DEP;
  const config = packageDenoJson(
    `${scope}/ui`,
    { ".": "./mod.ts", "./styles.css": "./styles.css" },
    {
      "denext": dep,
      "denext/jsx-runtime": `${dep}/jsx-runtime`,
      "denext/jsx-dev-runtime": `${dep}/jsx-dev-runtime`,
      "denext/testing": `${dep}/testing`,
      ...STD_ASSERT,
    },
  );
  return [
    { path: "packages/ui/deno.json", content: config },
    { path: "packages/ui/mod.ts", content: UI_MOD },
    { path: "packages/ui/button.tsx", content: UI_BUTTON },
    { path: "packages/ui/card.tsx", content: UI_CARD },
    { path: "packages/ui/styles.css", content: UI_STYLES },
    { path: "packages/ui/ui.test.tsx", content: UI_TEST },
  ];
}

const UI_MOD =
  `// The workspace's shared UI. These components hold no state and no effects, so a Server
// Component renders them on the server and a "use client" island renders (and hydrates) them in
// the browser. Apps import them by the package's name; the stylesheet is the package's
// \`./styles.css\` export (imported once, by the app's root layout).

export { Button, type ButtonProps } from "./button.tsx";
export { Card, type CardProps } from "./card.tsx";
`;

const UI_BUTTON = `import type { VNode, VNodeChildren } from "denext";

/** Props for {@linkcode Button}. */
export interface ButtonProps {
  /** The label. */
  children?: VNodeChildren;
  /**
   * Called on click. A function crosses no server/client boundary, so pass one from a
   * "use client" island (a Server Component passes a Server Action to a form instead).
   */
  onClick?: () => void;
  /** The button's type (default \`"button"\`). */
  type?: "button" | "submit" | "reset";
  /** Whether the button is disabled. */
  disabled?: boolean;
}

/** The shared button, styled by the package's \`styles.css\`. */
export function Button(
  { children, onClick, type = "button", disabled }: ButtonProps,
): VNode {
  return (
    <button class="ui-button" type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
`;

const UI_CARD = `import type { VNode, VNodeChildren } from "denext";

/** Props for {@linkcode Card}. */
export interface CardProps {
  /** The card's heading. */
  title: string;
  /** The card's body. */
  children?: VNodeChildren;
}

/** A titled panel, styled by the package's \`styles.css\`. */
export function Card({ title, children }: CardProps): VNode {
  return (
    <div class="ui-card">
      <h2 class="ui-card-title">{title}</h2>
      {children}
    </div>
  );
}
`;

const UI_STYLES = `.ui-card {
  border: 1px solid #e5e7eb;
  border-radius: 0.75rem;
  padding: 1rem 1.25rem;
}
.ui-card-title {
  margin: 0 0 0.5rem;
  font-size: 1.125rem;
}
.ui-button {
  border: 0;
  border-radius: 0.5rem;
  padding: 0.5rem 1rem;
  background: #111827;
  color: #fff;
  cursor: pointer;
}
.ui-button:disabled {
  opacity: 0.5;
  cursor: default;
}
`;

const UI_TEST = `import { assertEquals } from "@std/assert";
import { render } from "denext/testing";
import { Button, Card } from "./mod.ts";

Deno.test("Button calls onClick", async () => {
  let clicks = 0;
  const screen = await render(<Button onClick={() => clicks++}>Save</Button>);
  await screen.fireEvent.click(screen.getByRole("button"));
  assertEquals(clicks, 1);
});

Deno.test("Card renders its title and body", async () => {
  const screen = await render(<Card title="Hello">Body</Card>);
  assertEquals(screen.getByRole("heading").textContent, "Hello");
  screen.getByText("Body");
});
`;

/** `packages/shared`: plain TypeScript every member may use (no denext, no DOM). */
function sharedPackage(scope: string): ScaffoldFile[] {
  return [
    {
      path: "packages/shared/deno.json",
      content: packageDenoJson(`${scope}/shared`, "./mod.ts", STD_ASSERT),
    },
    { path: "packages/shared/mod.ts", content: SHARED_MOD },
    { path: "packages/shared/mod.test.ts", content: SHARED_TEST },
  ];
}

const SHARED_MOD =
  `// Plain TypeScript shared by the workspace's apps and packages: no denext, no DOM, so it runs
// on the server, in the browser and in tests alike.

/**
 * The form of a word for a count: \`pluralize(1, "time")\` is \`"time"\`, \`pluralize(2, "time")\`
 * is \`"times"\`.
 *
 * @param count How many.
 * @param singular The word for one.
 * @param plural The word for any other count (default: \`singular\` + "s").
 */
export function pluralize(
  count: number,
  singular: string,
  plural = \`\${singular}s\`,
): string {
  return count === 1 ? singular : plural;
}
`;

const SHARED_TEST = `import { assertEquals } from "@std/assert";
import { pluralize } from "./mod.ts";

Deno.test("pluralize picks the form for the count", () => {
  assertEquals(pluralize(1, "time"), "time");
  assertEquals(pluralize(0, "time"), "times");
  assertEquals(pluralize(2, "child", "children"), "children");
});
`;

/** The root `.gitignore`: what every member's build writes, plus the root features' outputs. */
function rootGitignore(opts: ScaffoldOptions): string {
  const ignore = [
    ".denext/",
    "out/",
    "dist/",
    ".deno/",
    "/tsconfig.json",
    "node_modules/",
    ".env*.local",
    "*.local",
  ];
  if (opts.fallow) ignore.push(...FALLOW_GITIGNORE);
  return ignore.join("\n") + "\n";
}

/**
 * The root's fallow setup: the single-app `fallow.toml`'s path patterns matched at any depth
 * (`denext.config.ts` → `**\/denext.config.ts`), so they cover `apps/web` and later apps.
 */
function rootFallowFiles(opts: ScaffoldOptions): ScaffoldFile[] {
  return fallowFiles().map((f) => {
    if (f.path === "fallow.toml") {
      return { ...f, content: f.content.replace(/^(\s*)"(?!\*\*\/)([^"]+)",$/gm, '$1"**/$2",') };
    }
    if (opts.mcp && f.path === "AGENTS.md") {
      return { ...f, content: f.content + MCP_AGENTS_SECTION };
    }
    return f;
  });
}

/** The root README: the layout, the tasks, and how to add an app or a package. */
function rootReadme(opts: ScaffoldOptions): string {
  const name = basename(opts.dir) || "my-monorepo";
  const scope = monorepoScope(opts.dir);
  const rows: (readonly string[])[] = [
    ["`denext task dev`", "The app's dev server (`apps/web`), with HMR across the packages"],
    ["`denext task build`", "The app's production build"],
    ["`denext task start`", "Serve the app's production build"],
    ["`denext task test`", "Every member's tests"],
    ["`denext task check`", "`deno fmt --check`, `deno lint` and the tests, over the workspace"],
  ];
  if (opts.desktop) rows.push(["`denext task desktop`", "The app in a native desktop window"]);
  if (opts.capacitor || opts.fastlane) {
    rows.push(["`denext task mobile:sync`", "Export the app and sync the iOS / Android shells"]);
  }
  if (opts.fallow) {
    rows.push(["`denext task fallow:audit`", "fallow's changed-code gate over the workspace"]);
  }
  if (opts.mcp) rows.push(...MCP_README_ROWS);
  const item = (text: string) => wrapProse(text, "- ", "  ");
  return `# ${name}

${
    wrapProse(
      "A [denext](https://denext.dev) monorepo: a Deno workspace with one app and the packages " +
        "it shares.",
    )
  }
## Layout

${
    [
      item(
        "`apps/web/` — the denext app (`app/`, `denext.config.ts`, its own `deno.json` and " +
          "tasks). Native targets (`--desktop`, `--capacitor`) live here too: each denext target " +
          "is one app. Run any `denext` verb on it: `denext dev apps/web`.",
      ),
      item(
        `\`packages/ui/\` — \`${scope}/ui\`: the shared \`Card\` and \`Button\`. They hold no ` +
          'state, so Server Components and `"use client"` islands both render them. Its ' +
          `stylesheet is the \`${scope}/ui/styles.css\` export, imported by the app's root layout.`,
      ),
      item(
        `\`packages/shared/\` — \`${scope}/shared\`: plain TypeScript (no denext) any member ` +
          "may import.",
      ),
      item(
        "`deno.json` — the workspace. Its members are listed one by one (a glob such as " +
          "`packages/*` works too). It also holds what every member shares: `compilerOptions`, " +
          "`fmt`, `lint`, and the `unstable` / `allowScripts` fields only a root may set.",
      ),
    ].join("")
  }
## Tasks

${markdownTable(["Command", "What it does"], rows)}
${
    wrapProse(
      "Run them from this directory; `dev`, `build` and `start` delegate to `apps/web`. " +
        "`denext upgrade` here moves the denext pin in every member at once.",
    )
  }
## Adding a member

${
    [
      item(
        `A package: a folder under \`packages/\` with a \`deno.json\` holding \`"name"\` ` +
          `(\`${scope}/<name>\`), \`"version"\` and \`"exports"\`, then its path in the root's ` +
          `\`"workspace"\` list. Apps import it as \`${scope}/<name>\`.`,
      ),
      item(
        "An app: `denext generate app <name>` writes `apps/<name>` (importing the shared " +
          'packages), adds it to the `"workspace"` list and adds a `dev:<name>` task here. ' +
          "Give each app its own port when two run at once (`denext dev apps/<name> --port 3001`).",
      ),
    ].join("")
  }
## Learn more

${item("Monorepos: https://denext.dev/docs/monorepo")}${
    item("Guide + API: https://denext.dev/docs")
  }`;
}

/**
 * The files a monorepo scaffold writes besides the app's (which {@linkcode scaffoldProject}
 * writes under `apps/web`): the root's and the packages'. Pure, for tests.
 *
 * @param opts The create options (`dir` is the root).
 */
export function monorepoFiles(opts: ScaffoldOptions): ScaffoldFile[] {
  const scope = monorepoScope(opts.dir);
  const files: ScaffoldFile[] = [
    { path: "deno.json", content: monorepoRootDenoJson(opts) },
    { path: ".gitignore", content: rootGitignore(opts) },
    { path: "README.md", content: rootReadme(opts) },
    ...uiPackage(scope),
    ...sharedPackage(scope),
  ];
  if (opts.fallow) files.push(...rootFallowFiles(opts));
  return files;
}

/**
 * Every `deno.json` the scaffold writes, joined: the text the `@denext/*` pins are planned over
 * before anything is written (`denext create` moves them all together).
 *
 * @param opts The create options (`dir` is the root).
 */
export function monorepoConfigText(opts: ScaffoldOptions): string {
  const own = monorepoFiles(opts).filter((f) => MONOREPO_CONFIGS.includes(f.path));
  return [...own.map((f) => f.content), denoJson(monorepoAppOptions(opts))].join("\n");
}

/** Refuse a target that isn't empty (or absent). */
async function refuseNonEmpty(dir: string): Promise<void> {
  try {
    for await (const _ of Deno.readDir(dir)) {
      throw new Error(`denext create: target directory ${dir} is not empty.`);
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/**
 * Scaffold a monorepo into `opts.dir` (empty or absent): the root and packages
 * ({@linkcode monorepoFiles}), the app under `apps/web` with every create option, then the root's
 * `.vscode` and MCP client configs when asked for.
 *
 * @param opts The create options (`dir` is the root).
 * @returns The paths written, relative to the root.
 */
export async function scaffoldMonorepo(opts: ScaffoldOptions): Promise<string[]> {
  await refuseNonEmpty(opts.dir);
  const written = await writeScaffoldFiles(opts.dir, monorepoFiles(opts));
  const app = await scaffoldProject(monorepoAppOptions(opts));
  written.push(...app.map((p) => `${MONOREPO_APP_DIR}/${p}`));
  written.push(...await writeProjectConfigs(opts));
  return written;
}
