// @denext/react-router's route typegen: React Router's `+types/<route>.ts` modules, written under
// `.react-router/types` where `compilerOptions.rootDirs` (what `denext migrate` writes) resolves
// the `import type { Route } from "./+types/<route>"` a route module has. The proof is a real
// `deno check` of route modules against the generated types: params from the full pattern,
// loader / action data unwrapped from `data()`, the client loader's data where it runs at
// hydration, a layout's matches, and a wrong use rejected.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { generateRouteTypes, paramsType } from "../packages/react-router/src/typegen.ts";
import { buildRouteTree } from "../packages/react-router/src/route-tree.ts";
import { index, layout, route } from "../packages/react-router/routes.ts";
import { quietDeno } from "./helpers/quiet-deno.ts";

Deno.test("typegen: params from the full pattern; a layout's descendants' are optional", () => {
  assertEquals(paramsType(""), "{}");
  assertEquals(paramsType("teams/:id"), `{ "id": string }`);
  assertEquals(paramsType("docs/:lang?/*"), `{ "lang"?: string; "*": string }`);
  assertEquals(paramsType("teams", ["teams/:id"]), `{ "id"?: string }`);
});

const DATA = `export class DataWithResponseInit<D> {
  readonly type = "DataWithResponseInit" as const;
  constructor(readonly data: D) {}
}
export const data = <D>(d: D) => new DataWithResponseInit(d);
`;

/** A React Router app (no JSX, so the check needs no JSX runtime) migrated the denext way. */
async function writeApp(dir: string, teamComponent: string): Promise<void> {
  await Deno.mkdir(join(dir, "app", "routes", "teams"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      unstable: ["sloppy-imports"],
      compilerOptions: { strict: true, rootDirs: [".", "./.react-router/types"] },
    }),
  );
  await Deno.writeTextFile(join(dir, "app", "data.ts"), DATA);
  await Deno.writeTextFile(
    join(dir, "app", "root.ts"),
    `export function loader() { return { user: "ada" }; }\nexport default function App() { return null; }\n`,
  );
  await Deno.writeTextFile(
    join(dir, "app", "routes", "shell.ts"),
    `import type { Route } from "./+types/shell";
export default function Shell({ params, matches }: Route.ComponentProps) {
  const id: string | undefined = params.id;
  const user: string = matches[0].loaderData.user;
  return [id, user];
}
`,
  );
  await Deno.writeTextFile(join(dir, "app", "routes", "teams", "team.ts"), teamComponent);
}

const TEAM = `import type { Route } from "./+types/team";
import { data } from "../../data";

export function loader({ params }: Route.LoaderArgs) {
  return data({ id: params.id, size: 3 });
}
export async function action({ request }: Route.ActionArgs) {
  return { renamed: String((await request.formData()).get("name")) };
}
export const meta: Route.MetaFunction = ({ loaderData }) => [{ title: loaderData.id }];
export default function Team({ loaderData, actionData, params }: Route.ComponentProps) {
  const id: string = params.id;
  const size: number = loaderData.size;
  const renamed: string | undefined = actionData?.renamed;
  return [id, size, renamed];
}
`;

async function check(dir: string, file: string): Promise<{ ok: boolean; out: string }> {
  const r = await quietDeno(["check", "-q", file], { cwd: dir, env: { NO_COLOR: "1" } });
  return { ok: r.success, out: r.stdout + r.stderr };
}

const routes = () =>
  buildRouteTree([
    index("routes/home.ts"),
    layout("routes/shell.ts", [route("teams/:id", "routes/teams/team.ts")]),
  ]);

