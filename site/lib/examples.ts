// The examples index (app/docs/examples/examples.json, generated from examples/* by
// scripts/gen-examples-index.ts) as the docs pages use it: by name, grouped by category, with
// each example's neighbours. Every example's page renders its own README.md (the single source
// for what the example says about itself); this module only reads the generated index.

import type { NavChild } from "../components/ui.tsx";
import examplesIndex from "../app/docs/examples/examples.json" with { type: "json" };

/** One example, as the generated index describes it. */
export interface Example {
  name: string;
  title: string;
  blurb: string;
  url: string;
  tags: string[];
  hasReadme: boolean;
  category: string;
  run: string;
  runFrom: "example" | "root";
}

/** A category of the index, in display order. */
export interface ExampleCategory {
  id: string;
  label: string;
}

/** Every example, sorted by name. */
export const EXAMPLES: readonly Example[] = examplesIndex.examples as Example[];

/** The categories, in display order. */
export const CATEGORIES: readonly ExampleCategory[] = examplesIndex.categories;

/** The example called `name`, if there is one. */
export function exampleByName(name: string): Example | undefined {
  return EXAMPLES.find((e) => e.name === name);
}

/** The category `id`, if there is one. */
export function categoryById(id: string): ExampleCategory | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

/** Each category with its examples (by name), in display order; empty categories are dropped. */
export function byCategory(): { category: ExampleCategory; examples: Example[] }[] {
  return CATEGORIES
    .map((category) => ({
      category,
      examples: EXAMPLES.filter((e) => e.category === category.id),
    }))
    .filter((g) => g.examples.length > 0);
}

/** Every example in index order (category, then name) — the order prev / next walk. */
export function indexOrder(): Example[] {
  return byCategory().flatMap((g) => g.examples);
}

/** The examples before and after `name` in index order. */
export function neighbours(name: string): { prev?: Example; next?: Example } {
  const all = indexOrder();
  const i = all.findIndex((e) => e.name === name);
  if (i === -1) return {};
  return { prev: all[i - 1], next: all[i + 1] };
}

/** The repo-relative path of an example's README. */
export const readmePath = (name: string): string => `examples/${name}/README.md`;

/** The URL of an example's page on the docs site. */
export const exampleHref = (name: string): string => `/docs/examples/${name}`;

/** The anchor a category has on the index page. */
export const categoryAnchor = (id: string): string => `cat-${id}`;

/**
 * The full "Run it" block: clone the repository, change into the directory the README's commands
 * are written for (the example, or the repo root for a root task), then those commands.
 */
export function runBlock(e: Example): string {
  const cd = e.runFrom === "root" ? "cd denext" : `cd denext/examples/${e.name}`;
  return `git clone https://github.com/Brainwires/denext\n${cd}\n${e.run}`;
}

/**
 * The sidebar links nested under "Examples": every category (an anchor on the index), and under
 * the current example's category its examples, the current one marked.
 */
export function examplesNav(current?: string): NavChild[] {
  const here = current ? exampleByName(current) : undefined;
  return byCategory().map(({ category, examples }) => ({
    href: `/docs/examples#${categoryAnchor(category.id)}`,
    label: category.label,
    children: here?.category === category.id
      ? examples.map((e) => ({
        href: exampleHref(e.name),
        label: e.name,
        current: e.name === current,
      }))
      : undefined,
  }));
}
