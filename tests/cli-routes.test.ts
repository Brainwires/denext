// `denext routes` and the shared route listing (src/build/route-list.ts) the MCP
// `denext_list_routes` tool also reads: pages + API routes, params, files, and the HTTP methods
// an API route exports — found in its source, never by importing it.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  collectRoutes,
  exportedMethods,
  formatRouteListText,
  formatRouteTable,
} from "../src/build/route-list.ts";
import { routesCommand } from "../src/cli/commands/routes.ts";
import type { CommandContext } from "../src/cli/command.ts";
import { runTool } from "../src/mcp/tools.ts";

/** A project with two pages and two API routes; one route would throw if imported. */
async function project(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_routes_" });
  const write = async (rel: string, text: string) => {
    const path = join(dir, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, text);
  };
  await write("deno.json", "{}\n");
  await write("app/layout.tsx", "export default ({ children }) => children;\n");
  await write("app/page.tsx", "export default () => null;\n");
  await write("app/blog/[slug]/page.tsx", "export default () => null;\n");
  await write(
    "app/api/items/[id]/route.ts",
    'throw new Error("imported!");\nexport async function GET() {}\n' +
      "export const DELETE = () => new Response(null);\n",
  );
  await write(
    "app/api/hook/route.ts",
    "const handler = () => new Response();\nexport { handler as POST, handler as PUT };\n" +
      "export type { Foo as GET } from './types.ts';\n",
  );
  return dir;
}

Deno.test("exportedMethods: declarations, export lists and renames; type-only exports ignored", () => {
  assertEquals(
    exportedMethods(
      "export function GET() {}\nexport async function POST() {}\nexport const PATCH = 1;\n" +
        "export let OPTIONS;\nexport function helper() {}\nexport const revalidate = 60;",
    ),
    ["GET", "POST", "PATCH", "OPTIONS"],
  );
  assertEquals(exportedMethods("export { a as DELETE, HEAD }"), ["HEAD", "DELETE"]);
  assertEquals(exportedMethods("export type { X as GET }"), []);
  assertEquals(exportedMethods("const GET = 1;"), [], "a non-exported binding is not a method");
});

Deno.test("collectRoutes: pages and API routes with params, files and methods", async () => {
  const dir = await project();
  try {
    const list = await collectRoutes(dir);
    assertEquals(list.pages.map((p) => [p.path, p.params, p.file]), [
      ["/blog/[slug]", ["slug"], "app/blog/[slug]/page.tsx"],
      ["/", [], "app/page.tsx"],
    ]);
    assertEquals(
      list.api.map((a) => [a.path, a.params, a.methods]),
      [
        ["/api/items/[id]", ["id"], ["GET", "DELETE"]],
        ["/api/hook", [], ["POST", "PUT"]],
      ],
    );
    assertEquals(list.pages[0].methods, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("formatRouteTable aligns one row per route; an empty app says so", async () => {
  const dir = await project();
  try {
    const table = formatRouteTable(await collectRoutes(dir)).split("\n");
    assertEquals(table[0].split(/\s+/), ["KIND", "ROUTE", "METHODS", "PARAMS", "FILE"]);
    assertEquals(table.length, 5);
    assertEquals(table[3].split(/\s+/), [
      "api",
      "/api/items/[id]",
      "GET,DELETE",
      "id",
      "app/api/items/[id]/route.ts",
    ]);
    // Every column starts at the same offset on every row.
    const col = table[0].indexOf("METHODS");
    for (const row of table.slice(1)) assert(row[col - 1] === " " && row[col] !== " ", row);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  assertEquals(
    formatRouteTable({ pages: [], api: [] }),
    formatRouteListText({ pages: [], api: [] }),
  );
});

async function runRoutes(dir: string, json: boolean): Promise<string> {
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
  try {
    await routesCommand.run({
      positionals: [dir],
      flags: {},
      global: { json, verbose: false, quiet: false } as CommandContext["global"],
      rest: [],
    });
  } finally {
    console.log = log;
  }
  return printed.join("\n");
}

Deno.test("denext routes prints the table, and --json the same data", async () => {
  const dir = await project();
  try {
    const table = await runRoutes(dir, false);
    assertStringIncludes(table, "/api/hook");
    assertStringIncludes(table, "POST,PUT");
    const doc = JSON.parse(await runRoutes(dir, true));
    assertEquals(doc, JSON.parse(JSON.stringify(await collectRoutes(dir))));
    assertEquals(doc.api[1].methods, ["POST", "PUT"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the MCP denext_list_routes tool reads the same listing", async () => {
  const dir = await project();
  try {
    const res = await runTool("denext_list_routes", { dir });
    assert(!res.isError, res.content[0].text);
    assertEquals(res.content[0].text, formatRouteListText(await collectRoutes(dir)));
    assertStringIncludes(res.content[0].text, "/api/items/[id]   (params: id)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
