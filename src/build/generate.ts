// Codegen for `denext generate`: scaffold routes, layouts, components, API
// handlers, and server actions into an existing app. Placement honors the project's
// layout (App Router root, `src/app` when present) via {@link resolveProject}, and
// existing files are never overwritten.
//
// Build-time only; never imported by a shipped bundle.

import { dirname, join, relative } from "@std/path";
import { resolveProject } from "./paths.ts";

/**
 * Every artifact `denext generate` can scaffold, in the order the CLI lists them. This is the
 * single source of truth: the CLI verb, the MCP tool's enum and the `denext ui` picker all read
 * it, so a new kind can never be half-registered.
 */
export const GENERATE_KINDS = [
  "page",
  "route",
  "layout",
  "loading",
  "error",
  "not-found",
  "component",
  "api",
  "action",
  "middleware",
  "task",
  "test",
  "docker",
] as const;

/** The artifacts `denext generate` can scaffold. */
export type GenerateKind = typeof GENERATE_KINDS[number];

/** One file a generate run would produce. */
export interface GeneratePreviewFile {
  /** Absolute path the file would be written to. */
  readonly path: string;
  /** The file's full contents. */
  readonly contents: string;
}

/** How a generate run treats the filesystem. */
export interface GenerateOptions {
  /** Overwrite files that already exist (default: never overwrite). */
  readonly force?: boolean;
  /** Compute the plan without touching disk; the result carries `preview`. */
  readonly dryRun?: boolean;
}

/** Result of a generate run (for the CLI to print). */
export interface GenerateResult {
  /** Files written (on a dry run: the files that would be written). */
  readonly written: string[];
  /** Files left alone because they already exist. */
  readonly skipped: string[];
  /** On a dry run, every planned file with its contents. */
  readonly preview?: GeneratePreviewFile[];
}

/** PascalCase identifier from a path/name segment (`blog/[slug]` → `Slug`). */
function pascal(name: string): string {
  const last = name.replace(/\[|\]|\.\.\./g, "").split(/[\\/]/).filter(Boolean).pop() ?? "Page";
  return last
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("") || "Page";
}

function pageSource(name: string): string {
  const comp = pascal(name) || "Page";
  return `import type { PageProps } from "denext/server";

export const metadata = { title: ${JSON.stringify(comp)} };

export default function ${comp}Page(_props: PageProps) {
  return (
    <section>
      <h1>${comp}</h1>
    </section>
  );
}
`;
}

function layoutSource(name: string): string {
  const comp = pascal(name) || "Root";
  return `import type { LayoutProps } from "denext/server";

export default function ${comp}Layout({ children }: LayoutProps) {
  return <section>{children}</section>;
}
`;
}

function componentSource(name: string): string {
  const comp = pascal(name);
  return `"use client";

import { useState } from "denext";

export function ${comp}() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((c) => c + 1)}>
      ${comp}: {count}
    </button>
  );
}
`;
}

function apiSource(): string {
  return `export function GET(_request: Request): Response {
  return Response.json({ ok: true });
}
`;
}

function loadingSource(): string {
  return `export default function Loading() {
  return (
    <div role="status" aria-live="polite">
      Loading…
    </div>
  );
}
`;
}

function errorSource(): string {
  // error boundaries are Client Components and receive { error, reset } (Next parity).
  // Named RouteError to avoid shadowing the global \`Error\` used in the annotation.
  return `"use client";

export default function RouteError(
  { error, reset }: { error: Error & { digest?: string }; reset: () => void },
) {
  return (
    <section role="alert">
      <h2>Something went wrong</h2>
      <p>{error.message}</p>
      <button type="button" onClick={() => reset()}>Try again</button>
    </section>
  );
}
`;
}

function notFoundSource(): string {
  return `export default function NotFound() {
  return (
    <section>
      <h2>Not found</h2>
      <p>The page you were looking for doesn't exist.</p>
    </section>
  );
}
`;
}

