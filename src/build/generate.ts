// Codegen for `denext generate`: scaffold routes, layouts, components, API
// handlers, and server actions into an existing app. Placement honors the project's
// layout (App Router root, `src/app` when present) via {@link resolveProject}, and
// existing files are never overwritten.
//
// Build-time only; never imported by a shipped bundle.

import { dirname, join, relative } from "@std/path";
import { resolveProject } from "./paths.ts";

/** The artifacts `denext generate` can scaffold. */
export type GenerateKind = "page" | "route" | "layout" | "component" | "api" | "action";

/** Result of a generate run (for the CLI to print). */
export interface GenerateResult {
  readonly written: string[];
  readonly skipped: string[];
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
 * Join `parts` under `base` and refuse to escape it — a user-supplied `name` like
 * `../../evil` must not let `generate` write outside the project. Throws a
 * `denext:`-prefixed error (printed cleanly by the CLI) on traversal.
 */
function safeJoin(base: string, ...parts: string[]): string {
  const target = join(base, ...parts);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(".." + "/") || rel.startsWith(".." + "\\")) {
    throw new Error(
      `denext: generate refuses to write outside the project — check the name for "..".`,
    );
  }
  return target;
}

/** Write `content` to `path` unless it exists; record into `written`/`skipped`. */
async function writeIfAbsent(
  path: string,
  content: string,
  written: string[],
  skipped: string[],
): Promise<void> {
  try {
    await Deno.stat(path);
    skipped.push(path);
    return;
  } catch { /* absent — write it */ }
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
  written.push(path);
}

/**
 * Scaffold one artifact of `kind` named `name` into the project at `projectDir`.
 * `page`/`route` are synonyms. Route-shaped kinds (page/route/layout/api) treat
 * `name` as a route path under `app/`; `component`/`action` place files under the
 * source base (`src/` when present, else the project root).
 */
export async function generateArtifact(
  projectDir: string,
  kind: GenerateKind,
  name: string,
): Promise<GenerateResult> {
  const paths = await resolveProject(projectDir);
  const appDir = paths.appDir;
  const srcBase = dirname(appDir);
  const written: string[] = [];
  const skipped: string[] = [];
  const segment = name.replace(/^[\\/]+|[\\/]+$/g, "");

  // Reject `..` path components early with a clear message (safeJoin also guards).
  if (segment.split(/[\\/]+/).some((s) => s === "..")) {
    throw new Error(`denext: generate name "${name}" must not contain ".." path segments.`);
  }

  switch (kind) {
    case "page":
    case "route":
      await writeIfAbsent(
        safeJoin(appDir, segment, "page.tsx"),
        pageSource(name),
        written,
        skipped,
      );
      break;
    case "layout":
      await writeIfAbsent(
        safeJoin(appDir, segment, "layout.tsx"),
        layoutSource(name),
        written,
        skipped,
      );
      break;
    case "api":
      await writeIfAbsent(safeJoin(appDir, segment, "route.ts"), apiSource(), written, skipped);
      break;
    case "component": {
      const file = pascal(name) + ".tsx";
      await writeIfAbsent(
        safeJoin(srcBase, "components", file),
        componentSource(name),
        written,
        skipped,
      );
      break;
    }
    case "action": {
      const base = segment.replace(/\.ts$/, "") || "action";
      await writeIfAbsent(
        safeJoin(srcBase, "actions", base + ".ts"),
        actionSource(name),
        written,
        skipped,
      );
      break;
    }
  }
  return { written, skipped };
}