Deno.test("typegen: route modules type-check against the generated +types (rootDirs)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rr_typegen_" });
  try {
    await writeApp(dir, TEAM);
    const team = join("app", "routes", "teams", "team.ts");
    const missing = await check(dir, team);
    assert(!missing.ok, "without the generated types the import does not resolve");
    assertStringIncludes(missing.out, "+types/team");

    const written = await generateRouteTypes({
      projectRoot: dir,
      appDir: join(dir, "app"),
      nodes: routes(),
      rootFile: join(dir, "app", "root.ts"),
    });
    assertEquals(
      written.map((f) => f.slice(dir.length + 1).replaceAll("\\", "/")).sort(),
      [
        ".react-router/types/app/+types/root.ts",
        ".react-router/types/app/routes/+types/home.ts",
        ".react-router/types/app/routes/+types/shell.ts",
        ".react-router/types/app/routes/teams/+types/team.ts",
      ],
    );
    const ok = await check(dir, team);
    assert(ok.ok, ok.out);
    const shell = await check(dir, join("app", "routes", "shell.ts"));
    assert(shell.ok, shell.out);

    // A wrong use is a type error: loaderData.size is a number.
    await Deno.writeTextFile(
      join(dir, team),
      TEAM.replace(
        "const size: number = loaderData.size;",
        "const size: string = loaderData.size;",
      ),
    );
    const bad = await check(dir, team);
    assert(!bad.ok, "a wrong type is rejected");
    assertStringIncludes(bad.out, "TS2322");

    // A removed route's types are pruned.
    await generateRouteTypes({
      projectRoot: dir,
      appDir: join(dir, "app"),
      nodes: buildRouteTree([index("routes/home.ts")]),
      rootFile: null,
    });
    const left = [];
    for await (const e of Deno.readDir(join(dir, ".react-router/types/app/routes/+types"))) {
      left.push(e.name);
    }
    assertEquals(left, ["home.ts"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("typegen: a client loader that runs at hydration types loaderData as its own data", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rr_typegen_client_" });
  try {
    await writeApp(
      dir,
      `import type { Route } from "./+types/team";
export function loader() { return { source: "server" }; }
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  const s = await serverLoader();
  return { source: s.source, client: true as const };
}
clientLoader.hydrate = true as const;
export function HydrateFallback() { return null; }
export default function Team({ loaderData }: Route.ComponentProps) {
  const client: true = loaderData.client;
  return client;
}
`,
    );
    await generateRouteTypes({
      projectRoot: dir,
      appDir: join(dir, "app"),
      nodes: routes(),
      rootFile: join(dir, "app", "root.ts"),
    });
    const r = await check(dir, join("app", "routes", "teams", "team.ts"));
    assert(r.ok, r.out);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A route with React Router middleware and a typed context key (no runtime import needed). */
const TEAM_MIDDLEWARE = `import type { Route } from "./+types/team";

const user: { readonly defaultValue?: string } = { defaultValue: "anonymous" };

export const middleware: Route.MiddlewareFunction[] = [
  async ({ params, context }, next) => {
    context.set(user, params.id);
    const response: Response = await next();
    return response;
  },
];
export function loader({ context }: Route.LoaderArgs) {
  const name: string = context.get(user);
  return { name, legacy: context.legacy };
}
export default function Team({ loaderData }: Route.ComponentProps) {
  return [loaderData.name];
}
`;

Deno.test("typegen: Route.MiddlewareFunction and a typed context.get / context.set", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rr_typegen_mw_" });
  try {
    await writeApp(dir, TEAM_MIDDLEWARE);
    await generateRouteTypes({
      projectRoot: dir,
      appDir: join(dir, "app"),
      nodes: routes(),
      rootFile: join(dir, "app", "root.ts"),
    });
    const team = join("app", "routes", "teams", "team.ts");
    const ok = await check(dir, team);
    assert(ok.ok, ok.out);

    // The key's type flows through `get` and `set`.
    await Deno.writeTextFile(
      join(dir, team),
      TEAM_MIDDLEWARE.replace("context.set(user, params.id);", "context.set(user, 42);"),
    );
    const bad = await check(dir, team);
    assert(!bad.ok, "a value of the wrong type for the key is rejected");
    assertStringIncludes(bad.out, "TS2345");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