function middlewareSource(): string {
  return `import { redirectResponse } from "denext/server";

/**
 * Runs before matched routes. Return a \`Response\` to short-circuit (redirect or
 * rewrite), or \`null\` to continue to the route.
 */
export function middleware(request: Request): Response | null {
  const url = new URL(request.url);
  // Example — gate an area behind auth:
  //   if (url.pathname.startsWith("/admin") && !hasSession(request)) {
  //     return redirectResponse("/login", 307);
  //   }
  void url;
  void redirectResponse;
  return null;
}

export const config = {
  // Which paths the middleware runs on (omit \`config\` to run on all routes).
  matcher: ["/((?!_next|favicon.ico).*)"],
};
`;
}

function taskSource(name: string): string {
  const desc = pascal(name) || "Task";
  return `import { defineTask } from "denext/server";

export default defineTask({
  description: ${JSON.stringify(desc)},
  // schedule: "0 3 * * *", // optional cron (evaluated in UTC); or list it in
  // denext.config.ts \`scheduledTasks\`.
  handler: async ({ payload }) => {
    void payload;
    // Do the work here. Run it with \`denext task ${name}\` or runTask("${name}").
  },
});
`;
}

function actionSource(name: string): string {
  const fn = (pascal(name)[0]?.toLowerCase() ?? "d") + pascal(name).slice(1) || "action";
  return `"use server";

export async function ${fn}(formData: FormData): Promise<void> {
  // Read fields with formData.get("field"); persist, then revalidate as needed.
  await Promise.resolve(formData);
}
`;
}

/**
 * A component-test skeleton using `denext/testing`'s in-process renderer (no browser).
 * `importPath` is the (forward-slashed) relative specifier to the component under test.
 */
function testSource(name: string, importPath: string): string {
  const comp = pascal(name);
  return `import { assert } from "@std/assert";
import { render } from "denext/testing";
import { h } from "denext/jsx-runtime";
import { ${comp} } from "${importPath}";

Deno.test("${comp} renders", async () => {
  const screen = await render(h(${comp}, null));
  // Query the tree and assert; wire events through the async fireEvent:
  //   screen.getByRole("button") / getByText / getByLabelText / getByTestId
  //   await screen.fireEvent.click(screen.getByRole("button"));
  //   screen.fireEvent.change wires to onChange.
  assert(screen.html().length > 0);
});
`;
}

// ---- Docker / docker-compose generation ------------------------------------

/** How the generated Docker image serves the app. */
type DockerMode = "server" | "static";

/**
 * Pick the Docker mode: an explicit `server`/`ssr` or `spa`/`static` override wins;
 * otherwise auto-detect from `denext.config.*` (`mode: "spa"` → a static export image,
 * anything else → the App Router / SSR production server).
 */
async function detectDockerMode(projectDir: string, override?: string): Promise<DockerMode> {
  const o = (override ?? "").trim().toLowerCase();
  if (o === "spa" || o === "static") return "static";
  if (o === "server" || o === "ssr") return "server";
  if (o && o !== "docker") {
    throw new Error(
      `denext: unknown docker target "${override}" (expected: server | spa).`,
    );
  }
  for (const f of ["denext.config.ts", "denext.config.js", "denext.config.mjs"]) {
    try {
      const text = await Deno.readTextFile(join(projectDir, f));
      if (/\bmode\s*:\s*["']spa["']/.test(text)) return "static";
    } catch { /* config absent — fall through to the server default */ }
  }
  return "server";
}

/** The Deno base-image tag, pinned to the version generating this file. */
function denoImage(): string {
  return `denoland/deno:${Deno.version.deno}`;
}

/** Dockerfile for an App Router / SSR app: build, then run the production server. */
function dockerfileServerSource(): string {
  return `# Production image for a denext (App Router / SSR) app.
# Generated by \`denext generate docker\`. Pinned to the Deno version this was
# generated with — bump it deliberately.
FROM ${denoImage()}

WORKDIR /app

# denext fetches its framework + deps from JSR/npm during the build, so this stage
# needs network. Copy the whole project and build the production bundle.
COPY . .
RUN deno task build

# The production server listens on 3000 and binds 0.0.0.0 by default (see
# \`deno task start\`). Override the port by appending \`-- --port <n>\` to the CMD.
EXPOSE 3000
ENV DENO_DIR=/deno-dir

# Optional healthcheck — point it at a route that returns 200:
# HEALTHCHECK --interval=30s --timeout=3s CMD deno eval "fetch('http://localhost:3000/').then((r)=>Deno.exit(r.ok?0:1)).catch(()=>Deno.exit(1))"

CMD ["deno", "task", "start"]
`;
}

/** Dockerfile for a static/SPA app: export to out/, serve it as static files. */
function dockerfileStaticSource(): string {
  return `# Production image for a denext static / SPA app (\`mode: "spa"\`).
# Generated by \`denext generate docker\`. Pinned to the Deno version this was
# generated with — bump it deliberately.
FROM ${denoImage()}

WORKDIR /app

# Build the static export into out/ (denext fetches deps from JSR/npm here).
COPY . .
RUN deno task export

# Serve the static export with Deno's std file server (each route is a real
# index.html, so no SPA history-fallback is needed).
EXPOSE 3000
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-sys", "jsr:@std/http/file-server", "out", "--host", "0.0.0.0", "--port", "3000"]
`;
}

/** docker-compose.yml with the app service and a commented Postgres example. */
function dockerComposeSource(mode: DockerMode): string {
  const svc = mode === "static" ? "web" : "web";
  return `# Generated by \`denext generate docker\`.
services:
  ${svc}:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    restart: unless-stopped
    # Load secrets / runtime env from a file (uncomment and create .env):
    # env_file: .env

  # Example Postgres service — uncomment, then wire DATABASE_URL into \`${svc}\`.
  # db:
  #   image: postgres:16-alpine
  #   restart: unless-stopped
  #   environment:
  #     POSTGRES_USER: denext
  #     POSTGRES_PASSWORD: denext
  #     POSTGRES_DB: denext
  #   volumes:
  #     - denext-db:/var/lib/postgresql/data
  #   ports:
  #     - "5432:5432"

# volumes:
#   denext-db:
`;
}

/** `.dockerignore` — keep build cache, VCS, local env, and the image files out. */
function dockerignoreSource(): string {
  return `.git
.gitignore
node_modules
.denext
out
*.log
.env
.env.*
!.env.example
Dockerfile
docker-compose.yml
.dockerignore
desktop-icon.png
`;
}

/**
 * The `Dockerfile`, `docker-compose.yml` and `.dockerignore` a `generate docker` run would
 * produce at the project root. `mode` follows `override` (server | spa) or is auto-detected
 * from the denext config.
 */
async function dockerPlan(
  projectDir: string,
  override: string | undefined,
): Promise<GeneratePreviewFile[]> {
  const mode = await detectDockerMode(projectDir, override);
  return [
    {
      path: join(projectDir, "Dockerfile"),
      contents: mode === "static" ? dockerfileStaticSource() : dockerfileServerSource(),
    },
    { path: join(projectDir, "docker-compose.yml"), contents: dockerComposeSource(mode) },
    { path: join(projectDir, ".dockerignore"), contents: dockerignoreSource() },
  ];
}

/**
 * Join `parts` under `base` and refuse to escape it — a user-supplied `name` like
 * `../../evil` must not let `generate` write outside the project. Throws a
 * `denext:`-prefixed error (printed cleanly by the CLI) on traversal.
 *
 * @param base The directory the result must stay inside.
 * @param parts Path segments to join under it.
 * @returns The joined absolute path.
 * @throws When the joined path escapes `base`.
 */
export function safeJoin(base: string, ...parts: string[]): string {
  const target = join(base, ...parts);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(".." + "/") || rel.startsWith(".." + "\\")) {
    throw new Error(
      `denext: generate refuses to write outside the project — check the name for "..".`,
    );
  }
  return target;
}

/** Whether `path` already exists on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `content` to `path` unless it exists (or `force` says to overwrite); record the
 * outcome into `written`/`skipped`.
 */
async function writeIfAbsent(
  path: string,
  content: string,
  written: string[],
  skipped: string[],
  force = false,
): Promise<void> {
  if (!force && await exists(path)) {
    skipped.push(path);
    return;
  }
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
  written.push(path);
}

/**
 * The files one generate run would produce, in write order — the pure half of
 * {@linkcode generateArtifact}, so a dry run and a real run can never disagree about what
 * gets written.
 */
async function planArtifacts(
  projectDir: string,
  kind: GenerateKind,
  name: string,
): Promise<GeneratePreviewFile[]> {
  // Docker assets live at the project root and don't need an App Router `app/` dir (a SPA
  // app may not have one), so handle them before `resolveProject`. `name`, when present,
  // is the mode override (`server` | `spa`).
  if (kind === "docker") return await dockerPlan(projectDir, name || undefined);
  const paths = await resolveProject(projectDir);
  const segment = name.replace(/^[\\/]+|[\\/]+$/g, "");
  // Reject `..` path components early with a clear message (safeJoin also guards).
  if (segment.split(/[\\/]+/).some((s) => s === "..")) {
    throw new Error(`denext: generate name "${name}" must not contain ".." path segments.`);
  }
  const target = artifactTarget(kind, name, segment, projectDir, paths.appDir);
  return target ? [{ path: target.path, contents: target.content }] : [];
}

/**
 * Scaffold one artifact of `kind` named `name` into the project at `projectDir`.
 * `page`/`route` are synonyms. Route-shaped kinds (page/route/layout/api) treat
 * `name` as a route path under `app/`; `component`/`action` place files under the
 * source base (`src/` when present, else the project root).
 *
 * @param projectDir The project to scaffold into.
 * @param kind The artifact kind (one of {@linkcode GENERATE_KINDS}).
 * @param name The route/component/action name (the mode override for `docker`).
 * @param options `force` overwrites existing files; `dryRun` plans without touching disk.
 * @returns What was written and what was skipped — plus `preview` on a dry run.
 */
export async function generateArtifact(
  projectDir: string,
  kind: GenerateKind,
  name: string,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const plan = await planArtifacts(projectDir, kind, name);
  const force = options.force === true;
  const written: string[] = [];
  const skipped: string[] = [];
  if (options.dryRun === true) {
    for (const file of plan) {
      (force || !(await exists(file.path)) ? written : skipped).push(file.path);
    }
    return { written, skipped, preview: plan };
  }
  for (const file of plan) {
    await writeIfAbsent(file.path, file.contents, written, skipped, force);
  }
  return { written, skipped };
}

/**
 * Where an artifact goes and what it contains. Route-shaped kinds (page/route/layout/api)
 * treat `name` as a route path under `app/`; `component`/`action`/`test` place files under
 * the source base (`src/` when present, else the project root).
 */
function artifactTarget(
  kind: Exclude<GenerateKind, "docker">,
  name: string,
  segment: string,
  projectDir: string,
  appDir: string,
): { path: string; content: string } | null {
  const srcBase = dirname(appDir);
  switch (kind) {
    case "page":
    case "route":
      return { path: safeJoin(appDir, segment, "page.tsx"), content: pageSource(name) };
    case "layout":
      return { path: safeJoin(appDir, segment, "layout.tsx"), content: layoutSource(name) };
    case "loading":
      return { path: safeJoin(appDir, segment, "loading.tsx"), content: loadingSource() };
    case "error":
      return { path: safeJoin(appDir, segment, "error.tsx"), content: errorSource() };
    case "not-found":
      return { path: safeJoin(appDir, segment, "not-found.tsx"), content: notFoundSource() };
    case "api":
      return { path: safeJoin(appDir, segment, "route.ts"), content: apiSource() };
    case "middleware":
      // Sits beside `app/` — at `src/` when the app lives in `src/app`, else project root.
      return { path: safeJoin(srcBase, "middleware.ts"), content: middlewareSource() };
    case "task": {
      const base = segment.replace(/\.ts$/, "") || "task";
      return { path: safeJoin(projectDir, "tasks", base + ".ts"), content: taskSource(name) };
    }
    case "component":
      return {
        path: safeJoin(srcBase, "components", pascal(name) + ".tsx"),
        content: componentSource(name),
      };
    case "action": {
      const base = segment.replace(/\.ts$/, "") || "action";
      return { path: safeJoin(srcBase, "actions", base + ".ts"), content: actionSource(name) };
    }
    case "test": {
      // A component test under tests/, importing the component from the conventional
      // components dir (where `generate component` places it) via a relative specifier.
      const comp = pascal(name);
      const compPath = safeJoin(srcBase, "components", comp + ".tsx");
      const testPath = safeJoin(projectDir, "tests", comp + ".test.tsx");
      const importPath = relative(dirname(testPath), compPath).replaceAll("\\", "/");
      return { path: testPath, content: testSource(name, importPath) };
    }
    default:
      return null;
  }
}
